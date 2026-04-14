/**
 * Slack Socket Mode listener.
 * Single connection — routes messages to registered subscribers via HTTP.
 */

import pkg from '@slack/bolt';
import { log, error as logError } from './logger.js';
const { App, LogLevel } = pkg;

export interface ListenerConfig {
  botToken: string;
  appToken: string;
}

export interface SlackEvent {
  channel_id: string;
  user_id: string;
  text: string;
  message_ts: string;
  thread_ts?: string;
}

export type MessageHandler = (event: SlackEvent) => Promise<void>;

export async function startListener(
  config: ListenerConfig,
  onMessage: MessageHandler,
): Promise<InstanceType<typeof App>> {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  const userCache = new Map<string, string>();
  const channelCache = new Map<string, string>();

  app.message(async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>;
    const text = msg['text'] as string | undefined;

    if (!text || msg['bot_id'] || msg['subtype']) return;

    await onMessage({
      channel_id: msg['channel'] as string,
      user_id: (msg['user'] as string) ?? 'unknown',
      text,
      message_ts: msg['ts'] as string,
      thread_ts: msg['thread_ts'] as string | undefined,
    });
  });

  app.event('app_mention', async ({ event }) => {
    if (!event.text) return;

    await onMessage({
      channel_id: event.channel,
      user_id: event.user ?? 'unknown',
      text: event.text,
      message_ts: event.ts,
      thread_ts: event.thread_ts ?? undefined,
    });
  });

  app.error(async (error) => {
    logError(`[bolt] ${error}`);
  });

  // Expose caches for name resolution
  (app as unknown as Record<string, unknown>)['_userCache'] = userCache;
  (app as unknown as Record<string, unknown>)['_channelCache'] = channelCache;

  await app.start();
  log('[daemon] Socket Mode connected');

  return app;
}

/** Resolve user ID → display name using Slack API */
export async function resolveUser(app: InstanceType<typeof App>, userId: string): Promise<string> {
  const cache = (app as unknown as Record<string, Map<string, string>>)['_userCache'];
  if (cache.has(userId)) return cache.get(userId)!;

  try {
    const result = await app.client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.name || userId;
    cache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/** Resolve channel ID → channel name using Slack API */
export async function resolveChannel(
  app: InstanceType<typeof App>,
  channelId: string,
): Promise<string> {
  const cache = (app as unknown as Record<string, Map<string, string>>)['_channelCache'];
  if (cache.has(channelId)) return cache.get(channelId)!;

  try {
    const result = await app.client.conversations.info({ channel: channelId });
    const name = result.channel?.name || channelId;
    cache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}
