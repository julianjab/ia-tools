#!/usr/bin/env bash
# Capture each user prompt for session-forge.
#
# Bucket:      bookkeeping
# Listens to:  UserPromptSubmit
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "session_id": "...", "prompt": "...", "hook_event_name": "UserPromptSubmit", ... }
# Output:      printf '{}' on stdout; appends one event + one prompts_fts row.
#
# Stores the prompt text (capped) for later analysis: repetition detection,
# correction-pattern mining, FTS lookup. Never echoes the prompt back.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/common.sh"

payload=$(cat)
[ -n "$payload" ] || { printf '{}'; exit 0; }

session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
prompt_text=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
[ -n "$session_id" ] || { printf '{}'; exit 0; }

now_ms=$(sf_now_ms)

event=$(jq -cn \
  --arg sid "$session_id" \
  --argjson ts "$now_ms" \
  --arg prompt "$prompt_text" \
  --argjson payload "$payload" \
  '{
    session_id: $sid,
    ts: $ts,
    event_type: "user_prompt",
    prompt_text: (if $prompt == "" then null else $prompt end),
    payload: $payload
  }')

printf '%s' "$event" | bash "${SCRIPT_DIR}/_lib/append-event.sh"

printf '{}'
exit 0
