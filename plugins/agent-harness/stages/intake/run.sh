#!/usr/bin/env bash
# stages/intake/run.sh — turn a raw request into structured intake data.
#
# Usage: run.sh <state.yaml> <request-text>
#   <state.yaml>   absolute path to the session state file
#   <request-text> the user's request, verbatim, as a single arg
#
# Reads:  nothing from state.yaml (intake is the entry stage)
# Writes: state.yaml `.intake` section
# Emits:  one event to harness-events.log (sibling of state.yaml)

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/../.." && pwd)"
PROMPT_FILE="$STAGE_DIR/prompt.md"
SCHEMA_FILE="$STAGE_DIR/schema.json"

# shellcheck source=../../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
config_init
MODEL="$(config_model intake)"

state_file="${1:?usage: run.sh <state.yaml> <request-text>}"
request="${2:?usage: run.sh <state.yaml> <request-text>}"

session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"

# ── 1. ensure state.yaml exists with meta header ──────────────────
if [[ ! -f "$state_file" ]]; then
  mkdir -p "$session_dir"
  cat >"$state_file" <<YAML
version: 1
session_id: $(basename "$session_dir")
created_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
updated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
phase: intake
YAML
fi

# ── 2. call claude -p with schema-constrained output ──────────────
prompt="$(cat "$PROMPT_FILE")"
schema="$(cat "$SCHEMA_FILE")"

# claude -p emits the model output as text; --json-schema constrains it.
raw="$(
  claude -p \
    --model "$MODEL" \
    --output-format json \
    --disable-slash-commands \
    --json-schema "$schema" \
    --system-prompt "$prompt" \
    -- "$request"
)"

# --output-format json wraps the model output in a metadata envelope.
# With --json-schema the validated object lives under .structured_output.
result_json="$(echo "$raw" | jq -c .structured_output)"

# ── 3. validate locally as a defense in depth ─────────────────────
echo "$result_json" | jq -e . >/dev/null || {
  echo "✗ intake: model returned non-JSON" >&2
  echo "$result_json" >&2
  exit 1
}

intent="$(echo "$result_json" | jq -r .intent)"

# ── 4. merge into state.yaml under .intake ────────────────────────
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export INTAKE_RAW="$request"
export INTAKE_JSON="$result_json"
export NOW="$now"

yq -i '
  .updated_at = strenv(NOW) |
  .phase = "intake" |
  .intake.request_raw = strenv(INTAKE_RAW) |
  .intake.result = (strenv(INTAKE_JSON) | from_json)
' "$state_file"

# ── 5. append event ───────────────────────────────────────────────
session_id="$(yq -r '.session_id' "$state_file")"
summary="intent=$intent, targets=$(echo "$result_json" | jq '.targets | length')"
jq -nc \
  --arg ts "$now" \
  --arg sid "$session_id" \
  --arg sum "$summary" \
  --argjson data "$result_json" \
  '{ts:$ts, session_id:$sid, stage:"intake", kind:"outcome", summary:$sum, data:$data}' \
  >>"$events_log"

echo "✓ intake complete — $summary"
echo "  state: $state_file"
echo "  log:   $events_log"
