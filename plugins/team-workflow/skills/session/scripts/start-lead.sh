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
#   IA_TW_AGENT      Agent to boot. Default: team-workflow:lead.
#                    e.g. team-workflow:repo-worker for single-repo,
#                    clone-work-PR sessions inside a long-lived pod.
#   IA_TW_PROVISION  How the orchestrator gets its working copy:
#                      worktree-local — git worktree in a sibling repo
#                                       (default; lead's classic mode)
#                      clone          — git clone of a remote URL into a
#                                       managed dir on a persistent volume
#                                       (repo-worker / Kubernetes pod mode)
#   IA_TW_REPO_URL   Git URL to clone when IA_TW_PROVISION=clone.
set -euo pipefail

feature="${1:?feature required}"
topic="${2:-}"
request="${3:?request required}"

agent="${IA_TW_AGENT:-team-workflow:lead}"
provision="${IA_TW_PROVISION:-worktree-local}"
repo_url="${IA_TW_REPO_URL:-}"

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
  "IA_TW_PROVISION=$provision"
)
[ -n "$topic" ]    && env_args+=("SLACK_TOPICS=$topic")
[ -n "$repo_url" ] && env_args+=("IA_TW_REPO_URL=$repo_url")
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
echo "  attach: tmux attach -t $feature"
