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
#
# YAML insertion delegated to lib/write-event.sh (single source of truth
# for the events: append pattern shared across this bucket).

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

new_id=$(printf '%s'    "$payload" | jq -r '.task.id // empty'                2>/dev/null)
subject=$(printf '%s'   "$payload" | jq -r '.task.subject // empty'           2>/dev/null)
replaces=$(printf '%s'  "$payload" | jq -r '.task.metadata.replaces // empty' 2>/dev/null)
reason=$(printf '%s'    "$payload" | jq -r '.task.metadata.reason // empty'   2>/dev/null)

[ -n "$replaces" ] || exit 0
[ -n "$new_id" ]   || exit 0

wt_prefix="${subject%%:*}"

# Idempotency (S8): skip if this exact replacement is already recorded.
if grep -qF "kind: task_replaced" "$state_file" 2>/dev/null \
   && grep -A 3 "kind: task_replaced" "$state_file" 2>/dev/null \
      | grep -qF "old_id: ${replaces}" 2>/dev/null \
   && grep -A 3 "kind: task_replaced" "$state_file" 2>/dev/null \
      | grep -qF "new_id: ${new_id}" 2>/dev/null; then
  exit 0
fi

# Delegate the YAML insert to the shared helper.
jq -n \
  --arg old_id    "$replaces" \
  --arg new_id    "$new_id" \
  --arg subject   "$subject" \
  --arg wt_prefix "$wt_prefix" \
  --arg reason    "$reason" '
  {
    kind:    "task_replaced",
    old_id:  $old_id,
    new_id:  $new_id,
    subject: $subject
  }
  | if $wt_prefix != $subject and ($wt_prefix | length) > 0 then .wt_prefix = $wt_prefix else . end
  | if ($reason   | length) > 0 then .reason    = $reason    else . end
' | bash "$(dirname "$0")/../lib/write-event.sh" || true

exit 0
