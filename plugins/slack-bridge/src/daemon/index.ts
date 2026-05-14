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
 *   DAEMON_PORT                  — HTTP API port (default: 3800)
 *   DAEMON_LOG                   — Log file path (default: /tmp/slack-bridge/daemon-logs.json)
 *   DAEMON_IDLE_SHUTDOWN_MS      — Auto-exit after this many ms with 0 subscribers
 *                                  (default: 600000 = 10 min; set to 0 to disable)
 */

import { fileURLToPath } from 'node:url';
import { buildSlackMessage } from '../shared/build-message.js';
import { DaemonLogger } from '../shared/daemon-logger.js';
import { PathResolver } from '../shared/path-resolver.js';
import { type MessagePayload, parseTopic } from '../shared/types.js';
import { type SlackEvent, resolveChannel, resolveUser, startListener } from './listener.js';
import { Registry } from './registry.js';
import { createApiServer } from './server.js';

// Resolve the daemon log path once: DAEMON_LOG env wins, else PathResolver.
const paths = new PathResolver();
const daemonLogPath = process.env.DAEMON_LOG?.trim() || paths.getDaemonLogPath();
const daemonLogger = new DaemonLogger({ logPath: daemonLogPath });
const log = (msg: string) => daemonLogger.log(msg);
const warn = (msg: string) => daemonLogger.warn(msg);
const error = (msg: string) => daemonLogger.error(msg);
const logPath = daemonLogger.logPath;

// ─── CLI args ───────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const botToken = arg('bot-token') ?? process.env.SLACK_BOT_TOKEN;
const appToken = arg('app-token') ?? process.env.SLACK_APP_TOKEN;
const port = Number.parseInt(process.env.DAEMON_PORT ?? '3800', 10);

if (!botToken || !appToken) {
  error('Missing --bot-token / SLACK_BOT_TOKEN or --app-token / SLACK_APP_TOKEN');
  process.exit(1);
}

const registry = new Registry({ logger: daemonLogger });
const startedAt = Date.now();
let socketStatus: 'connected' | 'disconnected' = 'disconnected';

const entrypoint = fileURLToPath(import.meta.url);
log(`[daemon] starting — pid=${process.pid} port=${port} entrypoint=${entrypoint} log=${logPath}`);

// Trace who spawned us — env vars are set by ensure-daemon.ts in the MCP.
// When the daemon is launched manually (pnpm daemon) these are absent.
const spawnerSession = process.env.DAEMON_SPAWNER_SESSION;
if (spawnerSession) {
  log(
    `[daemon] spawned by mcp — session=${spawnerSession} pid=${process.env.DAEMON_SPAWNER_PID ?? '?'} ppid=${process.env.DAEMON_SPAWNER_PPID ?? '?'} cwd=${process.env.DAEMON_SPAWNER_CWD ?? '?'} ts=${process.env.DAEMON_SPAWNER_TS ?? '?'}`,
  );
} else {
  log('[daemon] spawned manually (no DAEMON_SPAWNER_* env)');
}

// ─── HTTP API ───────────────────────────────────────────────────────
// Bind the port BEFORE starting Socket Mode so that if another daemon is
// already running we exit immediately with EADDRINUSE instead of opening a
// duplicate Slack connection. The listen port is the singleton mutex.
const api = createApiServer(registry, startedAt, () => socketStatus, undefined, daemonLogger);
await new Promise<void>((resolveListen, rejectListen) => {
  const onError = (err: NodeJS.ErrnoException) => {
    api.off('listening', onListening);
    rejectListen(err);
  };
  const onListening = () => {
    api.off('error', onError);
    log(`[daemon] API listening on :${port}`);
    resolveListen();
  };
  api.once('error', onError);
  api.once('listening', onListening);
  api.listen(port);
}).catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    warn(`[daemon] port ${port} already bound — another daemon is running. Exiting.`);
    process.exit(0);
  }
  error(`[daemon] failed to bind :${port} — ${err.message}`);
  process.exit(1);
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

