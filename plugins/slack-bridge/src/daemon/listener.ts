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
  /** Emoji name (without colons) for reaction_added events. */
  reaction?: string;
}

export type MessageHandler = (event: SlackEvent) => Promise<void>;
/** Returns true if any subscriber holds an explicit thread-scoped topic for this channel+thread. */
export type ThreadSubscriptionChecker = (channelId: string, threadTs: string) => boolean;

/** Short-lived dedup set to prevent double-delivery when app_mention and message both fire. */
const recentTs = new Set<string>();
function markSeen(ts: string): boolean {
  if (recentTs.has(ts)) return true;
  recentTs.add(ts);
  setTimeout(() => recentTs.delete(ts), 30_000);
  return false;
}

export async function startListener(
  config: ListenerConfig,
  onMessage: MessageHandler,
  hasThreadSubscription?: ThreadSubscriptionChecker,
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

    userMessage: async ({ event, setTitle, getThreadContext }) => {
      // Narrow MessageEvent union to GenericMessageEvent (subtype: undefined).
      // All other subtypes (bot_message, channel_join, etc.) are not user messages.
      if (event.subtype !== undefined) return;
      const text = event.text;
      if (!text) return;

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
    markSeen(event.ts); // mark so the message handler skips this ts
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

  // ── Channel thread replies (no @mention required) ─────────────────────────
  // Fires for all messages in channels the bot is a member of.
  // Filtered to thread replies only (thread_ts present); top-level channel
  // posts and DMs are excluded. Requires channels:history scope.
  app.event('message', async ({ event }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = event as any;
    // Allow bot_message (e.g. vitruvio replying in a thread); skip everything
    // else: channel_join, file_share, message_changed, etc.
    if (e.subtype !== undefined && e.subtype !== 'bot_message') return;
    if (!e.thread_ts) return;            // only replies inside a thread
    if (!e.user && !e.bot_id) return;    // must have an actor (human or bot)
    if (e.channel?.startsWith('D')) return; // DMs handled by assistant.userMessage
    // Bot replies are only relevant in threads we created and subscribed to.
    if (e.subtype === 'bot_message' && hasThreadSubscription && !hasThreadSubscription(e.channel, e.thread_ts)) return;
    if (markSeen(e.ts)) return;          // already delivered via app_mention
    try {
      await onMessage({
        channel_id: e.channel,
        user_id: e.bot_id ?? e.user,     // bots carry bot_id, humans carry user
        text: e.text ?? '',
        message_ts: e.ts,
        thread_ts: e.thread_ts,
      });
    } catch (err) {
      logError(`[channel_message] ${err}`);
    }
  });

  // ── Emoji reactions ────────────────────────────────────────────────────────
  // Delivers reaction_added events as synthetic messages so subscribers
  // (e.g. lead waiting for approval) can act on ✅ / ❌ without a text reply.
  // thread_ts is set to item.ts so topic C:<channel>:*:<root_ts> matches when
  // the reaction is placed on the root message of the subscribed thread.
  app.event('reaction_added', async ({ event }) => {
    if (event.item.type !== 'message') return;
    if (!event.user) return;
    const item = event.item as { type: 'message'; channel: string; ts: string };
    try {
      await onMessage({
        channel_id: item.channel,
        user_id: event.user,
        text: `:${event.reaction}:`,
        message_ts: item.ts,
        thread_ts: item.ts,
        reaction: event.reaction,
      });
    } catch (err) {
      logError(`[reaction_added] ${err}`);
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
