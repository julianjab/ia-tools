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
import { loadConfig, saveConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { createLogger } from './logger.js';
import { WebhookServer } from './webhook-server.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Union two optional string arrays, deduplicating values. */
function union(a, b) {
    if (!a?.length && !b?.length)
        return [];
    return [...new Set([...(a ?? []), ...(b ?? [])])];
}
export class McpBridgeServer {
    mcp;
    web;
    daemonClient;
    logger;
    constructor({ web, daemonClient, logger }) {
        this.web = web;
        this.daemonClient = daemonClient;
        this.logger = logger;
        this.mcp = new Server({ name: 'slack-bridge', version: '0.2.0' }, {
            capabilities: {
                experimental: { 'claude/channel': {} },
                tools: {},
            },
            instructions: [
                'Slack messages arrive as channel notifications with source="slack-bridge".',
                'When you want to respond to a message, FIRST call claim_message with the message_ts.',
                'If the claim succeeds, call reply_slack. If it fails, another session already claimed it — do nothing.',
                'Reply routing priority: (1) if thread_ts is present, always reply in the thread;',
                '(2) if is_dm=true and no thread_ts, reply directly to the DM — omit thread_ts;',
                '(3) otherwise reply to the channel.',
                'Use subscribe_slack at the start of the session to tell the daemon what to listen to.',
                'Use read_thread or read_channel to fetch conversation history.',
            ].join(' '),
        });
        this.registerHandlers();
        this.registerOnInitialized();
    }
    get server() {
        return this.mcp;
    }
    async connect(transport) {
        await this.mcp.connect(transport);
    }
    // ─── Private: handler registration ────────────────────────────────────────
    registerHandlers() {
        this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'subscribe_slack',
                    description: 'Subscribe to Slack messages. Call this when the user tells you what channels/users/threads to listen to. ' +
                        'Subscription is persisted to .claude/.channels.json. All filter logic runs in the daemon.',
                    inputSchema: {
                        type: 'object',
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
                                description: 'Optional regexp filters applied in the daemon before forwarding (AND logic — all must match).',
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
                    inputSchema: { type: 'object', properties: {} },
                },
                {
                    name: 'claim_message',
                    description: 'Claim a Slack message before replying. First session to claim wins. ' +
                        'ALWAYS call this before reply_slack. If claimed=false, do NOT reply.',
                    inputSchema: {
                        type: 'object',
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
                    description: 'Reply to a Slack message. Only call after a successful claim. ' +
                        'Reply routing: (1) thread_ts present → always reply in thread; ' +
                        '(2) is_dm=true and no thread_ts → reply to DM, omit thread_ts; ' +
                        '(3) channel with no thread_ts → reply to channel.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            channel_id: { type: 'string', description: 'Channel ID' },
                            text: { type: 'string', description: 'Message text (Slack mrkdwn)' },
                            message_ts: {
                                type: 'string',
                                description: 'Timestamp of the original message (optional — used to clear the thinking ack if set).',
                            },
                            thread_ts: {
                                type: 'string',
                                description: 'Thread ts. In DMs omit unless the source message had an explicit thread_ts.',
                            },
                        },
                        required: ['channel_id', 'text'],
                    },
                },
                {
                    name: 'read_thread',
                    description: 'Read messages from a Slack thread.',
                    inputSchema: {
                        type: 'object',
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
                        type: 'object',
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
                    inputSchema: { type: 'object', properties: {} },
                },
            ],
        }));
        this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
            const { name } = req.params;
            const args = (req.params.arguments ?? {});
            return this.dispatchTool(name, args);
        });
    }
    async dispatchTool(name, args) {
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
    async handleSubscribeSlack(args) {
        try {
            const filters = {
                channels: args.channels ?? [],
                dms: args.dms ?? [],
                threads: args.threads ?? [],
            };
            const regexp = args.filters;
            const label = args.label;
            if (!this.daemonClient) {
                throw new Error('DAEMON_URL is not set — cannot subscribe');
            }
            await this.daemonClient.subscribe(filters, regexp, label);
            // Persist to .claude/.channels.json — merge with existing so previous subscriptions survive
            try {
                const existing = loadConfig();
                saveConfig({
                    channels: union(existing.channels, filters.channels),
                    dms: union(existing.dms, filters.dms),
                    threads: union(existing.threads, filters.threads),
                    ...(regexp ? { filters: regexp } : existing.filters ? { filters: existing.filters } : {}),
                    ...(label ? { bot: { label } } : existing.bot ? { bot: existing.bot } : {}),
                });
            }
            catch (err) {
                this.logger.warn(`could not persist subscription — ${err}`);
            }
            const parts = [];
            if (filters.channels?.length)
                parts.push(`channels: ${filters.channels.join(', ')}`);
            if (filters.dms?.length)
                parts.push(`dms: ${filters.dms.join(', ')}`);
            if (filters.threads?.length)
                parts.push(`threads: ${filters.threads.join(', ')}`);
            if (regexp && Object.keys(regexp).length)
                parts.push(`regexp: ${JSON.stringify(regexp)}`);
            const summary = parts.length ? parts.join(' | ') : 'all messages';
            return {
                content: [
                    {
                        type: 'text',
                        text: `Subscribed on :${this.daemonClient.port} — listening to: ${summary}`,
                    },
                ],
            };
        }
        catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
    async handleUnsubscribeSlack() {
        if (this.daemonClient) {
            await this.daemonClient.unsubscribe();
        }
        return { content: [{ type: 'text', text: 'Unsubscribed from daemon' }] };
    }
    async handleClaimMessage(args) {
        try {
            if (!this.daemonClient) {
                throw new Error('DAEMON_URL is not set — cannot claim messages');
            }
            const result = await this.daemonClient.claim(args.message_ts);
            if (result.claimed) {
                return { content: [{ type: 'text', text: 'Claimed — you may reply.' }] };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `Already claimed by another session (:${result.claimed_by}). Do NOT reply.`,
                    },
                ],
            };
        }
        catch (err) {
            return { content: [{ type: 'text', text: `Claim error: ${err}` }], isError: true };
        }
    }
    async handleReplySlack(args) {
        const { channel_id, text, message_ts, thread_ts } = args;
        try {
            const result = await this.web.chat.postMessage({ channel: channel_id, text, thread_ts });
            if (message_ts) {
                await clearThinkingAck(this.web, { channel_id, message_ts, thread_ts });
            }
            return { content: [{ type: 'text', text: `Sent (ts: ${result.ts})` }] };
        }
        catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
    async handleReadThread(args) {
        const { channel_id, thread_ts, limit } = args;
        try {
            const result = await this.web.conversations.replies({
                channel: channel_id,
                ts: thread_ts,
                limit: limit ?? 20,
            });
            const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
            return { content: [{ type: 'text', text: messages || 'No messages in thread' }] };
        }
        catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
    async handleReadChannel(args) {
        const { channel_id, limit } = args;
        try {
            const result = await this.web.conversations.history({
                channel: channel_id,
                limit: limit ?? 20,
            });
            const messages = (result.messages ?? []).map((m) => `${m.user}: ${m.text}`).join('\n');
            return { content: [{ type: 'text', text: messages || 'No messages in channel' }] };
        }
        catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
    async handleListSlackChannels() {
        try {
            const result = await this.web.users.conversations({
                types: 'public_channel,private_channel',
                limit: 100,
            });
            const channels = (result.channels ?? []).map((c) => `#${c.name} (${c.id})`).join('\n');
            return { content: [{ type: 'text', text: channels || 'No channels found' }] };
        }
        catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
        }
    }
    registerOnInitialized() {
        this.mcp.oninitialized = async () => {
            if (!this.daemonClient) {
                this.logger.warn('DAEMON_URL is not set — running in read-only mode (no subscriptions possible)');
                return;
            }
            const fileConfig = loadConfig();
            const channels = process.env.SLACK_CHANNELS?.split(',').filter(Boolean) ?? fileConfig.channels ?? [];
            const dms = process.env.SLACK_USERS?.split(',').filter(Boolean) ?? fileConfig.dms ?? [];
            const threads = process.env.SLACK_THREADS?.split(',').filter(Boolean) ?? fileConfig.threads ?? [];
            if (!channels.length && !dms.length && !threads.length)
                return;
            try {
                await this.daemonClient.subscribe({ channels, dms, threads }, fileConfig.filters, fileConfig.bot?.label ?? 'auto');
                this.logger.log(`auto-subscribed on :${this.daemonClient.port} — channels=${channels} dms=${dms} threads=${threads}`);
            }
            catch {
                this.logger.warn('daemon not reachable — subscription skipped. Use subscribe_slack once the daemon is running.');
            }
        };
    }
}
// ─── Entry point ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[mcp] unhandledRejection: ${String(reason)}\n`);
    if (reason instanceof Error)
        process.stderr.write(reason.stack ?? '');
    process.stderr.write('\n');
    process.exit(1);
});
process.on('uncaughtException', (err) => {
    process.stderr.write(`[mcp] uncaughtException: ${err.message}\n${err.stack ?? ''}\n`);
    process.exit(1);
});
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
// Build server first so the webhook callback can reference it safely
const webhookSrv = new WebhookServer(async (payload) => {
    const { message } = payload;
    logger.debug(`[webhook] received ts=${message.message_ts} channel=${message.channel_id} user=${message.user_id} is_dm=${message.is_dm}`);
    try {
        await mcpServer.server.notification({
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
                },
            },
        });
        logger.debug(`[webhook] notification sent ts=${message.message_ts}`);
    }
    catch (err) {
        logger.error(`[webhook] notification failed: ${err}`);
        if (err instanceof Error)
            logger.error(err.stack ?? '');
        throw err;
    }
});
const webhookPort = await webhookSrv.start();
const daemonClient = DAEMON_URL ? new DaemonClient(DAEMON_URL, webhookPort) : null;
const mcpServer = new McpBridgeServer({ web, daemonClient, logger });
await mcpServer.connect(new StdioServerTransport());
//# sourceMappingURL=mcp-server.js.map