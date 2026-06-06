#!/usr/bin/env bash
# PreToolUse nudge — mutative Bash.
#
# Bucket:      intelligence
# Listens to:  PreToolUse (matcher: Bash)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_name": "Bash", "tool_input": { "command": "..." }, ... }
# Output: additionalContext for mutative commands when repo has resources;
#         `{}` otherwise (read-only / search commands pass silent).
#
# Filters Bash by pattern: only commands that change state (git commit/push,
# package installs, migrations, deploys, …) trigger the nudge. Read-only
# commands (ls, grep, git status, git diff, …) pass through. Skips when
# called from inside a subagent. Agnostic — no team-workflow state reads.

set -u

# shellcheck source=./_agent-routing-lib.sh
. "$(dirname "$0")/_agent-routing-lib.sh"

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
agent_name=$(printf '%s' "$payload" | jq -r '.agent_name // empty' 2>/dev/null)

if [ -z "$command" ]; then
  printf '{}'
  exit 0
fi

if [ -n "$agent_name" ]; then
  printf '{}'
  exit 0
fi

if ! agent_routing_is_mutative_bash "$command"; then
  printf '{}'
  exit 0
fi

root=$(agent_routing_find_root "$PWD")
if [ -z "$root" ]; then
  printf '{}'
  exit 0
fi

roster=$(agent_routing_print_roster "$root")
if [ -z "$roster" ]; then
  printf '{}'
  exit 0
fi

short_cmd=$(printf '%s' "$command" | head -c 120)

body="[agent-routing — mutative Bash detected]
Command: ${short_cmd}

This repo exposes execution resources that likely wrap this kind of
operation (commits, installs, migrations, deploys). Prefer them over
ad-hoc shell:

${roster}

(Not blocking — reminder only. Read-only commands like ls / grep / git
status / git diff are never flagged.)"

agent_routing_emit_context "PreToolUse" "$body"
