#!/usr/bin/env bash
# =============================================================================
# start-session.sh — Spawn a Claude sub-session as the orchestrator agent.
#
# Opens a fresh tmux session (name = session-name) and launches Claude with
# `--agent team-workflow:orchestrator`. Runtime context is passed via env
# vars (SESSION_NAME, SLACK_THREADS, SLACK_CHANNEL); the user's request is
# passed as the prompt POSITIONAL ARG to claude — never via shell parsing.
# The orchestrator creates its own worktree on boot — this script does NOT
# touch git.
#
# Usage:
#   bash start-session.sh <session-name> <slack-ts|""> <slack-channel|""> <request>
#
# Positional args:
#   $1  session-name   Label for the session; also the tmux session name.
#                      Must not contain '.' or ':' (breaks tmux target syntax).
#   $2  slack-ts       Slack thread timestamp. Empty string = local mode.
#   $3  slack-channel  Slack channel id.       Empty string = local mode.
#   $4  request        User's raw request. Passed as the prompt argument to
#                      claude (positional, NOT via shell — survives any
#                      quoting, backticks, $-vars, ampersands, semicolons,
#                      parentheses, long text).
#
# Mode detection:
#   slack-ts + slack-channel both non-empty → slack mode
#   both empty                              → local mode
#   exactly one set                         → error
# =============================================================================
set -euo pipefail

# ── colors / log helpers ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "${CYAN}▶${RESET} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
die()  { printf "${RED}✗ ERROR:${RESET} %s\n" "$1" >&2; exit 1; }

# ── globals populated by parse_args / detect_mode / build_* ───────────────────
SESSION_NAME=""
SLACK_TS=""
SLACK_CHANNEL_ARG=""
REQUEST=""
MODE=""
CWD=""
ENV_ARGS=()      # K=V pairs for env(1)
CLAUDE_ARGV=()   # full argv for tmux to exec after `--`

# _reject_unsafe — bail out if a value contains CR/LF (NUL is stripped by execve).
# input:  $1 label, $2 value
# output: exits via die() on bad input
_reject_unsafe() {
  case "$2" in
    *$'\n'*|*$'\r'*) die "invalid character (newline or CR) in ${1}" ;;
  esac
}

# parse_args — validate positional args, populate the SESSION_NAME/SLACK_*/REQUEST globals.
# input:  "$@" from main
# output: SESSION_NAME, SLACK_TS, SLACK_CHANNEL_ARG, REQUEST set
parse_args() {
  SESSION_NAME="${1:?Usage: start-session.sh <session-name> <slack-ts|\"\"> <slack-channel|\"\"> <request>}"
  SLACK_TS="${2:-}"
  SLACK_CHANNEL_ARG="${3:-}"
  REQUEST="${4:-}"

  _reject_unsafe "session-name"  "$SESSION_NAME"
  _reject_unsafe "slack-ts"      "$SLACK_TS"
  _reject_unsafe "slack-channel" "$SLACK_CHANNEL_ARG"
  _reject_unsafe "request"       "$REQUEST"

  [ -n "$SESSION_NAME" ] || die "session-name cannot be empty"

  case "$SESSION_NAME" in
    *.*|*:*) die "session-name must not contain '.' or ':' (got: ${SESSION_NAME})" ;;
  esac
}

# detect_mode — derive MODE from the slack-ts / slack-channel pair.
# input:  SLACK_TS, SLACK_CHANNEL_ARG
# output: MODE = "slack" | "local" (dies if exactly one is set)
detect_mode() {
  if [ -n "$SLACK_TS" ] && [ -n "$SLACK_CHANNEL_ARG" ]; then
    MODE="slack"
  elif [ -z "$SLACK_TS" ] && [ -z "$SLACK_CHANNEL_ARG" ]; then
    MODE="local"
  else
    die "slack-ts and slack-channel must both be set or both be empty"
  fi
}

# check_dependencies — ensure tmux + claude are reachable on PATH.
# input:  PATH, $HOME
# output: PATH possibly extended; dies if either binary is missing
check_dependencies() {
  log "Checking dependencies..."
  command -v tmux >/dev/null 2>&1 || die "tmux not installed"
  if ! command -v claude >/dev/null 2>&1; then
    for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/usr/local/bin/claude"; do
      [ -x "$p" ] && { export PATH="$(dirname "$p"):$PATH"; break; }
    done
  fi
  command -v claude >/dev/null 2>&1 || die "claude CLI not found (checked PATH and ~/.claude/local/)"
  ok "tmux + claude OK"
}

