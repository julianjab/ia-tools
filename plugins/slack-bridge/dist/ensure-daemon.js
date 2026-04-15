/**
 * Daemon lifecycle helpers.
 *
 * resolveDaemonUrl() — reads DAEMON_URL env var; returns null if absent.
 * ensureDaemon()     — starts the daemon once if it is not already running (singleton).
 *                      Safe to call concurrently — only one MCP instance will spawn it.
 *                      No-op if daemonUrl is null.
 */
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;
/**
 * Resolve the daemon URL from the DAEMON_URL environment variable.
 * Returns null if not set or empty — the MCP server will start but skip subscription.
 */
export function resolveDaemonUrl() {
    const envUrl = process.env.DAEMON_URL;
    return envUrl?.trim() || null;
}
async function isHealthy(daemonUrl) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 500);
        const res = await fetch(`${daemonUrl}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        return res.ok;
    }
    catch {
        return false;
    }
}
async function waitHealthy(daemonUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isHealthy(daemonUrl))
            return true;
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    return false;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function acquireLock(lockPath) {
    try {
        const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
    }
    catch (err) {
        if (err.code !== 'EEXIST')
            throw err;
    }
    try {
        const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        if (Number.isFinite(pid) && processAlive(pid))
            return false;
        unlinkSync(lockPath);
        return acquireLock(lockPath);
    }
    catch {
        return false;
    }
}
function daemonEntrypoint() {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, 'daemon/index.js');
}
function spawnDaemon(port) {
    const logPath = process.env.DAEMON_LOG?.trim() || '/tmp/slack-bridge/daemon-logs.json';
    try {
        mkdirSync(dirname(logPath), { recursive: true });
    }
    catch {
        /* best effort */
    }
    const logFd = openSync(logPath, 'a');
    // Redirect stderr to the log file so crashes before the logger initialises are captured.
    const child = spawn(process.execPath, [daemonEntrypoint()], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd],
        env: { ...process.env, DAEMON_PORT: String(port) },
    });
    closeSync(logFd);
    child.unref();
}
/**
 * Ensure a healthy daemon exists. Safe to call concurrently from multiple MCP instances —
 * only one will actually spawn the daemon; the rest wait for it to become healthy.
 * No-op if daemonUrl is null.
 *
 * Throws if SLACK_BOT_TOKEN / SLACK_APP_TOKEN are missing and the daemon is not running,
 * or if the daemon does not become healthy within HEALTH_TIMEOUT_MS.
 */
export async function ensureDaemon(daemonUrl) {
    if (!daemonUrl)
        return;
    if (await isHealthy(daemonUrl))
        return;
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
        throw new Error('slack-bridge daemon is not running and cannot be auto-started: ' +
            'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set.');
    }
    const stateBase = process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`;
    const stateDir = `${stateBase}/ia-tools/slack-bridge`;
    if (!existsSync(stateDir))
        mkdirSync(stateDir, { recursive: true });
    const lockPath = `${stateDir}/daemon.pid`;
    if (acquireLock(lockPath)) {
        try {
            const port = Number.parseInt(new URL(daemonUrl).port || '3800', 10);
            spawnDaemon(port);
        }
        catch (err) {
            try {
                unlinkSync(lockPath);
            }
            catch {
                /* best effort */
            }
            throw err;
        }
    }
    const ok = await waitHealthy(daemonUrl, HEALTH_TIMEOUT_MS);
    if (!ok) {
        throw new Error(`slack-bridge daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms. ` +
            `Check ${process.env.DAEMON_LOG || '/tmp/slack-bridge/daemon-logs.json'} for details.`);
    }
}
//# sourceMappingURL=ensure-daemon.js.map