/**
 * Default daemon logger — module-level singleton used by daemon subsystems
 * (`ack.ts`, `listener.ts`, `index.ts`) that don't receive a logger via DI.
 *
 * This is a thin compatibility wrapper around `DaemonLogger`. It resolves the
 * log path from `DAEMON_LOG` env var (when set) or falls back to
 * `PathResolver.getDaemonLogPath()` so all paths flow through one source of
 * truth.
 *
 * Newer code paths (Registry, createApiServer) accept a Logger via DI and
 * never go through this module. Prefer DI for anything new.
 */

import { DaemonLogger } from '../shared/daemon-logger.js';
import { PathResolver } from '../shared/path-resolver.js';

function resolveDefaultLogPath(): string {
  const fromEnv = process.env.DAEMON_LOG?.trim();
  if (fromEnv) return fromEnv;
  return new PathResolver().getDaemonLogPath();
}

const defaultLogger = new DaemonLogger({ logPath: resolveDefaultLogPath() });

export const log = (msg: string) => defaultLogger.log(msg);
export const warn = (msg: string) => defaultLogger.warn(msg);
export const error = (msg: string) => defaultLogger.error(msg);
export const debug = (msg: string) => defaultLogger.debug(msg);
export const logPath = defaultLogger.logPath;
