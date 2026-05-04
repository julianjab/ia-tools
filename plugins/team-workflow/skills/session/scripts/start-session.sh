#!/usr/bin/env bash
# =============================================================================
# start-session.sh — Spawn a Claude sub-session as the orchestrator agent.
#
# Opens a fresh tmux session (name = session-name) and launches Claude with
# `--agent team-workflow:orchestrator`. Runtime context is passed via env
# vars (SESSION_NAME, REQUEST, SLACK_THREADS, SLACK_CHANNEL). The orchestrator
# creates its own worktree on boot — this script does NOT touch git.
#
# Usage:
#   bash start-session.sh <session-name> <slack-ts|""> <slack-channel|""> <request>
#
# Positional args:
#   $1  session-name   Label for the session; also the tmux session name.
#                      Must not contain '.' or ':' (breaks tmux target syntax).
#   $2  slack-ts       Slack thread timestamp. Empty string = local mode.
#   $3  slack-channel  Slack channel id.       Empty string = local mode.
#   $4  request        User's raw request. Typed as the first message to the
#                      orchestrator after Claude boots.
#
# Mode detection:
#   slack-ts + slack-channel both non-empty → slack mode
#   both empty                              → local mode
#   exactly one set                         → error
# =============================================================================
set -euo pipefail

# ── colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "${CYAN}▶${RESET} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
die()  { printf "${RED}✗ ERROR:${RESET} %s\n" "$1" >&2; exit 1; }

# ── args ──────────────────────────────────────────────────────────────────────
SESSION_NAME="${1:?Usage: start-session.sh <session-name> <slack-ts|\"\"> <slack-channel|\"\"> <request>}"
SLACK_TS="${2:-}"
SLACK_CHANNEL_ARG="${3:-}"
REQUEST="${4:-}"

# ── validation ────────────────────────────────────────────────────────────────
reject_unsafe() {
  # NUL cannot appear in a bash argv (execve strips it), so only CR/LF matter.
  case "$2" in
    *$'\n'*|*$'\r'*) die "invalid character (newline or CR) in ${1}" ;;
  esac
}
reject_unsafe "session-name"  "$SESSION_NAME"
reject_unsafe "slack-ts"      "$SLACK_TS"
reject_unsafe "slack-channel" "$SLACK_CHANNEL_ARG"
reject_unsafe "request"       "$REQUEST"

[ -n "$SESSION_NAME" ] || die "session-name cannot be empty"

case "$SESSION_NAME" in
  *.*|*:*) die "session-name must not contain '.' or ':' (got: ${SESSION_NAME})" ;;
esac

if [ -n "$SLACK_TS" ] && [ -n "$SLACK_CHANNEL_ARG" ]; then
  MODE="slack"
elif [ -z "$SLACK_TS" ] && [ -z "$SLACK_CHANNEL_ARG" ]; then
  MODE="local"
else
  die "slack-ts and slack-channel must both be set or both be empty"
fi

printf "\n${BOLD}/session — Spawning sub-session${RESET}\n"
printf "────────────────────────────────────────────────\n"
printf "  Session: ${CYAN}%s${RESET}\n" "$SESSION_NAME"
printf "  Mode:    ${CYAN}%s${RESET}\n" "$MODE"
if [ "$MODE" = "slack" ]; then
  printf "  Thread:  ${CYAN}%s${RESET}\n" "$SLACK_TS"
  printf "  Channel: ${CYAN}%s${RESET}\n" "$SLACK_CHANNEL_ARG"
fi
printf "  Request: ${CYAN}%s${RESET}\n\n" "$REQUEST"

# ── dependencies ──────────────────────────────────────────────────────────────
log "Checking dependencies..."
command -v tmux >/dev/null 2>&1 || die "tmux not installed"
if ! command -v claude >/dev/null 2>&1; then
  for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/usr/local/bin/claude"; do
    [ -x "$p" ] && { export PATH="$(dirname "$p"):$PATH"; break; }
  done
fi
command -v claude >/dev/null 2>&1 || die "claude CLI not found (checked PATH and ~/.claude/local/)"
ok "tmux + claude OK"

# ── env prefix for inline claude CLI ──────────────────────────────────────────
# All runtime context rides on env vars. The role is set via --agent flag.
sq_escape() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
SESSION_NAME_ESC=$(sq_escape "$SESSION_NAME")
REQUEST_ESC=$(sq_escape "$REQUEST")
SLACK_TS_ESC=$(sq_escape "$SLACK_TS")
SLACK_CHANNEL_ESC=$(sq_escape "$SLACK_CHANNEL_ARG")

ENV_PREFIX="CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
ENV_PREFIX="${ENV_PREFIX} SESSION_NAME='${SESSION_NAME_ESC}'"
ENV_PREFIX="${ENV_PREFIX} REQUEST='${REQUEST_ESC}'"
if [ "$MODE" = "slack" ]; then
  ENV_PREFIX="${ENV_PREFIX} SLACK_THREADS='${SLACK_TS_ESC}'"
  ENV_PREFIX="${ENV_PREFIX} SLACK_CHANNEL='${SLACK_CHANNEL_ESC}'"
fi

AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
if [ -n "$AGENT_TOKEN" ]; then
  ENV_PREFIX="CLAUDE_CODE_OAUTH_TOKEN=${AGENT_TOKEN} ${ENV_PREFIX}"
  ok "OAuth token resolved"
fi

CLAUDE_CMD="${ENV_PREFIX} claude --agent team-workflow:orchestrator --dangerously-skip-permissions --teammateMode split-pane"

# ── tmux session ──────────────────────────────────────────────────────────────
# One tmux session per sub-session. Session name = SESSION_NAME.
# CWD = caller's cwd (typically the consumer repo root). The orchestrator
# creates its own worktree once booted.
CWD="$(pwd)"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  warn "tmux session '${SESSION_NAME}' already exists — reusing"
else
  tmux new-session -d -s "$SESSION_NAME" -c "$CWD"
  ok "tmux session '${SESSION_NAME}' created (CWD=${CWD})"
fi

# ── launch claude + send request ──────────────────────────────────────────────
log "Launching Claude as orchestrator..."
tmux send-keys -t "$SESSION_NAME" "$CLAUDE_CMD" Enter
sleep 2
tmux send-keys -t "$SESSION_NAME" "$REQUEST"
sleep 2
tmux send-keys -t "$SESSION_NAME" Enter

# ── report ────────────────────────────────────────────────────────────────────
printf "\n"
ok "Sub-session started"
printf "\n${BOLD}Summary:${RESET}\n"
printf "  Session: ${CYAN}%s${RESET}\n" "$SESSION_NAME"
printf "  Mode:    ${CYAN}%s${RESET}\n" "$MODE"
printf "  CWD:     ${CYAN}%s${RESET}\n" "$CWD"
if [ "$MODE" = "slack" ]; then
  printf "  Slack:   thread=${CYAN}%s${RESET} channel=${CYAN}%s${RESET}\n" "$SLACK_TS" "$SLACK_CHANNEL_ARG"
fi
printf "\nAttach with: ${BOLD}tmux attach -t %s${RESET}\n" "$SESSION_NAME"
