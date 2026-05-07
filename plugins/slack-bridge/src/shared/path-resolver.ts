/**
 * PathResolver — single source of truth for slack-bridge file paths.
 *
 * All on-disk artifacts live under a single base directory (default
 * `/tmp/slack-bridge`):
 *
 *   <base>/daemon-logs.json                  ← daemon-wide (no session)
 *   <base>/<sessionId>/                      ← per-MCP-session directory
 *   <base>/<sessionId>/slack-bridge.json     ← persisted topic subscriptions
 *   <base>/<sessionId>/mcp-logs.json         ← per-session MCP log file
 *
 * The class is pure: it never touches the filesystem. Callers (loggers,
 * config helpers) handle directory creation. This keeps the resolver
 * trivially mockable in tests — pass a `baseDir` pointing at a tmp dir
 * and every derived path follows.
 *
 * SRP: path resolution only. SOLID:
 *   - Single Responsibility: resolve paths.
 *   - Open/Closed: extend by subclassing or constructor options.
 *   - Liskov: deterministic, no surprising overrides.
 *   - Interface Segregation: a flat, focused method surface.
 *   - Dependency Inversion: consumers depend on this class via DI.
 */

import { join } from 'node:path';

const DEFAULT_BASE_DIR = '/tmp/slack-bridge';
const STATE_FILE_NAME = 'slack-bridge.json';
const MCP_LOG_FILE_NAME = 'mcp-logs.json';
const DAEMON_LOG_FILE_NAME = 'daemon-logs.json';

export interface PathResolverOptions {
  /** Base directory for all slack-bridge artifacts. Defaults to /tmp/slack-bridge. */
  baseDir?: string;
}

export class PathResolver {
  private readonly baseDir: string;

  constructor(opts: PathResolverOptions = {}) {
    const raw = opts.baseDir?.trim();
    const base = raw && raw.length > 0 ? raw : DEFAULT_BASE_DIR;
    // Strip a single trailing slash so join() doesn't double up.
    this.baseDir = base.endsWith('/') ? base.slice(0, -1) : base;
  }

  /** The base directory all other paths derive from. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** `<base>/<sessionId>` — per-session directory. */
  getSessionDir(sessionId: string): string {
    requireSessionId(sessionId);
    return join(this.baseDir, sessionId);
  }

  /** `<base>/<sessionId>/slack-bridge.json` — persisted subscriptions. */
  getStateFilePath(sessionId: string): string {
    requireSessionId(sessionId);
    return join(this.baseDir, sessionId, STATE_FILE_NAME);
  }

  /** `<base>/<sessionId>/mcp-logs.json` — per-session MCP log. */
  getMcpLogPath(sessionId: string): string {
    requireSessionId(sessionId);
    return join(this.baseDir, sessionId, MCP_LOG_FILE_NAME);
  }

  /** `<base>/daemon-logs.json` — daemon-wide log (no session). */
  getDaemonLogPath(): string {
    return join(this.baseDir, DAEMON_LOG_FILE_NAME);
  }
}

function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('PathResolver: sessionId must be a non-empty string');
  }
}
