# MCP Slack Bridge

Bidirectional Slack ↔ Claude Code bridge via Socket Mode.

Supports two modes:

- **Poll mode** (default): Messages queue up. Claude calls `poll_slack` to drain them.
- **Reactive mode**: Each incoming message triggers MCP sampling — Claude processes it immediately and can auto-reply.

## Prerequisites

1. A Slack App with **Socket Mode** enabled
2. Claude Code v2.1.80+

## Slack App Setup

### 1. Enable Socket Mode

Go to your Slack App → **Settings → Socket Mode** → Toggle ON.

Generate an **App-Level Token** with scope `connections:write`. Save it as `SLACK_APP_TOKEN`.

### 2. Bot Token Scopes

Under **OAuth & Permissions**, add these Bot Token Scopes:

- `channels:history` — Read messages in public channels
- `channels:read` — List channels
- `groups:history` — Read messages in private channels
- `groups:read` — List private channels
- `chat:write` — Send messages
- `users:read` — Resolve user names
- `app_mentions:read` — Receive @mention events

### 3. Event Subscriptions

Under **Event Subscriptions**, subscribe to these bot events:

- `message.channels` — Messages in public channels
- `message.groups` — Messages in private channels
- `app_mention` — When someone @mentions the bot

### 4. Install to Workspace

Install (or reinstall) the app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-...`).

## Build & Run

```bash
cd mcp-servers/slack-bridge
pnpm install
pnpm build
```

## Configure Claude Code

### Poll Mode (default)

Messages are queued. Claude calls `poll_slack` when it needs to check for new messages.

```json
{
  "mcpServers": {
    "slack-bridge": {
      "command": "node",
      "args": ["./mcp-servers/slack-bridge/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token",
        "SLACK_APP_TOKEN": "xapp-your-app-token",
        "SLACK_CHANNELS": "",
        "SLACK_THREAD_ONLY": "false"
      }
    }
  }
}
```

### Reactive Mode

Each Slack message triggers Claude automatically. Claude processes the message via MCP sampling and can auto-reply in the thread.

```json
{
  "mcpServers": {
    "slack-bridge": {
      "command": "node",
      "args": ["./mcp-servers/slack-bridge/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token",
        "SLACK_APP_TOKEN": "xapp-your-app-token",
        "SLACK_BRIDGE_MODE": "reactive",
        "SLACK_BRIDGE_AUTO_REPLY": "true",
        "SLACK_BRIDGE_MAX_TOKENS": "1024",
        "SLACK_CHANNELS": "C01ABC123,C02DEF456",
        "SLACK_THREAD_ONLY": "false"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | — | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | — | App-Level Token (`xapp-...`) for Socket Mode |
| `SLACK_BRIDGE_MODE` | No | `poll` | `poll` or `reactive` |
| `SLACK_CHANNELS` | No | all | Comma-separated channel IDs to monitor |
| `SLACK_THREAD_ONLY` | No | `false` | `true` to only capture thread replies |
| `SLACK_BRIDGE_AUTO_REPLY` | No | `true` | (Reactive) Whether Claude auto-replies in Slack |
| `SLACK_BRIDGE_MAX_TOKENS` | No | `1024` | (Reactive) Max tokens for Claude's response |
| `SLACK_BRIDGE_SYSTEM_PROMPT` | No | built-in | (Reactive) Custom system prompt for Claude |

## Tools Available to Claude

| Tool | Description |
|---|---|
| `poll_slack` | Drain queued messages received since last poll |
| `send_slack` | Send a message to a channel or thread |
| `read_slack_thread` | Read all replies in a thread |
| `list_channels` | List channels the bot is in |

## Architecture

### Poll Mode

```
Slack ──Socket Mode──▶ Bolt Listener ──push──▶ MessageStore (queue)
                                                      │
                                              poll_slack / send_slack
                                                      │
                                                      ▼
                                               MCP Server (stdio)
                                                      │
                                                Claude Code
```

### Reactive Mode

```
Slack ──Socket Mode──▶ Bolt Listener
                           │
                           │ (message arrives)
                           ▼
                    Reactive Handler
                           │
                           │ MCP sampling request
                           ▼
                    Claude processes message
                           │
                           │ auto-reply (if enabled)
                           ▼
                    send_slack ──▶ Slack thread
```

## Usage Examples

```
# Poll mode — check for new messages
"Poll slack for new messages and summarize them"

# Poll mode — reply to a thread
"Reply to that thread saying we'll fix it by EOD"

# Reactive mode — just runs automatically
# Someone writes in Slack → Claude processes → replies in thread

# Either mode — read a thread for context
"Read the full thread in #incidents about the deploy failure"
```

## Custom System Prompt (Reactive Mode)

You can customize how Claude handles incoming messages by setting `SLACK_BRIDGE_SYSTEM_PROMPT`. The default prompt asks Claude to respond with a JSON object containing `should_reply`, `reply_text`, and `summary` fields.

Example custom prompt:

```
You are a DevOps assistant monitoring Slack. When you receive a message:
- If it mentions a deploy, check recent logs and report status
- If it's a question about infrastructure, answer from your knowledge
- If it's casual, don't reply (set should_reply to false)
Always respond in Spanish.
```
