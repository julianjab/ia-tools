/**
 * Slack Socket Mode listener.
 * Single connection — routes messages to registered subscribers via HTTP.
 */
import pkg from '@slack/bolt';
import { log, error as logError } from './logger.js';
const { App, LogLevel } = pkg;
export async function startListener(config, onMessage) {
    const app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
        logLevel: LogLevel.ERROR,
    });
    const userCache = new Map();
    const channelCache = new Map();
    app.message(async ({ message }) => {
        const msg = message;
        const text = msg.text;
        if (!text || msg.bot_id || msg.subtype)
            return;
        await onMessage({
            channel_id: msg.channel,
            user_id: msg.user ?? 'unknown',
            text,
            message_ts: msg.ts,
            thread_ts: msg.thread_ts,
        });
    });
    app.event('app_mention', async ({ event }) => {
        if (!event.text)
            return;
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
    app._userCache = userCache;
    app._channelCache = channelCache;
    await app.start();
    log('[daemon] Socket Mode connected');
    return app;
}
/** Resolve user ID → display name using Slack API */
export async function resolveUser(app, userId) {
    const cache = app._userCache;
    if (cache.has(userId))
        return cache.get(userId);
    try {
        const result = await app.client.users.info({ user: userId });
        const name = result.user?.real_name || result.user?.name || userId;
        cache.set(userId, name);
        return name;
    }
    catch {
        return userId;
    }
}
/** Resolve channel ID → channel name using Slack API */
export async function resolveChannel(app, channelId) {
    const cache = app._channelCache;
    if (cache.has(channelId))
        return cache.get(channelId);
    try {
        const result = await app.client.conversations.info({ channel: channelId });
        const name = result.channel?.name || channelId;
        cache.set(channelId, name);
        return name;
    }
    catch {
        return channelId;
    }
}
//# sourceMappingURL=listener.js.map