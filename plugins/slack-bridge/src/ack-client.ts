/**
 * MCP-side helper to clear the thinking acknowledgement after a reply is sent.
 *
 * Both calls are best-effort — rejections are swallowed so a Slack API error
 * never surfaces to the caller.
 *
 * The emoji to remove is read from SLACK_ACK_EMOJI at call time so that
 * the env var can be changed without restarting the process.
 */

import type { WebClient } from '@slack/web-api';

export interface ClearAckArgs {
  channel_id: string;
  message_ts: string;
  thread_ts?: string;
}

export interface AddAckArgs {
  channel_id: string;
  message_ts: string;
  thread_ts?: string;
}

/**
 * Add the reaction emoji and set the assistant thread status to signal
 * that Claude is processing the message. Called from handleClaimMessage
 * in the MCP so the daemon stays as pure routing infrastructure.
 */
export async function addThinkingAck(web: WebClient, args: AddAckArgs): Promise<void> {
  const emoji = process.env.SLACK_ACK_EMOJI ?? 'eyes';
  const status = process.env.SLACK_ACK_STATUS ?? 'thinking...';
  const threadTs = args.thread_ts ?? args.message_ts;

  await Promise.allSettled([
    web.reactions
      .add({
        name: emoji,
        channel: args.channel_id,
        timestamp: args.message_ts,
      })
      .catch((err: unknown) => warn(`[ack-client] reactions.add failed: ${err}`)),

    (async () => {
      try {
        const client = web as unknown as {
          assistant?: { threads?: { setStatus: (args: unknown) => Promise<unknown> } };
          apiCall: (method: string, args: unknown) => Promise<unknown>;
        };
        if (client.assistant?.threads?.setStatus) {
          await client.assistant.threads.setStatus({
            channel_id: args.channel_id,
            thread_ts: threadTs,
            status,
          });
        } else {
          await client.apiCall('assistant.threads.setStatus', {
            channel_id: args.channel_id,
            thread_ts: threadTs,
            status,
          });
        }
      } catch (err) {
        warn(`[ack-client] assistant.threads.setStatus failed: ${err}`);
      }
    })(),
  ]);
}

function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Remove the reaction emoji and clear the assistant thread status, signalling
 * that the reply has been delivered.
 */
export async function clearThinkingAck(web: WebClient, args: ClearAckArgs): Promise<void> {
  const emoji = process.env.SLACK_ACK_EMOJI ?? 'eyes';
  const threadTs = args.thread_ts ?? args.message_ts;

  await Promise.allSettled([
    web.reactions
      .remove({
        name: emoji,
        channel: args.channel_id,
        timestamp: args.message_ts,
      })
      .catch((err: unknown) => warn(`[ack-client] reactions.remove failed: ${err}`)),

    (async () => {
      try {
        const client = web as unknown as {
          assistant?: { threads?: { setStatus: (args: unknown) => Promise<unknown> } };
          apiCall: (method: string, args: unknown) => Promise<unknown>;
        };
        if (client.assistant?.threads?.setStatus) {
          await client.assistant.threads.setStatus({
            channel_id: args.channel_id,
            thread_ts: threadTs,
            status: '',
          });
        } else {
          await client.apiCall('assistant.threads.setStatus', {
            channel_id: args.channel_id,
            thread_ts: threadTs,
            status: '',
          });
        }
      } catch (err) {
        warn(`[ack-client] assistant.threads.setStatus failed: ${err}`);
      }
    })(),
  ]);
}
