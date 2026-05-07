#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code MCP Plugin.
 *
 * Lightweight MCP server that:
 * 1. Subscribes to the slack-daemon for message routing
 * 2. Receives webhooks and pushes notifications to Claude
 * 3. Exposes tools: subscribe_slack, unsubscribe_slack, list_subscriptions,
 *    claim_message, reply, read_thread, read_channel, list_channels
 *
 * The daemon must be started separately:
 *   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... pnpm --filter @ia-tools/slack-bridge daemon
 *
 * On startup the MCP reads /tmp/slack-bridge/<session-id>/slack-bridge.json. If
 * subscription data exists it subscribes automatically. The file lives under
 * /tmp (not the project tree) so session state never leaks into the repo.
 * All topic matching runs in the daemon. Paths come from `PathResolver`
 * (single source of truth).
 *
 * Env:
 *   SLACK_BOT_TOKEN                       — Bot token for Slack API calls (reply, read)
 *   DAEMON_URL                            — Daemon API URL (required to receive
 *                                           messages; omit to run read-only)
 *   SLACK_TOPICS                          — Comma-separated topics (overrides the
 *                                           state file on auto-subscribe)
 *                                           e.g. "C06Q8SNF93P,DM:U02M1QFA0AF,..."
 *   SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS  — Comma-separated Slack user IDs that
 *                                           are authorized to request topic
 *                                           subscription changes. When set,
 *                                           subscribe_slack and unsubscribe_slack
 *                                           require a `requested_by: <user_id>`
 *                                           argument and reject any value not in
 *                                           this list. When empty / unset → no
 *                                           gate (backward-compatible default).
 *                                           Example: "U02M1QFA0AF,U03ABCDEF"
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { clearThinkingAck } from './ack-client.js';
import { ConfigWatcher } from './config-watcher.js';
import { loadConfig, loadConfigFromPath, saveConfig, saveConfigAtPath } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, resolveDaemonUrl } from './ensure-daemon.js';
import type { Logger } from './logger.js';
import { SESSION_MANAGER_PROMPT } from './session-manager-prompt.js';
import { McpLogger } from './shared/mcp-logger.js';
import { PathResolver } from './shared/path-resolver.js';
import type { MessagePayload, TopicSpec } from './shared/types.js';
import { normalizeTopic } from './shared/types.js';
import { WebhookServer } from './webhook-server.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Merge two TopicSpec lists by topic string. Later entries' labels win
 * so a re-subscribe can rebrand a topic.
 */
function mergeTopicSpecs(existing: TopicSpec[], incoming: TopicSpec[]): TopicSpec[] {
  const map = new Map<string, TopicSpec>();
  for (const t of existing) map.set(t.topic, t);
  for (const t of incoming) {
    const prev = map.get(t.topic);
    map.set(t.topic, {
      topic: t.topic,
      ...(t.label ? { label: t.label } : prev?.label ? { label: prev.label } : {}),
    });
  }
  return [...map.values()];
}

function formatSpec(spec: TopicSpec): string {
  return spec.label ? `${spec.label}:${spec.topic}` : spec.topic;
}

// ─── McpBridgeServer ─────────────────────────────────────────────────────────

export interface McpBridgeServerOptions {
  web: WebClient;
  daemonClient: DaemonClient | null;
  logger: Logger;
  /**
   * Absolute path to the persisted state file. When set, the server reads
   * and writes this file (and watches it for external edits). When omitted,
   * the legacy `<cwd>/.claude/.slack-bridge.json` location is used so
   * existing tests/consumers keep working.
   */
  stateFilePath?: string;
  /**
   * Slack user IDs authorized to request subscribe/unsubscribe changes via
   * the agent. Empty set = no gate (any caller passes). When non-empty,
   * subscribe_slack / unsubscribe_slack must receive a `requested_by`
   * argument that is in this set, otherwise the call is rejected.
   */
  allowedSubscribeUsers: Set<string>;
  /**
   * Optional session id used purely for display in the `list_subscriptions`
   * output so the operator can correlate the response with the Claude session
   * directory under `/tmp/slack-bridge/<session-id>/`.
   */
  sessionId?: string;
}

