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
# The events: insertion + local_phase rewrite is a single awk pass that
# preserves the rest of the file byte-for-byte.

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

[ -n "$state_dir" ] || exit 0

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

tmp=$(mktemp 2>/dev/null) || exit 0

awk -v prefix="$worktree_prefix" \
    -v new_phase="$new_phase" \
    -v ts="$ts" \
    -v subject="$subject" '
  BEGIN { state = "pre"; has_events_header = 0; matched = 0 }

  state == "pre" && /^---$/ { state = "front"; print; next }

  state == "front" && /^---$/ {
    if (has_events_header == 0) print "events:"
    print "  - ts: " ts
    print "    kind: task_completed"
    print "    subject: \"" subject "\""
    print "    wt_prefix: " prefix
    state = "body"
    print
    next
  }

  state == "front" && /^events:[[:space:]]*$/ { has_events_header = 1 }
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

# Only swap if awk produced non-empty output (guard against truncation).
if [ -s "$tmp" ]; then
  cat "$tmp" > "$state_md" 2>/dev/null || true
fi
rm -f "$tmp" 2>/dev/null || true

exit 0
