#!/usr/bin/env bash
# SubagentStop hook — appends structured agent-run metadata to state.md events block.
#
# Bucket:      bookkeeping
# Listens to:  SubagentStop
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "agent_name", "exit_code", "output", "task": { "subject" }, ... }
# Output: exit 0 always; writes an events: entry to state.md when applicable.
#
# Fires when a one-shot Agent() subagent finishes. Captures agent name, task,
# exit code, and a short output excerpt into state.md as a structured events: list.
# This gives session-end a curated pre-memory instead of raw transcript parsing.
#
# No LLM call — fast, cheap, and safe to run on every subagent stop.

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0
state_file="${IA_TW_STATE_DIR}/state.md"
[ -f "$state_file" ] || exit 0

agent_name=$(printf '%s' "$payload" | jq -r '.agent_name // empty'    2>/dev/null)
exit_code=$(printf '%s'  "$payload" | jq -r '.exit_code  // "0"'      2>/dev/null)
task_subj=$(printf '%s'  "$payload" | jq -r '.task.subject // empty'   2>/dev/null)
raw_output=$(printf '%s' "$payload" | jq -r '.output // empty'         2>/dev/null)
ts=$(date -u '+%Y-%m-%dT%H:%MZ')

[ -n "$agent_name" ] || exit 0

# One-line summary: last 400 chars of output, collapsed to single line.
note=""
if [ -n "$raw_output" ]; then
  note=$(printf '%s' "$raw_output" \
    | tail -c 400 \
    | tr '\n\r\t' '   ' \
    | sed 's/[[:space:]]\+/ /g' \
    | sed 's/^[[:space:]]*//' \
    | sed 's/[[:space:]]*$//' \
    | sed 's/"/\\"/g')
fi

# Ensure events: block exists in state.md.
grep -q '^events:' "$state_file" 2>/dev/null || printf '\nevents:\n' >> "$state_file" 2>/dev/null || true

# Append the event entry.
{
  printf '  - ts: %s\n'       "$ts"
  printf '    agent: %s\n'    "$agent_name"
  [ -n "$task_subj" ] && printf '    task: %s\n' "$task_subj"
  printf '    exit_code: %s\n' "$exit_code"
  [ -n "$note" ] && printf '    note: "%s"\n' "$note"
} >> "$state_file" 2>/dev/null || true

exit 0
