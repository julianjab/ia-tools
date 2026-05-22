#!/usr/bin/env bash
# enforce-worktree.sh — universal protected-branch enforcement.
#
# Bucket:      enforcement
# Listens to:  PreToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    yes (emits permissionDecision=deny in hookSpecificOutput)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs path>" }, ... }
# Output: empty `{}` on allow, or PreToolUse-shaped deny JSON on block.
#
# Rules (universal — no env coupling, no path patterns, no session state):
#
#   1. File outside any git repo                 → ALLOW
#      (state_dir, /tmp, scratch files — nothing to protect)
#   2. File explicitly gitignored                → ALLOW
#      (`.env`, `node_modules/*`, build outputs — local/ephemeral)
#   3. Repo has NO remotes configured            → ALLOW
#      (purely local experiments — no branch protection to defend)
#   4. Branch == `main` / `master`
#      AND file is tracked-or-trackable           → DENY
#      ("nothing reaches main except via PR")
#   5. Else                                       → ALLOW
#      (feature branches anywhere — fine to edit)
#
# Determinism: decision is a pure function of (file path, git state).
# No `IA_TW_*` env reads, no hardcoded path allowlists, no SESSION_DIR
# special-casing. Worktrees inside the session workspace fall through
# rule #1 (state_dir isn't a git repo) or are caught by rule #4 if
# someone happens to check out main inside them.
set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file_path" ] && { printf '{}'; exit 0; }

dir=$(dirname "$file_path")

# 1. Outside any git repo → ALLOW.
git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { printf '{}'; exit 0; }

# 2. Gitignored → ALLOW.
git -C "$dir" check-ignore -q "$file_path" 2>/dev/null \
  && { printf '{}'; exit 0; }

# 3. No remote configured → ALLOW (no protection model applies).
[ -z "$(git -C "$dir" remote 2>/dev/null)" ] \
  && { printf '{}'; exit 0; }

# 4. Protected branch → DENY for tracked-or-trackable files.
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  # JSON-escape the file path + reason inline (no jq dependency on the
  # write path — keeps the hook usable when jq is missing).
  fp=${file_path//\\/\\\\}
  fp=${fp//\"/\\\"}
  reason="Branch protegida: estás en ${branch} y ${file_path} es tracked. Crea una branch o un worktree antes de editar (e.g. /worktree init feat/<nombre>)."
  esc=${reason//\\/\\\\}
  esc=${esc//\"/\\\"}
  esc=${esc//$'\n'/\\n}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$esc"
  exit 0
fi

# 5. Feature branch with remote → ALLOW.
printf '{}'
exit 0
