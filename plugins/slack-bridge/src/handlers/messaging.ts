/**
 * Tool handlers for `claim_message` and `reply`. Extracted from
 * `mcp-server.ts` for SRP — these two handlers share the same dep set
 * (web client + daemon client + logger) so they live together.
 */

import type { WebClient } from '@slack/web-api';
import { addThinkingAck, clearThinkingAck } from '../ack-client.js';
import type { DaemonClient } from '../daemon-client.js';

/**
 * Dependencies for the messaging-related handlers. Kept minimal per
 * Interface Segregation — `claim_message` needs the daemon client,
 * `reply` needs the WebClient.
 */
export interface MessagingHandlerDeps {
  web: WebClient;
  daemonClient: DaemonClient | null;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export async function handleClaimMessage(
  args: Record<string, unknown>,
  deps: MessagingHandlerDeps,
): Promise<ToolResult> {
  try {
    if (!deps.daemonClient) {
      throw new Error('DAEMON_URL is not set — cannot claim messages');
    }
    const { message_ts, channel_id, thread_ts } = args as {
      message_ts: string;
      channel_id?: string;
      thread_ts?: string;
    };
    const result = await deps.daemonClient.claim(message_ts);
    if (result.claimed) {
      if (channel_id) {
        await addThinkingAck(deps.web, { channel_id, message_ts, thread_ts });
      }
      return { content: [{ type: 'text' as const, text: 'Claimed — you may reply.' }] };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Already claimed by another session (:${result.claimed_by}). Do NOT reply.`,
        },
      ],
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Claim error: ${err}` }], isError: true };
  }
}

export async function handleReply(
  args: Record<string, unknown>,
  deps: MessagingHandlerDeps,
): Promise<ToolResult> {
  const { channel_id, text, message_ts, thread_ts } = args as {
    channel_id: string;
    text: string;
    message_ts?: string;
    thread_ts?: string;
  };

  try {
    const result = await deps.web.chat.postMessage({ channel: channel_id, text, thread_ts });
    if (message_ts) {
      await clearThinkingAck(deps.web, { channel_id, message_ts, thread_ts });
    }

    return { content: [{ type: 'text' as const, text: `Sent (ts: ${result.ts})` }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
  }
}

export async function handleReplyUpdate(
  args: Record<string, unknown>,
  deps: MessagingHandlerDeps,
): Promise<ToolResult> {
  const { channel_id, ts, text } = args as { channel_id: string; ts: string; text: string };
  try {
    await deps.web.chat.update({ channel: channel_id, ts, text });
    return { content: [{ type: 'text' as const, text: 'Updated.' }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
  }
}
