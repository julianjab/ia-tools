#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code MCP Plugin.
 *
 * Lightweight MCP server that:
 * 1. Subscribes to the slack-daemon for message routing
 * 2. Receives webhooks and pushes notifications to Claude
 * 3. Exposes tools: subscribe_slack, unsubscribe_slack, claim_message, reply,
 *    read_thread, read_channel, list_channels
 *
 * The daemon must be started separately:
 *   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... pnpm --filter @ia-tools/slack-bridge daemon
 *
 * On startup the MCP reads .claude/.channels.json. If subscription data exists it
 * subscribes automatically. All topic matching runs in the daemon.
 *
 * Env:
 *   SLACK_BOT_TOKEN   — Bot token for Slack API calls (reply, read)
 *   DAEMON_URL        — Daemon API URL (required to receive messages; omit to run read-only)
 *   SLACK_TOPICS      — Comma-separated topics (overrides .claude/.channels.json)
 *                       e.g. "C06Q8SNF93P,DM:U02M1QFA0AF,C06Q8SNF93P:*:1778078158.577219"
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { clearThinkingAck } from './ack-client.js';
import { loadConfig, saveConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, resolveDaemonUrl } from './ensure-daemon.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import type { MessagePayload } from './shared/types.js';
import { WebhookServer } from './webhook-server.js';

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
  /** All topics this subscriber is currently registered for. */
  private subscribedTopics: string[] = [];

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
          'If the claim succeeds, call reply. If it fails, another session already claimed it — do nothing.',
          'Reply routing priority: (1) if thread_ts is present, always reply in the thread;',
          '(2) if is_dm=true and no thread_ts, reply directly to the DM — omit thread_ts;',
          '(3) otherwise reply to the channel.',
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
            'Subscribe to Slack messages using topics. ' +
            'Topic formats: ' +
            '"{channel}" → all messages in channel; ' +
            '"{channel}:{user}" → messages from a specific user in a channel; ' +
            '"{channel}:*:{thread_ts}" → all replies in a thread (any user); ' +
            '"{channel}:{user}:{thread_ts}" → thread replies from a specific user; ' +
            '"DM:{user}" → direct messages from a user. ' +
            'Use "*" as a wildcard for channel or user. ' +
            'Subscription is persisted to .claude/.channels.json.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              topics: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'List of topics to subscribe to. ' +
                  'Examples: ["C06Q8SNF93P", "C06Q8SNF93P:*:1778078158.577219", "DM:U02M1QFA0AF"]',
              },
              label: {
                type: 'string',
                description: 'Label for this session (visible in daemon logs and /subscribers)',
              },
            },
            required: ['topics'],
          },
        },
        {
          name: 'unsubscribe_slack',
          description:
            'Stop listening to Slack messages. ' +
            'With `topics`, removes only those topics from the subscription and ' +
            'persists the change to .claude/.channels.json. ' +
            'Without `topics`, unsubscribes from everything.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              topics: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional list of specific topics to remove. Omit to unsubscribe from all.',
              },
            },
          },
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
          name: 'reply',
          description:
            'Reply to a Slack message. Only call after a successful claim. ' +
            'Reply routing: (1) thread_ts present → always reply in thread; ' +
            '(2) is_dm=true and no thread_ts → reply to DM, omit thread_ts; ' +
            '(3) channel with no thread_ts → reply to channel.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              channel_id: { type: 'string', description: 'Channel ID' },
              text: { type: 'string', description: 'Message text (Slack mrkdwn)' },
              message_ts: {
                type: 'string',
                description:
                  'Timestamp of the original message (optional — used to clear the thinking ack if set).',
              },
              thread_ts: {
                type: 'string',
                description:
                  'Thread ts. In DMs omit unless the source message had an explicit thread_ts.',
              },
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
          name: 'list_channels',
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
    if (name === 'subscribe_slack') return this.handleSubscribe(args);
    if (name === 'unsubscribe_slack') return this.handleUnsubscribe(args);
    if (name === 'claim_message') return this.handleClaimMessage(args);
    if (name === 'reply') return this.handleReply(args);
    if (name === 'read_thread') return this.handleReadThread(args);
    if (name === 'read_channel') return this.handleReadChannel(args);
    if (name === 'list_channels') return this.handleListChannels();
    throw new Error(`Unknown tool: ${name}`);
  }

  private async handleSubscribe(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      const topics = (args.topics as string[]) ?? [];
      const label = args.label as string | undefined;

      if (!topics.length) {
        return {
          content: [{ type: 'text' as const, text: 'Error: topics[] must be non-empty' }],
          isError: true,
        };
      }

      if (!this.daemonClient) {
        throw new Error('DAEMON_URL is not set — cannot subscribe');
      }

      await this.daemonClient.subscribe(topics, label);
      this.subscribedTopics = [...new Set([...this.subscribedTopics, ...topics])];

      // Persist merged topics to .claude/.channels.json
      try {
        const existing = loadConfig();
        saveConfig({
          topics: [...new Set([...(existing.topics ?? []), ...topics])],
          ...(label ? { bot: { label } } : existing.bot ? { bot: existing.bot } : {}),
        });
      } catch (err) {
        this.logger.warn(`could not persist subscription — ${err}`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Subscribed on :${this.daemonClient.port} — topics: ${topics.join(', ')}`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private async handleUnsubscribe(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }> {
    const requested = (args.topics as string[] | undefined) ?? null;
    const isPartial = Array.isArray(requested) && requested.length > 0;

    // Always tear down the existing subscription on the daemon — the registry
    // doesn't expose a "remove these topics" op, so partial unsubscribe is
    // implemented as full unsubscribe + resubscribe with the remainder.
    if (this.daemonClient) {
      await this.daemonClient.unsubscribe();
    }

    let remaining: string[] = [];
    let removed: string[] = [];
    if (isPartial) {
      const toRemove = new Set(requested);
      removed = this.subscribedTopics.filter((t) => toRemove.has(t));
      remaining = this.subscribedTopics.filter((t) => !toRemove.has(t));
      if (this.daemonClient && remaining.length > 0) {
        const label = loadConfig().bot?.label;
        await this.daemonClient.subscribe(remaining, label);
      }
    } else {
      removed = [...this.subscribedTopics];
    }

    this.subscribedTopics = remaining;

    // Persist the new topic list (or empty) to .claude/.channels.json
    try {
      const existing = loadConfig();
      saveConfig({
        topics: remaining,
        ...(existing.bot ? { bot: existing.bot } : {}),
      });
    } catch (err) {
      this.logger.warn(`could not persist unsubscribe — ${err}`);
    }

    const text = isPartial
      ? `Unsubscribed from: ${removed.join(', ') || '(none — topic was not subscribed)'}. Remaining: ${remaining.join(', ') || '(none)'}`
      : `Unsubscribed from all topics${removed.length ? ` (${removed.join(', ')})` : ''}`;
    return { content: [{ type: 'text' as const, text }] };
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

  private async handleReply(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { channel_id, text, message_ts, thread_ts } = args as {
      channel_id: string;
      text: string;
      message_ts?: string;
      thread_ts?: string;
    };

    try {
      const result = await this.web.chat.postMessage({ channel: channel_id, text, thread_ts });
      if (message_ts) {
        await clearThinkingAck(this.web, { channel_id, message_ts, thread_ts });
      }
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

  private async handleListChannels(): Promise<{
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
      const topics =
        process.env.SLACK_TOPICS?.split(',').filter(Boolean) ?? fileConfig.topics ?? [];

      if (!topics.length) return;

      try {
        const label = fileConfig.bot?.label ?? 'auto';
        await this.daemonClient.subscribe(topics, label);
        this.subscribedTopics = [...new Set([...this.subscribedTopics, ...topics])];
        this.logger.log(
          `auto-subscribed on :${this.daemonClient.port} — topics=${topics.join(', ')}`,
        );
      } catch {
        this.logger.warn(
          'daemon not reachable — subscription skipped. Use subscribe_slack once the daemon is running.',
        );
      }
    };
  }

  /** Called by the webhook server when a message arrives from the daemon. */
  async handleIncomingMessage(payload: MessagePayload): Promise<void> {
    const { message, matched_topics } = payload;
    await this.mcp.notification({
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
          is_dm: message.is_dm ? 'true' : 'false',
          matched_topics: matched_topics.join(','),
          subscribed_topics: this.subscribedTopics.join(','),
        },
      },
    });
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[mcp] unhandledRejection: ${String(reason)}\n`);
  if (reason instanceof Error) process.stderr.write(reason.stack ?? '');
  process.stderr.write('\n');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[mcp] uncaughtException: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});

