/**
 * Tool handlers for `claim_message` and `reply`.
 *
 * Multiple Claude sessions can subscribe to the same Slack topic (DM,
 * channel, thread). To keep two sessions from working the same inbound
 * in parallel, the daemon owns a claim map keyed by `message_ts`:
 *
 *   claim_message(ts)  — call this BEFORE doing any work on the inbound
 *                        (Reads, Greps, Agent calls, drafting). First
 *                        session wins; losers get isError and exit the
 *                        turn without working.
 *
 *   reply(ts, …)       — post + clear the indicator. Re-claims (idempotent
 *                        for the holder) so a session that claimed upfront
 *                        posts normally, while a session whose claim was
 *                        lost gets isError instead of double-posting.
 *
 * The thinking indicator (👀 + assistant.threads.setStatus) lives across
 * both calls — `claim_message` sets it when work begins, `reply` clears
 * it on a successful post.
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
  args: Record<string, unknown>,
  deps: MessagingHandlerDeps,
): Promise<ToolResult> {
  const { message_ts, channel_id, thread_ts } = args as {
    message_ts?: string;
    channel_id?: string;
    thread_ts?: string;
  };
  if (!message_ts) {
    return {
      content: [{ type: 'text' as const, text: 'Error: message_ts is required.' }],
      isError: true,
    };
  }
  if (!deps.daemonClient) {
    // No daemon → no multi-session contention. Treat as held by this
    // session so the rest of the workflow proceeds normally.
    if (channel_id) {
      await addThinkingAck(deps.web, { channel_id, message_ts, thread_ts });
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Claimed (no daemon — single-session mode). Work the message and call reply() when done.',
        },
      ],
    };
  }
  try {
    const result = await deps.daemonClient.claim(message_ts);
    if (!result.claimed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Already claimed by another session (:${result.claimed_by}). Exit this turn — do not work the message.`,
          },
        ],
        isError: true,
      };
    }
    if (channel_id) {
      await addThinkingAck(deps.web, { channel_id, message_ts, thread_ts });
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Claimed — work the message. The thinking indicator is visible until reply() clears it.',
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
