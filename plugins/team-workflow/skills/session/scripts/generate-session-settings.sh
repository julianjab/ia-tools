#!/usr/bin/env bash
# generate-session-settings.sh — emit a per-session `.claude/settings.local.json`
# under $state_dir so the spawned `claude` process inherits envs + MCP servers
# without the launching shell having to `env VAR=...` them on the command line.
#
# Bucket:      skills/session/scripts (utility, not a hook)
# Listens to:  N/A (invoked from start-lead.sh and any future spawner)
# Blocking:    no — exits non-zero only on bad args or write failure
# Input:       positional arg + env vars (see Usage)
# Output:      $state_dir/.claude/settings.local.json (atomic write)
#
# Usage:
#   generate-session-settings.sh <state-dir>
#
# Required env (caller must export before invoking):
#   IA_TW_FEATURE             feature label
#   IA_TW_TOPIC               Slack topic, or the literal "local"
#   IA_TW_ROOT_DIR            absolute path to the consumer repo or multi-repo root
#
# Deliberately NOT written:
#   IA_TW_REQUEST  — the verbatim request text already lives in state.md
#                    (lead persists it) and flows as the first user-message
#                    argv into the claude process. Putting it in env adds
#                    noise and corrupts JSON for multi-line requests.
#
# Optional env (silently dropped from the JSON when empty):
#   IA_TW_AGENT               default: team-workflow:lead
#   IA_TW_TOPIC_WORKER_AGENT  default: team-workflow:topic-worker
#   IA_TW_PROVISION           default: worktree-local
#   IA_TW_REPO_URL            single-repo clone mode
#   IA_TW_REPO_URLS           multi-repo CSV clone mode
#   IA_TW_REPO_CACHE_DIR      pod persistent cache dir
#   IA_TW_PARENT_SOCK         router IPC socket for parent /ask-user escalation
#   ALLOWED_USERS_DM          slack-bridge gate
#   ALLOWED_USERS_MENTIONS    slack-bridge gate
#   DAEMON_URL                slack-bridge daemon URL (default: http://localhost:3800)
#   SB_DIST                   absolute path to slack-bridge dist/mcp-server.js
#                             (auto-resolved when unset)
#
# Tokens NEVER written to disk (must remain in launching-process env):
#   CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
#   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, any *_TOKEN / *_SECRET / *_API_KEY var.
#
# Schema written (Claude Code settings.local.json subset):
#   {
#     "env":        { IA_TW_*, CLAUDE_CODE_*, SLACK_TOPICS, DAEMON_URL, ALLOWED_USERS_* },
#     "mcpServers": { figma, slack, slack-bridge }
#   }
#
# Claude Code merges this file with ~/.claude/settings.json + the active plugin
# settings, so the global hook registrations and permissions are preserved —
# only env + mcpServers are added per-session.

set -euo pipefail

state_dir="${1:?usage: generate-session-settings.sh <state-dir>}"
[ -d "$state_dir" ] || { printf '✗ state_dir not found: %s\n' "$state_dir" >&2; exit 1; }

: "${IA_TW_FEATURE:?IA_TW_FEATURE required}"
: "${IA_TW_TOPIC:?IA_TW_TOPIC required (use \"local\" when no Slack topic)}"
: "${IA_TW_ROOT_DIR:?IA_TW_ROOT_DIR required}"
# NOTE: IA_TW_REQUEST is NOT written to settings.local.json on purpose.
# The request text is persisted by lead in state.md and reaches the
# session as the first user-message argv. Duplicating it in env adds no
# value and pollutes JSON for multi-line requests.

agent="${IA_TW_AGENT:-team-workflow:lead}"
topic_worker_agent="${IA_TW_TOPIC_WORKER_AGENT:-team-workflow:topic-worker}"
provision="${IA_TW_PROVISION:-worktree-local}"
daemon_url="${DAEMON_URL:-http://localhost:3800}"

