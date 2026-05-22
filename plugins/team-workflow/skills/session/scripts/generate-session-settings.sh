#!/usr/bin/env bash
# generate-session-settings.sh — emit/merge a per-session
# `.claude/settings.local.json` under $state_dir so the spawned `claude`
# process inherits envs + MCP servers without the launching shell having
# to `env VAR=...` them on the command line.
#
# Bucket:      skills/session/scripts (utility, not a hook)
# Listens to:  N/A (invoked from start-lead.sh, init.sh, sync-agents.sh,
#              and /session rehydrate)
# Blocking:    no — exits non-zero only on bad args
# Input:       positional arg + env vars (see Usage)
# Output:      $state_dir/.claude/settings.local.json (atomic, idempotent merge)
#
# Usage:
#   generate-session-settings.sh <state-dir>
#
# Idempotency contract:
#   The util OVERWRITES only "managed" keys; everything else is preserved.
#   Re-running with the same inputs is a no-op (modulo timestamp churn).
#   Re-running with different inputs replaces only the managed values.
#
# Managed keys (overwrite on every run):
#   env:
#     IA_TW_*                            (every key matching this prefix)
#     CLAUDE_CODE_*                      (every key matching this prefix)
#     SLACK_TOPICS, DAEMON_URL,
#     ALLOWED_USERS_DM, ALLOWED_USERS_MENTIONS
#   mcpServers:
#     figma, slack, slack-bridge
#   additionalDirectories:
#     replaced atomically with [STATE_DIR, ...active worktree paths from state.md]
#
# Preserved keys (never touched):
#   - Any env.* key not in the IA_TW_*/CLAUDE_CODE_*/SLACK_TOPICS/etc allowlist.
#   - Any mcpServers.* server not named figma / slack / slack-bridge.
#   - Top-level fields like permissions, hooks, model, theme — anything else.
#
# Required env (caller must export before invoking):
#   IA_TW_FEATURE             feature label
#   IA_TW_TOPIC               Slack topic, or the literal "local"
#   IA_TW_ROOT_DIR            absolute path to the consumer repo / multi-repo root
#
# Derived envs the caller is expected to set (Capa B contract):
#   IA_TW_STATE_DIR           ← becomes the cwd of the spawned session
#   IA_TW_WORKTREE_ROOT       ← $IA_TW_STATE_DIR/worktrees (passed through to lead)
#   IA_TW_AGENT_LINK_DIR      ← $IA_TW_STATE_DIR/.claude/agents (passed through)
#   IA_TW_ARCHIVE_DIR         ← persistent archive path for the merge
#   IA_TW_AGENT_LINK_STRATEGY symlink | copy
#   IA_TW_ARCHIVE_ON_MERGE    1 | 0
#
# Optional env (silently dropped from the JSON when empty):
#   IA_TW_AGENT               default: team-workflow:lead
#   IA_TW_TOPIC_WORKER_AGENT  default: team-workflow:topic-worker
#   IA_TW_PROVISION           default: worktree-local
#   IA_TW_REPO_URL            single-repo clone mode
#   IA_TW_REPO_URLS           multi-repo CSV clone mode
#   IA_TW_REPO_CACHE_DIR      pod persistent cache dir
#   IA_TW_PARENT_SOCK         router IPC socket
#   ALLOWED_USERS_DM          slack-bridge gate
#   ALLOWED_USERS_MENTIONS    slack-bridge gate
#   DAEMON_URL                slack-bridge daemon URL (default: http://localhost:3800)
#   SB_DIST                   abs path to slack-bridge dist/mcp-server.js (auto-resolved)
#   WORKTREES_CSV             comma-separated abs paths to seed additionalDirectories
#                             with (typically read from state.md by the caller; an
#                             empty value means: read state.md directly).
#
# Tokens NEVER written to disk (must remain in launching-process env):
#   CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
#   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, any *_TOKEN / *_SECRET / *_API_KEY var.

set -euo pipefail

state_dir="${1:?usage: generate-session-settings.sh <state-dir>}"
[ -d "$state_dir" ] || { printf '✗ state_dir not found: %s\n' "$state_dir" >&2; exit 1; }

: "${IA_TW_FEATURE:?IA_TW_FEATURE required}"
: "${IA_TW_TOPIC:?IA_TW_TOPIC required (use \"local\" when no Slack topic)}"
: "${IA_TW_ROOT_DIR:?IA_TW_ROOT_DIR required}"

agent="${IA_TW_AGENT:-team-workflow:lead}"
topic_worker_agent="${IA_TW_TOPIC_WORKER_AGENT:-team-workflow:topic-worker}"
provision="${IA_TW_PROVISION:-worktree-local}"
daemon_url="${DAEMON_URL:-http://localhost:3800}"
worktree_root="${IA_TW_WORKTREE_ROOT:-$state_dir/worktrees}"
agent_link_dir="${IA_TW_AGENT_LINK_DIR:-$state_dir/.claude/agents}"
agent_link_strategy="${IA_TW_AGENT_LINK_STRATEGY:-symlink}"
archive_dir="${IA_TW_ARCHIVE_DIR:-}"
archive_on_merge="${IA_TW_ARCHIVE_ON_MERGE:-1}"

if ! command -v jq >/dev/null 2>&1; then
  printf '⚠ jq not on PATH — skipping settings.local.json generation.\n' >&2
  printf '  Install with: brew install jq (or apt-get install jq).\n' >&2
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

