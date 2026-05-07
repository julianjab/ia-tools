/**
 * Tool handlers for `read_thread`, `read_channel`, and `list_channels`.
 * Extracted from `mcp-server.ts` for SRP — these are pure read-only Slack
 * Web API wrappers, sharing the same `web` dependency.
 */

import type { WebClient } from '@slack/web-api';

/** Dependencies for the read-only Slack Web API handlers. */
export interface ReadOnlyHandlerDeps {
  web: WebClient;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export async function handleReadThread(
  args: Record<string, unknown>,
  deps: ReadOnlyHandlerDeps,
): Promise<ToolResult> {
  const { channel_id, thread_ts, limit } = args as {
    channel_id: string;
    thread_ts: string;
    limit?: number;
  };
  try {
    const result = await deps.web.conversations.replies({
      channel: channel_id,
      ts: thread_ts,
      limit: limit ?? 20,
    });
    const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
    return { content: [{ type: 'text' as const, text: messages || 'No messages in thread' }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
  }
}

export async function handleReadChannel(
  args: Record<string, unknown>,
  deps: ReadOnlyHandlerDeps,
): Promise<ToolResult> {
  const { channel_id, limit } = args as { channel_id: string; limit?: number };
  try {
    const result = await deps.web.conversations.history({
      channel: channel_id,
      limit: limit ?? 20,
    });
    const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
    return { content: [{ type: 'text' as const, text: messages || 'No messages in channel' }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
  }
}

export async function handleListChannels(deps: ReadOnlyHandlerDeps): Promise<ToolResult> {
  try {
    const result = await deps.web.users.conversations({
      types: 'public_channel,private_channel',
      limit: 100,
    });
    const channels = (result.channels ?? []).map((c) => `#${c.name} (${c.id})`).join('\n');
    return { content: [{ type: 'text' as const, text: channels || 'No channels found' }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
  }
}
