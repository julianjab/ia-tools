#!/usr/bin/env node
/**
 * Parent-session IPC client.
 *
 * Two modes:
 *
 *   ipc-client.mjs ask <text>
 *     Lead-side. Opens IA_TW_PARENT_SOCK, posts a {type:"ask"} with
 *     a generated UUID, blocks until the server writes back a
 *     {type:"answer", text}, then prints the text on stdout and exits
 *     0. On timeout / error: prints the error to stderr, exits non-zero.
 *
 *   ipc-client.mjs answer <id> <text>
 *     Router-Claude side (via /ipc-answer skill). Opens the socket,
 *     posts {type:"answer", id, text}, expects {type:"ok"}, exits 0.
 *
 * The socket path is taken from IA_TW_PARENT_SOCK. When unset or the
 * socket is unreachable, exits 3 so the caller can fall back to the
 * terminal path (AskUserQuestion).
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';

const TIMEOUT_MS = Number(process.env.IA_TW_IPC_TIMEOUT_MS || 30 * 60 * 1000);

const [, , mode, ...rest] = process.argv;
const SOCK = process.env.IA_TW_PARENT_SOCK;
const FROM = process.env.IA_TW_FEATURE || process.env.TMUX_PANE || 'unknown';

if (!SOCK) {
  process.stderr.write('[ipc-client] IA_TW_PARENT_SOCK not set — parent IPC unavailable\n');
  process.exit(3);
}
if (!existsSync(SOCK)) {
  process.stderr.write(`[ipc-client] socket ${SOCK} does not exist\n`);
  process.exit(3);
}

function connect() {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
    conn.once('connect', () => resolve(conn));
    conn.once('error', reject);
  });
}

async function ask(text) {
  if (!text) {
    process.stderr.write('Usage: ipc-client.mjs ask <text>\n');
    process.exit(2);
  }
  const id = randomUUID();
  let conn;
  try {
    conn = await connect();
  } catch (err) {
    process.stderr.write(`[ipc-client] connect failed: ${err.message}\n`);
    process.exit(3);
  }
  conn.write(`${JSON.stringify({ type: 'ask', id, from: FROM, text })}\n`);

  let buffer = '';
  const timer = setTimeout(() => {
    process.stderr.write(`[ipc-client] timeout waiting for answer (${TIMEOUT_MS}ms)\n`);
    conn.destroy();
    process.exit(4);
  }, TIMEOUT_MS);

  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    const line = buffer.slice(0, nl);
    clearTimeout(timer);
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'answer') {
        process.stdout.write(msg.text);
        process.exit(0);
      }
      process.stderr.write(`[ipc-client] server error: ${msg.reason || JSON.stringify(msg)}\n`);
      process.exit(5);
    } catch (err) {
      process.stderr.write(`[ipc-client] parse error: ${err.message}\n`);
      process.exit(5);
    }
  });
  conn.on('error', (err) => {
    clearTimeout(timer);
    process.stderr.write(`[ipc-client] socket error: ${err.message}\n`);
    process.exit(5);
  });
}

async function answer(id, text) {
  if (!id || text === undefined) {
    process.stderr.write('Usage: ipc-client.mjs answer <id> <text>\n');
    process.exit(2);
  }
  let conn;
  try {
    conn = await connect();
  } catch (err) {
    process.stderr.write(`[ipc-client] connect failed: ${err.message}\n`);
    process.exit(3);
  }
  conn.write(`${JSON.stringify({ type: 'answer', id, text })}\n`);

  let buffer = '';
  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    const line = buffer.slice(0, nl);
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'ok') {
        process.stdout.write(`ok (id=${id})\n`);
        process.exit(0);
      }
      process.stderr.write(`[ipc-client] server error: ${msg.reason || JSON.stringify(msg)}\n`);
      process.exit(5);
    } catch (err) {
      process.stderr.write(`[ipc-client] parse error: ${err.message}\n`);
      process.exit(5);
    }
  });
  conn.on('error', (err) => {
    process.stderr.write(`[ipc-client] socket error: ${err.message}\n`);
    process.exit(5);
  });
}

if (mode === 'ask') {
  await ask(rest.join(' '));
} else if (mode === 'answer') {
  const [id, ...textParts] = rest;
  await answer(id, textParts.join(' '));
} else {
  process.stderr.write('Usage: ipc-client.mjs ask <text>  |  ipc-client.mjs answer <id> <text>\n');
  process.exit(2);
}
