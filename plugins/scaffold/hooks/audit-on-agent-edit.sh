#!/usr/bin/env bash
# PostToolUse hook (scaffold plugin): triggers /audit-agent when an agents/*.md
# file is saved. Fires on Edit, Write, and MultiEdit.
#
# Exit 0 → file is not an agent definition, no-op.
# Exit 2 → sends feedback to Claude instructing it to run /audit-agent.

set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$file_path" ]; then
  exit 0
fi

case "$file_path" in
  */agents/*.md) ;;
  *) exit 0 ;;
esac

printf 'Agent file updated: %s\nRun /audit-agent %s to validate it against the anti-pattern rules (A1–A14).\n' \
  "$file_path" "$file_path" >&2
exit 2
