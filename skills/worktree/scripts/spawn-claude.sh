#!/usr/bin/env zsh
# =============================================================================
# spawn-claude.sh — Open a Claude Code session in tmux inside a worktree,
#                   optionally subscribed to a Slack thread.
#
# Usage:
#   zsh spawn-claude.sh <worktree-path> <session-name> <window-name> \
#                       [slack-thread-ts] [slack-channel-id] [branch-name]
#
# Examples:
#   zsh spawn-claude.sh /repo/.worktrees/feat-my-task feat-my-task feat-my-task
#   zsh spawn-claude.sh /repo/.worktrees/feat-my-task dev feat-my-task \
#       1234567890.123456 C07815S0XNX feat/my-task
# =============================================================================
set -e

WORKTREE_PATH="${1:?Usage: spawn-claude.sh <worktree-path> <session> <window> [thread-ts] [channel-id] [branch]}"
SESSION="${2:?Missing session name}"
WINDOW="${3:?Missing window name}"
SLACK_THREAD_TS="${4:-}"
SLACK_CHANNEL_ID="${5:-}"
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
[ -n "$SLACK_THREAD_TS" ] && echo -e "  Slack:   ${CYAN}thread=${SLACK_THREAD_TS} channel=${SLACK_CHANNEL_ID}${RESET}"
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

# ── 2. Validate worktree path ─────────────────────────────────────────────────
[ -d "$WORKTREE_PATH" ] || die "Worktree not found at: $WORKTREE_PATH — run /worktree init first"
ok "Worktree exists: $WORKTREE_PATH"

# ── 3. Validate Slack args consistency ───────────────────────────────────────
if [ -n "$SLACK_THREAD_TS" ] && [ -z "$SLACK_CHANNEL_ID" ]; then
  die "--slack-thread requires --channel (Slack channel ID)"
fi

# ── 4. Resolve OAuth token ────────────────────────────────────────────────────
AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"

if [ -n "$AGENT_TOKEN" ]; then
  CLAUDE_BASE="CLAUDE_CODE_OAUTH_TOKEN=$AGENT_TOKEN claude --dangerously-skip-permissions"
  ok "OAuth token resolved (separate rate-limit pool)"
else
  CLAUDE_BASE="claude --dangerously-skip-permissions"
  warn "No CLAUDE_TEAM_OAUTH_TOKEN — using main account (rate-limit risk under heavy load)"
fi

# ── 5. Build full launch command with optional Slack env vars ─────────────────
if [ -n "$SLACK_THREAD_TS" ]; then
  CLAUDE_CMD="SLACK_THREAD_TS=$SLACK_THREAD_TS SLACK_CHANNELS=$SLACK_CHANNEL_ID $CLAUDE_BASE"
else
  CLAUDE_CMD="$CLAUDE_BASE"
fi

# ── 6. Create or reuse tmux session ──────────────────────────────────────────
log "Setting up tmux..."
if tmux has-session -t "$SESSION" 2>/dev/null; then
  warn "Session '$SESSION' already exists — adding new window '$WINDOW'"
  tmux new-window -t "$SESSION" -n "$WINDOW" -c "$WORKTREE_PATH"
else
  tmux new-session -d -s "$SESSION" -n "$WINDOW" -c "$WORKTREE_PATH"
  ok "Session '$SESSION' created"
fi

# ── 7. Launch Claude in the tmux window ──────────────────────────────────────
log "Launching Claude..."
tmux send-keys -t "${SESSION}:${WINDOW}" "$CLAUDE_CMD" Enter

# ── 8. Send boot prompt after Claude initializes ─────────────────────────────
sleep 1

if [ -n "$SLACK_THREAD_TS" ]; then
  BOOT_PROMPT="You are a Claude Code agent working on branch ${BRANCH_NAME} inside worktree ${WORKTREE_PATH}. First, call subscribe_slack with threads=[\"${SLACK_THREAD_TS}\"], channels=[\"${SLACK_CHANNEL_ID}\"], label=\"task: ${BRANCH_NAME}\". Then wait — do NOT act until you receive a Slack message in this thread. When a message arrives, read it, plan your work, and execute it. Use /commit for checkpoints. Reply to the thread with reply_slack to report progress."
else
  BOOT_PROMPT="You are a Claude Code agent working on branch ${BRANCH_NAME} inside worktree ${WORKTREE_PATH}. Read CLAUDE.md to understand the project context. Then wait for tasks — they will arrive via the main Claude session or by a user message here. Use /commit for checkpoints. Do NOT start work until you receive a task."
fi

tmux send-keys -t "${SESSION}:${WINDOW}" "$BOOT_PROMPT" Enter

# ── 9. Report ─────────────────────────────────────────────────────────────────
echo ""
ok "Session ready"
echo -e "\n${BOLD}Worktree session spawned:${RESET}"
echo -e "  Branch:  ${CYAN}${BRANCH_NAME}${RESET}"
echo -e "  Path:    ${CYAN}${WORKTREE_PATH}${RESET}"
echo -e "  tmux:    session=${CYAN}${SESSION}${RESET}  window=${CYAN}${WINDOW}${RESET}"
if [ -n "$SLACK_THREAD_TS" ]; then
  echo -e "  Slack:   subscribed → thread=${CYAN}${SLACK_THREAD_TS}${RESET} channel=${CYAN}${SLACK_CHANNEL_ID}${RESET}"
else
  echo -e "  Slack:   not connected (no --slack-thread provided)"
fi
echo ""
echo -e "Attach with:  ${BOLD}tmux attach -t ${SESSION}${RESET}"
