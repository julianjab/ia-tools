#!/usr/bin/env bash
# PreToolUse nudge — file-mutating tools.
#
# Bucket:      intelligence
# Listens to:  PreToolUse (matcher: Edit|Write|MultiEdit)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_name": "...", "tool_input": { "file_path": ... }, ... }
# Output: additionalContext suggesting delegation; never blocks.
#
# Fires right before a file mutation. If the target repo exposes a roster
# of agents/skills/commands, emit a soft reminder. Agnostic — no
# team-workflow state inspection. Subagent calls (when the tool is being
# invoked from inside an Agent()) skip the nudge to avoid double-reminding.

set -u

# shellcheck source=./_agent-routing-lib.sh
. "$(dirname "$0")/_agent-routing-lib.sh"

payload=$(cat)
tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
agent_name=$(printf '%s' "$payload" | jq -r '.agent_name // empty' 2>/dev/null)

if [ -z "$tool_name" ] || [ -z "$file_path" ]; then
  printf '{}'
  exit 0
fi

# Skip when already inside a subagent — the reminder targets the main session.
if [ -n "$agent_name" ]; then
  printf '{}'
  exit 0
fi

# Anchor discovery on the file being edited (its repo), not $PWD, so the
# roster matches the actual target.
anchor_dir=$(dirname "$file_path")
[ -d "$anchor_dir" ] || anchor_dir="$PWD"

root=$(agent_routing_find_root "$anchor_dir")
if [ -z "$root" ]; then
  printf '{}'
  exit 0
fi

roster=$(agent_routing_print_roster "$root")
if [ -z "$roster" ]; then
  printf '{}'
  exit 0
fi

body="[agent-routing — about to ${tool_name} ${file_path}]
This file lives under ${root}, which ships repo-local resources for
execution work. Consider delegating to one of them via
Agent(subagent_type=<name>) instead of editing inline:

${roster}

(Not blocking — this is a reminder. Search / planning steps are fine inline.)"

agent_routing_emit_context "PreToolUse" "$body"
