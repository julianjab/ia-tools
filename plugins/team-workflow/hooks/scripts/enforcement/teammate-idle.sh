#!/usr/bin/env bash
# TeammateIdle hook — keeps `qa` and `security` working until they publish
# their workflow verdict.
#
# Bucket:      enforcement
# Listens to:  TeammateIdle
# Blocking:    yes (exit 2 forces the teammate to keep working)
# Input  (stdin JSON, per https://code.claude.com/docs/en/hooks#teammateidle):
#   { "teammate": { "name", "agent_type", "blockedBy" },
#     "transcript_path", "cwd", ... }
# Output: exit 0 (allow idle) or exit 2 (force teammate to keep working).
#
# This is the strongest enforcement of plugin invariants 2 and 3 because
# the hook payload provides the teammate name + agent_type, and Claude Code
# also surfaces `transcript_path` (common input field). We scan the
# transcript for the verdict marker the agent is required to emit; if it
# is missing, we exit 2 to keep the teammate working.
#
# Required verdict markers (defined by the agent prompts):
#   qa       → "RED confirmed" (case-insensitive)
#   security → either "APPROVED" or "REJECTED" (uppercase, on a verdict line)
#
# Other teammates idle freely.
set -u

payload=$(cat)

name=$(printf '%s' "$payload" | jq -r '.teammate.name // empty' 2>/dev/null)
agent_type=$(printf '%s' "$payload" | jq -r '.teammate.agent_type // empty' 2>/dev/null)
transcript_path=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)

# Normalize: agent_type is usually the plugin agent name (qa, security, …),
# but some teammates carry the repo-local alias (e.g. "subscriptions-backend").
# Use both fields to classify.
#
# impl fallback teammates are named `impl-<wt_prefix>` (agent_type=implementer).
# Repo-local impl agents have arbitrary names; they are not classified here
# because their agent_type is also their repo-local name (no stable pattern).
role=""
case "${agent_type}:${name}" in
  qa:*|*:qa|*:qa-*|*:tester|*:tester-*) role="qa" ;;
  security:*|*:security|*:security-*)    role="security" ;;
  implementer:*|*:impl-*)                role="impl" ;;
esac

# If we can't classify or there is no transcript yet, allow idle.
if [ -z "$role" ] || [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  printf '{}'
  exit 0
fi

case "$role" in
  qa)
    if ! grep -iE 'RED[[:space:]]+confirmed|✅[[:space:]]*RED' "$transcript_path" >/dev/null 2>&1; then
      printf 'ia-tools invariant 2: qa cannot idle before publishing the RED verdict. Write the failing tests, run them to confirm they fail for the right reason, then emit the literal line "✅ RED confirmed" referencing the worktree prefix (e.g. "✅ RED confirmed for solo:").\n' >&2
      exit 2
    fi
    ;;
  security)
    if ! grep -E '\b(APPROVED|REJECTED)\b' "$transcript_path" >/dev/null 2>&1; then
      printf 'ia-tools invariant 3: security cannot idle before publishing a verdict. Emit a verdict line containing the literal word APPROVED or REJECTED for the audited worktree (e.g. "Verdict: APPROVED — 0 HIGH, 0 MEDIUM").\n' >&2
      exit 2
    fi
    ;;
  impl)
    # Extract wt_prefix from teammate name (impl-<wt_prefix> naming convention).
    wt_prefix="${name#impl-}"
    state_file="${IA_TW_STATE_DIR:-}/state.md"
    if [ -n "${IA_TW_STATE_DIR:-}" ] && [ -f "$state_file" ]; then
      if ! grep -A 30 "wt_prefix:[[:space:]]*${wt_prefix}" "$state_file" 2>/dev/null \
           | grep -qE "green[[:space:]]+for[[:space:]]+${wt_prefix}" 2>/dev/null; then
        printf 'ia-tools staging contract: impl cannot idle before writing the green + staged marker for worktree %s. Run tests (GREEN), stage the exact file list with git add <files>, verify with git -C <wt> diff --cached --name-only, then write "green for %s (staged)" and staged_files: to state.md.\n' \
          "$wt_prefix" "$wt_prefix" >&2
        exit 2
      fi
    fi
    ;;
esac

printf '{}'
exit 0