if ! command -v jq >/dev/null 2>&1; then
  printf '⚠ jq not on PATH — skipping settings.local.json generation.\n' >&2
  printf '  Install with: brew install jq (or apt-get install jq) for per-session\n' >&2
  printf '  env + MCP-server config. The session will boot without it; the\n' >&2
  printf '  spawner falls back to whatever envs are in the launching shell.\n' >&2
  exit 0
fi

# ─── Resolve slack-bridge dist path (caller may override via SB_DIST) ──────
sb_dist="${SB_DIST:-}"
if [ -z "$sb_dist" ]; then
  if [ -f "$IA_TW_ROOT_DIR/plugins/slack-bridge/dist/mcp-server.js" ]; then
    sb_dist="$IA_TW_ROOT_DIR/plugins/slack-bridge/dist/mcp-server.js"
  else
    sb_dist=$(ls -1d "$HOME/.claude/plugins/cache/ia-tools/slack-bridge"/*/dist/mcp-server.js 2>/dev/null \
                | sort -V | tail -1)
  fi
fi
[ -n "$sb_dist" ] && [ ! -f "$sb_dist" ] && sb_dist=""

# ─── Compose JSON with jq (safe quoting; no manual JSON assembly) ──────────
mkdir -p "$state_dir/.claude"
out="$state_dir/.claude/settings.local.json"
tmp="$(mktemp "$out.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

jq -n \
  --arg feature           "$IA_TW_FEATURE" \
  --arg topic             "$IA_TW_TOPIC" \
  --arg root_dir          "$IA_TW_ROOT_DIR" \
  --arg state_dir         "$state_dir" \
  --arg agent             "$agent" \
  --arg topic_worker      "$topic_worker_agent" \
  --arg provision         "$provision" \
  --arg repo_url          "${IA_TW_REPO_URL:-}" \
  --arg repo_urls         "${IA_TW_REPO_URLS:-}" \
  --arg repo_cache        "${IA_TW_REPO_CACHE_DIR:-}" \
  --arg parent_sock       "${IA_TW_PARENT_SOCK:-}" \
  --arg allowed_dm        "${ALLOWED_USERS_DM:-}" \
  --arg allowed_mentions  "${ALLOWED_USERS_MENTIONS:-}" \
  --arg daemon_url        "$daemon_url" \
  --arg sb_dist           "$sb_dist" \
  '
  # Helper: drop empty-string keys from an object.
  def compact: with_entries(select(.value != "" and .value != null));

  {
    env:
      ({
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        CLAUDE_CODE_DISABLE_AGENT_VIEW:       "1",
        IA_TW_FEATURE:            $feature,
        IA_TW_TOPIC:              $topic,
        IA_TW_ROOT_DIR:           $root_dir,
        IA_TW_STATE_DIR:          $state_dir,
        IA_TW_AGENT:              $agent,
        IA_TW_TOPIC_WORKER_AGENT: $topic_worker,
        IA_TW_PROVISION:          $provision,
        DAEMON_URL:               $daemon_url,
        SLACK_TOPICS:             (if $topic != "local" then $topic else "" end),
        IA_TW_REPO_URL:           $repo_url,
        IA_TW_REPO_URLS:          $repo_urls,
        IA_TW_REPO_CACHE_DIR:     $repo_cache,
        IA_TW_PARENT_SOCK:        $parent_sock,
        ALLOWED_USERS_DM:         $allowed_dm,
        ALLOWED_USERS_MENTIONS:   $allowed_mentions,
      } | compact),

    mcpServers:
      ({
        figma: {
          type: "http",
          url:  "https://mcp.figma.com/mcp"
        },
        slack: {
          type:  "http",
          url:   "https://mcp.slack.com/mcp",
          oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 }
        }
      }
      + (if $sb_dist != "" then {
           "slack-bridge": {
             command: "node",
             args:    [ $sb_dist ],
             env: (
               { DAEMON_URL: $daemon_url,
                 ALLOWED_USERS_DM: $allowed_dm,
                 ALLOWED_USERS_MENTIONS: $allowed_mentions }
               | compact
             )
           }
         } else {} end))
  }
  ' > "$tmp"

mv "$tmp" "$out"
trap - EXIT
printf '✓ wrote %s\n' "$out"
