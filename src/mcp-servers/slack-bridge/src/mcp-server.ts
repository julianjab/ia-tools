#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code MCP Plugin.
 *
 * Lightweight MCP server that:
 * 1. Subscribes to the slack-daemon for message routing
 * 2. Receives webhooks and pushes notifications to Claude
 * 3. Exposes tools: subscribe_slack, unsubscribe_slack, claim_message, reply_slack,
 *    read_thread, read_channel, list_slack_channels
 *
 * The daemon must be started separately:
 *   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... pnpm --filter @ia-tools/slack-bridge daemon
 *
 * On startup the MCP reads .claude/.channels.json. If subscription data exists it
 * subscribes automatically. All filter logic (ID-based and regexp) runs in the daemon.
 *
 * Env:
 *   SLACK_BOT_TOKEN   — Bot token for Slack API calls (reply, read)
 *   DAEMON_URL        — Daemon API URL (required to receive messages; omit to run read-only)
 *   SLACK_CHANNELS    — Comma-separated channel IDs (overrides .claude/.channels.json)
 *   SLACK_USERS       — Comma-separated user IDs (overrides .claude/.channels.json)
 *   SLACK_THREADS     — Comma-separated thread timestamps (overrides .claude/.channels.json)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { clearThinkingAck } from './ack-client.js';
import type { SlackFilters } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { WebhookServer } from './webhook-server.js';
import type { MessagePayload, SubscriptionFilters } from './shared/types.js';

// ─── McpBridgeServer ─────────────────────────────────────────────────────────

export interface McpBridgeServerOptions {
  web: WebClient;
  daemonClient: DaemonClient | null;
  logger: Logger;
}

export class McpBridgeServer {
  private readonly mcp: Server;
  private readonly web: WebClient;
  private readonly daemonClient: DaemonClient | null;
  private readonly logger: Logger;

  constructor({ web, daemonClient, logger }: McpBridgeServerOptions) {
    this.web = web;
    this.daemonClient = daemonClient;
    this.logger = logger;

    this.mcp = new Server(
      { name: 'slack-bridge', version: '0.2.0' },
      {
        capabilities: {
          experimental: { 'claude/channel': {} },
          tools: {},
        },
        instructions: [
          'Slack messages arrive as channel notifications with source="slack-bridge".',
          'When you want to respond to a message, FIRST call claim_message with the message_ts.',
          'If the claim succeeds, call reply_slack. If it fails, another session already claimed it — do nothing.',
          'Always pass message_ts to reply_slack — it is required to clear the thinking indicator.',
          'In DMs (is_dm=true in the notification meta), omit thread_ts unless the source message already had one.',
          'Use subscribe_slack at the start of the session to tell the daemon what to listen to.',
          'Use read_thread or read_channel to fetch conversation history.',
        ].join(' '),
      },
    );

    this.registerHandlers();
    this.registerOnInitialized();
  }

  get server(): Server {
    return this.mcp;
  }

  async connect(transport: StdioServerTransport): Promise<void> {
    await this.mcp.connect(transport);
  }

