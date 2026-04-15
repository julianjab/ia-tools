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
import { WebClient } from '@slack/web-api';
import { DaemonClient } from './daemon-client.js';
import type { Logger } from './logger.js';
export interface McpBridgeServerOptions {
    web: WebClient;
    daemonClient: DaemonClient | null;
    logger: Logger;
}
export declare class McpBridgeServer {
    private readonly mcp;
    private readonly web;
    private readonly daemonClient;
    private readonly logger;
    constructor({ web, daemonClient, logger }: McpBridgeServerOptions);
    get server(): Server;
    connect(transport: StdioServerTransport): Promise<void>;
    private registerHandlers;
    private dispatchTool;
    private handleSubscribeSlack;
    private handleUnsubscribeSlack;
    private handleClaimMessage;
    private handleReplySlack;
    private handleReadThread;
    private handleReadChannel;
    private handleListSlackChannels;
    private registerOnInitialized;
}
//# sourceMappingURL=mcp-server.d.ts.map