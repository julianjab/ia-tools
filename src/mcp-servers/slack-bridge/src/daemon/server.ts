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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from './logger.js';
import type { Registry } from './registry.js';
import type {
  SubscribeRequest,
  ClaimRequest,
  ClaimResponse,
  DaemonHealth,
} from '../shared/types.js';

/** In-memory claim store: message_ts → subscriber port */
const claims = new Map<string, number>();

/** Auto-expire claims after 5 minutes */
const CLAIM_TTL_MS = 5 * 60 * 1000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createApiServer(
  registry: Registry,
  startedAt: number,
  getSocketStatus: () => 'connected' | 'disconnected',
) {
  // Periodic cleanup of expired claims
  setInterval(() => {
    const now = Date.now();
    for (const [ts] of claims) {
      const claimTime = parseFloat(ts) * 1000;
      if (now - claimTime > CLAIM_TTL_MS) claims.delete(ts);
    }
  }, 60_000);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // POST /subscribe
    if (req.method === 'POST' && path === '/subscribe') {
      try {
        const body: SubscribeRequest = JSON.parse(await readBody(req));
        if (!body.port) {
          json(res, 400, { error: 'port is required' });
          return;
        }
        const sub = registry.add(body.port, body.filters ?? {}, body.regexp, body.label);
        log(
          `[api] +subscriber :${body.port} (${body.label ?? '-'}) filters=${JSON.stringify(body.filters)} regexp=${JSON.stringify(body.regexp ?? {})}`,
        );
        json(res, 200, sub);
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
      return;
    }

    // DELETE /subscribe/:port
    if (req.method === 'DELETE' && path.startsWith('/subscribe/')) {
      const port = parseInt(path.split('/')[2], 10);
      if (isNaN(port)) {
        json(res, 400, { error: 'invalid port' });
        return;
      }
      const removed = registry.remove(port);
      log(`[api] -subscriber :${port} removed=${removed}`);
      json(res, 200, { removed });
      return;
    }

    // GET /subscribers
    if (req.method === 'GET' && path === '/subscribers') {
      json(res, 200, registry.all());
      return;
    }

    // POST /claim/:message_ts — first caller wins
    if (req.method === 'POST' && path.startsWith('/claim/')) {
      const messageTs = path.slice('/claim/'.length);
      if (!messageTs) {
        json(res, 400, { error: 'message_ts is required' });
        return;
      }
      try {
        const body: ClaimRequest = JSON.parse(await readBody(req));
        const existing = claims.get(messageTs);

        if (existing !== undefined) {
          const resp: ClaimResponse = { claimed: false, claimed_by: existing };
          log(
            `[claim] ${messageTs} already claimed by :${existing}, rejected :${body.subscriber_port}`,
          );
          json(res, 409, resp);
          return;
        }

        claims.set(messageTs, body.subscriber_port);
        const resp: ClaimResponse = { claimed: true };
        log(`[claim] ${messageTs} → :${body.subscriber_port}`);
        json(res, 200, resp);
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
      return;
    }

    // GET /health
    if (req.method === 'GET' && path === '/health') {
      const health: DaemonHealth = {
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        subscribers: registry.all().length,
        socketMode: getSocketStatus(),
      };
      json(res, 200, health);
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  return server;
}
