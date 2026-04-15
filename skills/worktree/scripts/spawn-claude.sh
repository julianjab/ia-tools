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

CLAUDE_BIN=""
if command -v claude &>/dev/null; then
  CLAUDE_BIN="$(command -v claude)"
else
  for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/usr/local/bin/claude"; do
    [ -x "$p" ] && { CLAUDE_BIN="$p"; break; }
  done
fi
[ -n "$CLAUDE_BIN" ] || die "claude CLI not found (checked PATH and ~/.claude/local/)"
ok "tmux + claude OK ($CLAUDE_BIN)"

# ── 2. Validate worktree ──────────────────────────────────────────────────────
[ -d "$WORKTREE_PATH" ] || die "Worktree not found at: $WORKTREE_PATH — run /worktree init first"
ok "Worktree exists: $WORKTREE_PATH"

# ── 3. Validate task list ─────────────────────────────────────────────────────
TASKS_FILE="${WORKTREE_PATH}/.sdlc/tasks.md"
if [ ! -s "$TASKS_FILE" ]; then
  die "No task list found at .sdlc/tasks.md — the Orchestrator must define tasks before spawning"
fi
ok "Task list found: .sdlc/tasks.md"

# ── 3b. Seed .sdlc/scope.json with the primary worktree ──────────────────────
# Dynamic allow-list consumed by hooks/scripts/enforce-worktree.sh. The
# Orchestrator appends additional absolute paths here when the engineer
# declares multi-repo scope, then runs /add-dir at runtime for each one.
SCOPE_FILE="${WORKTREE_PATH}/.sdlc/scope.json"
WORKTREE_ABS=$(cd "$WORKTREE_PATH" && pwd -P)
if [ ! -s "$SCOPE_FILE" ]; then
  cat > "$SCOPE_FILE" <<JSON
{
  "primary": "${WORKTREE_ABS}",
  "worktrees": ["${WORKTREE_ABS}"]
}
JSON
  ok "Seeded .sdlc/scope.json with primary worktree"
else
  ok "scope.json already present — preserving declared scope"
fi

# ── 4. Resolve main repo root (needed for .claude/ copy + --plugin-dir) ──────
# For a linked worktree, --git-common-dir returns the main repo's .git path;
# for the main checkout it returns .git in the main repo. Parent in both cases
# is the primary working tree — which is what we want for plugin loading.
GIT_COMMON_DIR=$(git -C "$WORKTREE_PATH" rev-parse --path-format=absolute --git-common-dir)
REPO_ROOT=$(dirname "$GIT_COMMON_DIR")
ok "Main repo root: $REPO_ROOT"

log "Syncing .claude/ config..."
if [ -d "${REPO_ROOT}/.claude" ] && [ ! -d "${WORKTREE_PATH}/.claude" ]; then
  cp -r "${REPO_ROOT}/.claude/" "${WORKTREE_PATH}/.claude/"
  ok ".claude/ copied from root"
elif [ -d "${WORKTREE_PATH}/.claude" ]; then
  ok ".claude/ already present in worktree"
else
  mkdir -p "${WORKTREE_PATH}/.claude"
  warn "No .claude/ in root — created empty one in worktree"
fi

# Write a local settings override that disables the full plugin_slack_slack
# plugin in the spawned session. The spawned Orchestrator only needs the
# slack-bridge MCP (claim/reply/subscribe) — the full Slack plugin (search,
# canvases, users, DMs) is noise and enlarges the prompt-injection blast
# radius under --dangerously-load-development-channels.
SETTINGS_LOCAL="${WORKTREE_PATH}/.claude/settings.local.json"
log "Writing settings.local.json (disabling plugin_slack_slack)..."
cat > "$SETTINGS_LOCAL" <<'JSON'
{
  "disabledMcpjsonServers": ["plugin_slack_slack"],
  "disabledPlugins": ["slack"]
}
JSON
ok "Disabled plugin_slack_slack for this worktree"

# ── 5. Resolve OAuth token ────────────────────────────────────────────────────
AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"

CLAUDE_FLAGS="--dangerously-skip-permissions --plugin-dir ${REPO_ROOT} --dangerously-load-development-channels server:slack-bridge"

# IA_TOOLS_WORKTREE_BOUNDARY is read by hooks/scripts/enforce-worktree.sh to
# reject Edit/Write/MultiEdit on paths outside this worktree. Belt-and-
# suspenders on top of the cwd set by tmux new-window -c.
BOUNDARY="IA_TOOLS_WORKTREE_BOUNDARY=${WORKTREE_PATH}"

if [ -n "$AGENT_TOKEN" ]; then
  CLAUDE_BASE="${BOUNDARY} CLAUDE_CODE_OAUTH_TOKEN=$AGENT_TOKEN $CLAUDE_BIN $CLAUDE_FLAGS"
  ok "OAuth token resolved (separate rate-limit pool)"
else
  CLAUDE_BASE="${BOUNDARY} $CLAUDE_BIN $CLAUDE_FLAGS"
  warn "No CLAUDE_TEAM_OAUTH_TOKEN — using main account (rate-limit risk under heavy load)"
fi
ok "Plugin dir: $REPO_ROOT (with slack-bridge dev channel)"
ok "Worktree boundary: $WORKTREE_PATH (enforced by hook)"

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
# Claude Code with --dangerously-load-development-channels shows a confirmation
# modal on first launch. Flow:
#   1) wait for TUI to initialize
#   2) press Enter once to accept the dev-channel permissions modal
#   3) wait for the prompt box to be ready
#   4) type the boot prompt and press Enter to submit
sleep 5
log "Accepting dev-channel permissions modal..."
tmux send-keys -t "${SESSION}:${WINDOW}" Enter
sleep 2

BOOT_PROMPT="You are running as the Orchestrator agent defined in agents/orchestrator.md. Your scope is restricted to the worktrees listed in .sdlc/scope.json — initially just this one at ${WORKTREE_PATH}. Any edit outside that allow-list is rejected by the enforce-worktree hook. Your branch is ${BRANCH_NAME}. Step 1: subscribe to the Slack thread anchor via slack-bridge MCP (the full plugin_slack_slack is disabled here): subscribe_slack(threads=[\"${SLACK_THREAD_TS}\"], channels=[\"${SLACK_CHANNEL_ID}\"], label=\"task: ${BRANCH_NAME}\"). Step 2: read .sdlc/tasks.md (raw intake + Phase 0 placeholder) and .sdlc/scope.json (current allow-list). Step 3: ask up to 3 clarifying questions in the same thread. If the request could touch more than one repo, ALWAYS ask explicitly which repos are in scope — default is single-repo. Step 4: for each extra repo the engineer declares, run /worktree init feat/${BRANCH_NAME#feat/} inside that repo, append the resulting absolute path to .sdlc/scope.json's 'worktrees' array, then use the native /add-dir <path> command to expose it to this session. Step 5: rewrite .sdlc/tasks.md with the finalized task list and run the pipeline (Issue Refiner if complex → spec → QA RED → leads GREEN → security → /pr). ALL replies go to thread_ts=${SLACK_THREAD_TS} in channel ${SLACK_CHANNEL_ID}; never reply top-level. Report only at phase boundaries."

log "Sending boot prompt..."
tmux send-keys -t "${SESSION}:${WINDOW}" "$BOOT_PROMPT"
sleep 1
tmux send-keys -t "${SESSION}:${WINDOW}" Enter

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
