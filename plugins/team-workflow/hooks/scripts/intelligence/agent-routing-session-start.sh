#!/usr/bin/env bash
# SessionStart roster — surface repo-local agents/skills/commands.
#
# Bucket:      intelligence
# Listens to:  SessionStart
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "startup_mode": "startup|resume|clear|compact", ... }
# Output: additionalContext with the discovered roster, or `{}` when empty.
#
# Walks up from $PWD looking for .claude/{agents,skills,commands}/. If found,
# lists what's there as additionalContext so the model knows what to delegate
# to. Pure discovery — no team-workflow dependencies.

set -u

# shellcheck source=./_agent-routing-lib.sh
. "$(dirname "$0")/_agent-routing-lib.sh"

payload=$(cat)
startup_mode=$(printf '%s' "$payload" | jq -r '.startup_mode // empty' 2>/dev/null)

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

body="[agent-routing — repo resources discovered at ${root}]
For execution tasks (edits, code changes, mutations) prefer delegating to a
repo-local resource over doing the work inline. Use Agent(subagent_type=<name>)
for agents, Skill(<name>) for skills, and /<name> for commands. Search and
planning tasks (read, grep, explain, list, audit) can proceed inline freely.

Available in this repo:
${roster}

Startup mode: ${startup_mode:-unknown}"

agent_routing_emit_context "SessionStart" "$body"