/**
 * Claude writes ~/.claude/sessions/<claude_pid>.json with a `sessionId` UUID
 * when it boots. The MCP server is spawned as a child of Claude, so process.ppid
 * points at that exact file. Reading it lets us use the canonical Claude
 * session UUID as the log directory, making correlation with Claude's
 * own session logs (~/.claude/projects/.../<sessionId>.jsonl,
 * ~/.claude/debug/<sessionId>.txt) trivial.
 *
 * Falls back to <ppid>-<pid> if the file is unreadable (race at very early
 * startup, or the MCP being run standalone outside Claude).
 */
function readClaudeSessionId(ppid: number): string | null {
  try {
    const raw = readFileSync(`${homedir()}/.claude/sessions/${ppid}.json`, 'utf8');
    const data = JSON.parse(raw) as { sessionId?: string };
    return typeof data.sessionId === 'string' && data.sessionId.length > 0 ? data.sessionId : null;
  } catch {
    return null;
  }
}

const claudeSessionId = readClaudeSessionId(process.ppid);
const SESSION_ID = claudeSessionId ?? `${process.ppid}-${process.pid}`;
const mcpLogPath = `/tmp/slack-bridge/${SESSION_ID}/mcp-logs.json`;
const logger = createLogger({ logPath: mcpLogPath, label: 'mcp', stderr: true });
if (claudeSessionId) {
  logger.log(`claude session: ${claudeSessionId} (ppid=${process.ppid})`);
} else {
  logger.warn(`claude session id unavailable (ppid=${process.ppid}); using fallback`);
}

