/**
 * Daemon lifecycle helpers.
 *
 * resolveDaemonUrl() — reads DAEMON_URL env var; returns null if absent.
 * ensureDaemon()     — starts the daemon once if it is not already running (singleton).
 *                      Safe to call concurrently — only one MCP instance will spawn it.
 *                      No-op if daemonUrl is null.
 */
/**
 * Resolve the daemon URL from the DAEMON_URL environment variable.
 * Returns null if not set or empty — the MCP server will start but skip subscription.
 */
export declare function resolveDaemonUrl(): string | null;
/**
 * Ensure a healthy daemon exists. Safe to call concurrently from multiple MCP instances —
 * only one will actually spawn the daemon; the rest wait for it to become healthy.
 * No-op if daemonUrl is null.
 *
 * Throws if SLACK_BOT_TOKEN / SLACK_APP_TOKEN are missing and the daemon is not running,
 * or if the daemon does not become healthy within HEALTH_TIMEOUT_MS.
 */
export declare function ensureDaemon(daemonUrl: string | null): Promise<void>;
//# sourceMappingURL=ensure-daemon.d.ts.map