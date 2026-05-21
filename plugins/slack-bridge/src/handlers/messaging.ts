/**
 * Tool handlers for `reply` (claim+ack+post+clearAck atomic) and the
 * deprecated `claim_message` shim. Extracted from `mcp-server.ts` for SRP.
 *
 * `reply` now folds claim into the post path so no caller can skip it:
 *   claim(message_ts) → addThinkingAck → chat.postMessage → clearThinkingAck.
 * If the claim is lost the post is skipped and the call returns an error.
 *
 * `claim_message` is kept as a deprecated no-op for one release so existing
 * agent prompts keep working while they migrate.
 */

import type { WebClient } from '@slack/web-api';
import { addThinkingAck, clearThinkingAck } from '../ack-client.js';
import type { DaemonClient } from '../daemon-client.js';

export interface MessagingHandlerDeps {
  web: WebClient;
  daemonClient: DaemonClient | null;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export async function handleClaimMessage(
  _args: Record<string, unknown>,
  _deps: MessagingHandlerDeps,
): Promise<ToolResult> {
  process.stderr.write(
    '[slack-bridge] claim_message is deprecated and a no-op — reply() now claims atomically.\n',
  );
  return {
    content: [
      {
        type: 'text' as const,
        text: 'claim_message is deprecated and a no-op — reply() now claims atomically. You may call reply() directly with message_ts.',
      },
    ],
  };
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

  if (!channel_id || !text) {
    return {
      content: [{ type: 'text' as const, text: 'Error: channel_id and text are required.' }],
      isError: true,
    };
  }
  if (!message_ts) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: message_ts is required. reply() claims the message before posting; pass the inbound notification message_ts.',
        },
      ],
      isError: true,
    };
  }
  if (!deps.daemonClient) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: DAEMON_URL is not set — reply() requires the daemon to claim before posting.',
        },
      ],
      isError: true,
    };
  }

  try {
    const claim = await deps.daemonClient.claim(message_ts);
    if (!claim.claimed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Already claimed by another session (:${claim.claimed_by}). Reply skipped.`,
          },
        ],
        isError: true,
      };
    }
    await addThinkingAck(deps.web, { channel_id, message_ts, thread_ts });
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Claim error: ${err}` }],
      isError: true,
    };
  }

  // Post-claim: on chat.postMessage failure we intentionally do NOT call
  // clearThinkingAck so the operator sees the failed state in Slack.
  try {
    const result = await deps.web.chat.postMessage({ channel: channel_id, text, thread_ts });
    await clearThinkingAck(deps.web, { channel_id, message_ts, thread_ts });
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
