#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code MCP Plugin.
 *
 * Lightweight MCP server that:
 * 1. Subscribes to the slack-daemon for message routing
 * 2. Receives webhooks and pushes notifications to Claude
 * 3. Exposes tools: subscribe_slack, claim_message, reply_slack, read_thread, read_channel
 *
 * The user tells Claude what to listen to ("escucha #dev-team y DMs de Julian")
 * and Claude calls subscribe_slack to register with the daemon.
 *
 * Env:
 *   SLACK_BOT_TOKEN   — Bot token for Slack API calls (reply, read)
 *   DAEMON_URL        — Daemon API URL (default: http://localhost:3800)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MessagePayload, SubscriptionFilters, ClaimResponse } from './shared/types.js';
import { ensureDaemon } from './ensure-daemon.js';

const botToken = process.env['SLACK_BOT_TOKEN'];
if (!botToken) {
  console.error('Missing SLACK_BOT_TOKEN');
  process.exit(1);
}

const DAEMON_URL = process.env['DAEMON_URL'] ?? 'http://localhost:3800';
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
      // GET /health — daemon health checks
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // POST /message — incoming Slack message from daemon
      if (req.method === 'POST' && req.url === '/message') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          try {
            const payload: MessagePayload = JSON.parse(Buffer.concat(chunks).toString());
            const { message } = payload;

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

    // Listen on random available port
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

// ─── Daemon communication helpers ───────────────────────────────────
async function daemonSubscribe(filters: SubscriptionFilters, label?: string): Promise<boolean> {
  if (!webhookPort) {
    console.log('Starting webhook server');
    webhookPort = await startWebhookServer();
  }

  const res = await fetch(`${DAEMON_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: webhookPort, filters, label }),
  });

  if (!res.ok) throw new Error(`Daemon subscribe failed: ${res.status} ${await res.text()}`);
  return true;
}

async function daemonUnsubscribe(): Promise<boolean> {
  if (!webhookPort) return false;
  const res = await fetch(`${DAEMON_URL}/subscribe/${webhookPort}`, { method: 'DELETE' });
  return res.ok;
}

async function daemonClaim(messageTs: string): Promise<ClaimResponse> {
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
        'Empty filters = listen to everything the daemon sees.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Channel IDs to listen to (e.g., ["C123ABC"])',
          },
          users: {
            type: 'array',
            items: { type: 'string' },
            description: 'User IDs for DM listening (e.g., ["U456DEF"])',
          },
          threads: {
            type: 'array',
            items: { type: 'string' },
            description: 'Thread timestamps to follow',
          },
          label: {
            type: 'string',
            description: 'Label for this session (for debugging)',
          },
        },
      },
    },
    {
      name: 'unsubscribe_slack',
      description: 'Stop listening to Slack messages. Unregisters from the daemon.',
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
        'Reply to a Slack message. Always reply in threads. Only call after a successful claim.',
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
        users: (args['users'] as string[]) ?? [],
        threads: (args['threads'] as string[]) ?? [],
      };
      await daemonSubscribe(filters, args['label'] as string);
      const parts: string[] = [];
      if (filters.channels?.length) parts.push(`channels: ${filters.channels.join(', ')}`);
      if (filters.users?.length) parts.push(`users: ${filters.users.join(', ')}`);
      if (filters.threads?.length) parts.push(`threads: ${filters.threads.join(', ')}`);
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

// ─── Auto-subscribe once client is fully connected ─────────────────
// Opt-in via env: SLACK_CHANNELS, SLACK_USERS, SLACK_THREADS (comma-separated)
const autoChannels = process.env['SLACK_CHANNELS']?.split(',').filter(Boolean) ?? [];
const autoUsers = process.env['SLACK_USERS']?.split(',').filter(Boolean) ?? [];
const autoThreads = process.env['SLACK_THREADS']?.split(',').filter(Boolean) ?? [];

if (autoChannels.length || autoUsers.length || autoThreads.length) {
  mcp.oninitialized = async () => {
    try {
      await daemonSubscribe(
        { channels: autoChannels, users: autoUsers, threads: autoThreads },
        'auto',
      );
      console.error(
        `[slack-bridge] auto-subscribed on :${webhookPort} — channels=${autoChannels} users=${autoUsers} threads=${autoThreads}`,
      );
    } catch {
      console.error('[slack-bridge] auto-subscribe failed (daemon not running?)');
    }
  };
}

// ─── Ensure daemon is running (singleton, auto-start once) ─────────
try {
  await ensureDaemon(DAEMON_URL);
} catch (err) {
  console.error(`[slack-bridge] ${(err as Error).message}`);
  process.exit(1);
}

// ─── Connect ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await mcp.connect(transport);
