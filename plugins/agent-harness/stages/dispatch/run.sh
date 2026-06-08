#!/usr/bin/env bash
# stages/dispatch/run.sh — execute ready tasks from the plan.
#
# Usage:
#   run.sh <state.yaml> [--task <id>] [--dry-run] [--max-parallel <n>]
#
#   <state.yaml>          session state
#   --task <id>           run only this task (must be ready)
#   --dry-run             print what would happen; do not spawn claude -p
#   --max-parallel <n>    cap of concurrent task runs (default 1)
#
# Reads:  .tasks[], .worktrees[]
# Writes: .tasks[].status, .tasks[].finished_at, .runs[]
# Emits:  one event per task (kind: outcome | error | skipped) and one
#         summary event at the end.
#
# Each task is executed by spawning:
#   claude -p --add-dir <worktree-path> --agent <assigned_to> \
#          --output-format json -- "<task-title>"
# The exit code + stop reason decides success/failure. The output is
# captured to <session>/runs/<task-id>.json for the audit trail.
#
# Tasks with assigned_to=null are skipped (event: kind=skipped, reason
# "no agent assigned"). The user must edit state.yaml to assign or
# remove the task before re-running.

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/../.." && pwd)"

# shellcheck source=../../lib/config.sh
source "$PLUGIN_ROOT/lib/config.sh"
config_init

state_file=""
only_task=""
dry_run=0
max_parallel=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)         only_task="$2"; shift 2 ;;
    --dry-run)      dry_run=1; shift ;;
    --max-parallel) max_parallel="$2"; shift 2 ;;
    -*) echo "✗ dispatch: unknown flag $1" >&2; exit 1 ;;
    *)  state_file="$1"; shift ;;
  esac
done
[[ -n "$state_file" ]] || { echo "usage: run.sh <state.yaml> [--task <id>] [--dry-run]" >&2; exit 1; }
[[ -f "$state_file" ]] || { echo "✗ dispatch: $state_file missing" >&2; exit 1; }

session_dir="$(dirname "$state_file")"
events_log="$session_dir/harness-events.log"
runs_dir="$session_dir/runs"
mkdir -p "$runs_dir"

session_id="$(yq -r '.session_id' "$state_file")"
tasks_json="$(yq -o=json '.tasks // []' "$state_file")"
worktrees_json="$(yq -o=json '.worktrees // []' "$state_file")"

[[ "$(echo "$tasks_json" | jq 'length')" -gt 0 ]] || {
  echo "✗ dispatch: no .tasks[] — run task-plan first" >&2; exit 1; }

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# helper: look up worktree path for a task
wt_path_for() {
  local wt_name="$1"
  jq -r --arg n "$wt_name" '.[] | select(.name == $n) | .path' <<<"$worktrees_json"
}

# helper: read current status of a task from state.yaml (live, not the
# cached tasks_json snapshot — needed when running in --task mode).
task_status() {
  local id="$1"
  ID="$id" yq -r '.tasks[] | select(.id == strenv(ID)) | .status // "pending"' "$state_file"
}

