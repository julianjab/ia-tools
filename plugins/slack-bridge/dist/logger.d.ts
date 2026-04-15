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
export type Level = 'info' | 'warn' | 'error' | 'debug';
export interface Logger {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    /** Writes to log file always; writes to stderr only when NODE_DEBUG matches. */
    debug: (msg: string) => void;
    logPath?: string;
}
export declare function createLogger(opts: {
    logPath: string;
    label: string;
    stderr?: boolean;
    /** NODE_DEBUG namespace. Defaults to 'slack-bridge:<label>'. */
    debugNamespace?: string;
}): Logger;
//# sourceMappingURL=logger.d.ts.map