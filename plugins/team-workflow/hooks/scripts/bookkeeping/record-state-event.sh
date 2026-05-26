#!/usr/bin/env bash
# record-state-event.sh — records task completions in the audit log + state.md events.
#
# Bucket:      bookkeeping
# Listens to:  TaskCompleted
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "task": { "id", "subject", "status" }, "cwd" }
# Output: exit 0 always; appends to hook-audit.log and state.md (events: +
#         local_phase + last_event_at) when applicable.
#
# Runs AFTER enforcement/enforce-task-invariants.sh in the TaskCompleted
# chain. If invariants didn't block, this hook records the completion in:
#
#   1. $state_dir/hook-audit.log         — append-only TaskCompleted log
#   2. $state_dir/state.md events:        — structured event entry
#   3. $state_dir/state.md local_phase    — transition per subject suffix
#   4. $state_dir/state.md last_event_at  — bump to now
#
# Bucket discipline: never blocks, never calls `claude -p`, always exit 0.
# Two passes:
#   (1) events: insertion delegated to lib/write-event.sh (shared YAML helper).
#   (2) in-place updates of last_event_at + the matching worktree's
#       local_phase, in one awk pass that preserves the rest of the file
#       byte-for-byte.

set -u

payload=$(cat)

subject=$(printf '%s' "$payload" | jq -r '.task.subject // empty' 2>/dev/null)
status=$(printf '%s'  "$payload" | jq -r '.task.status  // empty' 2>/dev/null)
cwd=$(printf '%s'     "$payload" | jq -r '.cwd          // empty' 2>/dev/null)

[ -z "$subject" ]            && { printf '{}'; exit 0; }
[ "$status" = "completed" ]  || { printf '{}'; exit 0; }

# Resolve state dir (same precedence as the enforcement hook).
state_dir=""
if [ -n "${IA_TW_STATE_DIR:-}" ] && [ -d "$IA_TW_STATE_DIR" ]; then
  state_dir="$IA_TW_STATE_DIR"
elif [ -n "$cwd" ] && [ -d "$cwd/.sessions" ]; then
  state_dir=$(find "$cwd/.sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)
fi

# Orphan-event fallback. When state_dir can't be resolved we still want
# a breadcrumb that the TaskCompleted hook fired — otherwise the bug is
# invisible. Without this, missing IA_TW_STATE_DIR propagation produces
# zero audit log + zero events, looking identical to "no tasks ran".
if [ -z "$state_dir" ]; then
  orphan_log="${HOME}/.claude/team-workflow/orphan-events.log"
  mkdir -p "$(dirname "$orphan_log")" 2>/dev/null || true
  printf '%s TaskCompleted subject=%q status=%s cwd=%q IA_TW_STATE_DIR=%q (UNRESOLVED — no audit written)\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$subject" "$status" "$cwd" "${IA_TW_STATE_DIR:-}" \
    >> "$orphan_log" 2>/dev/null || true
  exit 0
fi

worktree_prefix="${subject%%:*}"

# ── 1. hook-audit.log append ──────────────────────────────────────────────
printf '%s TaskCompleted subject=%q status=%s\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$subject" "$status" \
  >> "${state_dir}/hook-audit.log" 2>/dev/null || true

# ── 2/3/4. state.md events: + local_phase + last_event_at ─────────────────
state_md="${state_dir}/state.md"
[ -f "$state_md" ] || exit 0
[ -n "$worktree_prefix" ] || exit 0

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Marker→local_phase mapping for this subject's role suffix.
new_phase=""
case "$subject" in
  *":qa:red"|*":qa:red:"*)                          new_phase="red-confirmed" ;;
  *":impl:green"|*":impl:"*|*":green"|*":green:"*)  new_phase="green" ;;
  *":security"|*":security:"*|*":sec"|*":sec:"*)    new_phase="security-approved" ;;
  *":pr"|*":pr:open"|*":pr:"*)                      new_phase="pr-open" ;;
esac

# Pass 1 — insert the event entry via the shared helper.
jq -n \
  --arg ts      "$ts" \
  --arg subject "$subject" \
  --arg wt      "$worktree_prefix" '{
    ts:        $ts,
    kind:      "task_completed",
    subject:   $subject,
    wt_prefix: $wt
  }' | IA_TW_STATE_DIR="$state_dir" bash "$(dirname "$0")/../lib/write-event.sh" || true

# Pass 2 — in-place updates of last_event_at and the matching worktree's
# local_phase. Pure scalar rewrites; no list manipulation.
tmp=$(mktemp 2>/dev/null) || exit 0
awk -v prefix="$worktree_prefix" \
    -v new_phase="$new_phase" \
    -v ts="$ts" '
  BEGIN { state = "pre"; matched = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ { state = "body"; print; next }

  state == "front" && /^last_event_at:[[:space:]]/ {
    sub(/last_event_at:[[:space:]]*.*/, "last_event_at: " ts)
  }
  state == "front" && /^  - repo:/ { matched = 0 }
  state == "front" && matched == 0 && $0 ~ ("wt_prefix:[[:space:]]*" prefix "([^[:alnum:]_-]|$)") { matched = 1 }
  state == "front" && matched == 1 && new_phase != "" && /^[[:space:]]*local_phase:[[:space:]]/ {
    sub(/local_phase:[[:space:]]*[^[:space:]]+.*/, "local_phase: " new_phase)
    matched = 2
  }

  { print }
' "$state_md" > "$tmp" 2>/dev/null

if [ -s "$tmp" ]; then
  cat "$tmp" > "$state_md" 2>/dev/null || true
fi
rm -f "$tmp" 2>/dev/null || true

exit 0
