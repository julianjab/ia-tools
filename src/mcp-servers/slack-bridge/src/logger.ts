/**
 * Shared logger for daemon and MCP server.
 *
 * createLogger({ logPath, label }) — returns { log, warn, error, debug }.
 *
 * Format (file + terminal): [YYYY-MM-DD HH:mm:ss] LEVEL [label] msg
 *
 * debug() writes to the log file always and to stderr only when
 * NODE_DEBUG matches the namespace (default: 'slack-bridge:<label>').
 * Uses node:util debuglog so NODE_DEBUG glob rules apply:
 *   NODE_DEBUG=slack-bridge       → enables both mcp and daemon
 *   NODE_DEBUG=slack-bridge:mcp   → enables only mcp
 *   NODE_DEBUG=slack*             → glob match
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { debuglog } from 'node:util';

export type Level = 'info' | 'warn' | 'error' | 'debug';

export interface Logger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** Writes to log file always; writes to stderr only when NODE_DEBUG matches. */
  debug: (msg: string) => void;
  logPath?: string;
}

function now(): { date: string; time: string } {
  const d = new Date();
  return {
    date: d.toLocaleDateString('en-CA'), // YYYY-MM-DD
    time: d.toTimeString().slice(0, 8), // HH:mm:ss
  };
}

export function createLogger(opts: {
  logPath: string;
  label: string;
  stderr?: boolean;
  /** NODE_DEBUG namespace. Defaults to 'slack-bridge:<label>'. */
  debugNamespace?: string;
}): Logger {
  const { logPath, label, stderr: allStderr = false, debugNamespace } = opts;
  const namespace = debugNamespace ?? `slack-bridge:${label}`;

  // util.debuglog handles NODE_DEBUG matching (globs, comma-separated lists, etc.)
  const nodeDebug = debuglog(namespace);

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* best effort */
  }

  function writeToFile(level: Level, msg: string): void {
    const { date, time } = now();
    const line = `[${date} ${time}] ${level.toUpperCase().padEnd(5)} [${label}] ${msg}\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      /* best effort — never crash over a log write failure */
    }
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
    debug: (msg) => {
      // Always persist to file for post-mortem diagnostics
      writeToFile('debug', msg);
      // stderr only when NODE_DEBUG=slack-bridge (or slack-bridge:mcp, etc.)
      nodeDebug('%s', msg);
    },
    logPath,
  };
}
