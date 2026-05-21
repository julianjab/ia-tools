#!/usr/bin/env bash
# PostToolUse hook (scaffold plugin) — nudges /audit-* on definition file edits.
#
# Bucket:      enforcement (uses exit 2 to surface the nudge to Claude)
# Listens to:  PostToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    yes (exit 2 with stderr feedback; the edit itself is NOT reverted)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs path>" }, ... }
# Output: exit 0 on non-definition paths; exit 2 with stderr nudge otherwise.
#
# Triggers /audit-agent, /audit-skill, or /audit-script depending on which
# scaffold artifact was modified:
#
#   agents/*.md             → /audit-agent  (A1–A14)
#   skills/*/SKILL.md       → /audit-skill  (S1–S18 for skills)
#   hooks/scripts/*.sh      → /audit-script (S1–S20 for bash)
#   plugins/*/hooks/.../*.sh→ /audit-script (S1–S20 for bash)
#   scripts/*.sh            → /audit-script (S1–S20 for bash)

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
  */hooks/scripts/*.sh|*/hooks/*.sh|*/scripts/*.sh)
    printf 'Script file updated: %s\nRun /audit-script %s to validate it against the structured-bash rules (S1–S20).\n' \
      "$file_path" "$file_path" >&2
    exit 2
    ;;
  *) exit 0 ;;
esac
