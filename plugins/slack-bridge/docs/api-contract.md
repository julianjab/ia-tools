# API Contract — slack-bridge DM + thinking ack

Internal contracts for REQ-001. No HTTP surface changes — this covers the TypeScript interfaces, MCP tool schemas, and the Slack Web API calls.

## 1. SlackMessage (shared/types.ts)

```ts
export interface SlackMessage {
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  text: string;
  message_ts: string;
  thread_ts?: string;
  is_dm: boolean; // NEW — true iff channel_id starts with "D"
}
```

Rule: `is_dm = channel_id.startsWith('D')`. Group DMs (`G*`) and public channels (`C*`) are `false`.

## 2. Notification meta (MCP → Claude)

`notifications/claude/channel` meta gains one field:

```ts
meta: {
  source: 'slack-bridge',
  channel_id: string,
  channel_name: string,
  user_id: string,
  user_name: string,
  message_ts: string,
  thread_ts: string,   // existing — '' when absent
  is_dm: boolean,      // NEW
}
```

## 3. Daemon ack (daemon/ack.ts — NEW)

```ts
import type { App } from '@slack/bolt';
import type { SlackMessage } from '../shared/types.js';

export interface AckOptions {
  emoji: string;   // default "eyes"
  status: string;  // default "thinking..."
}

export async function addThinkingAck(
  app: App,
  msg: SlackMessage,
  opts: AckOptions,
): Promise<void>;
```

Semantics:
1. `app.client.reactions.add({ name: opts.emoji, channel: msg.channel_id, timestamp: msg.message_ts })` — wrapped in `.catch(warn)`.
2. `app.client.assistant.threads.setStatus({ channel_id: msg.channel_id, thread_ts: msg.thread_ts ?? msg.message_ts, status: opts.status })` — wrapped in `.catch(warn)`.
3. Both rejections are swallowed; the function always resolves.

Env bootstrap (read once at daemon startup in `daemon/index.ts`):

```ts
const ackOpts: AckOptions = {
  emoji: process.env.SLACK_ACK_EMOJI ?? 'eyes',
  status: process.env.SLACK_ACK_STATUS ?? 'thinking...',
};
```

Call site (after `registry.match`, before fan-out):

```ts
const targets = registry.match(msg);
if (targets.length === 0) { /* drop */ return; }
await addThinkingAck(app, msg, ackOpts);
// ...existing fan-out...
```

## 4. Ack cleanup (mcp-server.ts — NEW ack-client.ts)

```ts
import type { WebClient } from '@slack/web-api';

export interface ClearAckArgs {
  channel_id: string;
  message_ts: string;
  thread_ts?: string;
}

export async function clearThinkingAck(
  web: WebClient,
  args: ClearAckArgs,
): Promise<void>;
```

Semantics:
1. Resolve emoji name from `process.env.SLACK_ACK_EMOJI ?? 'eyes'`.
2. `web.reactions.remove({ name, channel: args.channel_id, timestamp: args.message_ts })` — `.catch(warn)`.
3. `web.assistant.threads.setStatus({ channel_id: args.channel_id, thread_ts: args.thread_ts ?? args.message_ts, status: '' })` — `.catch(warn)`.
4. Always resolves. Never throws.

## 5. MCP tool — reply (BREAKING)

```json
{
  "name": "reply",
  "description": "Reply to a Slack message. Pass message_ts (the ts of the user message you are replying to) so the bridge can clear the thinking ack. In DMs omit thread_ts unless the source message already had one — passing thread_ts in a top-level DM message creates a new reply thread.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "channel_id": { "type": "string" },
      "text":       { "type": "string" },
      "message_ts": { "type": "string", "description": "ts of the message being replied to (used to clear the thinking ack)" },
      "thread_ts":  { "type": "string", "description": "Pass only when the source message already had a thread_ts" }
    },
    "required": ["channel_id", "text", "message_ts"]
  }
}
```

Handler flow:

```ts
if (!message_ts) return { content: [...], isError: true };
try {
  const result = await web.chat.postMessage({ channel: channel_id, text, thread_ts });
  await clearThinkingAck(web, { channel_id, message_ts, thread_ts });
  return { content: [{ type: 'text', text: `Sent (ts: ${result.ts})` }] };
} catch (err) {
  // NO cleanup on failure — see REQ-001 out of scope.
  return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
}
```

## 6. Slack scopes required

- `chat:write` (already present)
- `reactions:write` (NEW)
- `assistant:write` (NEW — best-effort; non-Assistant apps silently no-op)
- `im:read` / `im:history` (already present for DMs)

## 7. Env vars

| Name | Default | Read where | Purpose |
|------|---------|------------|---------|
| `SLACK_ACK_EMOJI` | `eyes` | daemon startup + mcp on cleanup | Emoji name used for reactions.add / remove |
| `SLACK_ACK_STATUS` | `thinking...` | daemon startup | Status string for setStatus on route |

## 8. Test doubles

QA should mock:
- `@slack/web-api` `WebClient` via `vi.mock` — stub `chat.postMessage`, `reactions.remove`, `assistant.threads.setStatus`.
- For daemon ack tests, stub a minimal `App`-like object with `client.reactions.add` and `client.assistant.threads.setStatus` spies.
- No real HTTP, no real Socket Mode. `startListener` is not exercised — tests target `addThinkingAck`, `clearThinkingAck`, the message-building block, and the MCP tool handler in isolation.
