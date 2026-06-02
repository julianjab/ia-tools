#!/usr/bin/env bash
# Capture a tool_pre event before each tool call.
#
# Bucket:      bookkeeping
# Listens to:  PreToolUse
# Blocking:    no (always exit 0; never blocks the tool call)
# Input  (stdin JSON): { "session_id": "...", "tool_name": "...", "tool_input": {...}, ... }
# Output:      printf '{}' on stdout; appends one event row.
#
# Used by PR2 detectors to pair with tool_post events for duration + outcome.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/common.sh"

payload=$(cat)
[ -n "$payload" ] || { printf '{}'; exit 0; }

session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
[ -n "$session_id" ] || { printf '{}'; exit 0; }

now_ms=$(sf_now_ms)

event=$(jq -cn \
  --arg sid "$session_id" \
  --argjson ts "$now_ms" \
  --arg tool "$tool_name" \
  --argjson payload "$payload" \
  '{
    session_id: $sid,
    ts: $ts,
    event_type: "tool_pre",
    tool_name: (if $tool == "" then null else $tool end),
    payload: $payload
  }')

printf '%s' "$event" | bash "${SCRIPT_DIR}/_lib/append-event.sh"

printf '{}'
exit 0
