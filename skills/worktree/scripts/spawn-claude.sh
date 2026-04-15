#!/usr/bin/env zsh
# =============================================================================
# spawn-claude.sh — Open a Claude Code session in tmux inside a worktree,
#                   subscribed to a Slack thread.
#
# Requires a defined task list (.sdlc/tasks.md) and a Slack thread to link to.
# Called by /worktree spawn after the Orchestrator has announced the task in Slack.
#
# Usage:
#   zsh spawn-claude.sh <worktree-path> <session-name> <window-name> \
#                       <slack-thread-ts> <slack-channel-id> <branch-name>
#
# Example:
#   zsh spawn-claude.sh /repo/.worktrees/feat-my-task dev feat-my-task \
#       1234567890.123456 C07815S0XNX feat/my-task
# =============================================================================
set -e

WORKTREE_PATH="${1:?Usage: spawn-claude.sh <worktree-path> <session> <window> <thread-ts> <channel-id> <branch>}"
SESSION="${2:?Missing session name}"
WINDOW="${3:?Missing window name}"
SLACK_THREAD_TS="${4:?Missing --slack-thread (required for spawn)}"
SLACK_CHANNEL_ID="${5:?Missing --channel (required for spawn)}"
BRANCH_NAME="${6:-$WINDOW}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${CYAN}▶${RESET} $1"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
die()  { echo -e "${RED}✗ ERROR:${RESET} $1" >&2; exit 1; }

echo -e "\n${BOLD}Claude Code — Worktree Session${RESET}"
echo "────────────────────────────────────────────────"
echo -e "  Branch:  ${CYAN}${BRANCH_NAME}${RESET}"
echo -e "  Path:    ${CYAN}${WORKTREE_PATH}${RESET}"
echo -e "  Session: ${CYAN}${SESSION}${RESET} / window: ${CYAN}${WINDOW}${RESET}"
echo -e "  Slack:   ${CYAN}thread=${SLACK_THREAD_TS} channel=${SLACK_CHANNEL_ID}${RESET}"
echo ""

# ── 1. Validate dependencies ──────────────────────────────────────────────────
log "Checking dependencies..."
command -v tmux &>/dev/null || die "tmux not installed — brew install tmux"

if ! command -v claude &>/dev/null; then
  for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/usr/local/bin/claude"; do
    [ -x "$p" ] && { export PATH="$(dirname $p):$PATH"; break; }
  done
fi
command -v claude &>/dev/null || die "claude CLI not found (checked PATH and ~/.claude/local/)"
ok "tmux + claude OK"

# ── 2. Validate worktree ──────────────────────────────────────────────────────
[ -d "$WORKTREE_PATH" ] || die "Worktree not found at: $WORKTREE_PATH — run /worktree init first"
ok "Worktree exists: $WORKTREE_PATH"

# ── 3. Validate task list ─────────────────────────────────────────────────────
TASKS_FILE="${WORKTREE_PATH}/.sdlc/tasks.md"
if [ ! -s "$TASKS_FILE" ]; then
  die "No task list found at .sdlc/tasks.md — the Orchestrator must define tasks before spawning"
fi
ok "Task list found: .sdlc/tasks.md"

# ── 4. Ensure .claude/ is in the worktree ────────────────────────────────────
log "Syncing .claude/ config..."
REPO_ROOT=$(git -C "$WORKTREE_PATH" rev-parse --show-toplevel 2>/dev/null || \
            git -C "$(dirname "$WORKTREE_PATH")" rev-parse --show-toplevel)
if [ -d "${REPO_ROOT}/.claude" ] && [ ! -d "${WORKTREE_PATH}/.claude" ]; then
  cp -r "${REPO_ROOT}/.claude/" "${WORKTREE_PATH}/.claude/"
  ok ".claude/ copied from root"
elif [ -d "${WORKTREE_PATH}/.claude" ]; then
  ok ".claude/ already present in worktree"
else
  warn "No .claude/ found in root — skipping copy"
fi

# ── 5. Resolve OAuth token ────────────────────────────────────────────────────
AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"

if [ -n "$AGENT_TOKEN" ]; then
  CLAUDE_BASE="CLAUDE_CODE_OAUTH_TOKEN=$AGENT_TOKEN claude --dangerously-skip-permissions"
  ok "OAuth token resolved (separate rate-limit pool)"
else
  CLAUDE_BASE="claude --dangerously-skip-permissions"
  warn "No CLAUDE_TEAM_OAUTH_TOKEN — using main account (rate-limit risk under heavy load)"
fi

# ── 6. Build launch command with Slack env vars ───────────────────────────────
CLAUDE_CMD="SLACK_THREAD_TS=${SLACK_THREAD_TS} SLACK_CHANNELS=${SLACK_CHANNEL_ID} ${CLAUDE_BASE}"

# ── 7. Create or reuse tmux session ──────────────────────────────────────────
log "Setting up tmux..."
if tmux has-session -t "$SESSION" 2>/dev/null; then
  warn "Session '$SESSION' already exists — adding new window '$WINDOW'"
  tmux new-window -t "$SESSION" -n "$WINDOW" -c "$WORKTREE_PATH"
else
  tmux new-session -d -s "$SESSION" -n "$WINDOW" -c "$WORKTREE_PATH"
  ok "Session '$SESSION' created"
fi

# ── 8. Launch Claude ──────────────────────────────────────────────────────────
log "Launching Claude..."
tmux send-keys -t "${SESSION}:${WINDOW}" "$CLAUDE_CMD" Enter

# ── 9. Send boot prompt ───────────────────────────────────────────────────────
sleep 1

BOOT_PROMPT="You are a Claude Code agent working on branch ${BRANCH_NAME} inside worktree ${WORKTREE_PATH}. Read .sdlc/tasks.md to get your task list. Then subscribe to the Slack thread where this task was announced: subscribe_slack(threads=[\"${SLACK_THREAD_TS}\"], channels=[\"${SLACK_CHANNEL_ID}\"], label=\"task: ${BRANCH_NAME}\"). Begin the first pending task immediately. Report progress and blockers via reply_slack. Use /commit for checkpoints. Follow the pipeline in CLAUDE.md."

tmux send-keys -t "${SESSION}:${WINDOW}" "$BOOT_PROMPT" Enter

# ── 10. Report ────────────────────────────────────────────────────────────────
echo ""
ok "Session ready"
echo -e "\n${BOLD}Worktree session spawned:${RESET}"
echo -e "  Branch:  ${CYAN}${BRANCH_NAME}${RESET}"
echo -e "  Path:    ${CYAN}${WORKTREE_PATH}${RESET}"
echo -e "  tmux:    session=${CYAN}${SESSION}${RESET}  window=${CYAN}${WINDOW}${RESET}"
echo -e "  Slack:   thread=${CYAN}${SLACK_THREAD_TS}${RESET}  channel=${CYAN}${SLACK_CHANNEL_ID}${RESET}"
echo -e "  Tasks:   loaded from .sdlc/tasks.md"
echo ""
echo -e "Attach with:  ${BOLD}tmux attach -t ${SESSION}${RESET}"
