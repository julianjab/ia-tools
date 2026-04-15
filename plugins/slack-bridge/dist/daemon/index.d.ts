#!/usr/bin/env node
/**
 * Slack Bridge Daemon — standalone process.
 *
 * Single Socket Mode connection to Slack.
 * Routes messages to registered subscribers (MCP instances) via HTTP webhooks.
 *
 * Usage:
 *   node dist/daemon/index.js --bot-token xoxb-... --app-token xapp-...
 *
 * Args (take precedence over env vars):
 *   --bot-token <token>   Bot token (xoxb-...)
 *   --app-token <token>   App-level token for Socket Mode (xapp-...)
 *
 * Env (fallback):
 *   SLACK_BOT_TOKEN   — Bot token
 *   SLACK_APP_TOKEN   — App-level token for Socket Mode
 *   DAEMON_PORT       — HTTP API port (default: 3800)
 *   DAEMON_LOG        — Log file path (default: /tmp/slack-bridge/daemon-logs.json)
 */
export {};
//# sourceMappingURL=index.d.ts.map