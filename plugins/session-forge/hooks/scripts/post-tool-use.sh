#!/usr/bin/env bash
# Capture a tool_post event after each tool call.
#
# Bucket:      bookkeeping
# Listens to:  PostToolUse
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "session_id": "...", "tool_name": "...", "tool_input": {...},
#                       "tool_response": {...}|null, ... }
# Output:      printf '{}' on stdout; appends one event row.
#
# Records success/failure (best-effort: looks at tool_response.error or
# tool_response.is_error). Duration_ms is left null in PR1 and computed by
# PR2 detectors as (tool_post.ts - matching tool_pre.ts).

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

# Heuristic success extraction. Different tools shape responses differently.
# Treat "is_error: true" or non-empty "error" field as failure; everything
# else as success. Unknown shape → leave null.
success=$(printf '%s' "$payload" | jq -r '
  .tool_response
  | if . == null then ""
    elif (.is_error // false) == true then 0
    elif (.error // null) != null and (.error | tostring) != "" then 0
    else 1
    end
' 2>/dev/null)

now_ms=$(sf_now_ms)

event=$(jq -cn \
  --arg sid "$session_id" \
  --argjson ts "$now_ms" \
  --arg tool "$tool_name" \
  --arg success "$success" \
  --argjson payload "$payload" \
  '{
    session_id: $sid,
    ts: $ts,
    event_type: "tool_post",
    tool_name: (if $tool == "" then null else $tool end),
    success: (if $success == "" then null else ($success | tonumber) end),
    payload: $payload
  }')

printf '%s' "$event" | bash "${SCRIPT_DIR}/_lib/append-event.sh"

printf '{}'
exit 0