# helper: mark a task and record a run
mark_task() {
  local id="$1" status="$2" run_path="$3" reason="${4:-}"
  local ts; ts="$(now)"
  local run_obj
  run_obj="$(jq -nc \
    --arg id "$id" --arg st "$status" --arg ts "$ts" \
    --arg rp "$run_path" --arg rs "$reason" \
    '{task_id:$id, finished_at:$ts, status:$st, run_file:$rp, reason:$rs}')"
  export ID="$id" ST="$status" TS="$ts" RUN_OBJ="$run_obj"
  yq -i '
    (.tasks[] | select(.id == strenv(ID))).status = strenv(ST) |
    (.tasks[] | select(.id == strenv(ID))).finished_at = strenv(TS) |
    .runs = ((.runs // []) + [strenv(RUN_OBJ) | from_json]) |
    .updated_at = strenv(TS)
  ' "$state_file"
}

# helper: dependency check
deps_ready() {
  local id="$1"
  local blocked_by
  blocked_by="$(echo "$tasks_json" | jq -c --arg id "$id" \
    '.[] | select(.id == $id) | .blockedBy // []')"
  local n; n="$(echo "$blocked_by" | jq 'length')"
  [[ "$n" -eq 0 ]] && return 0
  local i
  for i in $(seq 0 $((n - 1))); do
    local dep; dep="$(echo "$blocked_by" | jq -r ".[$i]")"
    # read latest status from state.yaml (live)
    local s; s="$(task_status "$dep")"
    [[ "$s" == "completed" ]] || return 1
  done
  return 0
}

# Execute one task. Returns 0 always (errors recorded as task status).
run_task() {
  local id="$1"
  local task title wt assigned wt_path run_file
  task="$(echo "$tasks_json" | jq -c --arg id "$id" '.[] | select(.id == $id)')"
  title="$(echo "$task" | jq -r .title)"
  wt="$(echo "$task" | jq -r .worktree)"
  assigned="$(echo "$task" | jq -r '.assigned_to // ""')"
  wt_path="$(wt_path_for "$wt")"
  run_file="$runs_dir/${id}.json"

  if [[ -z "$assigned" || "$assigned" == "null" ]]; then
    echo "↷ skip [$id] no agent assigned"
    jq -nc --arg ts "$(now)" --arg sid "$session_id" \
       --arg sum "skip $id — no agent" --arg id "$id" \
       '{ts:$ts, session_id:$sid, stage:"dispatch", kind:"skipped",
         summary:$sum, data:{task_id:$id, reason:"assigned_to is null"}}' \
       >>"$events_log"
    mark_task "$id" "skipped" "" "no agent assigned"
    return 0
  fi

  if [[ -z "$wt_path" || ! -d "$wt_path" ]]; then
    echo "✗ [$id] worktree path missing: $wt_path"
    jq -nc --arg ts "$(now)" --arg sid "$session_id" \
       --arg sum "fail $id — worktree missing" --arg id "$id" --arg p "$wt_path" \
       '{ts:$ts, session_id:$sid, stage:"dispatch", kind:"error",
         summary:$sum, data:{task_id:$id, worktree_path:$p}}' \
       >>"$events_log"
    mark_task "$id" "failed" "" "worktree path missing"
    return 0
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    echo "↪ DRY [$id] $assigned @ $wt_path: \"$title\""
    jq -nc --arg ts "$(now)" --arg sid "$session_id" \
       --arg sum "dry-run $id → $assigned" --arg id "$id" \
       --arg ag "$assigned" --arg p "$wt_path" --arg t "$title" \
       '{ts:$ts, session_id:$sid, stage:"dispatch", kind:"decision",
         summary:$sum, data:{task_id:$id, assigned_to:$ag, worktree:$p, title:$t, dry_run:true}}' \
       >>"$events_log"
    mark_task "$id" "completed" "" "dry-run"
    return 0
  fi

  echo "▶ [$id] $assigned @ $wt: \"$title\""
  mark_task "$id" "in_progress" "$run_file" ""

  local started; started="$(now)"
  # Permission mode for the spawned task. The operator chose to invoke
  # dispatch, which is the explicit handoff of autonomy. Default to
  # acceptEdits so Write/Edit/MultiEdit run without prompts inside the
  # worktree. Operators who want stricter behavior override with
  # AGENT_HARNESS_DISPATCH_PERMISSION_MODE.
  local perm_mode="${AGENT_HARNESS_DISPATCH_PERMISSION_MODE:-acceptEdits}"

  if claude -p \
      --add-dir "$wt_path" \
      --agent "$assigned" \
      --output-format json \
      --disable-slash-commands \
      --permission-mode "$perm_mode" \
      -- "$title" \
      >"$run_file" 2>>"$runs_dir/${id}.stderr"; then
    local stop; stop="$(jq -r '.stop_reason // ""' "$run_file" 2>/dev/null || echo "")"
    jq -nc --arg ts "$(now)" --arg sid "$session_id" \
       --arg sum "done $id ($stop)" --arg id "$id" --arg rp "$run_file" --arg st "$started" \
       '{ts:$ts, session_id:$sid, stage:"dispatch", kind:"outcome",
         summary:$sum, data:{task_id:$id, run_file:$rp, started_at:$st}}' \
       >>"$events_log"
    mark_task "$id" "completed" "$run_file" ""
  else
    local code=$?
    jq -nc --arg ts "$(now)" --arg sid "$session_id" \
       --arg sum "fail $id (exit $code)" --arg id "$id" --arg rp "$run_file" \
       --argjson c "$code" \
       '{ts:$ts, session_id:$sid, stage:"dispatch", kind:"error",
         summary:$sum, data:{task_id:$id, run_file:$rp, exit_code:$c}}' \
       >>"$events_log"
    mark_task "$id" "failed" "$run_file" "claude -p exit $code"
    echo "✗ [$id] failed (exit $code) — see $runs_dir/${id}.stderr"
  fi
}

