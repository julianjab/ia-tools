#!/usr/bin/env bash
# Spawn an orchestrator sub-session in a tmux session.
#
# Usage:
#   start-lead.sh <feature> <topic|""> <request>
#
# Exports the IA_TW_* env vars the orchestrator expects, plus SLACK_TOPICS
# for the slack-bridge MCP auto-subscribe (when topic is non-empty).
#
# Parametrization (env-var overridable — this is what makes team-workflow
# non-static; the spawner picks the persona and provisioning strategy):
#   IA_TW_AGENT              Agent to boot. Default: team-workflow:lead.
#                            e.g. team-workflow:repo-worker for single-repo,
#                            clone-work-PR sessions inside a long-lived pod.
#   IA_TW_TOPIC_WORKER_AGENT topic-worker persona the router spawns for
#                            answer/ask intents. Default: team-workflow:topic-worker.
#   IA_TW_PROVISION          worktree-local (default) | clone | none.
#   IA_TW_REPO_URL           Singular repo URL when IA_TW_PROVISION=clone.
#   IA_TW_REPO_URLS          CSV of repo URLs for multi-repo pods. Pre-clone
#                            iterates over this list when set.
#
# Configuration cascade: if .claude/team-workflow.yaml exists in $PWD or
# $HOME, load-tw-config.sh maps it into these env vars before we spawn.
# Env vars already set always win over the file.
set -euo pipefail

# Load .claude/team-workflow.yaml when present (env wins). Tolerate missing yq.
_loader="$(dirname "${BASH_SOURCE[0]}")/load-tw-config.sh"
if [ -f "$_loader" ]; then
  # shellcheck disable=SC1090
  . "$_loader" || echo "start-lead: load-tw-config.sh skipped (yq missing or error)" >&2
fi

feature="${1:?feature required}"
topic="${2:-}"
request="${3:?request required}"

agent="${IA_TW_AGENT:-team-workflow:lead}"
topic_worker_agent="${IA_TW_TOPIC_WORKER_AGENT:-team-workflow:topic-worker}"
provision="${IA_TW_PROVISION:-worktree-local}"
repo_url="${IA_TW_REPO_URL:-}"
repo_urls="${IA_TW_REPO_URLS:-}"

# Topic hash: $topic if set, else "local:$feature".
hash_key="${topic:-local:$feature}"
topic_hash=$(printf '%s' "$hash_key" | shasum | head -c 12)

state_dir="$HOME/.claude/team-workflow/state/$topic_hash"
mkdir -p "$state_dir"

# Note: .worktrees/ is added to each target repo's .gitignore by
# /worktree init (see skills/worktree/scripts/init.sh). The wrapper
# never touches consumer repo state.

env_args=(
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
  "CLAUDE_CODE_DISABLE_AGENT_VIEW=1"
  "IA_TW_FEATURE=$feature"
  "IA_TW_TOPIC=${topic:-local}"
  "IA_TW_REQUEST=$request"
  "IA_TW_ROOT_DIR=$PWD"
  "IA_TW_STATE_DIR=$state_dir"
  "IA_TW_AGENT=$agent"
  "IA_TW_TOPIC_WORKER_AGENT=$topic_worker_agent"
  "IA_TW_PROVISION=$provision"
)
[ -n "$topic" ]                      && env_args+=("SLACK_TOPICS=$topic")
[ -n "$repo_url" ]                   && env_args+=("IA_TW_REPO_URL=$repo_url")
[ -n "$repo_urls" ]                  && env_args+=("IA_TW_REPO_URLS=$repo_urls")
[ -n "${IA_TW_REPO_CACHE_DIR:-}" ]   && env_args+=("IA_TW_REPO_CACHE_DIR=$IA_TW_REPO_CACHE_DIR")
[ -n "${ALLOWED_USERS_DM:-}" ]       && env_args+=("ALLOWED_USERS_DM=$ALLOWED_USERS_DM")
[ -n "${ALLOWED_USERS_MENTIONS:-}" ] && env_args+=("ALLOWED_USERS_MENTIONS=$ALLOWED_USERS_MENTIONS")
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && env_args+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")

tmux new-session -d -s "$feature" -c "$PWD" -- \
  env "${env_args[@]}" \
  claude --agent "$agent" \
         --dangerously-load-development-channels plugin:slack-bridge@ia-tools \
         --dangerously-skip-permissions \
         "$request"

# Boot-prompt poller: dismisses the two one-time prompts (dev-channels
# warning + trust-folder) by sending Enter when their patterns appear.
# Runs at most 30s in background, then exits — does NOT touch later
# prompts like ExitPlanMode.
(
  for _ in $(seq 1 15); do
    sleep 2
    out=$(tmux capture-pane -p -t "$feature" 2>/dev/null | tail -15) || break
    case "$out" in
      *"local development"*|*"Trust the files"*|*"trust the files"*|*"Do you trust"*)
        tmux send-keys -t "$feature" Enter
        ;;
    esac
  done
) >/dev/null 2>&1 &

echo "✓ $agent spawned (tmux: $feature, provision: $provision, state: $state_dir)"
echo "  topic-worker: $topic_worker_agent"
[ -n "$repo_url$repo_urls" ] && echo "  repo(s): ${repo_urls:-$repo_url}"
echo "  attach: tmux attach -t $feature"
