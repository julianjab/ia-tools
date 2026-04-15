#!/usr/bin/env bash
# =============================================================================
# start-task.sh — Open a full task sub-session.
#
# Called by the /task skill, which is called by the triage main session when
# it classifies a Slack message as a `change` intent.
#
# Responsibilities:
#   1. Ensure the git worktree exists (delegates to /worktree init)
#   2. Seed .sdlc/tasks.md with a minimal stub
#   3. Open (or reuse) a tmux session and create a window in the worktree
#   4. Launch `claude` inside the window with SLACK_* env vars + orchestrator
#      role hint, so the SessionStart hook injects the orchestrator system prompt
#   5. Send the boot prompt to the new Claude instance
#
# Usage:
#   bash start-task.sh <branch-name> <slack-thread-ts> <slack-channel-id> \
#                      <description-or-review-flag>
#
# Examples:
#   bash start-task.sh feat/google-login 1728591234.001 C07815S0XNX \
#        "arregla el login de Google"
#
#   bash start-task.sh review/pr-42 1728591234.001 C07815S0XNX --review=42
# =============================================================================
set -euo pipefail

BRANCH_NAME="${1:?Usage: start-task.sh <branch-name> <thread-ts> <channel-id> <description-or-review>}"
SLACK_THREAD_TS="${2:?Missing --thread (required)}"
SLACK_CHANNEL_ID="${3:?Missing --channel (required)}"
DESCRIPTION_OR_REVIEW="${4:-}"

# ── colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "${CYAN}▶${RESET} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
die()  { printf "${RED}✗ ERROR:${RESET} %s\n" "$1" >&2; exit 1; }

printf "\n${BOLD}/task — Opening sub-session${RESET}\n"
printf "────────────────────────────────────────────────\n"
printf "  Branch:  ${CYAN}%s${RESET}\n" "$BRANCH_NAME"
printf "  Thread:  ${CYAN}%s${RESET}\n" "$SLACK_THREAD_TS"
printf "  Channel: ${CYAN}%s${RESET}\n" "$SLACK_CHANNEL_ID"
printf "  Input:   ${CYAN}%s${RESET}\n\n" "$DESCRIPTION_OR_REVIEW"

# ── 1. Validate dependencies ─────────────────────────────────────────────────
log "Checking dependencies..."
command -v tmux >/dev/null 2>&1 || die "tmux not installed — install via your package manager"
command -v git  >/dev/null 2>&1 || die "git not available"

if ! command -v claude >/dev/null 2>&1; then
  for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/usr/local/bin/claude"; do
    if [ -x "$p" ]; then export PATH="$(dirname "$p"):$PATH"; break; fi
  done
fi
command -v claude >/dev/null 2>&1 || die "claude CLI not found (checked PATH and ~/.claude/local/)"
ok "tmux + git + claude OK"

# ── 2. Resolve repo root and worktree path ───────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR_NAME="$(printf '%s' "$BRANCH_NAME" | tr '/' '-')"
WORKTREE_PATH="${REPO_ROOT}/.worktrees/${DIR_NAME}"

# ── 3. Create worktree if it doesn't exist ───────────────────────────────────
if git -C "$REPO_ROOT" worktree list --porcelain | grep -q "^worktree ${WORKTREE_PATH}$"; then
  ok "Worktree already exists: $WORKTREE_PATH"
else
  log "Creating worktree..."
  git -C "$REPO_ROOT" fetch origin >/dev/null 2>&1 || warn "fetch failed (continuing)"

  BASE_BRANCH="main"
  git -C "$REPO_ROOT" rev-parse --verify "origin/${BASE_BRANCH}" >/dev/null 2>&1 \
    || BASE_BRANCH="master"

  mkdir -p "${REPO_ROOT}/.worktrees"
  grep -qxF '.worktrees/' "${REPO_ROOT}/.gitignore" 2>/dev/null \
    || echo '.worktrees/' >> "${REPO_ROOT}/.gitignore"

  # --review mode creates the branch from the PR ref
  if [[ "$DESCRIPTION_OR_REVIEW" == --review=* ]]; then
    PR_NUMBER="${DESCRIPTION_OR_REVIEW#--review=}"
    git -C "$REPO_ROOT" fetch origin "pull/${PR_NUMBER}/head:${BRANCH_NAME}" >/dev/null 2>&1 \
      || die "failed to fetch PR #${PR_NUMBER}"
    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
  else
    git -C "$REPO_ROOT" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/${BASE_BRANCH}"
  fi

  # Copy .claude/ so the sub-session has the same hooks/skills/config
  if [ -d "${REPO_ROOT}/.claude" ] && [ ! -d "${WORKTREE_PATH}/.claude" ]; then
    cp -r "${REPO_ROOT}/.claude" "${WORKTREE_PATH}/.claude"
  fi

  ok "Worktree created: $WORKTREE_PATH"