export class McpBridgeServer {
  private readonly mcp: Server;
  private readonly web: WebClient;
  private readonly daemonClient: DaemonClient | null;
  private readonly logger: Logger;
  private readonly allowedSubscribeUsers: Set<string>;
  /** Display-only session id surfaced in list_subscriptions output. */
  private readonly sessionId: string | undefined;
  /** All topic specs this subscriber is currently registered for. */
  private subscribedTopics: TopicSpec[] = [];
  /** Reloads subscriptions when the persisted config file changes on disk. */
  private readonly configWatcher: ConfigWatcher;
  /** Absolute path to the state file, or undefined for legacy mode. */
  private readonly stateFilePath: string | undefined;

  constructor({
    web,
    daemonClient,
    logger,
    stateFilePath,
    allowedSubscribeUsers,
    sessionId,
  }: McpBridgeServerOptions) {
    this.web = web;
    this.daemonClient = daemonClient;
    this.logger = logger;
    this.stateFilePath = stateFilePath;
    this.allowedSubscribeUsers = allowedSubscribeUsers;
    this.sessionId = sessionId;
    const watchedPath = stateFilePath ?? join(process.cwd(), '.claude', '.slack-bridge.json');
    this.configWatcher = new ConfigWatcher({
      configPath: watchedPath,
      onChange: () => this.reloadFromConfig(),
      logger: { log: (m) => this.logger.log(m), warn: (m) => this.logger.warn(m) },
    });

    // Short-form guidance for slack-bridge tools, always present.
    const mcpGuidance = [
      'Slack messages arrive as channel notifications with source="slack-bridge".',
      'When you want to respond to a message, FIRST call claim_message with the message_ts.',
      'If the claim succeeds, call reply. If it fails, another session already claimed it — do nothing.',
      'Reply routing priority: (1) if thread_ts is present, always reply in the thread;',
      '(2) if is_dm=true and no thread_ts, reply directly to the DM — omit thread_ts;',
      '(3) otherwise reply to the channel.',
      'Use subscribe_slack at the start of the session to tell the daemon what to listen to.',
      'Use read_thread or read_channel to fetch conversation history.',
    ].join(' ');

    // The session-manager role prompt is injected ONLY in main sessions
    // (IA_TOOLS_ROLE unset/empty). Sub-sessions spawned by /session set
    // IA_TOOLS_ROLE=orchestrator and load orchestrator.md natively via
    // `claude --agent team-workflow:orchestrator`, so they must NOT receive
    // the session-manager prompt here. (In practice sub-sessions are launched
    // without --dangerously-load-development-channels and so don't even mount
    // slack-bridge — this check is a defensive belt-and-braces.)
    const role = process.env.IA_TOOLS_ROLE ?? '';
    const instructions = role === '' ? `${SESSION_MANAGER_PROMPT}\n\n${mcpGuidance}` : mcpGuidance;

    this.mcp = new Server(
      { name: 'slack-bridge', version: '0.2.0' },
      {
        capabilities: {
          experimental: { 'claude/channel': {} },
          tools: {},
        },
        instructions,
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
            'Each entry can be a bare topic string or an object {topic, label} ' +
            'where label is metadata the agent will see on every matched ' +
            'message (use it to remember WHY this subscription exists, e.g. ' +
            '"ship-pr-42" or "team-channel"). ' +
            'Topic formats: ' +
            '"{channel}" → all messages in channel; ' +
            '"{channel}:{user}" → messages from a specific user in a channel; ' +
            '"{channel}:*:{thread_ts}" → all replies in a thread (any user); ' +
            '"{channel}:{user}:{thread_ts}" → thread replies from a specific user; ' +
            '"DM:{user}" → direct messages from a user. ' +
            'Use "*" as a wildcard for channel or user. ' +
            'Subscription is persisted to /tmp/slack-bridge/<session-id>/slack-bridge.json. ' +
            'When acting on a Slack message, ALWAYS pass `requested_by` set to the ' +
            'Slack user_id of whoever asked for the change. Without `requested_by` ' +
            'the call is treated as a local CLI invocation by the operator. ' +
            'Slack-originated requests are blocked unless the user is in ' +
            'SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              topics: {
                type: 'array',
                items: {
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        topic: { type: 'string' },
                        label: { type: 'string' },
                      },
                      required: ['topic'],
                    },
                  ],
                },
                description:
                  'Topics to subscribe to. Each item is either a topic string ' +
                  'or {topic, label?}. Examples: ' +
                  '["C06Q8SNF93P", {"topic": "C06Q8SNF93P:*:1778078158.577219", "label": "ship-pr-42"}, {"topic": "DM:U02M1QFA0AF", "label": "dm-julian"}]',
              },
              requested_by: {
                type: 'string',
                description:
                  'Slack user_id of the human who requested this subscription change. ' +
                  'Required when the MCP has an allowlist configured.',
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
            'persists the change to the state file. ' +
            'Without `topics`, unsubscribes from everything. ' +
            'Pass `requested_by` (Slack user_id) for the same allowlist gate as subscribe_slack.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              topics: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional list of specific topics to remove. Omit to unsubscribe from all.',
              },
              requested_by: {
                type: 'string',
                description:
                  'Slack user_id of the human who requested this unsubscribe. ' +
                  'Required when the MCP has an allowlist configured.',
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
        {
          name: 'list_subscriptions',
          description:
            'List the topic subscriptions currently active for THIS Claude session. ' +
            'Returns the same TopicSpecs (topic + optional label) the agent receives ' +
            'in matched_topics on every delivery. Use it to verify state before ' +
            'subscribe/unsubscribe, or to recover the active set after a long context.',
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
    if (name === 'list_subscriptions') return this.handleListSubscriptions();
    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Authorization gate for subscribe/unsubscribe.
   *
   * The agent passes `requested_by` to declare the source of the request:
   *   - `requested_by` absent  → local CLI invocation (the operator typing
   *     in Claude Code). Always allowed; the operator is implicitly trusted.
   *   - `requested_by` present → request originated from a Slack message
   *     (the agent should set it to the user_id from the triggering
   *     notification). In this case:
   *       - allowlist empty  → REJECTED. Slack-originated requests must be
   *         explicitly authorized via SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS.
   *       - allowlist set    → must include `requested_by`, otherwise
   *         REJECTED.
   *
   * Returns the tool error response when blocked, or null when the call may
   * proceed.
   */
  private gateSubscribeChange(
    args: Record<string, unknown>,
    op: 'subscribe' | 'unsubscribe',
  ): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
    const raw = args.requested_by;
    const requestedBy = typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (!requestedBy) {
      // Local CLI invocation — implicitly trusted operator.
      return null;
    }
    if (this.allowedSubscribeUsers.size === 0) {
      this.logger.warn(`[gate] ${op} rejected — Slack-originated, no allowlist configured`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Refused: ${op}_slack requests originating from Slack messages are blocked because no allowlist is configured. Set SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS in the MCP env to authorize specific users.`,
          },
        ],
        isError: true,
      };
    }
    if (!this.allowedSubscribeUsers.has(requestedBy)) {
      this.logger.warn(`[gate] ${op} rejected — ${requestedBy} not in allowlist`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Refused: user ${requestedBy} is not authorized to change subscriptions. Allowed: ${[...this.allowedSubscribeUsers].join(', ')}.`,
          },
        ],
        isError: true,
      };
    }
    return null;
  }

  private async handleSubscribe(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const blocked = this.gateSubscribeChange(args, 'subscribe');
    if (blocked) return blocked;

    try {
      const raw = (args.topics as Array<string | TopicSpec> | undefined) ?? [];
      const incoming = raw.map(normalizeTopic);

      if (!incoming.length) {
        return {
          content: [{ type: 'text' as const, text: 'Error: topics[] must be non-empty' }],
          isError: true,
        };
      }

      if (!this.daemonClient) {
        throw new Error('DAEMON_URL is not set — cannot subscribe');
      }

      await this.daemonClient.subscribe(incoming);
      this.subscribedTopics = mergeTopicSpecs(this.subscribedTopics, incoming);

      // Persist merged topics to the state file.
      try {
        const existing = this.readState();
        const existingSpecs = (existing.topics ?? []).map(normalizeTopic);
        this.writeState({ topics: mergeTopicSpecs(existingSpecs, incoming) });
      } catch (err) {
        this.logger.warn(`could not persist subscription — ${err}`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Subscribed on :${this.daemonClient.port} — topics: ${incoming.map(formatSpec).join(', ')}`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
    }
  }

  private async handleUnsubscribe(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const blocked = this.gateSubscribeChange(args, 'unsubscribe');
    if (blocked) return blocked;

    const requested = (args.topics as string[] | undefined) ?? null;
    const isPartial = Array.isArray(requested) && requested.length > 0;

    // Always tear down the existing subscription on the daemon — the registry
    // doesn't expose a "remove these topics" op, so partial unsubscribe is
    // implemented as full unsubscribe + resubscribe with the remainder.
    if (this.daemonClient) {
      await this.daemonClient.unsubscribe();
    }

    let remaining: TopicSpec[] = [];
    let removed: TopicSpec[] = [];
    if (isPartial) {
      const toRemove = new Set(requested);
      removed = this.subscribedTopics.filter((t) => toRemove.has(t.topic));
      remaining = this.subscribedTopics.filter((t) => !toRemove.has(t.topic));
      if (this.daemonClient && remaining.length > 0) {
        await this.daemonClient.subscribe(remaining);
      }
    } else {
      removed = [...this.subscribedTopics];
    }

    this.subscribedTopics = remaining;

    // Persist the new topic list (or empty) to the state file.
    try {
      this.writeState({ topics: remaining });
    } catch (err) {
      this.logger.warn(`could not persist unsubscribe — ${err}`);
    }

    const text = isPartial
      ? `Unsubscribed from: ${removed.map(formatSpec).join(', ') || '(none — topic was not subscribed)'}. Remaining: ${remaining.map(formatSpec).join(', ') || '(none)'}`
      : `Unsubscribed from all topics${removed.length ? ` (${removed.map(formatSpec).join(', ')})` : ''}`;
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

  private async handleListSubscriptions(): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }> {
    const count = this.subscribedTopics.length;
    if (count === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No active subscriptions for this session.' }],
      };
    }
    const lines = this.subscribedTopics.map((t, i) => `  ${i + 1}. ${formatSpec(t)}`).join('\n');
    const json = JSON.stringify(this.subscribedTopics);
    const header = this.sessionId
      ? `Active subscriptions (${count}) for session ${this.sessionId}:`
      : `Active subscriptions (${count}):`;
    return {
      content: [
        {
          type: 'text' as const,
          text: `${header}\n${lines}\n\nJSON: ${json}`,
        },
      ],
    };
  }

  private registerOnInitialized(): void {
    this.mcp.oninitialized = async () => {
      if (!this.daemonClient) {
        this.logger.warn(
          'DAEMON_URL is not set — running in read-only mode (no subscriptions possible)',
        );
        return;
      }

      const fileConfig = this.readState();
      const envTopics = process.env.SLACK_TOPICS?.split(',').filter(Boolean) ?? null;
      const raw: Array<string | TopicSpec> = envTopics ?? fileConfig.topics ?? [];
      const topics = raw.map(normalizeTopic);

      // Always watch the config file — topics may be added later by the user
      // editing the file or another process writing it (e.g. /ship).
      this.configWatcher.start();

      if (!topics.length) return;

      try {
        await this.daemonClient.subscribe(topics);
        this.subscribedTopics = mergeTopicSpecs(this.subscribedTopics, topics);
        this.logger.log(
          `auto-subscribed on :${this.daemonClient.port} — topics=${topics.map(formatSpec).join(', ')}`,
        );
      } catch {
        this.logger.warn(
          'daemon not reachable — subscription skipped. Use subscribe_slack once the daemon is running.',
        );
      }
    };
  }

  /**
   * Diff the on-disk config against the in-memory subscription state and
   * sync via the daemon. Catches manual edits to the state file or
   * writes from other processes (e.g. /ship adding a new thread topic).
   */
  private async reloadFromConfig(): Promise<void> {
    if (!this.daemonClient) return;
    const desired = (this.readState().topics ?? []).map(normalizeTopic);

    const desiredKeys = new Set(desired.map((t) => t.topic));
    const currentKeys = new Set(this.subscribedTopics.map((t) => t.topic));
    const added = desired.filter((t) => !currentKeys.has(t.topic));
    const removed = this.subscribedTopics.filter((t) => !desiredKeys.has(t.topic));
    const relabeled = desired.filter((t) => {
      const cur = this.subscribedTopics.find((s) => s.topic === t.topic);
      return cur && cur.label !== t.label;
    });

    if (added.length === 0 && removed.length === 0 && relabeled.length === 0) {
      return; // file changed but topic state matches — no-op (e.g. our own write)
    }

    // Full re-sync: registry has no "patch" op, so unsubscribe + subscribe.
    await this.daemonClient.unsubscribe();
    if (desired.length > 0) {
      await this.daemonClient.subscribe(desired);
    }
    this.subscribedTopics = desired;

    this.logger.log(
      `config reload — +${added.length} -${removed.length} ~${relabeled.length} (total=${desired.length})`,
    );
  }

  /**
   * Read persisted state. Routes through the explicit `stateFilePath` when
   * provided, otherwise falls back to the legacy `<cwd>/.claude/.slack-bridge.json`
   * via `loadConfig()`.
   */
  private readState(): ReturnType<typeof loadConfig> {
    return this.stateFilePath ? loadConfigFromPath(this.stateFilePath) : loadConfig();
  }

  /**
   * Persist state. Routes through the explicit `stateFilePath` when
   * provided, otherwise falls back to the legacy location via `saveConfig()`.
   */
  private writeState(patch: Parameters<typeof saveConfig>[0]): void {
    if (this.stateFilePath) {
      saveConfigAtPath(this.stateFilePath, patch);
    } else {
      saveConfig(patch);
    }
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
          // Per-topic labels surface the subscriber's intent for this match
          // (e.g. "ship-pr-42") so the agent can decide what to do with the
          // message based on WHY it was subscribed, not just the topic string.
          matched_topics: JSON.stringify(matched_topics),
          matched_labels: matched_topics
            .map((t) => t.label)
            .filter((l): l is string => Boolean(l))
            .join(','),
          subscribed_topics: JSON.stringify(this.subscribedTopics),
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
 * when it boots. The MCP server is spawned as a child of Claude, so
 * process.ppid points at that exact file. Reading it lets us use the
 * canonical Claude session UUID as the directory namespace, making
 * correlation with Claude's own logs trivial (~/.claude/projects/.../
 * <sessionId>.jsonl, ~/.claude/debug/<sessionId>.txt).
 *
 * Race: Claude often writes the session file in parallel with spawning the
 * MCP, so the first read can hit ENOENT or an empty/partial JSON. We retry
 * up to ~1 s before falling back, which covers the common case (<150 ms)
 * with margin and still bounds the worst-case startup delay.
 *
 * Falls back to <ppid>-<pid> if the file is still unreadable after retries
 * (e.g. the MCP being run standalone outside Claude).
 */
async function readClaudeSessionId(ppid: number): Promise<string | null> {
  const path = `${homedir()}/.claude/sessions/${ppid}.json`;
  const ATTEMPTS = 10;
  const BACKOFF_MS = 100;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const raw = readFileSync(path, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: string };
      if (typeof data.sessionId === 'string' && data.sessionId.length > 0) {
        return data.sessionId;
      }
    } catch {
      /* not yet — fall through to backoff */
    }
    if (attempt < ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
    }
  }
  return null;
}

const claudeSessionId = await readClaudeSessionId(process.ppid);
const SESSION_ID = claudeSessionId ?? `${process.ppid}-${process.pid}`;
const paths = new PathResolver();
const mcpLogPath = paths.getMcpLogPath(SESSION_ID);
const stateFilePath = paths.getStateFilePath(SESSION_ID);
const logger = new McpLogger({ sessionId: SESSION_ID, paths });
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
logger.log(
  `starting — session=${SESSION_ID} daemon=${DAEMON_URL} log=${mcpLogPath} state=${stateFilePath}`,
);

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
const allowedSubscribeUsers = new Set(
  (process.env.SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
if (allowedSubscribeUsers.size > 0) {
  logger.log(
    `subscribe gate: allowlist active (${allowedSubscribeUsers.size} user(s)) — Slack-originated subscribe/unsubscribe must include requested_by`,
  );
} else {
  logger.log(
    'subscribe gate: no allowlist — Slack-originated subscribe/unsubscribe will be REJECTED',
  );
}

const mcpServer = new McpBridgeServer({
  web,
  daemonClient,
  logger,
  stateFilePath,
  allowedSubscribeUsers,
  sessionId: SESSION_ID,
});

await mcpServer.connect(new StdioServerTransport());
