#!/usr/bin/env bash
# Capture a session_start event for session-forge.
#
# Bucket:      bookkeeping
# Listens to:  SessionStart
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "session_id": "...", "cwd": "...", "hook_event_name": "SessionStart", ... }
# Output:      printf '{}' on stdout; appends one event row + upserts sessions.
#
# Records when the session started, the cwd, and (best-effort) the git branch
# and dirty flag. Everything else (tool usage, prompts) flows through the
# per-event hooks below.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/common.sh"

payload=$(cat)
[ -n "$payload" ] || { printf '{}'; exit 0; }

session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$session_id" ] || { printf '{}'; exit 0; }

now_ms=$(sf_now_ms)

# Best-effort git inspection. Never fails the hook.
branch=""
dirty=""
if [ -n "$cwd" ] && sf_have git; then
  branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -z "$(git -C "$cwd" status --porcelain 2>/dev/null)" ]; then
      dirty=0
    else
      dirty=1
    fi
  fi
fi

event=$(jq -cn \
  --arg sid "$session_id" \
  --argjson ts "$now_ms" \
  --arg cwd "$cwd" \
  --arg branch "$branch" \
  --arg dirty "$dirty" \
  --argjson payload "$payload" \
  '{
    session_id: $sid,
    ts: $ts,
    event_type: "session_start",
    cwd: (if $cwd == "" then null else $cwd end),
    git_branch: (if $branch == "" then null else $branch end),
    git_dirty: (if $dirty == "" then null else ($dirty | tonumber) end),
    payload: $payload
  }')

printf '%s' "$event" | bash "${SCRIPT_DIR}/_lib/append-event.sh"

printf '{}'
exit 0