fi

# ── 4. Seed .sdlc/tasks.md ───────────────────────────────────────────────────
TASKS_FILE="${WORKTREE_PATH}/.sdlc/tasks.md"
if [ ! -s "$TASKS_FILE" ]; then
  mkdir -p "${WORKTREE_PATH}/.sdlc"
  CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  REQUEST_TEXT="$DESCRIPTION_OR_REVIEW"
  [[ "$REQUEST_TEXT" == --review=* ]] && REQUEST_TEXT="Review PR #${REQUEST_TEXT#--review=}"

  cat > "$TASKS_FILE" <<EOF
# Task: ${BRANCH_NAME}

**Slack thread**: ${SLACK_CHANNEL_ID}/${SLACK_THREAD_TS}
**Created**: ${CREATED_AT}
**Status**: PENDING_PLAN

## Request

${REQUEST_TEXT}

## Plan

_(The orchestrator fills this in during Phase 1 and publishes it to
the Slack thread for approval.)_
EOF
  ok "Seeded .sdlc/tasks.md"
else
  ok ".sdlc/tasks.md already exists"
fi

# ── 5. Resolve OAuth token ───────────────────────────────────────────────────
AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
if [ -n "$AGENT_TOKEN" ]; then
  TOKEN_ENV="CLAUDE_CODE_OAUTH_TOKEN=${AGENT_TOKEN}"
  ok "OAuth token resolved"
else
  TOKEN_ENV=""
  warn "No CLAUDE_TEAM_OAUTH_TOKEN — using default auth"
fi

# ── 6. Build the Claude launch command ───────────────────────────────────────
# IA_TOOLS_ROLE=orchestrator is read by hooks/scripts/session-start.sh to
# inject the orchestrator system prompt. Without this env var, the SessionStart
# hook defaults to triage (main session behavior).
CLAUDE_ENV="IA_TOOLS_ROLE=orchestrator SLACK_THREAD_TS=${SLACK_THREAD_TS} SLACK_CHANNELS=${SLACK_CHANNEL_ID}"
if [ -n "$TOKEN_ENV" ]; then
  CLAUDE_ENV="${CLAUDE_ENV} ${TOKEN_ENV}"
fi
CLAUDE_CMD="${CLAUDE_ENV} claude --dangerously-skip-permissions"

# ── 7. tmux session / window ─────────────────────────────────────────────────
SESSION="${TMUX_SESSION_NAME:-ia-tools}"
WINDOW="$DIR_NAME"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  if tmux list-windows -t "$SESSION" -F '#W' | grep -qx "$WINDOW"; then
    warn "Window '$WINDOW' already exists in session '$SESSION' — reusing"
  else
    tmux new-window -t "$SESSION" -n "$WINDOW" -c "$WORKTREE_PATH"
    ok "Window '$WINDOW' created in existing session '$SESSION'"
  fi
else
  tmux new-session -d -s "$SESSION" -n "$WINDOW" -c "$WORKTREE_PATH"
  ok "Session '$SESSION' + window '$WINDOW' created"
fi

# ── 8. Launch Claude ─────────────────────────────────────────────────────────
log "Launching Claude in the window..."
tmux send-keys -t "${SESSION}:${WINDOW}" "$CLAUDE_CMD" Enter

# ── 9. Send boot prompt ──────────────────────────────────────────────────────
sleep 1

BOOT_PROMPT="You are the orchestrator of task ${BRANCH_NAME}. Your Slack thread: ts=${SLACK_THREAD_TS} channel=${SLACK_CHANNEL_ID}. Your worktree: ${WORKTREE_PATH}. Read .sdlc/tasks.md first, then follow the pipeline in agents/orchestrator.md starting from the boot sequence. Phase 1 is your first action: build and publish the plan, then BLOCK on the approval gate until you see a ✅ reaction."

tmux send-keys -t "${SESSION}:${WINDOW}" "$BOOT_PROMPT" Enter

# ── 10. Report ───────────────────────────────────────────────────────────────
printf "\n"
ok "Sub-session started"
printf "\n${BOLD}Sub-session summary:${RESET}\n"
printf "  Branch:   ${CYAN}%s${RESET}\n" "$BRANCH_NAME"
printf "  Worktree: ${CYAN}%s${RESET}\n" "$WORKTREE_PATH"
printf "  tmux:     session=${CYAN}%s${RESET} window=${CYAN}%s${RESET}\n" "$SESSION" "$WINDOW"
printf "  Slack:    thread=${CYAN}%s${RESET} channel=${CYAN}%s${RESET}\n" "$SLACK_THREAD_TS" "$SLACK_CHANNEL_ID"
printf "\nAttach with: ${BOLD}tmux attach -t %s${RESET}\n" "$SESSION"
