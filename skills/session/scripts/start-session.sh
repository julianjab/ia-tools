#!/usr/bin/env bash
# =============================================================================
# start-session.sh — Open a full sub-session.
#
# Called by the /session skill, which is called by the session-manager main session
# when it classifies a Slack message as a `change` intent, or after scope-check
# returns a `new-session` verdict.
#
# Responsibilities:
#   1. Ensure the git worktree exists (delegates to /worktree init)
#      — SKIPPED in resume-from mode (--resume-from set).
#   2. Seed .sdlc/tasks.md with a minimal stub
#      — SKIPPED in resume-from mode.
#   3. Open (or reuse) a tmux session and create a window in the worktree
#      (or consumer repo root in resume-from mode)
#   4. Launch `claude` inside the window with SLACK_* env vars + orchestrator
#      role hint, so the SessionStart hook injects the orchestrator system prompt
#   5. Send the boot prompt to the new Claude instance
#
# Usage:
#   bash start-session.sh <branch-name> <slack-thread-ts|""> <slack-channel-id|""> \
#                         <description-or-review-flag> [<base-branch|"">] \
#                         [<resume-from-path|"">]
#
# Flags (args 5 and 6):
#   --base <branch>       Base branch for worktree creation. Defaults to main → master.
#   --resume-from <path>  Activates resume-from mode. <path> must be an
#                         absolute path to .sessions/<label>/. Skips worktree
#                         creation; orchestrator CWD = consumer repo root.
#                         Sets IA_TOOLS_SESSION_DIR=<path> in settings.local.json.
#
# Mode detection (single source of truth: the Slack env vars):
#   - thread + channel non-empty → SLACK_THREAD_TS / SLACK_CHANNELS exported
#                                  → orchestrator runs in slack mode
#   - both empty                 → SLACK_* NOT exported
#                                  → orchestrator runs in local mode
#
# Resume-from detection:
#   - --resume-from set AND <path>/plan-draft.md exists → resume-from mode
#   - otherwise                                         → standard single-repo mode
#
# Examples:
#   bash start-session.sh feat/google-login 1728591234.001 C07815S0XNX \
#        "arregla el login de Google"
#
#   bash start-session.sh review/pr-42 1728591234.001 C07815S0XNX --review=42
#
#   bash start-session.sh feat/refactor-foo "" "" "refactorea el módulo foo"
#
#   bash start-session.sh feat/payment-tracking "" "" \
#        "payment tracking across repos" "main" \
#        "/Users/julian/development/lahaus/.sessions/feat-payment-tracking"
# =============================================================================
set -euo pipefail

# ── colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { printf "${CYAN}▶${RESET} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
die()  { printf "${RED}✗ ERROR:${RESET} %s\n" "$1" >&2; exit 1; }

# JSON-escape helper (inline; no jq dep): escapes \ and " (covers the realistic inputs —
# paths, Slack TS like "1728591234.001", Slack channel IDs like "C07815S0XNX").
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

BRANCH_NAME="${1:?Usage: start-session.sh <branch-name> <thread-ts|\"\"> <channel-id|\"\"> <description-or-review> [<base-branch|\"\">] [<resume-from-path|\"\">]}"
SLACK_THREAD_TS="${2:-}"
SLACK_CHANNEL_ID="${3:-}"
DESCRIPTION_OR_REVIEW="${4:-}"
BASE_BRANCH_ARG="${5:-}"
RESUME_FROM_PATH="${6:-}"

# ── Input validation: reject unsafe characters in user-controlled args ────────
reject_unsafe_chars() {
  # $1 = name, $2 = value
  case "$2" in
    *$'\n'*|*$'\r'*) die "invalid character (newline/CR) in ${1}";;
  esac
  case "$2" in
    *[$'\0']*) die "invalid character (NUL) in ${1}";;
  esac
}

reject_unsafe_chars "branch-name"     "$BRANCH_NAME"
reject_unsafe_chars "thread-ts"       "$SLACK_THREAD_TS"
reject_unsafe_chars "channel-id"      "$SLACK_CHANNEL_ID"
reject_unsafe_chars "description"     "$DESCRIPTION_OR_REVIEW"
reject_unsafe_chars "resume-from"     "${RESUME_FROM_PATH:-}"
reject_unsafe_chars "base"            "${BASE_BRANCH_ARG:-}"

# Validate branch name is a valid git ref
git check-ref-format --branch "$BRANCH_NAME" \
  >/dev/null 2>&1 \
  || die "invalid branch name: $BRANCH_NAME"

# Mode: slack if both Slack coords are set, otherwise local.
if [ -n "$SLACK_THREAD_TS" ] && [ -n "$SLACK_CHANNEL_ID" ]; then
  TASK_MODE="slack"
