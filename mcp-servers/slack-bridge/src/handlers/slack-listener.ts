/**
 * Slack Socket Mode listener.
 * Pushes messages to Claude via mcp.notification() (channels protocol).
 */

import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SlackEnv } from "../utils/env.js";
import type { MessageStore } from "../utils/message-store.js";
import { log } from "../utils/logger.js";

/** Silent logger — prevents Bolt from writing to stdout */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => log.warn(`bolt: ${args.join(" ")}`),
  error: (...args: unknown[]) => log.error(`bolt: ${args.join(" ")}`),
  getLevel: () => LogLevel.ERROR,
  setLevel: () => {},
  setName: () => {},
};

export interface ListenerDeps {
  env: SlackEnv;
  store: MessageStore;
  mcp: Server;
}

export async function startSlackListener(
  deps: ListenerDeps
): Promise<InstanceType<typeof App>> {
  const { env, store, mcp } = deps;

  const app = new App({
    token: env.botToken,
    appToken: env.appToken,
    socketMode: true,
    logger: silentLogger as unknown as ConstructorParameters<typeof App>[0] extends { logger?: infer L } ? L : never,
  });

  const userCache = new Map<string, string>();
  const channelCache = new Map<string, string>();
  /** Cache: threadTs → userId of the thread starter */
  const threadOwnerCache = new Map<string, string>();

  async function resolveUser(userId: string): Promise<string> {
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

  async function resolveChannel(channelId: string): Promise<string> {
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

  /** Resolve who started a thread (the author of the parent message) */
  async function resolveThreadOwner(channelId: string, threadTs: string): Promise<string | undefined> {
    if (threadOwnerCache.has(threadTs)) return threadOwnerCache.get(threadTs)!;
    try {
      const result = await app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 1,
        inclusive: true,
      });
      const parent = result.messages?.[0];
      const ownerId = parent?.user;
      if (ownerId) {
        threadOwnerCache.set(threadTs, ownerId);
        return ownerId;
      }
    } catch (err) {
      log.warn(`Failed to resolve thread owner for ${threadTs}: ${err}`);
    }
    return undefined;
  }

  /**
   * Filter rules (OR logic — match ANY rule to pass):
   *
   * 1. DMs: if dmUsers configured AND channelId starts with D AND user is in dmUsers → accept
   * 2. Channel mentions: if channels configured AND channel matches AND allowedUsers configured AND user matches → accept
   * 3. Thread: if threadTs configured AND message is in that thread → accept (any user)
   * 4. Thread owner: if message is in a thread started by an allowedUser → accept (any user in that thread)
   */
  async function shouldProcess(
    channelId: string,
    threadTs: string | undefined,
    userId: string,
    text: string
  ): Promise<boolean> {
    // Rule 3: specific thread — accept ALL messages in that thread
    if (env.threadTs && threadTs === env.threadTs) return true;

    // Rule 4: threads created by allowedUsers — accept ALL messages
    if (env.allowedUsers.length > 0 && threadTs) {
      const ownerId = await resolveThreadOwner(channelId, threadTs);
      if (ownerId && env.allowedUsers.includes(ownerId)) {
        log.debug(`ACCEPTED thread owned by ${ownerId} channel=${channelId} user=${userId}`);
        return true;
      }
    }

    // Rule 1: DMs from allowed users
    if (env.dmUsers.length > 0 && channelId.startsWith("D") && env.dmUsers.includes(userId)) return true;

    // Rule 2: channel messages from allowed users
    if (env.channels.length > 0 && env.channels.includes(channelId)) {
      if (env.allowedUsers.length === 0 || env.allowedUsers.includes(userId)) return true;
      log.debug(`REJECTED channel=${channelId} user=${userId} not in allowedUsers: "${text.slice(0, 60)}"`);
      return false;
    }

    // Nothing matched — log why
    const isDm = channelId.startsWith("D");
    if (isDm && env.dmUsers.length > 0) {
      log.debug(`REJECTED dm user=${userId} not in dmUsers: "${text.slice(0, 60)}"`);
    } else if (isDm && env.dmUsers.length === 0) {
      log.debug(`REJECTED dm (no dmUsers configured) user=${userId}: "${text.slice(0, 60)}"`);
    } else if (env.channels.length > 0) {
      log.debug(`REJECTED channel=${channelId} not in channels list: "${text.slice(0, 60)}"`);
    } else {
      log.debug(`REJECTED no rules matched channel=${channelId} user=${userId} thread=${threadTs ?? "none"}: "${text.slice(0, 60)}"`);
    }

    return false;
  }

  /** Push a Slack message to Claude via the channels protocol */
  async function pushToChannel(
    text: string,
    meta: Record<string, string>
  ): Promise<void> {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: text, meta },
    });
    log.info(`-> Claude: [#${meta["channel_name"]}] ${meta["user_name"]}: ${text.slice(0, 80)}`);
  }

  // ─── Messages ──────────────────────────────────────────────────────
  app.message(async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>;
    const text = msg["text"] as string | undefined;

    log.debug("message", msg, env);

    if (!text) return;
    if (msg["bot_id"]) return;
    if (msg["subtype"]) return;

    const channelId = msg["channel"] as string;
    const threadTs = msg["thread_ts"] as string | undefined;
    const userId = (msg["user"] as string) ?? "unknown";

    if (!(await shouldProcess(channelId, threadTs, userId, text))) return;

    const ts = msg["ts"] as string;
    const [userName, channelName] = await Promise.all([
      resolveUser(userId),
      resolveChannel(channelId),
    ]);

    await pushToChannel(text, {
      channel_id: channelId,
      channel_name: channelName,
      user_id: userId,
      user_name: userName,
      message_ts: ts,
      thread_ts: threadTs ?? "",
    });
  });

  // ─── @mentions ─────────────────────────────────────────────────────
  app.event("app_mention", async ({ event }) => {
    log.debug("app_mention", event, env);
    const channelId = event.channel;
    const userId = event.user ?? "unknown";
    const threadTs = event.thread_ts ?? undefined;


    if (!(await shouldProcess(channelId, threadTs, userId, event.text ?? ""))) return;

    const [userName, channelName] = await Promise.all([
      resolveUser(userId),
      resolveChannel(channelId),
    ]);

    await pushToChannel(event.text ?? "", {
      channel_id: channelId,
      channel_name: channelName,
      user_id: userId,
      user_name: userName,
      message_ts: event.ts,
      thread_ts: threadTs ?? "",
    });
  });

  app.error(async (error) => {
    log.error(`Bolt: ${error}`);
  });

  await app.start();

  const filters = [];
  if (env.threadTs) filters.push(`thread=${env.threadTs}`);
  if (env.dmUsers.length > 0) filters.push(`dmUsers=${env.dmUsers.join(",")}`);
  if (env.channels.length > 0) filters.push(`channels=${env.channels.join(",")}`);
  log.info(`Socket Mode connected [${filters.join(", ") || "all messages"}]`);

  return app;
}
