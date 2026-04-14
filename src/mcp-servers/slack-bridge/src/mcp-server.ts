#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code MCP Plugin.
 *
 * Lightweight MCP server that:
 * 1. Subscribes to the slack-daemon for message routing
 * 2. Receives webhooks and pushes notifications to Claude
 * 3. Exposes tools: subscribe_slack, claim_message, reply_slack, read_thread, read_channel
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
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MessagePayload, SubscriptionFilters, ClaimResponse } from './shared/types.js';
import type { SlackFilters } from './config.js';
import { resolveDaemonUrl, ensureDaemon } from './ensure-daemon.js';
import { loadConfig, saveConfig } from './config.js';
import { createLogger } from './logger.js';

// ─── Session logger ──────────────────────────────────────────────────
const SESSION_ID = `${Date.now()}-${process.pid}`;
const mcpLogPath = `./.logs/mcp-logs.json`;
const { log: mcpLog, warn: mcpWarn, error: mcpError } = createLogger({ logPath: mcpLogPath, label: 'mcp', stderr: true });

const botToken = process.env['SLACK_BOT_TOKEN'];
if (!botToken) {
  mcpError('Missing SLACK_BOT_TOKEN');
  process.exit(1);
}

const DAEMON_URL = resolveDaemonUrl();
mcpLog(`starting — session=${SESSION_ID} daemon=${DAEMON_URL ?? 'none'} log=${mcpLogPath}`);
const web = new WebClient(botToken);

// ─── State ──────────────────────────────────────────────────────────
let webhookPort: number | undefined;

// ─── MCP Server ─────────────────────────────────────────────────────
const mcp = new Server(
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
      'Use subscribe_slack at the start of the session to tell the daemon what to listen to.',
      'Use read_thread or read_channel to fetch conversation history.',
    ].join(' '),
  },
);

// ─── Webhook server — receives messages from daemon ─────────────────
function startWebhookServer(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/message') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          try {
            const payload: MessagePayload = JSON.parse(Buffer.concat(chunks).toString());
            const { message } = payload;

            // Daemon already applied all filters — forward unconditionally
            await mcp.notification({
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
                },
              },
            });

            res.writeHead(200);
            res.end('ok');
          } catch (err) {
            res.writeHead(500);
            res.end(String(err));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

// ─── Daemon communication helpers ───────────────────────────────────
async function daemonSubscribe(
  filters: SubscriptionFilters,
  regexp?: SlackFilters,
  label?: string,
): Promise<boolean> {
  if (!DAEMON_URL) throw new Error('DAEMON_URL is not set — cannot subscribe');
  if (!webhookPort) {
    webhookPort = await startWebhookServer();
  }

  const res = await fetch(`${DAEMON_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: webhookPort, filters, regexp, label }),
  });

  if (!res.ok) throw new Error(`Daemon subscribe failed: ${res.status} ${await res.text()}`);
  return true;
}

async function daemonUnsubscribe(): Promise<boolean> {
  if (!DAEMON_URL || !webhookPort) return false;
  const res = await fetch(`${DAEMON_URL}/subscribe/${webhookPort}`, { method: 'DELETE' });
  return res.ok;
}

async function daemonClaim(messageTs: string): Promise<ClaimResponse> {
  if (!DAEMON_URL) throw new Error('DAEMON_URL is not set — cannot claim messages');
  if (!webhookPort) throw new Error('Not subscribed — call subscribe_slack first');
  const res = await fetch(`${DAEMON_URL}/claim/${messageTs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriber_port: webhookPort }),
  });
  return (await res.json()) as ClaimResponse;
}

// ─── Tools ──────────────────────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
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
      description: 'Reply to a Slack message in-thread. Only call after a successful claim.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID' },
          text: { type: 'string', description: 'Message text (Slack mrkdwn)' },
          thread_ts: { type: 'string', description: 'Thread ts (use message_ts if no thread_ts)' },
        },
        required: ['channel_id', 'text'],
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

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (name === 'subscribe_slack') {
    try {
      const filters: SubscriptionFilters = {
        channels: (args['channels'] as string[]) ?? [],
        users: (args['dms'] as string[]) ?? [],
        threads: (args['threads'] as string[]) ?? [],
      };
      const regexp = args['filters'] as SlackFilters | undefined;
      const label = args['label'] as string | undefined;

      await daemonSubscribe(filters, regexp, label);

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
        console.error(`[slack-bridge] Warning: could not persist subscription — ${err}`);
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
            text: `Subscribed on :${webhookPort} — listening to: ${summary}`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  if (name === 'unsubscribe_slack') {
    await daemonUnsubscribe();
    return { content: [{ type: 'text' as const, text: 'Unsubscribed from daemon' }] };
  }

  if (name === 'claim_message') {
    try {
      const result = await daemonClaim(args['message_ts'] as string);
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

  if (name === 'reply_slack') {
    const { channel_id, text, thread_ts } = args as {
      channel_id: string;
      text: string;
      thread_ts?: string;
    };
    try {
      const result = await web.chat.postMessage({ channel: channel_id, text, thread_ts });
      return { content: [{ type: 'text' as const, text: `Sent (ts: ${result.ts})` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  if (name === 'read_thread') {
    const { channel_id, thread_ts, limit } = args as {
      channel_id: string;
      thread_ts: string;
      limit?: number;
    };
    try {
      const result = await web.conversations.replies({
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

  if (name === 'read_channel') {
    const { channel_id, limit } = args as { channel_id: string; limit?: number };
    try {
      const result = await web.conversations.history({ channel: channel_id, limit: limit ?? 20 });
      const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
      return { content: [{ type: 'text' as const, text: messages || 'No messages in channel' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  if (name === 'list_slack_channels') {
    try {
      const result = await web.users.conversations({
        types: 'public_channel,private_channel',
        limit: 100,
      });
      const channels = (result.channels ?? []).map((c) => `#${c.name} (${c.id})`).join('\n');
      return { content: [{ type: 'text' as const, text: channels || 'No channels found' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─── On connect: check capability, auto-subscribe from config if data exists ──
mcp.oninitialized = async () => {
  // No DAEMON_URL — running read-only, subscription not possible
  if (!DAEMON_URL) {
    mcpWarn('DAEMON_URL is not set — running in read-only mode (no subscriptions possible)');
    return;
  };
  // Read .claude/.channels.json — subscribe only if data exists
  const fileConfig = loadConfig();
  const channels =
    process.env['SLACK_CHANNELS']?.split(',').filter(Boolean) ?? fileConfig.channels ?? [];
  const users = process.env['SLACK_USERS']?.split(',').filter(Boolean) ?? fileConfig.dms ?? [];
  const threads =
    process.env['SLACK_THREADS']?.split(',').filter(Boolean) ?? fileConfig.threads ?? [];

  if (!channels.length && !users.length && !threads.length) return;

  try {
    await daemonSubscribe(
      { channels, users, threads },
      fileConfig.filters,
      fileConfig.bot?.label ?? 'auto',
    );
    mcpLog(`auto-subscribed on :${webhookPort} — channels=${channels} dms=${users} threads=${threads}`);
  } catch {
    mcpWarn('daemon not reachable — subscription skipped. Use subscribe_slack once the daemon is running.');
  }
};

// ─── Ensure daemon is running (singleton — first session spawns it) ─
try {
  await ensureDaemon(DAEMON_URL);
} catch (err) {
  mcpError((err as Error).message);
  process.exit(1);
}

// ─── Connect ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await mcp.connect(transport);
