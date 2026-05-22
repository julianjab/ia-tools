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
ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

[ -n "$agent_name" ] || exit 0

# Idempotency (S8): skip if this exact ts+agent+task combo is already recorded.
# SubagentStop can refire on transient hook retries; dedupe by composite key.
dedupe_key="ts: ${ts}"
if grep -qF "$dedupe_key" "$state_file" 2>/dev/null \
   && grep -A 4 -F "$dedupe_key" "$state_file" 2>/dev/null \
      | grep -qF "agent: ${agent_name}" 2>/dev/null; then
  exit 0
fi

# One-line summary: last 400 chars of output, collapsed to single line. No
# "-escaping needed — write-event.sh quotes when the value carries YAML-
# significant characters.
note=""
if [ -n "$raw_output" ]; then
  note=$(printf '%s' "$raw_output" \
    | tail -c 400 \
    | tr '\n\r\t' '   ' \
    | sed 's/[[:space:]]\+/ /g' \
    | sed 's/^[[:space:]]*//' \
    | sed 's/[[:space:]]*$//')
fi

# Delegate the YAML insert to the shared helper. `kind: subagent_run`
# discriminates these from feedback-grade events (user_correction etc.)
# that extract-memory-signal.sh consumes — that hook filters by kind
# and ignores unrecognised kinds, so adding a new kind is a no-op for it.
jq -n \
  --arg ts        "$ts" \
  --arg agent     "$agent_name" \
  --arg task      "$task_subj" \
  --arg exit_code "$exit_code" \
  --arg note      "$note" '
  {
    ts:        $ts,
    kind:      "subagent_run",
    agent:     $agent,
    exit_code: $exit_code
  }
  | if ($task | length) > 0 then .task = $task else . end
  | if ($note | length) > 0 then .note = $note else . end
' | bash "$(dirname "$0")/../lib/write-event.sh" || true

exit 0
