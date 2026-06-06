#!/usr/bin/env bash
# UserPromptSubmit nudge — remind to delegate execution tasks.
#
# Bucket:      intelligence
# Listens to:  UserPromptSubmit
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "prompt": "<user text>", ... }
# Output: additionalContext when prompt looks like an execution request AND
#         the repo exposes agents/skills/commands; `{}` otherwise.
#
# Classifies the prompt heuristically (Spanish + English) and skips silently
# on search/planning prompts. Agnostic — only depends on $PWD discovery.

set -u

# shellcheck source=./_agent-routing-lib.sh
. "$(dirname "$0")/_agent-routing-lib.sh"

payload=$(cat)
prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)

if [ -z "$prompt" ]; then
  printf '{}'
  exit 0
fi

intent=$(agent_routing_classify_prompt "$prompt")
case "$intent" in
  exec) ;;
  *) printf '{}'; exit 0 ;;
esac

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

body="[agent-routing — execution intent detected]
This prompt looks like an execution / mutation request. Before editing files
or running mutative commands inline, pick a repo-local resource that already
encapsulates the workflow:

${roster}

Delegate via Agent(subagent_type=<name>) for agents, Skill(<name>) for skills,
or /<name> for slash commands. Search and planning steps can stay inline."

agent_routing_emit_context "UserPromptSubmit" "$body"
