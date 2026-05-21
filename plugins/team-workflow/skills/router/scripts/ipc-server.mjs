#!/usr/bin/env node
/**
 * Parent-session IPC server.
 *
 * Spawned in background by start-router.sh. Lets child sessions (a lead
 * booted via /session in local mode without an attached operator) ask
 * questions of the router-Claude that owns them, by:
 *
 *   1. listening on a Unix socket at IA_TW_PARENT_SOCK,
 *   2. injecting incoming questions into the router's tmux session as
 *      a synthetic user message prefixed `[ipc id=<uuid>] …`, and
 *   3. routing the router-Claude's answer (delivered by the /ipc-answer
 *      skill back through the same socket) to the original waiting
 *      lead connection.
 *
 * Protocol (newline-delimited JSON, both directions):
 *
 *   ask    {type: "ask", id, from, text}            // lead → server
 *   answer {type: "answer", id, text}               // /ipc-answer → server
 *   ok     {type: "ok"}                             // server → answer client
 *   error  {type: "error", reason}                  // server → any client
 *
 * The server is intentionally stateless beyond the open-question map;
 * questions older than IPC_TTL_MS are evicted. Each connection is
 * short-lived: a lead opens it, posts its `ask`, blocks on read, and
 * disconnects after receiving the answer.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';

const SOCK = process.env.IA_TW_PARENT_SOCK;
const TMUX_SESSION = process.env.IA_TW_PARENT_TMUX_SESSION;
const IPC_TTL_MS = 30 * 60 * 1000; // 30 min — questions abandoned past this are evicted

if (!SOCK) {
  process.stderr.write('[ipc-server] IA_TW_PARENT_SOCK is required\n');
  process.exit(2);
}
if (!TMUX_SESSION) {
  process.stderr.write('[ipc-server] IA_TW_PARENT_TMUX_SESSION is required\n');
  process.exit(2);
}

mkdirSync(dirname(SOCK), { recursive: true });
try {
  unlinkSync(SOCK);
} catch {
  // socket may not exist on first boot — ignore
}

/** id → { conn, createdAt, from } */
const pending = new Map();

setInterval(() => {
  const cutoff = Date.now() - IPC_TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) {
      try {
        entry.conn.write(`${JSON.stringify({ type: 'error', reason: 'timeout', id })}\n`);
        entry.conn.end();
      } catch {
        // connection may already be closed
      }
      pending.delete(id);
    }
  }
}, 60_000).unref();

function injectIntoTmux(id, from, text) {
  // Two-step paste: literal text first, then a separate Enter so the
  // TUI submits. Mirrors the protocol /send-session-message uses.
  const body = `[ipc id=${id} from=${from}] ${text}`;
  const r1 = spawnSync('tmux', ['send-keys', '-t', TMUX_SESSION, '-l', '--', body], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r1.status !== 0) {
    return { ok: false, error: `tmux send-keys -l failed: ${r1.stderr.toString()}` };
  }
  const r2 = spawnSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r2.status !== 0) {
    return { ok: false, error: `tmux send-keys Enter failed: ${r2.stderr.toString()}` };
  }
  return { ok: true };
}

const server = net.createServer((conn) => {
  let buffer = '';
  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    // biome-ignore lint/suspicious/noAssignInExpressions: line splitter
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        conn.write(`${JSON.stringify({ type: 'error', reason: 'invalid_json' })}\n`);
        continue;
      }

      if (msg.type === 'ask') {
        const id = msg.id || randomUUID();
        const from = msg.from || 'unknown';
        const text = String(msg.text || '');
        pending.set(id, { conn, createdAt: Date.now(), from });
        const r = injectIntoTmux(id, from, text);
        if (!r.ok) {
          pending.delete(id);
          conn.write(`${JSON.stringify({ type: 'error', reason: r.error, id })}\n`);
          conn.end();
        }
        // else: keep connection open; answer will arrive via a separate
        // /ipc-answer client and be routed back through `pending`.
        continue;
      }

      if (msg.type === 'answer') {
        const id = String(msg.id || '');
        const entry = pending.get(id);
        if (!entry) {
          conn.write(`${JSON.stringify({ type: 'error', reason: 'unknown_id', id })}\n`);
          conn.end();
          continue;
        }
        try {
          entry.conn.write(
            `${JSON.stringify({ type: 'answer', id, text: String(msg.text || '') })}\n`,
          );
          entry.conn.end();
        } catch {
          // original lead disconnected before answer arrived
        }
        pending.delete(id);
        conn.write(`${JSON.stringify({ type: 'ok' })}\n`);
        conn.end();
        continue;
      }

      conn.write(`${JSON.stringify({ type: 'error', reason: 'unknown_type' })}\n`);
    }
  });
  conn.on('error', () => {
    /* swallow — peer may have disconnected mid-write */
  });
});

server.listen(SOCK, () => {
  process.stderr.write(`[ipc-server] listening on ${SOCK} (tmux=${TMUX_SESSION})\n`);
});

function shutdown() {
  try {
    unlinkSync(SOCK);
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