// ─── Idle auto-shutdown ─────────────────────────────────────────────
// When no subscribers are registered for `DAEMON_IDLE_SHUTDOWN_MS`, exit so
// stale daemons don't outlive every Claude session that ever used them. Any
// new MCP that needs the daemon will spawn a fresh one via ensureDaemon.
// Set DAEMON_IDLE_SHUTDOWN_MS=0 to disable (persistent daemon).
const IDLE_SHUTDOWN_MS = Number.parseInt(
  process.env.DAEMON_IDLE_SHUTDOWN_MS ?? String(10 * 60 * 1000),
  10,
);
let lastActiveAt = Date.now();
if (IDLE_SHUTDOWN_MS > 0) {
  log(`[daemon] idle auto-shutdown enabled — ${Math.round(IDLE_SHUTDOWN_MS / 1000)}s`);
  setInterval(() => {
    if (registry.all().length > 0) {
      lastActiveAt = Date.now();
      return;
    }
    const idleMs = Date.now() - lastActiveAt;
    if (idleMs >= IDLE_SHUTDOWN_MS) {
      log(
        `[daemon] no subscribers for ${Math.round(idleMs / 1000)}s — shutting down (set DAEMON_IDLE_SHUTDOWN_MS=0 to disable)`,
      );
      registry.stopHealthChecks();
      api.close();
      process.exit(0);
    }
  }, 60_000);
} else {
  log('[daemon] idle auto-shutdown disabled (DAEMON_IDLE_SHUTDOWN_MS=0) — persistent mode');
}

// ─── Slack listener ─────────────────────────────────────────────────
const app = await startListener(
  { botToken, appToken },
  async (event: SlackEvent) => {
  socketStatus = 'connected';

  // Resolve names
  const [userName, channelName] = await Promise.all([
    resolveUser(app, event.user_id),
    resolveChannel(app, event.channel_id),
  ]);

  const msg = buildSlackMessage({
    channel_id: event.channel_id,
    channel_name: channelName,
    user_id: event.user_id,
    user_name: userName,
    text: event.text,
    message_ts: event.message_ts,
    thread_ts: event.thread_ts,
    thread_context: event.thread_context,
  });

  // Route to matching subscribers
  const targets = registry.match(msg);
  if (targets.length === 0) {
    log(`[route] no subscribers for #${channelName} from ${userName} — dropping`);
    return;
  }

  log(
    `[route] #${channelName} ${userName}: "${event.text.slice(0, 60)}" → ${targets.length} subscriber(s)`,
  );

  // Specificity pre-emption (registry.match): less-specific subscribers get
  // dropped when a more specific subscription also matched. Log only when
  // any were actually pre-empted, to avoid noise on the common single-match
  // case. maxScore is recomputed from the surviving winners — they all
  // share the same score by construction.
  const matchingCount = registry.countMatchingSubscribers(msg);
  const dropped = matchingCount - targets.length;
  if (dropped > 0) {
    let maxScore = 0;
    for (const { matched } of targets) {
      for (const t of matched) {
        const p = parseTopic(t.topic);
        let s = 0;
        if (p.channel) s++;
        if (p.user) s++;
        if (p.thread) s++;
        if (s > maxScore) maxScore = s;
      }
    }
    log(`[route] specificity max=${maxScore} — ${targets.length} winner(s), ${dropped} pre-empted`);
  }

  await Promise.allSettled(
    targets.map(async ({ subscriber: sub, matched }) => {
      const payload: MessagePayload = {
        message: msg,
        matched_topics: matched,
        daemon_ts: new Date().toISOString(),
      };
      const sessionSeg = sub.session_id ? ` (session=${sub.session_id})` : '';
      const matchedTopics = matched.map((t) => t.topic).join(',');
      log(
        `[route] → :${sub.port}${sessionSeg} #${channelName} ${userName} matched=[${matchedTopics}]`,
      );
      try {
        const res = await fetch(`http://localhost:${sub.port}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          warn(`[route] subscriber :${sub.port}${sessionSeg} responded ${res.status} — removing`);
          registry.remove(sub.port);
          return;
        }
        registry.markSeen(sub.port);
      } catch (_err) {
        warn(`[route] subscriber :${sub.port}${sessionSeg} unreachable — removing`);
        registry.remove(sub.port);
      }
    }),
  );
  },
  (channelId, threadTs) => registry.hasThreadSubscription(channelId, threadTs),
);

socketStatus = 'connected';

// ─── Graceful shutdown ──────────────────────────────────────────────
process.on('SIGINT', () => {
  log('[daemon] shutting down...');
  registry.stopHealthChecks();
  api.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('[daemon] shutting down...');
  registry.stopHealthChecks();
  api.close();
  process.exit(0);
});
