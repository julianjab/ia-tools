#!/usr/bin/env bash
# detect-task-replaced.sh — records task replacements as structured events.
#
# Bucket:      intelligence
# Listens to:  TaskCreated
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "task": { "id", "subject", "metadata": { "replaces": "<old-id>", ... } }, ... }
# Output: exit 0 always; appends `kind: task_replaced` to state.md events: when applicable.
#
# When the lead reopens or supersedes a task (e.g. RE-RESOLVED after a
# stub-only green was retracted), it creates a new task with
# `metadata.replaces` pointing at the previous id. This hook captures that
# signal so SessionEnd can surface it as a user-driven correction
# (`feedback`-type auto-memory) instead of letting it die in the audit log.

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

new_id=$(printf '%s'    "$payload" | jq -r '.task.id // empty'              2>/dev/null)
subject=$(printf '%s'   "$payload" | jq -r '.task.subject // empty'         2>/dev/null)
replaces=$(printf '%s'  "$payload" | jq -r '.task.metadata.replaces // empty' 2>/dev/null)
reason=$(printf '%s'    "$payload" | jq -r '.task.metadata.reason // empty'   2>/dev/null)

[ -n "$replaces" ] || exit 0
[ -n "$new_id" ]   || exit 0

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
wt_prefix="${subject%%:*}"

# Idempotency (S8): skip if this exact replacement is already recorded.
if grep -qF "kind: task_replaced" "$state_file" 2>/dev/null \
   && grep -A 3 "kind: task_replaced" "$state_file" 2>/dev/null \
      | grep -qF "old_id: ${replaces}" 2>/dev/null \
   && grep -A 3 "kind: task_replaced" "$state_file" 2>/dev/null \
      | grep -qF "new_id: ${new_id}" 2>/dev/null; then
  exit 0
fi

# Insert in-frontmatter before closing ---.
tmp=$(mktemp 2>/dev/null) || exit 0
awk -v ts="$ts" -v old_id="$replaces" -v new_id="$new_id" \
    -v subject="$subject" -v wt_prefix="$wt_prefix" -v reason="$reason" '
  BEGIN { state = "pre"; has_events_header = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ {
    if (has_events_header == 0) print "events:"
    printf "  - ts: %s\n",            ts
    printf "    kind: task_replaced\n"
    printf "    old_id: %s\n",        old_id
    printf "    new_id: %s\n",        new_id
    printf "    subject: \"%s\"\n",   subject
    if (wt_prefix != subject) printf "    wt_prefix: %s\n", wt_prefix
    if (reason != "") printf "    reason: \"%s\"\n", reason
    state = "body"
    print
    next
  }
  state == "front" && /^events:[[:space:]]*$/ { has_events_header = 1 }
  { print }
' "$state_file" > "$tmp" 2>/dev/null

if [ -s "$tmp" ]; then
  cat "$tmp" > "$state_file" 2>/dev/null || true
fi
rm -f "$tmp" 2>/dev/null || true

exit 0
