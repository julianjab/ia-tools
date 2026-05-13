#!/usr/bin/env bash
# Spawn a team-lead sub-session in a tmux session.
#
# Usage:
#   start-team-lead.sh <feature> <topic|""> <request>
#
# Exports the IA_TW_* env vars the team-lead expects, plus SLACK_TOPICS for
# the slack-bridge MCP auto-subscribe (when topic is non-empty).
set -euo pipefail

feature="${1:?feature required}"
topic="${2:-}"
request="${3:?request required}"

# Topic hash: $topic if set, else "local:$feature".
hash_key="${topic:-local:$feature}"
topic_hash=$(printf '%s' "$hash_key" | shasum | head -c 12)

state_dir="$HOME/.claude/team-workflow/state/$topic_hash"
mkdir -p "$state_dir"

# If CWD is a git repo, ensure .worktrees/ is in its .gitignore.
# For multi-repo features the team-lead handles the same step per
# target repo when it provisions each worktree.
if git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  gi="$(git -C "$PWD" rev-parse --show-toplevel)/.gitignore"
  if ! grep -qxF '.worktrees/' "$gi" 2>/dev/null; then
    printf '\n.worktrees/\n' >> "$gi"
  fi
fi

env_args=(
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
  "IA_TW_FEATURE=$feature"
  "IA_TW_TOPIC=${topic:-local}"
  "IA_TW_REQUEST=$request"
  "IA_TW_ROOT_DIR=$PWD"
  "IA_TW_STATE_DIR=$state_dir"
)
[ -n "$topic" ] && env_args+=("SLACK_TOPICS=$topic")
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && env_args+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")

tmux new-session -d -s "$feature" -c "$PWD" -- \
  env "${env_args[@]}" \
  claude --agent team-workflow:team-lead \
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

echo "✓ team-lead spawned (tmux: $feature, state: $state_dir)"
echo "  attach: tmux attach -t $feature"
