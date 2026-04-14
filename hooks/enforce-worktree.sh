#!/usr/bin/env bash
# Pipeline enforcement hook — ia-tools plugin.
#
# Blocks Edit/Write tool calls on protected paths (src/, agents/, skills/,
# scripts/, profiles/, src/mcp-servers/) when the current git branch is main
# or master. Forces the ia-tools pipeline rule: every code change must happen
# inside a worktree (see AGENTS.md rule #4).
#
# Reads Claude Code PreToolUse stdin payload and emits a JSON decision.

set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$file_path" ]; then
  printf '{}'
  exit 0
fi

case "$file_path" in
  */src/*|*/agents/*|*/skills/*|*/scripts/*|*/profiles/*)
    ;;
  *)
    printf '{}'
    exit 0
    ;;
esac

branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Pipeline violation: you are on '"$branch"' and tried to edit a protected path ('"$file_path"'). Per AGENTS.md rule #4, any change under src/, agents/, skills/, scripts/, or profiles/ must happen inside a worktree. Run /worktree init feat/<name> and edit inside that worktree."}}'
  exit 0
fi

printf '{}'