# resolve_oauth — pick the OAuth token to inject into the launched claude.
# input:  CLAUDE_TEAM_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
# output: prints token to stdout (empty if neither set)
resolve_oauth() {
  printf '%s' "${CLAUDE_TEAM_OAUTH_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
}

# build_env_vars — assemble the K=V pairs that env(1) will set for claude.
# input:  SESSION_NAME, MODE, SLACK_TS, SLACK_CHANNEL_ARG, resolve_oauth
# output: ENV_ARGS array filled
build_env_vars() {
  ENV_ARGS=(
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
    "SESSION_NAME=${SESSION_NAME}"
  )
  if [ "$MODE" = "slack" ]; then
    ENV_ARGS+=("SLACK_THREADS=${SLACK_TS}")
    ENV_ARGS+=("SLACK_CHANNEL=${SLACK_CHANNEL_ARG}")
  fi
  local token
  token="$(resolve_oauth)"
  if [ -n "$token" ]; then
    ENV_ARGS+=("CLAUDE_CODE_OAUTH_TOKEN=${token}")
    ok "OAuth token resolved"
  fi
}

# build_claude_argv — assemble the full argv (env + claude + flags + prompt).
# input:  ENV_ARGS, REQUEST
# output: CLAUDE_ARGV array filled (consumed by launch_claude after tmux's `--`)
build_claude_argv() {
  CLAUDE_ARGV=(
    env
    "${ENV_ARGS[@]}"
    claude
    --agent team-workflow:orchestrator
    --dangerously-skip-permissions
    --teammateMode split-pane
  )
  # The user's request is passed as the prompt POSITIONAL ARG. This is the
  # critical fix: argv is preserved literally by exec, so backticks, quotes,
  # $-signs, &, ;, parens, long text — all survive without ever touching a
  # shell. NO send-keys for the prompt.
  if [ -n "$REQUEST" ]; then
    CLAUDE_ARGV+=("$REQUEST")
  fi
}

# launch_claude — start a fresh tmux session that directly execs env + claude.
# input:  SESSION_NAME, CWD, CLAUDE_ARGV
# output: tmux session created with claude as the window's command
# note:   tmux's `--` separator runs the rest as a direct exec; no shell
#         parses our argv, so the prompt cannot break quoting.
launch_claude() {
  log "Launching Claude as orchestrator..."
  tmux new-session -d -s "$SESSION_NAME" -c "$CWD" -- "${CLAUDE_ARGV[@]}"
  ok "tmux session '${SESSION_NAME}' created (CWD=${CWD})"
}

# ensure_tmux_session — create the tmux session if missing; otherwise reuse.
# input:  SESSION_NAME, CWD, CLAUDE_ARGV
# output: tmux session running (idempotent — never relaunches claude)
ensure_tmux_session() {
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    warn "tmux session '${SESSION_NAME}' already exists — reusing (claude not relaunched)"
    return 0
  fi
  launch_claude
}

# print_header — banner shown before work starts.
# input:  globals
# output: stdout
print_header() {
  printf "\n${BOLD}/session — Spawning sub-session${RESET}\n"
  printf "────────────────────────────────────────────────\n"
  printf "  Session: ${CYAN}%s${RESET}\n" "$SESSION_NAME"
  printf "  Mode:    ${CYAN}%s${RESET}\n" "$MODE"
  if [ "$MODE" = "slack" ]; then
    printf "  Thread:  ${CYAN}%s${RESET}\n" "$SLACK_TS"
    printf "  Channel: ${CYAN}%s${RESET}\n" "$SLACK_CHANNEL_ARG"
  fi
  printf "  Request: ${CYAN}%s${RESET}\n\n" "$REQUEST"
}

# report — final summary block printed after launch.
# input:  globals
# output: stdout
report() {
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
}

# main — orchestrate the phases.
main() {
  parse_args "$@"
  detect_mode
  print_header
  check_dependencies
  build_env_vars
  build_claude_argv
  CWD="$(pwd)"
  ensure_tmux_session
  report
}

main "$@"
