#!/usr/bin/env bash
# InstructionsLoaded hook — validates CLAUDE.md config for team-workflow.
#
# Fires when a CLAUDE.md (or .claude/rules/*.md) file is loaded. Checks that
# repos involved in a lead session declare the config /team-review needs.
# Warns early — before reaching the dispatch loop — so the operator can fix
# missing config before wasting a full feature cycle.
#
# Never blocks (exit 0 always). Warnings go to stderr (shown to user).
#
# Input  (stdin JSON): { "path": "/abs/CLAUDE.md", "reason": "session_start|nested_traversal|...", ... }
# Output: exit 0 always; warnings on stderr.

set -u

payload=$(cat)
path=$(printf   '%s' "$payload" | jq -r '.path   // empty' 2>/dev/null)
reason=$(printf '%s' "$payload" | jq -r '.reason // empty' 2>/dev/null)

# Only check project CLAUDE.md files (not user or plugin-level).
case "$path" in
  */CLAUDE.md) ;;
  *) exit 0 ;;
esac
case "$path" in
  "$HOME/.claude/"*) exit 0 ;;
esac

# Only relevant inside a lead session.
[ -n "${IA_TW_FEATURE:-}" ] || exit 0

content=$(cat "$path" 2>/dev/null) || exit 0
warnings=()

# 1. Team-Review channel config.
has_channel_env="${TEAM_REVIEW_CHANNEL:-}"
has_channel_md=0
printf '%s' "$content" | grep -q 'channel:' && has_channel_md=1
if [ -z "$has_channel_env" ] && [ "$has_channel_md" -eq 0 ]; then
  warnings+=("No TEAM_REVIEW_CHANNEL env or 'channel:' in ## Team-Review Config — /team-review will prompt at runtime.")
fi

# 2. Mentions config.
has_mentions_env="${TEAM_REVIEW_MENTIONS:-}"
has_mentions_md=0
printf '%s' "$content" | grep -q 'mentions:' && has_mentions_md=1
if [ -z "$has_mentions_env" ] && [ "$has_mentions_md" -eq 0 ]; then
  warnings+=("No TEAM_REVIEW_MENTIONS env or 'mentions:' in ## Team-Review Config — team-review will have no default reviewers.")
fi

# 3. repo-reviewer declaration.
if ! printf '%s' "$content" | grep -q 'repo-reviewer:'; then
  warnings+=("No 'repo-reviewer:' in CLAUDE.md — stack-specific reviewer will not be auto-added to /team-review.")
fi

if [ ${#warnings[@]} -gt 0 ]; then
  printf '[ia-tools] CLAUDE.md config warnings for %s:\n' "$path" >&2
  for w in "${warnings[@]}"; do
    printf '  ⚠  %s\n' "$w" >&2
  done
fi

exit 0
