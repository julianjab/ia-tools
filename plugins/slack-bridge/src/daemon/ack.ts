/**
 * Best-effort thinking acknowledgement helpers for the daemon.
 *
 * Both calls are fire-and-forget; rejections are swallowed so a
 * Slack API error never blocks message routing.
 */

import type { App } from '@slack/bolt';
import type { SlackMessage } from '../shared/types.js';
import { warn } from './logger.js';

export interface AckOptions {
  emoji?: string;
  status?: string;
}

/**
 * Adds a reaction emoji and sets the assistant thread status to signal
 * that Claude is working on the message. Both Slack API calls are
 * best-effort — failures are logged and swallowed.
 */
export async function addThinkingAck(
  app: App,
  msg: SlackMessage,
  opts?: AckOptions,
): Promise<void> {
  const emoji = opts?.emoji ?? 'eyes';
  const status = opts?.status ?? 'thinking...';

  // Fire both calls concurrently; catch each one independently so the
  // second always executes even if the first rejects.
  await Promise.allSettled([
    app.client.reactions
      .add({
        name: emoji,
        channel: msg.channel_id,
        timestamp: msg.message_ts,
      })
      .catch((err: unknown) => warn(`[ack] reactions.add failed: ${err}`)),

    (async () => {
      const threadTs = msg.thread_ts ?? msg.message_ts;
      try {
        await setAssistantStatus(app, msg.channel_id, threadTs, status);
      } catch (err) {
        warn(`[ack] assistant.threads.setStatus failed: ${err}`);
      }
    })(),
  ]);
}

interface AssistantClient {
  assistant?: { threads?: { setStatus: (args: unknown) => Promise<unknown> } };
  apiCall: (method: string, args: unknown) => Promise<unknown>;
}

async function setAssistantStatus(
  app: App,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  const client = app.client as unknown as AssistantClient;
  const args = { channel_id: channelId, thread_ts: threadTs, status };
  if (client.assistant?.threads?.setStatus) {
    await client.assistant.threads.setStatus(args);
  } else {
    await client.apiCall('assistant.threads.setStatus', args);
  }
}
