/**
 * Ensures the slack-bridge daemon is running before the MCP server connects.
 *
 * Strategy:
 *  1. Probe `${DAEMON_URL}/health`. If it responds, we're done.
 *  2. Otherwise, try to acquire an exclusive pidfile lock. First winner spawns
 *     the daemon as a detached child. Losers just wait for the winner's daemon
 *     to become healthy.
 *  3. Poll `/health` until ready (or timeout).
 *
 * The daemon is a singleton Socket Mode connection to Slack, so only one must
 * run per machine regardless of how many MCP clients (Claude sessions) boot up.
 */

import { spawn } from "node:child_process";
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, mkdirSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;

function stateDir(): string {
  const base = process.env['XDG_STATE_HOME'] ?? `${homedir()}/.local/state`;
  const dir = `${base}/ia-tools/slack-bridge`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function isHealthy(daemonUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch(`${daemonUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(daemonUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(daemonUrl)) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to atomically create the pidfile. Returns true if we became the owner.
 * If the file exists but points at a dead pid, we take it over.
 */
function acquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
  }

  try {
    const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && processAlive(pid)) return false;
    unlinkSync(lockPath);
    return acquireLock(lockPath);
  } catch {
    return false;
  }
}

function daemonEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'daemon/index.js');
}

function spawnDaemon(logPath: string, port: number): void {
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [daemonEntrypoint()], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, DAEMON_PORT: String(port) },
  });
  child.unref();
}

/**
 * Resolve the daemon URL using a priority chain:
 *   1. DAEMON_URL env var (if defined and non-empty after trim) → use as-is.
 *   2. Read ${stateDir}/daemon.port; if valid port (1-65535) → http://localhost:<port>.
 *   3. Fallback: http://localhost:3800.
 *
 * The port file path is:
 *   - When XDG_STATE_HOME is set: ${XDG_STATE_HOME}/daemon.port
 *   - Otherwise: ${homedir()}/.local/state/ia-tools/slack-bridge/daemon.port
 */
export function resolveDaemonUrl(): string {
  const envUrl = process.env["DAEMON_URL"];
  if (envUrl && envUrl.trim()) {
    return envUrl.trim();
  }

  // Determine port file path
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  const portFilePath = xdgStateHome
    ? join(xdgStateHome, "daemon.port")
    : join(homedir(), ".local", "state", "ia-tools", "slack-bridge", "daemon.port");

  try {
    const raw = readFileSync(portFilePath, "utf8").trim();
    const port = parseInt(raw, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://localhost:${port}`;
    }
  } catch {
    /* port file does not exist or is unreadable — fall through to default */
  }

  return "http://localhost:3800";
}

/**
 * Ensure a healthy daemon exists. Safe to call concurrently across processes —
 * at most one will actually spawn.
 */
export async function ensureDaemon(daemonUrl: string): Promise<void> {
  if (await isHealthy(daemonUrl)) return;

  if (!process.env['SLACK_BOT_TOKEN'] || !process.env['SLACK_APP_TOKEN']) {
    throw new Error(
      'slack-bridge daemon is not running and cannot be auto-started: ' +
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in the MCP server env.',
    );
  }

  const dir = stateDir();
  const lockPath = `${dir}/daemon.pid`;
  const logPath = `${dir}/daemon.log`;

  if (acquireLock(lockPath)) {
    try {
      const port = parseInt(new URL(daemonUrl).port || '3800', 10);
      spawnDaemon(logPath, port);
    } catch (err) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  const ok = await waitHealthy(daemonUrl, HEALTH_TIMEOUT_MS);
  if (!ok) {
    throw new Error(
      `slack-bridge daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms. ` +
        `Check ${logPath} for details.`,
    );
  }
}
