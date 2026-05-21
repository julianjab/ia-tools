#!/usr/bin/env bash
# PreToolUse hook for AskUserQuestion.
#
# Intercepts the native AskUserQuestion tool and redirects the agent to
# the /ask-user skill when the session has a team-workflow context that
# can route the question better (a Slack topic, a parent-IPC socket, or
# a feature/worker label).
#
# Outside that context (vanilla Claude session, no team-workflow envs
# set) the hook is a no-op — AskUserQuestion still works as designed.
#
# Decision logic:
#
#   active context = any of
#     - IA_TW_TOPIC != "" and != "local"   → Slack topic available
#     - IA_TW_PARENT_SOCK != "" and the socket exists → parent IPC available
#     - IA_TW_FEATURE != ""                → lead/worker session
#
#   if active context → exit 2 with a teaching stderr message so the
#                       agent rephrases as SlashCommand(/ask-user …).
#   else              → exit 0 (allow).
#
# stdin carries the PreToolUse payload (tool_name + tool_input); we don't
# need to parse it because the matcher in hooks.json already scoped the
# hook to AskUserQuestion.

set -euo pipefail

active_context=0
reason=""

if [ -n "${IA_TW_TOPIC:-}" ] && [ "$IA_TW_TOPIC" != "local" ]; then
  active_context=1
  reason="Slack topic active (IA_TW_TOPIC=$IA_TW_TOPIC)"
fi

if [ -n "${IA_TW_PARENT_SOCK:-}" ] && [ -S "$IA_TW_PARENT_SOCK" ]; then
  active_context=1
  if [ -n "$reason" ]; then
    reason="$reason; parent IPC socket reachable"
  else
    reason="parent IPC socket reachable ($IA_TW_PARENT_SOCK)"
  fi
fi

if [ "$active_context" -eq 0 ] && [ -n "${IA_TW_FEATURE:-}" ]; then
  active_context=1
  reason="team-workflow lead/worker session (IA_TW_FEATURE=$IA_TW_FEATURE)"
fi

if [ "$active_context" -eq 0 ]; then
  # Vanilla session — AskUserQuestion is the right tool. Allow.
  exit 0
fi

# Block with a teaching message. The agent receives the stderr text and
# rephrases on the next turn.
cat >&2 <<EOF
AskUserQuestion is intercepted in this session ($reason).

Route every user-facing question through the /ask-user skill instead — it
picks the destination (Slack reply, parent IPC, or terminal) from the
session env so the operator actually sees the question, regardless of
where they are.

Retry as:
  SlashCommand(command="/ask-user \"<your question text>\" --ask --in-reply-to <inbound message_ts when applicable>")

For one-way notifications (no answer needed) drop the --ask flag.
EOF

exit 2
