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

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { parseAllowedSubscribeUsers } from './auth-gate.js';
import { ConfigWatcher } from './config-watcher.js';
import { loadConfig, loadConfigFromPath, saveConfig, saveConfigAtPath } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, resolveDaemonUrl } from './ensure-daemon.js';
import {
  type MessagingHandlerDeps,
  handleClaimMessage,
  handleReply,
} from './handlers/messaging.js';
import {
  type ReadOnlyHandlerDeps,
  handleListChannels,
  handleReadChannel,
  handleReadThread,
} from './handlers/read-only.js';
import {
  type SubscribeHandlerDeps,
  handleListSubscriptions,
  handleSubscribe,
  handleUnsubscribe,
} from './handlers/subscribe.js';
import type { Logger } from './logger.js';
import { hasAgentFlag, hasDevChannelsFlag, readParentCmd } from './parent-process.js';
import { loadSessionManagerPrompt } from './prompt-loader.js';
import { resolveSessionId } from './session-id-resolver.js';
import { McpLogger } from './shared/mcp-logger.js';
import { PathResolver } from './shared/path-resolver.js';
import type { MessagePayload, TopicSpec } from './shared/types.js';
import { normalizeTopic } from './shared/types.js';
import { formatSpec, mergeTopicSpecs } from './topic-helpers.js';
import { WebhookServer } from './webhook-server.js';

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
  /**
   * Optional session-manager role prompt. When non-empty, it is prepended to
   * the short MCP guidance and surfaced as the MCP `instructions` field — so
   * the operator's main Claude session adopts the session-manager role.
   * When empty (or omitted), only the MCP guidance is surfaced. The decision
   * to load (or skip) the prompt is made by the entry point based on whether
   * the parent Claude process was started with an `--agent` flag.
   */
  sessionManagerPrompt?: string;
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
    sessionManagerPrompt,
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

    // The session-manager role prompt is prepended to the MCP guidance only
    // when the entry point passed it in. The entry point decides based on
    // whether the parent Claude process was launched with an `--agent` flag:
    // if a specific agent was selected, we leave that agent's prompt as the
    // active personality and skip the session-manager role injection.
    const instructions =
      sessionManagerPrompt && sessionManagerPrompt.length > 0
        ? `${sessionManagerPrompt}\n\n${mcpGuidance}`
        : mcpGuidance;

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

  /** Build the deps bundle the subscribe/unsubscribe/list handlers need. */
  private subscribeDeps(): SubscribeHandlerDeps {
    return {
      daemonClient: this.daemonClient,
      logger: this.logger,
      allowedSubscribeUsers: this.allowedSubscribeUsers,
      sessionId: this.sessionId,
      readState: () => this.readState(),
      writeState: (patch) => this.writeState(patch),
      getSubscribedTopics: () => this.subscribedTopics,
      setSubscribedTopics: (next) => {
        this.subscribedTopics = next;
      },
    };
  }

  private messagingDeps(): MessagingHandlerDeps {
    return { web: this.web, daemonClient: this.daemonClient };
  }

  private readOnlyDeps(): ReadOnlyHandlerDeps {
    return { web: this.web };
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    if (name === 'subscribe_slack') return handleSubscribe(args, this.subscribeDeps());
    if (name === 'unsubscribe_slack') return handleUnsubscribe(args, this.subscribeDeps());
    if (name === 'claim_message') return handleClaimMessage(args, this.messagingDeps());
    if (name === 'reply') return handleReply(args, this.messagingDeps());
    if (name === 'read_thread') return handleReadThread(args, this.readOnlyDeps());
    if (name === 'read_channel') return handleReadChannel(args, this.readOnlyDeps());
    if (name === 'list_channels') return handleListChannels(this.readOnlyDeps());
    if (name === 'list_subscriptions') {
      return handleListSubscriptions({
        sessionId: this.sessionId,
        getSubscribedTopics: () => this.subscribedTopics,
      });
    }
    throw new Error(`Unknown tool: ${name}`);
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
        await this.daemonClient.subscribe(topics, this.sessionId);
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
      await this.daemonClient.subscribe(desired, this.sessionId);
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
//
// Everything below this line is bootstrap with side effects: process-level
// signal handlers, session-id resolution (3 s retry), `/tmp/slack-bridge/<id>/`
// directory creation, daemon ensure, port allocation, stdio transport
// connection. Wrapping it in an entry-point guard means importing this
// module from tests (or other tooling) only loads the class definition —
// no log dirs leak, no daemon probe, no JSON-RPC reject path. The standard
// ESM check `process.argv[1] === fileURLToPath(import.meta.url)` is true
// only when this file was invoked as `node mcp-server.js` (or via the
// bundled `dist/mcp-server.js`), false on every `import` path.

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  await (async () => {
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

    const paths = new PathResolver();
    // Capture log lines from resolveSessionId until the real logger exists,
    // then replay them so the resolution outcome lands in the per-session log.
    const bootBuffer: Array<{ level: 'log' | 'warn'; msg: string }> = [];
    const captureLogger: Logger = {
      log: (msg: string) => bootBuffer.push({ level: 'log', msg }),
      warn: (msg: string) => bootBuffer.push({ level: 'warn', msg }),
      error: (msg: string) => bootBuffer.push({ level: 'warn', msg }),
      debug: () => {},
    };
    const { id: SESSION_ID, source: SESSION_ID_SOURCE } = await resolveSessionId(
      process.ppid,
      captureLogger,
    );
    const mcpLogPath = paths.getMcpLogPath(SESSION_ID);
    const stateFilePath = paths.getStateFilePath(SESSION_ID);
    const logger = new McpLogger({ sessionId: SESSION_ID, paths });
    for (const entry of bootBuffer) {
      if (entry.level === 'warn') logger.warn(entry.msg);
      else logger.log(entry.msg);
    }
    logger.log(`session id source: ${SESSION_ID_SOURCE}`);

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      logger.error('Missing SLACK_BOT_TOKEN');
      process.exit(1);
    }

    const DAEMON_URL = resolveDaemonUrl();
    logger.log(
      `starting — session=${SESSION_ID} daemon=${DAEMON_URL} log=${mcpLogPath} state=${stateFilePath}`,
    );

    // slack-bridge depends on the experimental `claude/channel` capability,
    // which is only enabled when Claude is started with
    // --dangerously-load-development-channels. That flag is not propagated
    // to MCP child processes via env, but the parent process (Claude itself)
    // preserves it in its argv — readable via `ps`.
    const parentCmd = readParentCmd(process.ppid);
    const hasDevChannels = hasDevChannelsFlag(parentCmd);
    // Detecting `--agent <name>` (with the trailing space) lets us tell
    // whether the operator picked a specific agent at boot. When they did,
    // we leave that agent's prompt as the active personality and skip the
    // session-manager role injection. When they didn't, we load the .md
    // file at startup and surface it as the MCP `instructions` so the main
    // session adopts session-manager.
    const agentFlagPresent = hasAgentFlag(parentCmd);
    logger.log(`parent argv: ${parentCmd || '(unavailable)'}`);
    if (!hasDevChannels) {
      const msg =
        'slack-bridge requires Claude to be started with --dangerously-load-development-channels. ' +
        'Restart with: claude --dangerously-load-development-channels plugin:slack-bridge@ia-tools';
      logger.error(msg);

      // Reply to the JSON-RPC `initialize` request with an error so Claude
      // marks the MCP as failed and the user cannot invoke its tools. The
      // reason is surfaced in Claude's debug log
      // (~/.claude/debug/<session>.txt) and in
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
      // Block until exit so the rest of bootstrap doesn't run.
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
    const allowedSubscribeUsers = parseAllowedSubscribeUsers(
      process.env.SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS,
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

    // Decide once at startup. If the parent Claude was started with
    // `--agent`, the operator picked a specific persona — leave it alone.
    // Otherwise the main session is unspecialised and slack-bridge supplies
    // the session-manager role via the MCP `instructions` field.
    const sessionManagerPrompt = agentFlagPresent ? '' : loadSessionManagerPrompt(logger);
    if (agentFlagPresent) {
      logger.log('agent flag detected in parent argv — skipping session-manager prompt injection');
    }

    const mcpServer = new McpBridgeServer({
      web,
      daemonClient,
      logger,
      stateFilePath,
      allowedSubscribeUsers,
      sessionId: SESSION_ID,
      sessionManagerPrompt,
    });

    await mcpServer.connect(new StdioServerTransport());
  })();
}
