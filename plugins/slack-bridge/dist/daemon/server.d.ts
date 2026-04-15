/**
 * Daemon HTTP API server.
 *
 * Endpoints:
 *   POST   /subscribe          — Register a subscriber
 *   DELETE /subscribe/:port    — Unregister
 *   GET    /subscribers        — List active subscribers
 *   POST   /claim/:message_ts  — Claim a message (first wins)
 *   GET    /health             — Health check
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Registry } from './registry.js';
export declare function createApiServer(registry: Registry, startedAt: number, getSocketStatus: () => 'connected' | 'disconnected'): import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
//# sourceMappingURL=server.d.ts.map