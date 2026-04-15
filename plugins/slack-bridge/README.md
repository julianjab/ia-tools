# slack-bridge

Slack <-> Claude Code bridge: a Socket Mode daemon (singleton) + a lightweight MCP server (subscriber).

## Architecture

```
Slack ─── Socket Mode ─── Daemon (port 3800) ─── HTTP webhooks ─── MCP server(s)
                                                                         │
                                                               Claude Code (tool calls)
```

- **Daemon** — single long-lived process, connects to Slack via Socket Mode, fans messages out to registered MCP instances.
- **MCP server** — per-session, subscribes to the daemon, receives webhooks, exposes tools to Claude.

## Quick start

```bash
# 1. Start daemon (once per machine)
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... pnpm --filter @ia-tools/slack-bridge daemon

# 2. MCP server starts automatically when Claude Code loads the plugin
#    (plugin config at .claude-plugin/plugins/slack-bridge/.mcp.json)
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | — | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Daemon only | — | App-level token for Socket Mode (`xapp-...`) |
| `DAEMON_PORT` | No | `3800` | Daemon HTTP API port |
| `DAEMON_URL` | MCP only | auto-detected | Daemon base URL (e.g. `http://localhost:3800`) |
| `SLACK_CHANNELS` | No | from config | Comma-separated channel IDs to auto-subscribe |
| `SLACK_USERS` | No | from config | Comma-separated user IDs for DM listening |
| `SLACK_THREADS` | No | from config | Comma-separated thread timestamps |
| `SLACK_ACK_EMOJI` | No | `eyes` | Reaction emoji added when Claude starts processing a message |
| `SLACK_ACK_STATUS` | No | `thinking...` | Assistant thread status set while Claude is processing |

### Thinking acknowledgement (`SLACK_ACK_EMOJI` / `SLACK_ACK_STATUS`)

When a message matches at least one subscriber, the daemon fires two best-effort Slack API calls before routing:

1. `reactions.add` — adds the configured emoji to the original message.
2. `assistant.threads.setStatus` — sets the assistant thread status string.

Both calls are fire-and-forget; failures are logged and ignored so they never block routing.

When `reply_slack` sends a successful response, the MCP server clears both indicators:

1. `reactions.remove` — removes the emoji.
2. `assistant.threads.setStatus` — sets status to `""` (cleared).

`setStatus` requires the Slack app to be configured as an Assistant. If the app lacks that capability the call silently no-ops (Slack returns a non-fatal error that is swallowed).

## Required Slack scopes

| Scope | Used for |
|---|---|
| `channels:history` | Reading public channel messages |
| `groups:history` | Reading private channel messages |
| `im:history` | Reading DM messages |
| `mpim:history` | Reading group DM messages |
| `reactions:read` | (optional) Checking existing reactions |
| `reactions:write` | Adding / removing the thinking-ack emoji |
| `assistant:write` | Setting assistant thread status (best-effort — silently no-ops if app is not an Assistant) |
| `chat:write` | Posting replies via `reply_slack` |
| `users:read` | Resolving user display names |
| `channels:read` | Resolving channel names |

## DM reply behavior

Messages from DM channels (`channel_id` starts with `D`) are tagged `is_dm: true` in the notification meta.

When replying to a DM:

- **Omit `thread_ts`** unless the source message notification already included a `thread_ts`. DMs do not use threads by default — passing a `thread_ts` in a plain DM creates an unexpected thread.
- **Always pass `message_ts`** — it is required by `reply_slack` to clear the thinking indicator.

Example notification meta for a DM:
```json
{
  "source": "slack-bridge",
  "channel_id": "D12345",
  "is_dm": true,
  "message_ts": "1700000001.000200",
  "thread_ts": ""
}
```

## Tools

| Tool | Description |
|---|---|
| `subscribe_slack` | Subscribe to channels/DMs/threads; persisted to `.claude/.channels.json` |
| `unsubscribe_slack` | Stop receiving messages |
| `claim_message` | Claim a message before replying (first session wins) |
| `reply_slack` | Post a reply; requires `message_ts` |
| `read_thread` | Fetch thread history |
| `read_channel` | Fetch channel history |
| `list_slack_channels` | List channels the bot belongs to |
