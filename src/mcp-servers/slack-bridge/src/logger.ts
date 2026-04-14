/**
 * Shared logger for daemon and MCP server.
 *
 * createLogger({ logPath, label }) — returns { log, warn, error }.
 *
 * Format (file + terminal): [YYYY-MM-DD HH:mm:ss] LEVEL [label] msg
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Level = 'info' | 'warn' | 'error';

export interface Logger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  logPath: string;
}

function now(): { date: string; time: string } {
  const d = new Date();
  return {
    date: d.toLocaleDateString('en-CA'), // YYYY-MM-DD
    time: d.toTimeString().slice(0, 8), // HH:mm:ss
  };
}

export function createLogger(opts: { logPath: string; label: string; stderr?: boolean }): Logger {
  const { logPath, label, stderr: allStderr = false } = opts;

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* best effort */
  }

  function write(level: Level, msg: string): void {
    const { date, time } = now();
    const line = `[${date} ${time}] ${level.toUpperCase().padEnd(5)} [${label}] ${msg}\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      /* best effort — never crash over a log write failure */
    }
    // MCP servers use stdout as the protocol transport — always write to stderr there.
    if (allStderr || level === 'error' || level === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    log: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    logPath,
  };
}
