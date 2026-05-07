/**
 * Slack Socket Mode listener.
 * Single connection — routes messages to registered subscribers via HTTP.
 */

import pkg from '@slack/bolt';
import { channelCache, userCache } from './caches.js';
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
  /** Thread context from the Slack Agent (originating channel/workspace). */
  thread_context?: Record<string, unknown>;
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

    userMessage: async ({ event, setTitle, setStatus, getThreadContext }) => {
      // Narrow MessageEvent union to GenericMessageEvent (subtype: undefined).
      // All other subtypes (bot_message, channel_join, etc.) are not user messages.
      if (event.subtype !== undefined) return;
      const text = event.text;
      if (!text) return;

      // Immediate feedback — fires before the daemon routes to a subscriber
      await setStatus('está pensando...');

      // Set the thread title to the first ~50 chars of the message so the
      // user can identify the conversation in the Agent split-view sidebar.
      await setTitle(text.slice(0, 50)).catch(() => {});

      // Read thread context (what channel/workspace the user was viewing when
      // they opened the Assistant thread). Forwarded to subscribers so the
      // agent knows the originating context without a separate API call.
      let threadCtx: Record<string, unknown> | undefined;
      try {
        const ctx = await getThreadContext();
        if (ctx && typeof ctx === 'object') threadCtx = ctx as Record<string, unknown>;
      } catch {
        // Context may be absent on the first message in a new thread.
      }

      try {
        await onMessage({
          channel_id: event.channel,
          user_id: event.user ?? 'unknown',
          text,
          message_ts: event.ts,
          thread_ts: event.thread_ts,
          thread_context: threadCtx,
        });
      } catch (err) {
        logError(`[userMessage] ${err}`);
      }
    },
  });

  app.assistant(assistant);

  // ── Channel @mentions ─────────────────────────────────────────────────────
  app.event('app_mention', async ({ event }) => {
    if (!event.text || !event.user) return;
    try {
      await onMessage({
        channel_id: event.channel,
        user_id: event.user,
        text: event.text,
        message_ts: event.ts,
        thread_ts: event.thread_ts ?? undefined,
      });
    } catch (err) {
      logError(`[app_mention] ${err}`);
    }
  });

  // ── Feedback button acknowledgment ────────────────────────────────────────
  // Ack feedback block_actions immediately so Slack doesn't show an error.
  // No further processing needed — reactions are logged via Slack's native UX.
  app.action(/^feedback_(thumbs_up|thumbs_down)$/, async ({ ack }) => {
    await ack();
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
  const cached = userCache.get(userId);
  if (cached !== undefined) return cached;

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
  const cached = channelCache.get(channelId);
  if (cached !== undefined) return cached;

  try {
    const result = await app.client.conversations.info({ channel: channelId });
    const name = result.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}
