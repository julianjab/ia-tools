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

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Registry } from './registry.js';
import { createApiServer } from './server.js';
import { startListener, resolveUser, resolveChannel, type SlackEvent } from './listener.js';
import type { SlackMessage, MessagePayload } from '../shared/types.js';
import { log, warn, error, logPath } from './logger.js';

// ─── CLI args ───────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

// ─── Pidfile ────────────────────────────────────────────────────────
const stateBase = process.env['XDG_STATE_HOME'] ?? `${homedir()}/.local/state`;
const stateDir = `${stateBase}/ia-tools/slack-bridge`;
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
const pidFile = `${stateDir}/daemon.pid`;
writeFileSync(pidFile, String(process.pid));
const cleanupPidFile = () => {
  try {
    unlinkSync(pidFile);
  } catch {
    /* best effort */
  }
};
process.on('exit', cleanupPidFile);

const botToken = arg('bot-token') ?? process.env['SLACK_BOT_TOKEN'];
const appToken = arg('app-token') ?? process.env['SLACK_APP_TOKEN'];
const port = parseInt(process.env['DAEMON_PORT'] ?? '3800', 10);

if (!botToken || !appToken) {
  error('Missing --bot-token / SLACK_BOT_TOKEN or --app-token / SLACK_APP_TOKEN');
  process.exit(1);
}

const registry = new Registry();
const startedAt = Date.now();
let socketStatus: 'connected' | 'disconnected' = 'disconnected';

log(`[daemon] starting — port=${port} log=${logPath}`);

// ─── HTTP API ───────────────────────────────────────────────────────
const api = createApiServer(registry, startedAt, () => socketStatus);
api.listen(port, () => {
  log(`[daemon] API listening on :${port}`);
});

// ─── Health checks — remove dead subscribers ────────────────────────
registry.startHealthChecks(async (subscriberPort) => {
  try {
    const res = await fetch(`http://localhost:${subscriberPort}/health`);
    return res.ok;
  } catch {
    return false;
  }
});

// ─── Slack listener ─────────────────────────────────────────────────
const app = await startListener({ botToken, appToken }, async (event: SlackEvent) => {
  socketStatus = 'connected';

  // Resolve names
  const [userName, channelName] = await Promise.all([
    resolveUser(app, event.user_id),
    resolveChannel(app, event.channel_id),
  ]);

  const msg: SlackMessage = {
    channel_id: event.channel_id,
    channel_name: channelName,
    user_id: event.user_id,
    user_name: userName,
    text: event.text,
    message_ts: event.message_ts,
    thread_ts: event.thread_ts,
  };

  const payload: MessagePayload = {
    message: msg,
    daemon_ts: new Date().toISOString(),
  };

  // Route to matching subscribers
  const targets = registry.match(msg);
  if (targets.length === 0) {
    log(`[route] no subscribers for #${channelName} from ${userName} — dropping`);
    return;
  }

  log(
    `[route] #${channelName} ${userName}: "${event.text.slice(0, 60)}" → ${targets.length} subscriber(s)`,
  );

  await Promise.allSettled(
    targets.map(async (sub) => {
      try {
        const res = await fetch(`http://localhost:${sub.port}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          warn(`[route] subscriber :${sub.port} responded ${res.status} — removing`);
          registry.remove(sub.port);
          return;
        }
        registry.markSeen(sub.port);
      } catch (err) {
        warn(`[route] subscriber :${sub.port} unreachable — removing`);
        registry.remove(sub.port);
      }
    }),
  );
});

socketStatus = 'connected';

// ─── Graceful shutdown ──────────────────────────────────────────────
process.on('SIGINT', () => {
  log('[daemon] shutting down...');
  registry.stopHealthChecks();
  api.close();
  cleanupPidFile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('[daemon] shutting down...');
  registry.stopHealthChecks();
  api.close();
  cleanupPidFile();
  process.exit(0);
});