const botToken = process.env.SLACK_BOT_TOKEN;
if (!botToken) {
  logger.error('Missing SLACK_BOT_TOKEN');
  process.exit(1);
}

const DAEMON_URL = resolveDaemonUrl();
logger.log(`starting — session=${SESSION_ID} daemon=${DAEMON_URL} log=${mcpLogPath}`);

// slack-bridge depends on the experimental `claude/channel` capability, which
// is only enabled when Claude is started with --dangerously-load-development-channels.
// That flag is not propagated to MCP child processes via env, but the parent
// process (Claude itself) preserves it in its argv — readable via `ps`.
function readParentCmd(ppid: number): string {
  try {
    return execSync(`ps -ww -p ${ppid} -o command=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const parentCmd = readParentCmd(process.ppid);
const hasDevChannels = parentCmd.includes('--dangerously-load-development-channels');
logger.log(`parent argv: ${parentCmd || '(unavailable)'}`);
if (!hasDevChannels) {
  const msg =
    'slack-bridge requires Claude to be started with --dangerously-load-development-channels. ' +
    'Restart with: claude --dangerously-load-development-channels plugin:slack-bridge@ia-tools';
  logger.error(msg);

  // Reply to the JSON-RPC `initialize` request with an error so Claude marks
  // the MCP as failed and the user cannot invoke its tools. The reason is
  // surfaced in Claude's debug log (~/.claude/debug/<session>.txt) and in
  // /tmp/slack-bridge/<session>/mcp-logs.json.
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const req = JSON.parse(line) as { id?: number | string; method?: string };
      if (req.method === 'initialize' && req.id !== undefined) {
        const resp = {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32002, message: msg },
        };
        process.stdout.write(`${JSON.stringify(resp)}\n`);
        // Give stdout a tick to flush before exit.
        setTimeout(() => process.exit(1), 50);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  });
  // Safety timeout: if `initialize` never arrives, exit anyway.
  setTimeout(() => process.exit(1), 5000);
  // Block top-level await so the rest of the file doesn't run.
  await new Promise<never>(() => {});
}

let daemonReady = false;
try {
  await ensureDaemon(
    DAEMON_URL,
    {
      session: SESSION_ID,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
    },
    logger,
  );
  daemonReady = true;
  try {
    const res = await fetch(`${DAEMON_URL}/health`);
    const health = (await res.json()) as { pid?: number; entrypoint?: string };
    logger.log(
      `daemon ready at ${DAEMON_URL} — pid=${health.pid ?? '?'} entrypoint=${health.entrypoint ?? '?'}`,
    );
  } catch (err) {
    logger.warn(`daemon ready at ${DAEMON_URL} but /health lookup failed: ${err}`);
  }
} catch (err) {
  logger.warn(`ensureDaemon failed — continuing in read-only mode: ${err}`);
}

const web = new WebClient(botToken);

// Build server first so the webhook callback can reference it safely
const webhookSrv = new WebhookServer(async (payload: MessagePayload) => {
  const { message } = payload;
  logger.debug(
    `[webhook] received ts=${message.message_ts} channel=${message.channel_id} user=${message.user_id} is_dm=${message.is_dm} matched=${payload.matched_topics.join(',')}`,
  );
  try {
    await mcpServer.handleIncomingMessage(payload);
    logger.debug(`[webhook] notification sent ts=${message.message_ts}`);
  } catch (err) {
    logger.error(`[webhook] notification failed: ${err}`);
    if (err instanceof Error) logger.error(err.stack ?? '');
    throw err;
  }
});

const webhookPort = await webhookSrv.start();
const daemonClient = daemonReady ? new DaemonClient(DAEMON_URL, webhookPort) : null;
const mcpServer = new McpBridgeServer({ web, daemonClient, logger });

await mcpServer.connect(new StdioServerTransport());
