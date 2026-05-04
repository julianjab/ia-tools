#!/usr/bin/env bash
# =============================================================================
# skills/worktree/scripts/init.sh — Create a git worktree for a branch.
#
# Implements the `/worktree init` sub-command with support for the `--repo`
# flag introduced by REQ-001 (multi-repo orchestration).
#
# Usage:
#   bash init.sh <branch-name> [--base <base-branch>] [--repo <target-repo-root>]
#
# Flags:
#   --base <branch>   Base branch for the new worktree (default: main → master).
#   --repo <path>     Target repo root. When set, all git operations run as
#                     `git -C <path>` and the worktree lives at
#                     `<path>/.worktrees/<dir-name>` (inside the target repo,
#                     NOT the invoking CWD). The flag is additive — omitting it
#                     preserves the single-repo behavior.
#
# Rules:
#   - <path> passed to --repo MUST be an existing git repo root.
#   - Composes with --base and --review unchanged.
#   - Single-repo usage (no --repo) is identical to before REQ-001.
# =============================================================================
set -euo pipefail

# ── colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "${CYAN}▶${RESET} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
die()  { printf "${RED}✗ ERROR:${RESET} %s\n" "$1" >&2; exit 1; }

# M3: reject unsafe characters in user-controlled args
reject_unsafe_chars() {
  # $1 = name, $2 = value
  case "$2" in
    *$'\n'*|*$'\r'*) die "invalid character (newline/CR) in ${1}";;
  esac
  case "$2" in
    *[$'\0']*) die "invalid character (NUL) in ${1}";;
  esac
}

# ── parse arguments ───────────────────────────────────────────────────────────
BRANCH_NAME=""
BASE_BRANCH=""
REPO_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      BASE_BRANCH="${2:?--base requires a value}"
      shift 2
      ;;
    --repo)
      REPO_PATH="${2:?--repo requires a value}"
      shift 2
      ;;
    --*)
      warn "Unknown flag: $1 (ignoring)"
      shift
      ;;
    *)
      if [ -z "$BRANCH_NAME" ]; then
        BRANCH_NAME="$1"
      else
        warn "Extra positional argument ignored: $1"
      fi
      shift
      ;;
  esac
done

[ -n "$BRANCH_NAME" ] || die "Usage: init.sh <branch-name> [--base <branch>] [--repo <path>]"

# M3: validate user-controlled string args for unsafe characters
reject_unsafe_chars "branch-name" "$BRANCH_NAME"
reject_unsafe_chars "base"        "${BASE_BRANCH:-}"
reject_unsafe_chars "repo"        "${REPO_PATH:-}"

# M3: validate branch name is a valid git ref
git check-ref-format --branch "$BRANCH_NAME" \
  >/dev/null 2>&1 \
  || die "invalid branch name: $BRANCH_NAME"

# M3: validate base branch as a git ref (if provided)
if [ -n "$BASE_BRANCH" ]; then
  git check-ref-format "refs/remotes/origin/${BASE_BRANCH}" \
    >/dev/null 2>&1 \
    || die "invalid base ref: $BASE_BRANCH"
fi

# ── determine target repo root ────────────────────────────────────────────────
if [ -n "$REPO_PATH" ]; then
  # M4: canonicalise --repo path before use
  REPO_PATH_REAL=$(realpath "$REPO_PATH" 2>/dev/null \
    || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$REPO_PATH")
  [ -n "$REPO_PATH_REAL" ] || die "cannot resolve --repo path: $REPO_PATH"
  REPO_PATH="$REPO_PATH_REAL"

  # --repo mode: validate that <path> is a git repo root
  git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1 \
    || die "--repo path is not a valid git repo: ${REPO_PATH}"
  TARGET_REPO="$REPO_PATH"
  log "Target repo: ${TARGET_REPO} (--repo flag)"
else
  # Standard mode: use the current working directory's repo root
  TARGET_REPO="$(git rev-parse --show-toplevel 2>/dev/null \
    || git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)"
  log "Target repo: ${TARGET_REPO} (CWD)"
fi

# ── resolve base branch ───────────────────────────────────────────────────────
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="main"
  git -C "$TARGET_REPO" rev-parse --verify "origin/${BASE_BRANCH}" >/dev/null 2>&1 \
    || BASE_BRANCH="master"
fi
log "Base branch: ${BASE_BRANCH}"

# ── fetch ─────────────────────────────────────────────────────────────────────
log "Fetching origin..."
git -C "$TARGET_REPO" fetch origin >/dev/null 2>&1 || warn "fetch failed (continuing)"

# ── ensure .worktrees/ dir and gitignore entry ────────────────────────────────
mkdir -p "${TARGET_REPO}/.worktrees"
grep -qxF '.worktrees/' "${TARGET_REPO}/.gitignore" 2>/dev/null \
  || printf '.worktrees/\n' >> "${TARGET_REPO}/.gitignore"

# ── compute worktree path ─────────────────────────────────────────────────────
DIR_NAME="$(printf '%s' "$BRANCH_NAME" | tr '/' '-')"
WORKTREE_PATH="${TARGET_REPO}/.worktrees/${DIR_NAME}"

# ── check if worktree already exists ─────────────────────────────────────────
if git -C "$TARGET_REPO" worktree list --porcelain | grep -q "^worktree ${WORKTREE_PATH}$"; then
  ok "Worktree already exists: ${WORKTREE_PATH}"
  printf "  Branch: %s\n" "$(git -C "${WORKTREE_PATH}" branch --show-current 2>/dev/null || echo '(unknown)')"
  exit 0
fi

# ── create worktree ───────────────────────────────────────────────────────────
log "Creating worktree at ${WORKTREE_PATH}..."
git -C "$TARGET_REPO" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/${BASE_BRANCH}"
ok "Worktree created: ${WORKTREE_PATH}"

# ── copy .claude/ config ──────────────────────────────────────────────────────
if [ -d "${TARGET_REPO}/.claude" ]; then
  cp -r "${TARGET_REPO}/.claude/" "${WORKTREE_PATH}/.claude/"
  ok "Copied .claude/ config into worktree"
fi

# ── verify ────────────────────────────────────────────────────────────────────
CURRENT_BRANCH="$(git -C "${WORKTREE_PATH}" branch --show-current 2>/dev/null || echo '(unknown)')"
ok "Branch: ${CURRENT_BRANCH}"

printf "\n${BOLD}Worktree created:${RESET}\n"
printf "  Path:   ${CYAN}%s${RESET}\n" "${WORKTREE_PATH}"
printf "  Branch: ${CYAN}%s${RESET}\n" "${CURRENT_BRANCH}"
printf "  Base:   ${CYAN}origin/%s${RESET}\n" "${BASE_BRANCH}"
if [ -n "$REPO_PATH" ]; then
  printf "  Repo:   ${CYAN}%s${RESET} (--repo mode)\n" "${TARGET_REPO}"
fi
printf "\nTo work in this worktree, operate on files at: %s\n" "${WORKTREE_PATH}"
