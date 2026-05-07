/**
 * DaemonLogger — path-scoped Logger for the daemon process.
 *
 * Wraps the shared `createLogger` factory under the "daemon" label and
 * accepts the log path via DI (no env reads, no globals). Daemon
 * subsystems (registry, server, lifecycle) take a Logger by constructor
 * argument; this class is what `daemon/index.ts` builds and passes in.
 *
 * SRP: bind a path to a Logger labelled "daemon". The path is decided
 * elsewhere (typically `PathResolver.getDaemonLogPath()` or the
 * DAEMON_LOG env var, resolved in the daemon entrypoint).
 */

import { type Logger, createLogger } from '../logger.js';

export interface DaemonLoggerOptions {
  /** Absolute path to the log file. */
  logPath: string;
}

export class DaemonLogger implements Logger {
  private readonly inner: Logger;

  constructor(opts: DaemonLoggerOptions) {
    if (typeof opts.logPath !== 'string' || opts.logPath.length === 0) {
      throw new Error('DaemonLogger: logPath must be a non-empty string');
    }
    this.inner = createLogger({
      logPath: opts.logPath,
      label: 'daemon',
    });
  }

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
