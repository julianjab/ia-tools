/**
 * resolveDaemonUrl — resolves the daemon HTTP API URL.
 *
 * Priority:
 *   1. DAEMON_URL env var (if set and non-empty)
 *   2. Port file at ${XDG_STATE_HOME}/ia-tools/slack-bridge/daemon.port
 *      or ~/.local/state/ia-tools/slack-bridge/daemon.port
 *   3. Fallback: http://localhost:3800
 *
 * The daemon must be started manually:
 *   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... pnpm --filter @ia-tools/slack-bridge daemon
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function resolveDaemonUrl(): string {
  const envUrl = process.env['DAEMON_URL'];
  if (envUrl?.trim()) return envUrl.trim();

  const xdgStateHome = process.env['XDG_STATE_HOME'];
  const portFilePath = xdgStateHome
    ? join(xdgStateHome, 'daemon.port')
    : join(homedir(), '.local', 'state', 'ia-tools', 'slack-bridge', 'daemon.port');

  try {
    const raw = readFileSync(portFilePath, 'utf8').trim();
    const port = parseInt(raw, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://localhost:${port}`;
    }
  } catch {
    /* port file absent or unreadable — fall through */
  }

  return 'http://localhost:3800';
}
