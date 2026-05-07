/**
 * Slack Socket Mode listener.
 * Single connection — routes messages to registered subscribers via HTTP.
 */

import pkg from '@slack/bolt';
import { log, error as logError } from './logger.js';

const { App, Assistant, LogLevel } = pkg;

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

// Module-level caches shared across all resolutions within one daemon process
const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();

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

  // ── Agent / Assistant — DMs and split-view threads ────────────────────────
  // Handles all DM messages when the bot is configured as a Slack Agent.
  // `userMessage` takes precedence over `app.message` for im events in
  // Bolt v4, so no deduplication is needed — we omit `app.message` entirely.
  const assistant = new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts }) => {
      await say('¡Hola! ¿En qué te ayudo?');
      await setSuggestedPrompts({
        prompts: [
          { title: 'Abrir sesión de trabajo', message: 'Quiero trabajar en...' },
          { title: 'Estado de sesiones', message: '¿Qué sesiones hay activas?' },
          { title: 'Ayuda', message: '¿Qué puedes hacer?' },
        ],
      });
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ event, setStatus }) => {
      const msg = event as unknown as Record<string, unknown>;
      const text = msg.text as string | undefined;
      if (!text || msg.subtype) return;

      // Immediate feedback — fires before the daemon routes to a subscriber
      await setStatus('está pensando...');

      try {
        await onMessage({
          channel_id: msg.channel as string,
          user_id: (msg.user as string) ?? 'unknown',
          text,
          message_ts: msg.ts as string,
          thread_ts: msg.thread_ts as string | undefined,
        });
      } catch (err) {
        logError(`[userMessage] ${err}`);
      }
    },
  });

  app.assistant(assistant);

  // ── Channel @mentions ─────────────────────────────────────────────────────
  app.event('app_mention', async ({ event }) => {
    if (!event.text) return;
    try {
      await onMessage({
        channel_id: event.channel,
        user_id: event.user ?? 'unknown',
        text: event.text,
        message_ts: event.ts,
        thread_ts: event.thread_ts ?? undefined,
      });
    } catch (err) {
      logError(`[app_mention] ${err}`);
    }
  });

  app.error(async (error) => {
    logError(`[bolt] ${error}`);
  });

  await app.start();
  log('[daemon] Socket Mode connected');

  return app;
}

/** Resolve user ID → display name using Slack API */
export async function resolveUser(app: InstanceType<typeof App>, userId: string): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  try {
    const result = await app.client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.name || userId;
    userCache.set(userId, name);
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
  if (channelCache.has(channelId)) return channelCache.get(channelId)!;

  try {
    const result = await app.client.conversations.info({ channel: channelId });
    const name = result.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}
