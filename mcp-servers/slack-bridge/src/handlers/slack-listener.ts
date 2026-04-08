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

  // Caches
  const userCache = new Map<string, string>();
  const channelCache = new Map<string, string>();

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

  /** Push a Slack message to Claude via the channels protocol */
  async function pushToChannel(
    text: string,
    meta: Record<string, string>
  ): Promise<void> {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: text, meta },
    });
    log.info(`Pushed to Claude: [#${meta["channel_name"]}] ${meta["user_name"]}: ${text.slice(0, 80)}`);
  }

  // ─── Messages ──────────────────────────────────────────────────────
  app.message(async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>;
    const text = msg["text"] as string | undefined;
    if (!text) return;
    if (msg["bot_id"]) return;
    if (msg["subtype"]) return;

    const channelId = msg["channel"] as string;
    if (env.channels.length > 0 && !env.channels.includes(channelId)) return;

    const threadTs = msg["thread_ts"] as string | undefined;
    if (env.threadOnly && !threadTs) return;

    const userId = (msg["user"] as string) ?? "unknown";
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
    const channelId = event.channel;
    const userId = event.user ?? "unknown";

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
      thread_ts: event.thread_ts ?? "",
    });
  });

  app.error(async (error) => {
    log.error(`Bolt: ${error}`);
  });

  await app.start();
  log.info(`Socket Mode connected — pushing to Claude channel`);

  return app;
}
