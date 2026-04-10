#!/usr/bin/env bash
#
# ship-thread.sh — Post to Slack and spawn a Claude Code session on that thread.
#
# Usage:
#   ./scripts/ship-thread.sh <channel_id> <message> [--project <path>] [--background]
#
# Modes:
#   Foreground (default): Claude takes over the terminal. Ctrl+C to stop.
#   Background (--background): Claude runs as a daemon. Returns PID and log path.
#
# Requires: SLACK_BOT_TOKEN, SLACK_APP_TOKEN env vars

set -euo pipefail

CHANNEL_ID="${1:?Usage: ship-thread.sh <channel_id> <message> [--project <path>] [--background]}"
MESSAGE="${2:?Usage: ship-thread.sh <channel_id> <message> [--project <path>] [--background]}"
PROJECT_DIR="."
BACKGROUND=false

shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --background) BACKGROUND=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Validate tokens
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN not set}"
: "${SLACK_APP_TOKEN:?SLACK_APP_TOKEN not set}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/../mcp-servers/slack-bridge" && pwd)"

# ─── 1. Post to Slack ────────────────────────────────────────────────
echo "📤 Posting to ${CHANNEL_ID}..."
RESPONSE=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"channel":"%s","text":"%s\\n\\n🤖 _Claude is joining this thread..._"}' "$CHANNEL_ID" "$MESSAGE")")

OK=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null)
if [[ "$OK" != "True" ]]; then
  echo "❌ Failed to post:"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

THREAD_TS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['ts'])")
CH=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['channel'])")

echo "✅ Thread: ts=${THREAD_TS} channel=${CH}"

# ─── 2. Write MCP config to disk ─────────────────────────────────────
MCP_FILE="/tmp/ship-mcp-${THREAD_TS}.json"
cat > "$MCP_FILE" <<EOF
{
  "mcpServers": {
    "slack-bridge": {
      "command": "node",
      "args": ["${BRIDGE_DIR}/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
        "SLACK_APP_TOKEN": "${SLACK_APP_TOKEN}",
        "SLACK_CHANNELS": "${CH}",
        "SLACK_THREAD_TS": "${THREAD_TS}"
      }
    }
  }
}
EOF

# ─── 3. Launch Claude ────────────────────────────────────────────────
PROMPT="You are connected to a Slack thread. Messages arrive as <channel> tags. Reply using reply_slack with channel_id=${CH} and thread_ts=${THREAD_TS}. You have access to the repo. Introduce yourself briefly in the thread."
LOG_FILE="/tmp/ship-claude-${THREAD_TS}.log"

cd "$PROJECT_DIR"

if [[ "$BACKGROUND" == "true" ]]; then
  nohup claude \
    --dangerously-load-development-channels server:slack-bridge \
    --mcp-config "$MCP_FILE" \
    -p "$PROMPT" \
    > "$LOG_FILE" 2>&1 &

  PID=$!
  echo ""
  echo "🤖 Claude running in background"
  echo "   PID:  $PID"
  echo "   Logs: tail -f $LOG_FILE"
  echo "   Stop: kill $PID"
  echo "   MCP:  $MCP_FILE"

  # Output machine-readable for the skill to parse
  echo "---SHIP_RESULT---"
  echo "THREAD_TS=${THREAD_TS}"
  echo "CHANNEL=${CH}"
  echo "PID=${PID}"
  echo "LOG=${LOG_FILE}"
else
  echo ""
  echo "🤖 Starting Claude (Ctrl+C to stop)..."
  echo ""
  exec claude \
    --dangerously-load-development-channels server:slack-bridge \
    --mcp-config "$MCP_FILE" \
    -p "$PROMPT"
fi