# ── single-task mode ──────────────────────────────────────────────
if [[ -n "$only_task" ]]; then
  status="$(task_status "$only_task")"
  [[ "$status" == "pending" ]] || { echo "✗ dispatch: task $only_task is $status, not pending" >&2; exit 1; }
  deps_ready "$only_task" || { echo "✗ dispatch: task $only_task has unsatisfied blockedBy" >&2; exit 1; }
  # phase update
  export NOW="$(now)"
  yq -i '.updated_at = strenv(NOW) | .phase = "dispatch"' "$state_file"
  run_task "$only_task"
  echo "✓ dispatch single-task done"
  exit 0
fi

# ── loop mode: pick ready tasks until none remain ─────────────────
export NOW="$(now)"
yq -i '.updated_at = strenv(NOW) | .phase = "dispatch"' "$state_file"

n_total="$(echo "$tasks_json" | jq 'length')"
loops=0
while :; do
  # find one ready task (one at a time; max-parallel reserved for future)
  picked=""
  for i in $(seq 0 $((n_total - 1))); do
    id="$(echo "$tasks_json" | jq -r ".[$i].id")"
    s="$(task_status "$id")"
    [[ "$s" == "pending" ]] || continue
    if deps_ready "$id"; then picked="$id"; break; fi
  done

  if [[ -z "$picked" ]]; then break; fi
  run_task "$picked"
  ((loops++))
  if [[ "$loops" -gt $((n_total * 2)) ]]; then
    echo "✗ dispatch: loop guard tripped — possible cycle or unmet deps" >&2
    exit 1
  fi
done

# ── summary ───────────────────────────────────────────────────────
completed="$(yq -r '[.tasks[] | select(.status == "completed")] | length' "$state_file")"
failed="$(yq -r '[.tasks[] | select(.status == "failed")] | length' "$state_file")"
skipped="$(yq -r '[.tasks[] | select(.status == "skipped")] | length' "$state_file")"
pending="$(yq -r '[.tasks[] | select(.status == "pending" or .status == null)] | length' "$state_file")"

jq -nc --arg ts "$(now)" --arg sid "$session_id" \
  --argjson c "$completed" --argjson f "$failed" --argjson s "$skipped" --argjson p "$pending" \
  --arg sum "dispatch summary: $completed done, $failed failed, $skipped skipped, $pending pending" \
  '{ts:$ts, session_id:$sid, stage:"dispatch", kind:"outcome",
    summary:$sum, data:{completed:$c, failed:$f, skipped:$s, pending:$p}}' \
  >>"$events_log"

# mark phase done when nothing remains pending
if [[ "$pending" -eq 0 && "$failed" -eq 0 ]]; then
  export NOW="$(now)"
  yq -i '.updated_at = strenv(NOW) | .phase = "done"' "$state_file"
fi

echo "✓ dispatch complete — $completed done, $failed failed, $skipped skipped, $pending pending"