elif [ -z "$SLACK_THREAD_TS" ] && [ -z "$SLACK_CHANNEL_ID" ]; then
  TASK_MODE="local"
else
  printf "ERROR: thread and channel must both be set or both be empty\n" >&2
  exit 1
fi

printf "\n${BOLD}/session — Opening sub-session${RESET}\n"
printf "────────────────────────────────────────────────\n"
printf "  Branch:  ${CYAN}%s${RESET}\n" "$BRANCH_NAME"
printf "  Mode:    ${CYAN}%s${RESET}\n" "$TASK_MODE"
if [ "$TASK_MODE" = "slack" ]; then
  printf "  Thread:  ${CYAN}%s${RESET}\n" "$SLACK_THREAD_TS"
  printf "  Channel: ${CYAN}%s${RESET}\n" "$SLACK_CHANNEL_ID"
fi
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

# ── 2. Resolve repo root ─────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR_NAME="$(printf '%s' "$BRANCH_NAME" | tr '/' '-')"
WORKTREE_PATH="${REPO_ROOT}/.worktrees/${DIR_NAME}"

# Determine base branch (arg 5 overrides, then main → master fallback)
if [ -n "$BASE_BRANCH_ARG" ]; then
  BASE_BRANCH="$BASE_BRANCH_ARG"
else
  BASE_BRANCH="main"
  git -C "$REPO_ROOT" rev-parse --verify "origin/${BASE_BRANCH}" >/dev/null 2>&1 \
    || BASE_BRANCH="master"
fi

# ── 3. Shared-workspace mode vs standard mode ────────────────────────────────
# Shared-workspace mode: --resume-from set and <path>/plan-draft.md exists.
# In this mode we skip worktree creation and use the consumer repo root as CWD.
RESUME_FROM_MODE="false"
CONSUMER_REPO_ROOT="$REPO_ROOT"
SESSION_DIR=""