# ─── Resolve additionalDirectories list ────────────────────────────────────
# Priority: explicit WORKTREES_CSV from the caller; else read state.md via
# active-worktrees.sh; else empty list. STATE_DIR is always prepended so
# Claude Code treats the per-feature workspace as a session root.
worktrees_json='[]'
if [ -n "${WORKTREES_CSV:-}" ]; then
  worktrees_json=$(printf '%s' "$WORKTREES_CSV" \
                     | tr ',' '\n' \
                     | jq -R . \
                     | jq -s 'map(select(length > 0))')
elif [ -f "$state_dir/state.md" ]; then
  active_script="$(dirname "${BASH_SOURCE[0]}")/../../worktree/scripts/active-worktrees.sh"
  if [ -x "$active_script" ]; then
    worktrees_json=$(bash "$active_script" "$state_dir/state.md" 2>/dev/null \
                       | jq -R . \
                       | jq -s 'map(select(length > 0))')
  fi
fi

# Prepend STATE_DIR so the per-feature workspace itself is registered.
worktrees_json=$(jq -n --arg sd "$state_dir" --argjson rest "$worktrees_json" \
                  '[$sd] + $rest | unique')

# ─── Read existing file (or {}) and validate ───────────────────────────────
mkdir -p "$state_dir/.claude"
out="$state_dir/.claude/settings.local.json"
existing='{}'
if [ -f "$out" ]; then
  raw=$(cat "$out" 2>/dev/null || true)
  if printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    existing="$raw"
  else
    backup="$out.malformed.$(date +%Y%m%d-%H%M%S)"
    printf '⚠ %s is malformed — backing up to %s and starting fresh.\n' "$out" "$backup" >&2
    cp "$out" "$backup" 2>/dev/null || true
  fi
fi

# ─── Idempotent merge: strip managed keys from existing, then overlay ──────
tmp="$(mktemp "$out.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

printf '%s' "$existing" | jq \
  --arg feature           "$IA_TW_FEATURE" \
  --arg topic             "$IA_TW_TOPIC" \
  --arg root_dir          "$IA_TW_ROOT_DIR" \
  --arg state_dir         "$state_dir" \
  --arg worktree_root     "$worktree_root" \
  --arg agent_link_dir    "$agent_link_dir" \
  --arg agent_strategy    "$agent_link_strategy" \
  --arg archive_dir       "$archive_dir" \
  --arg archive_on_merge  "$archive_on_merge" \
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
  --argjson worktrees     "$worktrees_json" \
  '
  # Helper: drop empty-string / null keys from an object.
  def compact: with_entries(select(.value != "" and .value != null));

  # Managed env predicates — input-piped (key string flows in via `.`).
  # Implemented as filters on the current input so the second-pipe
  # `index(.)` finds the right value (a filter argument like `index(k)`
  # would re-evaluate `k` against the array, not the entry).
  def is_managed_env_key:
    startswith("IA_TW_") or
    startswith("CLAUDE_CODE_") or
    (. as $k |
      ["SLACK_TOPICS", "DAEMON_URL", "ALLOWED_USERS_DM", "ALLOWED_USERS_MENTIONS"]
      | index($k) != null);

  # Managed MCP server names — same input-piped pattern.
  def is_managed_mcp_key:
    . as $k | ["figma", "slack", "slack-bridge"] | index($k) != null;

  # New managed env block.
  ({
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW:       "1",
    IA_TW_FEATURE:                $feature,
    IA_TW_TOPIC:                  $topic,
    IA_TW_ROOT_DIR:               $root_dir,
    IA_TW_STATE_DIR:              $state_dir,
    IA_TW_WORKTREE_ROOT:          $worktree_root,
    IA_TW_AGENT_LINK_DIR:         $agent_link_dir,
    IA_TW_AGENT_LINK_STRATEGY:    $agent_strategy,
    IA_TW_ARCHIVE_DIR:            $archive_dir,
    IA_TW_ARCHIVE_ON_MERGE:       $archive_on_merge,
    IA_TW_AGENT:                  $agent,
    IA_TW_TOPIC_WORKER_AGENT:     $topic_worker,
    IA_TW_PROVISION:              $provision,
    DAEMON_URL:                   $daemon_url,
    SLACK_TOPICS:                 (if $topic != "local" then $topic else "" end),
    IA_TW_REPO_URL:               $repo_url,
    IA_TW_REPO_URLS:              $repo_urls,
    IA_TW_REPO_CACHE_DIR:         $repo_cache,
    IA_TW_PARENT_SOCK:            $parent_sock,
    ALLOWED_USERS_DM:             $allowed_dm,
    ALLOWED_USERS_MENTIONS:       $allowed_mentions,
  } | compact) as $new_env

  # New managed MCP block.
  | ({
      figma: { type: "http", url: "https://mcp.figma.com/mcp" },
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
       } else {} end)) as $new_mcps

  # Merge: strip managed keys from existing, then overlay new managed values.
  | .env             = ((.env             // {} | with_entries(select(.key | is_managed_env_key | not))) + $new_env)
  | .mcpServers      = ((.mcpServers      // {} | with_entries(select(.key | is_managed_mcp_key | not))) + $new_mcps)
  | .additionalDirectories = $worktrees
  ' > "$tmp"

mv "$tmp" "$out"
trap - EXIT
printf '✓ wrote %s\n' "$out"
