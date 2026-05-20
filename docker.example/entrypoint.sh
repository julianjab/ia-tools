#!/usr/bin/env bash
# Entrypoint for the long-lived team-workflow router pod.
#
# Responsibilities:
#   1. Resolve the POD PROFILE — which orchestrator the router dispatches,
#      and how it provisions a working copy. Two sources, env wins:
#        a. pod-config.json (openclaw-style declarative file), if present.
#        b. raw IA_TW_* env vars (k8s ConfigMap / .env). Always authoritative.
#   2. Sanity-check the env the router + slack-bridge need.
#   3. Start the slack-bridge daemon in the background (Slack transport).
#   4. exec the `router` main session in the foreground as PID 1.
#
# The router reads IA_TW_DISPATCH_* at boot and forwards them to every
# `repo-worker` (or `lead`) sub-session it spawns via start-lead.sh.
# Sub-sessions are tmux sessions inside this same pod; the tmux server
# auto-starts on first use.
set -euo pipefail

# --- 1. resolve the pod profile from pod-config.json (optional) --------------
# If POD_CONFIG points at a readable JSON file, interpolate ${ENV} refs
# against the current environment and export the IA_TW_* vars it implies.
# Any IA_TW_* var already set in the environment is NOT overwritten — the
# ConfigMap / .env always wins over the file.
POD_CONFIG="${POD_CONFIG:-/opt/ia-tools/pod-config.json}"
if [ -f "$POD_CONFIG" ]; then
  echo "▶ loading pod profile from $POD_CONFIG"
  eval "$(node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const cfg = JSON.parse(raw);
    const subst = (v) => typeof v === "string"
      ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] || "")
      : v;
    const out = {
      IA_TW_DISPATCH_AGENT:     subst(cfg?.router?.dispatch?.agent),
      IA_TW_DISPATCH_PROVISION: subst(cfg?.router?.dispatch?.provision),
      IA_TW_REPO_URL:           subst(cfg?.router?.dispatch?.repoUrl),
      IA_TW_STATE_ROOT:         subst(cfg?.state?.root),
      SLACK_TOPICS:             subst(cfg?.slack?.topics),
    };
    // env wins: only emit a var the file defines AND the env has not set.
    for (const [k, v] of Object.entries(out)) {
      if (v && !process.env[k]) console.log(`export ${k}=${JSON.stringify(v)}`);
    }
  ' "$POD_CONFIG")"
fi

# Defaults — make the dev-host profile the fallback when nothing is set.
export IA_TW_DISPATCH_AGENT="${IA_TW_DISPATCH_AGENT:-team-workflow:lead}"
export IA_TW_DISPATCH_PROVISION="${IA_TW_DISPATCH_PROVISION:-worktree-local}"
export IA_TW_STATE_ROOT="${IA_TW_STATE_ROOT:-/state}"
mkdir -p "$IA_TW_STATE_ROOT"

echo "▶ pod profile: dispatch=$IA_TW_DISPATCH_AGENT provision=$IA_TW_DISPATCH_PROVISION"

# --- 2. required env ---------------------------------------------------------
# Auth: a CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY must be present.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" >&2
  exit 1
fi

# When the profile provisions by clone, the repo URL is mandatory.
if [ "$IA_TW_DISPATCH_PROVISION" = "clone" ] && [ -z "${IA_TW_REPO_URL:-}" ]; then
  echo "FATAL: IA_TW_DISPATCH_PROVISION=clone requires IA_TW_REPO_URL" >&2
  exit 1
fi

# --- 3. git identity ---------------------------------------------------------
git config --global user.name  "${GIT_AUTHOR_NAME:-team-workflow-bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-team-workflow-bot@users.noreply.github.com}"
git config --global --add safe.directory '*'

# gh auth from GITHUB_TOKEN (used by the /pr skill).
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null \
    || echo "WARN: gh auth login failed; /pr may not be able to open PRs" >&2
fi

# --- 4. slack-bridge daemon --------------------------------------------------
# Only start it if Slack tokens are present. Without them, the router still
# runs but only in local/terminal mode (no Slack transport).
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ]; then
  echo "▶ starting slack-bridge daemon..."
  pnpm --dir /opt/ia-tools --filter @ia-tools/slack-bridge daemon \
    >"$IA_TW_STATE_ROOT/slack-bridge.log" 2>&1 &
  sleep 3
else
  echo "WARN: SLACK_BOT_TOKEN/SLACK_APP_TOKEN not set — router runs without Slack transport" >&2
fi

# --- 5. boot the router ------------------------------------------------------
# The router is the always-on main session. It reads IA_TW_DISPATCH_* at
# boot and forwards them to every sub-session it spawns. SLACK_TOPICS
# (optional) auto-subscribes the slack-bridge MCP at boot.
echo "▶ booting router (repo: ${IA_TW_REPO_URL:-<none — worktree-local>})"

exec env \
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  CLAUDE_CODE_DISABLE_AGENT_VIEW=1 \
  IA_TW_DISPATCH_AGENT="$IA_TW_DISPATCH_AGENT" \
  IA_TW_DISPATCH_PROVISION="$IA_TW_DISPATCH_PROVISION" \
  ${IA_TW_REPO_URL:+IA_TW_REPO_URL="$IA_TW_REPO_URL"} \
  ${SLACK_TOPICS:+SLACK_TOPICS="$SLACK_TOPICS"} \
  claude --agent team-workflow:router \
         --dangerously-load-development-channels plugin:slack-bridge@ia-tools \
         --dangerously-skip-permissions
