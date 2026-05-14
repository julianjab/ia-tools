#!/usr/bin/env bash
# PostToolUse hook (scaffold plugin): triggers /audit-agent or /audit-skill when
# an agents/*.md or skills/*/SKILL.md file is saved.
# Fires on Edit, Write, and MultiEdit.
#
# Exit 0 → file is not an agent/skill definition, no-op.
# Exit 2 → sends feedback to Claude instructing it to run the appropriate audit.

set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$file_path" ]; then
  exit 0
fi

case "$file_path" in
  */agents/*.md)
    printf 'Agent file updated: %s\nRun /audit-agent %s to validate it against the anti-pattern rules (A1–A14).\n' \
      "$file_path" "$file_path" >&2
    exit 2
    ;;
  */skills/*/SKILL.md)
    printf 'Skill file updated: %s\nRun /audit-skill %s to validate it against the skill rules (S1–S18).\n' \
      "$file_path" "$file_path" >&2
    exit 2
    ;;
  *) exit 0 ;;
esac
