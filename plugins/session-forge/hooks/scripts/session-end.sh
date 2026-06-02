#!/usr/bin/env bash
# Capture a session_end event for session-forge.
#
# Bucket:      bookkeeping
# Listens to:  SessionEnd
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "session_id": "...", "hook_event_name": "SessionEnd", ... }
# Output:      printf '{}' on stdout; updates sessions.ended_at + appends event.
#
# Records when the session ended so duration can be derived later.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/common.sh"

payload=$(cat)
[ -n "$payload" ] || { printf '{}'; exit 0; }

session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$session_id" ] || { printf '{}'; exit 0; }

now_ms=$(sf_now_ms)

event=$(jq -cn \
  --arg sid "$session_id" \
  --argjson ts "$now_ms" \
  --argjson payload "$payload" \
  '{
    session_id: $sid,
    ts: $ts,
    event_type: "session_end",
    payload: $payload
  }')

printf '%s' "$event" | bash "${SCRIPT_DIR}/_lib/append-event.sh"

printf '{}'
exit 0
