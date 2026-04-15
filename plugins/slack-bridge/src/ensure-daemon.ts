/**
 * Daemon lifecycle helpers — fileless singleton.
 *
 * resolveDaemonUrl() — reads DAEMON_URL env var; returns null if absent.
 * ensureDaemon()     — starts the daemon once if it is not already running.
 *                      Safe to call concurrently from multiple MCP instances —
 *                      the daemon's listen port acts as the mutex (the OS lets
 *                      only one process bind 127.0.0.1:<port>). Race losers die
 *                      with EADDRINUSE and every caller polls /health until the
 *                      winner is ready. No pidfiles, no state on disk.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;
const HEALTH_PROBE_TIMEOUT_MS = 500;
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:3800';

/**
 * Resolve the daemon URL. Uses DAEMON_URL if set, otherwise falls back to the
 * local default so the MCP can auto-boot the daemon out of the box.
 */
export function resolveDaemonUrl(): string {
  const envUrl = process.env.DAEMON_URL?.trim();
  return envUrl || DEFAULT_DAEMON_URL;
}

async function isHealthy(daemonUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
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

function daemonEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'daemon/index.js');
}

function spawnDaemon(port: number): void {
  const logPath = process.env.DAEMON_LOG?.trim() || '/tmp/slack-bridge/daemon-logs.json';
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* best effort */
  }
  const logFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [daemonEntrypoint()], {
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
    env: { ...process.env, DAEMON_PORT: String(port) },
  });
  closeSync(logFd);
  child.unref();
}

/**
 * Ensure a healthy daemon exists. Safe to call concurrently from multiple MCP
 * instances — at most one spawn wins the port bind; the rest see EADDRINUSE,
 * exit, and all callers poll /health until the winner is ready. No-op when
 * daemonUrl is null.
 *
 * Throws if SLACK_BOT_TOKEN / SLACK_APP_TOKEN are missing and the daemon is
 * not already running, or if the daemon does not become healthy within
 * HEALTH_TIMEOUT_MS.
 */
export async function ensureDaemon(daemonUrl: string): Promise<void> {
  if (await isHealthy(daemonUrl)) return;

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    throw new Error(
      'slack-bridge daemon is not running and cannot be auto-started: ' +
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set.',
    );
  }

  const port = Number.parseInt(new URL(daemonUrl).port || '3800', 10);
  spawnDaemon(port);

  const ok = await waitHealthy(daemonUrl, HEALTH_TIMEOUT_MS);
  if (!ok) {
    throw new Error(
      `slack-bridge daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms. ` +
        `Check ${process.env.DAEMON_LOG || '/tmp/slack-bridge/daemon-logs.json'} for details.`,
    );
  }
}