if [ -n "$RESUME_FROM_PATH" ]; then
  # M4: Canonicalise and enforce that the path is under <consumer-repo-root>/.sessions/
  RESUME_FROM_REAL=$(realpath "$RESUME_FROM_PATH" 2>/dev/null \
    || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$RESUME_FROM_PATH")
  [ -n "$RESUME_FROM_REAL" ] || die "cannot resolve --resume-from path: $RESUME_FROM_PATH"
  RESUME_FROM_PATH="$RESUME_FROM_REAL"

  case "$RESUME_FROM_PATH" in
    */.sessions/*) : ;;
    *) die "--resume-from must be inside a '.sessions/' directory (got: $RESUME_FROM_PATH)";;
  esac

  if [ ! -f "${RESUME_FROM_PATH}/plan-draft.md" ]; then
    die "--resume-from path does not contain plan-draft.md: ${RESUME_FROM_PATH}/plan-draft.md"
  fi
  # Derive consumer repo root: <root>/.sessions/<label>/ → two levels up
  CONSUMER_REPO_ROOT="$(git -C "${RESUME_FROM_PATH}" rev-parse --show-toplevel 2>/dev/null \
    || dirname "$(dirname "$RESUME_FROM_PATH")")"
  SESSION_DIR="$RESUME_FROM_PATH"
  WORKTREE_PATH="$CONSUMER_REPO_ROOT"  # orchestrator CWD = consumer repo root
  RESUME_FROM_MODE="true"
  ok "Resume-from mode: orchestrator CWD = ${CONSUMER_REPO_ROOT}"
  ok "session_dir = ${SESSION_DIR}"
else
  # Standard single-repo mode: create worktree as before
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -q "^worktree ${WORKTREE_PATH}$"; then
    ok "Worktree already exists: $WORKTREE_PATH"
  else
    log "Creating worktree..."
    git -C "$REPO_ROOT" fetch origin >/dev/null 2>&1 || warn "fetch failed (continuing)"

    mkdir -p "${REPO_ROOT}/.worktrees"
    grep -qxF '.worktrees/' "${REPO_ROOT}/.gitignore" 2>/dev/null \
      || echo '.worktrees/' >> "${REPO_ROOT}/.gitignore"

    # --review mode creates the branch from the PR ref
    if [ "${DESCRIPTION_OR_REVIEW#--review=}" != "$DESCRIPTION_OR_REVIEW" ]; then
      PR_NUMBER="${DESCRIPTION_OR_REVIEW#--review=}"
      git -C "$REPO_ROOT" fetch origin "pull/${PR_NUMBER}/head:${BRANCH_NAME}" >/dev/null 2>&1 \
        || die "failed to fetch PR #${PR_NUMBER}"
      git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
    else
      git -C "$REPO_ROOT" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/${BASE_BRANCH}"
    fi

    ok "Worktree created: $WORKTREE_PATH"
  fi
fi

# ── 3b. Write settings.local.json ────────────────────────────────────────────
# Only static config goes here — no runtime env vars.
# Runtime vars (SLACK_*, IA_TOOLS_SESSION_DIR, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)
# are passed directly in the Claude launch command so they don't bleed into the
# main session when the orchestrator runs in the consumer repo root.
if [ "$RESUME_FROM_MODE" = "true" ]; then
  SETTINGS_DIR="${CONSUMER_REPO_ROOT}/.claude"
else
  SETTINGS_DIR="${WORKTREE_PATH}/.claude"
fi
mkdir -p "$SETTINGS_DIR"
SETTINGS_FILE="${SETTINGS_DIR}/settings.local.json"

cat > "$SETTINGS_FILE" <<EOF
{
  "agent": "orchestrator",
  "disabledPlugins": ["slack@claude-plugins-official"]
}
EOF
ok "Wrote ${SETTINGS_FILE}"

# ── 3c. Resolve OAuth token for the tmux launch command (not persisted) ────
AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"
if [ -n "$AGENT_TOKEN" ]; then
  ok "OAuth token resolved"
else
  warn "No CLAUDE_TEAM_OAUTH_TOKEN — using default auth"
fi

# ── 4. Seed .sdlc/tasks.md (skipped in resume-from mode) ────────────────────
# In resume-from mode the seed is already in <session_dir>/plan-draft.md.
if [ "$RESUME_FROM_MODE" = "true" ]; then
  ok "Resume-from mode: skipping .sdlc/tasks.md seed (plan-draft.md is the seed)"
else
  TASKS_FILE="${WORKTREE_PATH}/.sdlc/tasks.md"
  if [ ! -s "$TASKS_FILE" ]; then
    mkdir -p "${WORKTREE_PATH}/.sdlc"
    CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    REQUEST_TEXT="$DESCRIPTION_OR_REVIEW"
    if [ "${REQUEST_TEXT#--review=}" != "$REQUEST_TEXT" ]; then
      REQUEST_TEXT="Review PR #${REQUEST_TEXT#--review=}"
    fi

    if [ "$TASK_MODE" = "slack" ]; then
      SOURCE_LINE="**Slack thread**: ${SLACK_CHANNEL_ID}/${SLACK_THREAD_TS}"
    else
      SOURCE_LINE="**Source**: local (no Slack)"
    fi

    cat > "$TASKS_FILE" <<EOF
# Session: ${BRANCH_NAME}

**Mode**: ${TASK_MODE}
${SOURCE_LINE}
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
fi

# ── 5. Build the Claude launch command ───────────────────────────────────────
# Runtime env vars are passed inline so they don't pollute settings.local.json
# (which is shared with the main session in resume-from / multi-repo mode).
SESSION_DIR_ESC=$(printf '%s' "$SESSION_DIR" | sed "s/'/'\\\\''/g")
SLACK_THREAD_TS_ESC=$(printf '%s' "$SLACK_THREAD_TS" | sed "s/'/'\\\\''/g")
SLACK_CHANNEL_ID_ESC=$(printf '%s' "$SLACK_CHANNEL_ID" | sed "s/'/'\\\\''/g")

ENV_PREFIX="CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
ENV_PREFIX="${ENV_PREFIX} IA_TOOLS_SESSION_DIR='${SESSION_DIR_ESC}'"
if [ "$TASK_MODE" = "slack" ]; then
  ENV_PREFIX="${ENV_PREFIX} SLACK_THREAD_TS='${SLACK_THREAD_TS_ESC}'"
  ENV_PREFIX="${ENV_PREFIX} SLACK_CHANNEL_ID='${SLACK_CHANNEL_ID_ESC}'"
  ENV_PREFIX="${ENV_PREFIX} SLACK_CHANNELS='${SLACK_CHANNEL_ID_ESC}'"
fi
if [ -n "$AGENT_TOKEN" ]; then
  ENV_PREFIX="CLAUDE_CODE_OAUTH_TOKEN=${AGENT_TOKEN} ${ENV_PREFIX}"
fi

CLAUDE_CMD="${ENV_PREFIX} claude --dangerously-load-development-channels plugin:slack-bridge@ia-tools --dangerously-skip-permissions --teammateMode split-pane"

# ── 7. tmux session / window ─────────────────────────────────────────────────
SESSION="${TMUX_SESSION_NAME:-ia-tools}"
WINDOW="$DIR_NAME"

# In resume-from mode: orchestrator CWD = consumer repo root.
# In standard mode: orchestrator CWD = the dedicated worktree.
if [ "$RESUME_FROM_MODE" = "true" ]; then
  TMUX_CWD="$CONSUMER_REPO_ROOT"
else
  TMUX_CWD="$WORKTREE_PATH"
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  if tmux list-windows -t "$SESSION" -F '#W' | grep -qx "$WINDOW"; then
    warn "Window '$WINDOW' already exists in session '$SESSION' — reusing"
  else
    tmux new-window -t "$SESSION" -n "$WINDOW" -c "$TMUX_CWD"
    ok "Window '$WINDOW' created in existing session '$SESSION'"
  fi
else
  tmux new-session -d -s "$SESSION" -n "$WINDOW" -c "$TMUX_CWD"
  ok "Session '$SESSION' + window '$WINDOW' created"
fi

# ── 8. Launch Claude ─────────────────────────────────────────────────────────
log "Launching Claude in the window..."
tmux send-keys -t "${SESSION}:${WINDOW}" "$CLAUDE_CMD" Enter

# ── 9. Send boot prompt ──────────────────────────────────────────────────────
sleep 2

if [ "$RESUME_FROM_MODE" = "true" ]; then
  # Resume-from boot prompt: orchestrator reads plan-draft.md, approval gate still runs
  if [ "$TASK_MODE" = "slack" ]; then
    BOOT_PROMPT="You are the orchestrator of session ${BRANCH_NAME}. Mode: slack. Your Slack thread: ts=${SLACK_THREAD_TS} channel=${SLACK_CHANNEL_ID}. Your CWD is the consumer repo root: ${CONSUMER_REPO_ROOT}. IA_TOOLS_SESSION_DIR=${SESSION_DIR}. Read ${SESSION_DIR}/plan-draft.md as your Phase 1 seed (do NOT start from scratch). Expand the draft into a full plan, publish it to the Slack thread, then BLOCK on the approval gate until you see a ✅ reaction. Approval gate still runs — resume-from seeds the plan, it does NOT skip approval."
  else
    BOOT_PROMPT="You are the orchestrator of session ${BRANCH_NAME}. Mode: local (no Slack). Your CWD is the consumer repo root: ${CONSUMER_REPO_ROOT}. IA_TOOLS_SESSION_DIR=${SESSION_DIR}. Read ${SESSION_DIR}/plan-draft.md as your Phase 1 seed (do NOT start from scratch). Expand the draft into a full plan, print it to this session, then BLOCK on the approval gate using AskUserQuestion. Approval gate still runs — resume-from seeds the plan, it does NOT skip approval. Do NOT call any slack-bridge MCP tool."
  fi
elif [ "$TASK_MODE" = "slack" ]; then
  BOOT_PROMPT="You are the orchestrator of session ${BRANCH_NAME}. Mode: slack. Your Slack thread: ts=${SLACK_THREAD_TS} channel=${SLACK_CHANNEL_ID}. Your worktree: ${WORKTREE_PATH}. Read .sdlc/tasks.md first, then follow the pipeline in agents/orchestrator.md starting from the boot sequence. Phase 1 is your first action: build and publish the plan, then BLOCK on the approval gate until you see a ✅ reaction in the thread."
else
  BOOT_PROMPT="You are the orchestrator of session ${BRANCH_NAME}. Mode: local (no Slack). Your worktree: ${WORKTREE_PATH}. Read .sdlc/tasks.md first, then follow the pipeline in agents/orchestrator.md starting from the boot sequence. Phase 1 is your first action: build and print the plan to this session, then BLOCK on the approval gate using AskUserQuestion — do NOT call any slack-bridge MCP tool."
fi

tmux send-keys -t "${SESSION}:${WINDOW}" "$BOOT_PROMPT"
sleep 2
tmux send-keys -t "${SESSION}:${WINDOW}" Enter

# ── 10. Report ───────────────────────────────────────────────────────────────
printf "\n"
ok "Sub-session started"
printf "\n${BOLD}Sub-session summary:${RESET}\n"
printf "  Branch:   ${CYAN}%s${RESET}\n" "$BRANCH_NAME"
printf "  Mode:     ${CYAN}%s${RESET}\n" "$TASK_MODE"
if [ "$RESUME_FROM_MODE" = "true" ]; then
  printf "  Orch CWD: ${CYAN}%s${RESET} (resume-from, no dedicated worktree)\n" "$CONSUMER_REPO_ROOT"
  printf "  Session dir: ${CYAN}%s${RESET}\n" "$SESSION_DIR"
else
  printf "  Worktree: ${CYAN}%s${RESET}\n" "$WORKTREE_PATH"
fi
printf "  tmux:     session=${CYAN}%s${RESET} window=${CYAN}%s${RESET}\n" "$SESSION" "$WINDOW"
if [ "$TASK_MODE" = "slack" ]; then
  printf "  Slack:    thread=${CYAN}%s${RESET} channel=${CYAN}%s${RESET}\n" "$SLACK_THREAD_TS" "$SLACK_CHANNEL_ID"
fi
printf "\nAttach with: ${BOLD}tmux attach -t %s${RESET}\n" "$SESSION"
