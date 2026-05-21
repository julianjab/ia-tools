#!/usr/bin/env bash
# Spawn the router agent in a detached tmux session.
#
# Hides the --dangerously-load-development-channels flag inside this
# wrapper so operators don't tipe it on every boot. slack-bridge is a
# local plugin channel, not on Anthropic's research-preview allowlist,
# so the dev-channels flag is the supported path for now. When/if the
# plugin lands in the org's allowedChannelPlugins managed setting,
# this script's claude invocation can be simplified to --channels.
#
# Usage:
#   bash start-router.sh [slack-topic] [tmux-session-name]
#
# Positional args:
#   $1  topic        Optional. Slack-bridge topic(s) to subscribe at boot.
#                    Omit to start the router without any subscription;
#                    use subscribe_slack inside the session later.
#                    Shapes:
#                      DM:<user_id>                       — DMs with the user
#                      <channel_id>                       — entire channel
#                      <channel_id>:*:<thread_ts>         — single thread
#                    Comma-separated for multiple topics at once.
#   $2  session      Optional. tmux session name. Default: "sm".
#                    Must not be passed if $1 is omitted (use -- or just
#                    pass "" as $1 to supply a session name without a topic).
set -euo pipefail

topic="${1:-}"
session_name="${2:-sm}"

if [ -n "$topic" ]; then
  case "$topic" in
    *$'\n'*|*$'\r'*) echo "invalid character in topic" >&2; exit 1 ;;
  esac
fi
case "$session_name" in
  *.*|*:*) echo "tmux session name must not contain . or :" >&2; exit 1 ;;
esac

# Reuse if already running.
if tmux has-session -t "$session_name" 2>/dev/null; then
  echo "✓ tmux session '$session_name' already exists — not relaunching."
  echo "  attach: tmux attach -t $session_name"
  exit 0
fi

# Parent-IPC socket: the router runs a small Node Unix-socket server in
# background so child leads booted in local mode (no Slack topic) can
# escalate questions to the router-Claude. The server injects each ask
# into this tmux session via tmux send-keys; the router-Claude responds
# via the /ipc-answer skill which writes back through the same socket.
ipc_dir="${HOME}/.claude/team-workflow/ipc"
mkdir -p "$ipc_dir"
ipc_sock="${ipc_dir}/router-${session_name}.sock"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

# Spawn the server in the background, fully detached. It outlives this
# wrapper and stays bound to the socket for as long as the router tmux
# session exists; a SIGTERM (e.g. on `tmux kill-session`) cleans it up.
if command -v node >/dev/null 2>&1; then
  IA_TW_PARENT_SOCK="$ipc_sock" \
  IA_TW_PARENT_TMUX_SESSION="$session_name" \
    nohup node "$script_dir/ipc-server.mjs" >/tmp/ia-tw-ipc-router-"$session_name".log 2>&1 &
  disown $! 2>/dev/null || true
  # Pointer file so /ask-user can discover the socket without env propagation.
  printf '%s\n' "$ipc_sock" > "${ipc_dir}/current.sock"
else
  echo "warning: node not found — parent-IPC disabled. Child leads will fall back to AskUserQuestion in local mode." >&2
fi

env_args=(
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
  "CLAUDE_CODE_DISABLE_AGENT_VIEW=1"
  "IA_TW_PARENT_SOCK=$ipc_sock"
  "IA_TW_PARENT_TMUX_SESSION=$session_name"
)
[ -n "$topic" ] && env_args+=("SLACK_TOPICS=$topic")
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && env_args+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")

tmux new-session -d -s "$session_name" -c "$PWD" -- \
  env "${env_args[@]}" \
  claude --agent team-workflow:router \
         --dangerously-load-development-channels plugin:slack-bridge@ia-tools \
         --dangerously-skip-permissions

# Boot-prompt poller (same pattern as start-lead.sh): dismiss the
# dev-channels and trust-folder prompts so the operator doesn't have to
# attach just to press Enter twice. Runs at most 30s in background.
(
  for _ in $(seq 1 15); do
    sleep 2
    out=$(tmux capture-pane -p -t "$session_name" 2>/dev/null | tail -15) || break
    case "$out" in
      *"local development"*|*"Trust the files"*|*"trust the files"*|*"Do you trust"*)
        tmux send-keys -t "$session_name" Enter
        ;;
    esac
  done
) >/dev/null 2>&1 &

if [ -n "$topic" ]; then
  echo "✓ router booted (tmux: $session_name, topic: $topic)"
else
  echo "✓ router booted (tmux: $session_name, no topic — subscribe later with subscribe_slack)"
fi
echo "  attach: tmux attach -t $session_name"
