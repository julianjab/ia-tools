import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';

const logPath = process.env.DAEMON_LOG?.trim() || '/tmp/slack-bridge/daemon-logs.json';

const {
  log,
  warn,
  error,
  debug,
  logPath: resolvedPath,
} = createLogger({
  logPath,
  label: 'daemon',
});

export { log, warn, error, debug };
export { resolvedPath as logPath };

// ─── Per-session writers ────────────────────────────────────────────
// In addition to the central daemon log, append events related to a specific
// subscriber session to /tmp/slack-bridge/<session_id>/daemon-logs.json so
// the session's directory contains a complete view of its own slice of
// activity (mcp-logs.json + this file).

type Level = 'info' | 'warn' | 'error';

function nowParts(): { date: string; time: string } {
  const d = new Date();
  return {
    date: d.toLocaleDateString('en-CA'),
    time: d.toTimeString().slice(0, 8),
  };
}

function appendSessionLine(sessionId: string, level: Level, msg: string): void {
  const path = `/tmp/slack-bridge/${sessionId}/daemon-logs.json`;
  const { date, time } = nowParts();
  const line = `[${date} ${time}] ${level.toUpperCase().padEnd(5)} [daemon] ${msg}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
  } catch {
    /* best effort */
  }
}

export function logForSession(sessionId: string | undefined, msg: string): void {
  log(msg);
  if (sessionId) appendSessionLine(sessionId, 'info', msg);
}

export function warnForSession(sessionId: string | undefined, msg: string): void {
  warn(msg);
  if (sessionId) appendSessionLine(sessionId, 'warn', msg);
}

export function errorForSession(sessionId: string | undefined, msg: string): void {
  error(msg);
  if (sessionId) appendSessionLine(sessionId, 'error', msg);
}
