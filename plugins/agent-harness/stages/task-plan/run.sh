#!/usr/bin/env bash
# stages/task-plan/run.sh — generate the task plan from intake + worktrees.
#
# Usage: run.sh <state.yaml>
# Reads:  .intake.result, .worktrees[] (with .agents)
# Writes: .tasks[]
# Emits:  one event to harness-events.log

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/../.." && pwd)"
PROMPT_FILE="$STAGE_DIR/prompt.md"
SCHEMA_FILE="$STAGE_DIR/schema.json"

# shellcheck source=../../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
config_init

state_file="${1:?usage: run.sh <state.yaml>}"
session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"

[[ -f "$state_file" ]] || { echo "✗ task-plan: $state_file missing" >&2; exit 1; }

intake_json="$(yq -o=json '.intake.result' "$state_file")"
worktrees_json="$(yq -o=json '.worktrees // []' "$state_file")"
[[ "$intake_json" != "null" ]] || { echo "✗ task-plan: .intake.result missing" >&2; exit 1; }
[[ "$(echo "$worktrees_json" | jq 'length')" -gt 0 ]] || {
  echo "✗ task-plan: no .worktrees[] — run agent-scan first" >&2; exit 1; }

MODEL="$(config_model task-plan)"

# strip path/base/status noise; the model only needs name + agents
slim_worktrees="$(echo "$worktrees_json" | jq '[.[] | {name, agents: (.agents // [])}]')"

user_payload="$(jq -nc \
  --argjson intake "$intake_json" \
  --argjson worktrees "$slim_worktrees" \
  '{intake:$intake, worktrees:$worktrees}')"

prompt="$(cat "$PROMPT_FILE")"
schema="$(cat "$SCHEMA_FILE")"

raw="$(
  claude -p \
    --model "$MODEL" \
    --output-format json \
    --disable-slash-commands \
    --json-schema "$schema" \
    --system-prompt "$prompt" \
    -- "$user_payload"
)"

result_json="$(echo "$raw" | jq -c .structured_output)"
[[ "$result_json" != "null" && -n "$result_json" ]] || {
  echo "✗ task-plan: model returned no structured output" >&2
  echo "$raw" >&2
  exit 1
}

# ── validation: assigned_to must be in the worktree's agent list (or null);
#                blockedBy ids must reference tasks in the same plan.
echo "$result_json" | jq -e '
  . as $r |
  ($r.tasks | map(.id)) as $ids |
  ($r.tasks | all(
    (.blockedBy | all(. as $b | $ids | index($b)))
  ))
' >/dev/null || { echo "✗ task-plan: blockedBy references unknown task ids" >&2; exit 1; }

# assignment sanity check
issues="$(jq --argjson r "$result_json" --argjson w "$worktrees_json" '
  [$r.tasks[] | . as $t |
    ($w | map(select(.name == $t.worktree)) | .[0]) as $wt |
    if $wt == null then "task \($t.id): worktree \($t.worktree) not in plan"
    elif ($t.assigned_to == null) then empty
    elif ($wt.agents | map(.id) | index($t.assigned_to)) == null
      then "task \($t.id): assigned_to=\($t.assigned_to) not in worktree \($t.worktree)"
    else empty end
  ]
' <<<"")"
if [[ "$(echo "$issues" | jq 'length')" -gt 0 ]]; then
  echo "✗ task-plan: $issues" >&2
  exit 1
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PLAN_JSON="$result_json"
export NOW="$now"

yq -i '
  .updated_at = strenv(NOW) |
  .phase = "task-plan" |
  .tasks = (strenv(PLAN_JSON) | from_json | .tasks)
' "$state_file"

session_id="$(yq -r '.session_id' "$state_file")"
n_tasks="$(echo "$result_json" | jq '.tasks | length')"
summary="$n_tasks task(s) planned"

jq -nc \
  --arg ts "$now" --arg sid "$session_id" --arg sum "$summary" \
  --argjson data "$result_json" \
  '{ts:$ts, session_id:$sid, stage:"task-plan", kind:"outcome", summary:$sum, data:$data}' \
  >>"$events_log"

echo "✓ task-plan complete — $summary"
echo "$result_json" | jq -r '.tasks[] |
  "  • [\(.id)] \(.title) → \(.assigned_to // "(unassigned)")" +
  (if (.blockedBy | length) > 0 then " (after: \(.blockedBy | join(", ")))" else "" end)'
