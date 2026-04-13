#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code MCP Plugin.
 *
 * Lightweight MCP server that:
 * 1. Subscribes to the slack-daemon for message routing
 * 2. Receives webhooks and pushes notifications to Claude (with optional regexp filters)
 * 3. Exposes tools: subscribe_slack, claim_message, reply_slack, read_thread, read_channel
 *
 * The user tells Claude what to listen to ("listen to #dev-team and DMs from Julian")
 * and Claude calls subscribe_slack to register with the daemon.
 * Each subscribe_slack call persists the subscription to .claude/.channels.json → slack key.
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
import { ensureDaemon, resolveDaemonUrl } from './ensure-daemon.js';
import { loadConfig, saveConfig } from './config.js';
import type { SlackFilters } from './config.js';

const botToken = process.env['SLACK_BOT_TOKEN'];
if (!botToken) {
  console.error('Missing SLACK_BOT_TOKEN');
  process.exit(1);
}

const DAEMON_URL = resolveDaemonUrl();
const web = new WebClient(botToken);

// ─── State ──────────────────────────────────────────────────────────
let webhookPort: number | undefined;
let activeFilters: SlackFilters | undefined;

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

// ─── Filter helpers ──────────────────────────────────────────────────

function matchesFilters(payload: MessagePayload, filters: SlackFilters | undefined): boolean {
  if (!filters) return true;

  const { message } = payload;

  if (filters.channel) {
    try {
      if (!new RegExp(filters.channel).test(message.channel_name)) return false;
    } catch {
      // invalid regexp — skip filter
    }
  }

  if (filters.user) {
    try {
      const userStr = message.user_name ?? message.user_id;
      if (!new RegExp(filters.user).test(userStr)) return false;
    } catch {
      // invalid regexp — skip filter
    }
  }

  if (filters.message) {
    try {
      if (!new RegExp(filters.message).test(message.text ?? '')) return false;
    } catch {
      // invalid regexp — skip filter
    }
  }

  if (filters.thread) {
    try {
      const threadStr = message.thread_ts ?? '';
      if (!new RegExp(filters.thread).test(threadStr)) return false;
    } catch {
      // invalid regexp — skip filter
    }
  }

  return true;
}

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

            // Apply regexp filters — drop message if it does not match
            if (!matchesFilters(payload, activeFilters)) {
              res.writeHead(200);
              res.end('filtered');
              return;
            }

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
        'Subscription is persisted to .claude/.channels.json for auto-restore on next session. ' +
        'Empty filters = listen to everything the daemon sees.',
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
              'Optional regexp filters applied client-side before forwarding to Claude. ' +
              'All filters must match (AND logic). Invalid regexps are silently ignored.',
            properties: {
              channel: { type: 'string', description: 'Regexp matched against channel_name' },
              user: { type: 'string', description: 'Regexp matched against user_name / user_id' },
              message: { type: 'string', description: 'Regexp matched against message text' },
              thread: { type: 'string', description: 'Regexp matched against thread_ts' },
            },
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
        users: (args['dms'] as string[]) ?? [], // daemon still calls them "users"
        threads: (args['threads'] as string[]) ?? [],
      };
      const clientFilters = args['filters'] as SlackFilters | undefined;

      await daemonSubscribe(filters, args['label'] as string);

      // Persist subscription to .claude/.channels.json → slack key
      try {
        saveConfig({
          channels: filters.channels,
          dms: filters.users, // map back to dms for storage
          threads: filters.threads,
          ...(clientFilters ? { filters: clientFilters } : {}),
          ...(args['label'] ? { bot: { label: args['label'] as string } } : {}),
        });
      } catch (err) {
        console.error(`[slack-bridge] Warning: could not persist subscription — ${err}`);
      }

      // Update active client-side filters
      activeFilters = clientFilters;

      const parts: string[] = [];
      if (filters.channels?.length) parts.push(`channels: ${filters.channels.join(', ')}`);
      if (filters.users?.length) parts.push(`dms: ${filters.users.join(', ')}`);
      if (filters.threads?.length) parts.push(`threads: ${filters.threads.join(', ')}`);
      if (clientFilters && Object.keys(clientFilters).length) {
        parts.push(`filters: ${JSON.stringify(clientFilters)}`);
      }
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
    activeFilters = undefined;
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
// Env vars take precedence over .claude/.channels.json config file values.
const fileConfig = loadConfig();
const autoChannels =
  process.env['SLACK_CHANNELS']?.split(',').filter(Boolean) ?? fileConfig.channels ?? [];
const autoUsers = process.env['SLACK_USERS']?.split(',').filter(Boolean) ?? fileConfig.dms ?? [];
const autoThreads =
  process.env['SLACK_THREADS']?.split(',').filter(Boolean) ?? fileConfig.threads ?? [];

if (autoChannels.length || autoUsers.length || autoThreads.length) {
  // Apply stored filters from file on auto-subscribe
  activeFilters = fileConfig.filters;

  mcp.oninitialized = async () => {
    try {
      await daemonSubscribe(
        { channels: autoChannels, users: autoUsers, threads: autoThreads },
        fileConfig.bot?.label ?? 'auto',
      );
      console.error(
        `[slack-bridge] auto-subscribed on :${webhookPort} — channels=${autoChannels} dms=${autoUsers} threads=${autoThreads}`,
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
