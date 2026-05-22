#!/usr/bin/env bash
# Entrypoint for the long-lived team-workflow router pod.
#
# Responsibilities (in order):
#   1. Source load-tw-config.sh — reads .claude/team-workflow.yaml when
#      present, interpolates ${VAR} refs against the env, and exports
#      IA_TW_* / SLACK_TOPICS / ALLOWED_USERS_*. Env wins over the file.
#   2. Sanity-check the env the router + slack-bridge need.
#   3. Configure git / gh identity.
#   4. Start the slack-bridge daemon in the background (when Slack tokens
#      are present).
#   5. exec the `router` main session in the foreground as PID 1.
#
# This entrypoint is GENERIC. It does NOT pre-clone any repos. The
# whitelist of repos in team-workflow.yaml (under `repos:`) is metadata
# the agents read at runtime; the actual `git clone` happens lazily,
# when an agent first needs to grep or branch off a repo.
#
# Consumer agents come from extending this image:
#   FROM ia-tools-router-pod:dev
#   COPY agents/<agent>.md /root/.claude/agents/<agent>.md
# and pointing `router.dispatch.agent: <agent>` in team-workflow.yaml
# when the consumer ships a custom orchestrator persona.
set -euo pipefail

# --- 1. Load the declarative profile ----------------------------------------
LOADER=/opt/ia-tools/plugins/team-workflow/skills/session/scripts/load-tw-config.sh
if [ -f "$LOADER" ]; then
  # shellcheck disable=SC1090
  . "$LOADER" || echo "entrypoint: loader skipped (yq missing or yaml error)" >&2
else
  echo "entrypoint: $LOADER not found; relying on env-only configuration" >&2
fi

# --- 2. Required auth -------------------------------------------------------
# Claude auth: a CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY must be present.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" >&2
  exit 1
fi

# State root — default falls back when load-tw-config.sh did not set it.
export IA_TW_STATE_ROOT="${IA_TW_STATE_ROOT:-/state}"
mkdir -p "$IA_TW_STATE_ROOT"

# --- 3. Git / gh identity ---------------------------------------------------
git config --global user.name  "${GIT_AUTHOR_NAME:-team-workflow-bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-team-workflow-bot@users.noreply.github.com}"
git config --global --add safe.directory '*'

# gh auth from GITHUB_TOKEN (used by the /pr skill).
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null \
    || echo "WARN: gh auth login failed; /pr may not be able to open PRs" >&2
fi

# --- 4. slack-bridge daemon (optional) --------------------------------------
# Only start when Slack tokens are present. Without them the router runs
# in local/terminal mode.
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ]; then
  echo "▶ starting slack-bridge daemon..."
  pnpm --dir /opt/ia-tools --filter @ia-tools/slack-bridge daemon \
    >"$IA_TW_STATE_ROOT/slack-bridge.log" 2>&1 &
  sleep 3
else
  echo "WARN: SLACK_BOT_TOKEN/SLACK_APP_TOKEN not set — router runs without Slack transport" >&2
fi

# --- 5. Boot the router -----------------------------------------------------
# The router is the always-on main session. It receives every inbound,
# bootstraps the per-topic state dir ($IA_TW_STATE_ROOT/<topic_hash>/)
# the first time it sees a topic, and dispatches code changes to `lead`
# via /session + an explicit Bash call to start-lead.sh.
echo "▶ booting router"
[ -n "${SLACK_TOPICS:-}" ] && echo "  slack topics: $SLACK_TOPICS"

exec env \
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  CLAUDE_CODE_DISABLE_AGENT_VIEW=1 \
  ${SLACK_TOPICS:+SLACK_TOPICS="$SLACK_TOPICS"} \
  ${ALLOWED_USERS_DM:+ALLOWED_USERS_DM="$ALLOWED_USERS_DM"} \
  ${ALLOWED_USERS_MENTIONS:+ALLOWED_USERS_MENTIONS="$ALLOWED_USERS_MENTIONS"} \
  claude --agent team-workflow:router \
         --dangerously-load-development-channels plugin:slack-bridge@ia-tools \
         --dangerously-skip-permissions
