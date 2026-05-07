/**
 * McpLogger — session-scoped Logger for the MCP server.
 *
 * Wraps the shared `createLogger` factory so the MCP side never reaches
 * for env vars or hand-rolls a path. Pass a session-id (and optionally a
 * PathResolver for tests) and the logger writes to the right per-session
 * file under the resolver's base directory.
 *
 * SRP: bind a session-id + PathResolver to a Logger. The actual write
 * formatting / debuglog / file appending stays in `createLogger`. This
 * class is the smallest stable seam between mcp-server.ts and the logger
 * primitives, and lets tests mock either side independently.
 */

import { type Logger, createLogger } from '../logger.js';
import { PathResolver } from './path-resolver.js';

export interface McpLoggerOptions {
  /** Stable identifier for the MCP session (Claude session UUID, fallback id, etc.). */
  sessionId: string;
  /** Optional PathResolver — DI seam for tests. Defaults to a fresh instance. */
  paths?: PathResolver;
  /**
   * When true (the default), info/debug also go to stderr instead of stdout.
   * MCP servers must keep stdout clean for the JSON-RPC protocol.
   */
  stderr?: boolean;
}

export class McpLogger implements Logger {
  private readonly inner: Logger;

  constructor(opts: McpLoggerOptions) {
    if (typeof opts.sessionId !== 'string' || opts.sessionId.length === 0) {
      throw new Error('McpLogger: sessionId must be a non-empty string');
    }
    const paths = opts.paths ?? new PathResolver();
    const logPath = paths.getMcpLogPath(opts.sessionId);
    this.inner = createLogger({
      logPath,
      label: 'mcp',
      stderr: opts.stderr ?? true,
    });
  }

  /** Path of the underlying log file. Useful for boot messages. */
  get logPath(): string {
    return this.inner.logPath ?? '';
  }

  log(msg: string): void {
    this.inner.log(msg);
  }

  warn(msg: string): void {
    this.inner.warn(msg);
  }

  error(msg: string): void {
    this.inner.error(msg);
  }

  debug(msg: string): void {
    this.inner.debug(msg);
  }
}