  // ─── Private: handler registration ────────────────────────────────────────

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'subscribe_slack',
          description:
            'Subscribe to Slack messages. Call this when the user tells you what channels/users/threads to listen to. ' +
            'Subscription is persisted to .claude/.channels.json. All filter logic runs in the daemon.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              channels: {
                type: 'array',
                items: { type: 'string' },
                description: 'Channel IDs to listen to (e.g., ["C123ABC"])',
              },
              dms: {
                type: 'array',
                items: { type: 'string' },
                description: 'User IDs for DM listening (e.g., ["U456DEF"])',
              },
              threads: {
                type: 'array',
                items: { type: 'string' },
                description: 'Thread timestamps to follow',
              },
              filters: {
                type: 'object',
                description:
                  'Optional regexp filters applied in the daemon before forwarding (AND logic — all must match).',
                properties: {
                  channel: { type: 'string', description: 'Regexp matched against channel_name' },
                  user: { type: 'string', description: 'Regexp matched against user_name' },
                  message: { type: 'string', description: 'Regexp matched against message text' },
                  thread: { type: 'string', description: 'Regexp matched against thread_ts' },
                },
              },
              label: {
                type: 'string',
                description: 'Label for this session (visible in daemon logs and /subscribers)',
              },
            },
          },
        },
        {
          name: 'unsubscribe_slack',
          description: 'Stop listening to Slack messages.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'claim_message',
          description:
            'Claim a Slack message before replying. First session to claim wins. ' +
            'ALWAYS call this before reply_slack. If claimed=false, do NOT reply.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              message_ts: {
                type: 'string',
                description: 'The message_ts from the channel notification',
              },
            },
            required: ['message_ts'],
          },
        },
        {
          name: 'reply_slack',
          description:
            'Reply to a Slack message. Only call after a successful claim. ' +
            'Always pass message_ts (required). ' +
            'In DMs (is_dm=true), omit thread_ts unless the source message already had one — ' +
            'DMs do not use threads by default.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              channel_id: { type: 'string', description: 'Channel ID' },
              text: { type: 'string', description: 'Message text (Slack mrkdwn)' },
              message_ts: {
                type: 'string',
                description:
                  'Timestamp of the original message (required — used to clear the thinking ack).',
              },
              thread_ts: {
                type: 'string',
                description:
                  'Thread ts. In DMs omit unless the source message had an explicit thread_ts.',
              },
            },
            required: ['channel_id', 'text', 'message_ts'],
          },
        },
        {
          name: 'read_thread',
          description: 'Read messages from a Slack thread.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              channel_id: { type: 'string', description: 'Channel ID' },
              thread_ts: { type: 'string', description: 'Thread timestamp' },
              limit: { type: 'number', description: 'Max messages to return (default: 20)' },
            },
            required: ['channel_id', 'thread_ts'],
          },
        },
        {
          name: 'read_channel',
          description: 'Read recent messages from a Slack channel.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              channel_id: { type: 'string', description: 'Channel ID' },
              limit: { type: 'number', description: 'Max messages to return (default: 20)' },
            },
            required: ['channel_id'],
          },
        },
        {
          name: 'list_slack_channels',
          description: 'List Slack channels the bot is a member of.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name } = req.params;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      return this.dispatchTool(name, args);
    });
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    if (name === 'subscribe_slack') {
      return this.handleSubscribeSlack(args);
    }

    if (name === 'unsubscribe_slack') {
      return this.handleUnsubscribeSlack();
    }

    if (name === 'claim_message') {
      return this.handleClaimMessage(args);
    }

    if (name === 'reply_slack') {
      return this.handleReplySlack(args);
    }

    if (name === 'read_thread') {
      return this.handleReadThread(args);
    }

    if (name === 'read_channel') {
      return this.handleReadChannel(args);
    }

    if (name === 'list_slack_channels') {
      return this.handleListSlackChannels();
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  private async handleSubscribeSlack(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      const filters: SubscriptionFilters = {
        channels: (args.channels as string[]) ?? [],
        users: (args.dms as string[]) ?? [],
        threads: (args.threads as string[]) ?? [],
      };
      const regexp = args.filters as SlackFilters | undefined;
      const label = args.label as string | undefined;

      if (!this.daemonClient) {
        throw new Error('DAEMON_URL is not set — cannot subscribe');
      }

      await this.daemonClient.subscribe(filters, regexp, label);

      // Persist to .claude/.channels.json
      try {
        saveConfig({
          channels: filters.channels,
          dms: filters.users,
          threads: filters.threads,
          ...(regexp ? { filters: regexp } : {}),
          ...(label ? { bot: { label } } : {}),
        });
      } catch (err) {
        this.logger.warn(`could not persist subscription — ${err}`);
      }

      const parts: string[] = [];
      if (filters.channels?.length) parts.push(`channels: ${filters.channels.join(', ')}`);
      if (filters.users?.length) parts.push(`dms: ${filters.users.join(', ')}`);
      if (filters.threads?.length) parts.push(`threads: ${filters.threads.join(', ')}`);
      if (regexp && Object.keys(regexp).length) parts.push(`regexp: ${JSON.stringify(regexp)}`);
      const summary = parts.length ? parts.join(' | ') : 'all messages';

      return {
        content: [
          {
            type: 'text' as const,
            text: `Subscribed on :${this.daemonClient.port} — listening to: ${summary}`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private async handleUnsubscribeSlack(): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }> {
    if (this.daemonClient) {
      await this.daemonClient.unsubscribe();
    }
    return { content: [{ type: 'text' as const, text: 'Unsubscribed from daemon' }] };
  }

  private async handleClaimMessage(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    try {
      if (!this.daemonClient) {
        throw new Error('DAEMON_URL is not set — cannot claim messages');
      }
      const result = await this.daemonClient.claim(args.message_ts as string);
      if (result.claimed) {
        return { content: [{ type: 'text' as const, text: 'Claimed — you may reply.' }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Already claimed by another session (:${result.claimed_by}). Do NOT reply.`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Claim error: ${err}` }], isError: true };
    }
  }

  private async handleReplySlack(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { channel_id, text, message_ts, thread_ts } = args as {
      channel_id: string;
      text: string;
      message_ts?: string;
      thread_ts?: string;
    };

    if (!message_ts) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'message_ts is required for reply_slack. Pass the message_ts from the channel notification.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await this.web.chat.postMessage({ channel: channel_id, text, thread_ts });
      await clearThinkingAck(this.web, { channel_id, message_ts, thread_ts });
      return { content: [{ type: 'text' as const, text: `Sent (ts: ${result.ts})` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private async handleReadThread(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { channel_id, thread_ts, limit } = args as {
      channel_id: string;
      thread_ts: string;
      limit?: number;
    };
    try {
      const result = await this.web.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
        limit: limit ?? 20,
      });
      const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
      return { content: [{ type: 'text' as const, text: messages || 'No messages in thread' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private async handleReadChannel(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { channel_id, limit } = args as { channel_id: string; limit?: number };
    try {
      const result = await this.web.conversations.history({
        channel: channel_id,
        limit: limit ?? 20,
      });
      const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
      return { content: [{ type: 'text' as const, text: messages || 'No messages in channel' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private async handleListSlackChannels(): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    try {
      const result = await this.web.users.conversations({
        types: 'public_channel,private_channel',
        limit: 100,
      });
      const channels = (result.channels ?? []).map((c) => `#${c.name} (${c.id})`).join('\n');
      return { content: [{ type: 'text' as const, text: channels || 'No channels found' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private registerOnInitialized(): void {
    this.mcp.oninitialized = async () => {
      if (!this.daemonClient) {
        this.logger.warn(
          'DAEMON_URL is not set — running in read-only mode (no subscriptions possible)',
        );
        return;
      }

      const fileConfig = loadConfig();
      const channels =
        process.env.SLACK_CHANNELS?.split(',').filter(Boolean) ?? fileConfig.channels ?? [];
      const users =
        process.env.SLACK_USERS?.split(',').filter(Boolean) ?? fileConfig.dms ?? [];
      const threads =
        process.env.SLACK_THREADS?.split(',').filter(Boolean) ?? fileConfig.threads ?? [];

      if (!channels.length && !users.length && !threads.length) return;

      try {
        await this.daemonClient.subscribe(
          { channels, users, threads },
          fileConfig.filters,
          fileConfig.bot?.label ?? 'auto',
        );
        this.logger.log(
          `auto-subscribed on :${this.daemonClient.port} — channels=${channels} dms=${users} threads=${threads}`,
        );
      } catch {
        this.logger.warn(
          'daemon not reachable — subscription skipped. Use subscribe_slack once the daemon is running.',
        );
      }
    };
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const SESSION_ID = `${Date.now()}-${process.pid}`;
const mcpLogPath = './.logs/mcp-logs.json';
const logger = createLogger({ logPath: mcpLogPath, label: 'mcp', stderr: true });

const botToken = process.env.SLACK_BOT_TOKEN;
if (!botToken) {
  logger.error('Missing SLACK_BOT_TOKEN');
  process.exit(1);
}

const DAEMON_URL = process.env.DAEMON_URL?.trim() || null;
logger.log(`starting — session=${SESSION_ID} daemon=${DAEMON_URL ?? 'none'} log=${mcpLogPath}`);

const web = new WebClient(botToken);

const webhookSrv = new WebhookServer(async (payload: MessagePayload) => {
  const { message } = payload;
  await server.server.notification({
    method: 'notifications/claude/channel',
    params: {
      content: message.text,
      meta: {
        source: 'slack-bridge',
        channel_id: message.channel_id,
        channel_name: message.channel_name,
        user_id: message.user_id,
        user_name: message.user_name,
        message_ts: message.message_ts,
        thread_ts: message.thread_ts ?? '',
        is_dm: message.is_dm,
      },
    },
  });
});

const webhookPort = await webhookSrv.start();
const daemonClient = DAEMON_URL ? new DaemonClient(DAEMON_URL, webhookPort) : null;
const server = new McpBridgeServer({ web, daemonClient, logger });

await server.connect(new StdioServerTransport());
