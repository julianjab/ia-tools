/**
 * Sub-task #1 — WebhookServer
 *
 * Tests for the NOT-YET-CREATED module: src/webhook-server.ts
 *
 * Contract (from REQ-MCP-REFACTOR):
 *   WebhookServer(onMessage: (payload: MessagePayload) => Promise<void>)
 *     - start()   → binds to a random port (0) and resolves with the assigned port
 *     - stop()    → closes the HTTP server gracefully
 *     - port      → getter, undefined before start()
 *     - GET /health          → 200 {"status":"ok"}  Content-Type: application/json
 *     - POST /message        → calls onMessage with parsed MessagePayload
 *     - POST /message (bad JSON) → 500, onMessage NOT called
 *     - POST /message (onMessage throws) → 500, body contains error text
 *     - GET /unknown         → 404
 *
 * RED phase: src/webhook-server.ts does NOT exist yet — import will fail.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
// RED: this module does not exist yet
import { WebhookServer } from '../webhook-server.js';
import type { MessagePayload } from '../shared/types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const CHANNEL_ID = 'C1';
const CHANNEL_NAME = 'general';
const USER_ID = 'U1';
const USER_NAME = 'alice';
const MESSAGE_TEXT = 'hello';
const MESSAGE_TS = '1234.5678';
const DAEMON_TS = '1234.0000';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeValidPayload(): MessagePayload {
  return {
    message: {
      channel_id: CHANNEL_ID,
      channel_name: CHANNEL_NAME,
      user_id: USER_ID,
      user_name: USER_NAME,
      text: MESSAGE_TEXT,
      message_ts: MESSAGE_TS,
      is_dm: false,
    },
    daemon_ts: DAEMON_TS,
  };
}

function noopOnMessage(): (payload: MessagePayload) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WebhookServer.start() — port binding', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('start_called_resolvesWithPortNumberGreaterThanZero', async () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());

    // Act
    const port = await server.start();

    // Assert
    expect(port).toBeTypeOf('number');
    expect(port).toBeGreaterThan(0);
  });

  it('start_called_portGetterMatchesResolvedPort', async () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());

    // Act
    const resolvedPort = await server.start();

    // Assert
    expect(server.port).toBe(resolvedPort);
  });

  it('start_notCalledYet_portGetterIsUndefined', () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());

    // Act
    const result = server.port;

    // Assert
    expect(result).toBeUndefined();
  });
});

describe('WebhookServer — GET /health', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('getHealth_runningServer_returns200', async () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/health`);

    // Assert
    expect(res.status).toBe(200);
  });

  it('getHealth_runningServer_returnsStatusOkBody', async () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();

    // Assert
    expect(body).toEqual({ status: 'ok' });
  });

  it('getHealth_runningServer_contentTypeIsApplicationJson', async () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/health`);

    // Assert
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('WebhookServer — POST /message with valid payload', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('postMessage_validPayload_returns200', async () => {
    // Arrange
    const mock_onMessage = noopOnMessage();
    server = new WebhookServer(mock_onMessage);
    const port = await server.start();
    const payload = makeValidPayload();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Assert
    expect(res.status).toBe(200);
  });

  it('postMessage_validPayload_callsOnMessageOnce', async () => {
    // Arrange
    const mock_onMessage = noopOnMessage();
    server = new WebhookServer(mock_onMessage);
    const port = await server.start();
    const payload = makeValidPayload();

    // Act
    await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Assert
    expect(mock_onMessage).toHaveBeenCalledOnce();
  });

  it('postMessage_validPayload_callsOnMessageWithParsedPayload', async () => {
    // Arrange
    const mock_onMessage = noopOnMessage();
    server = new WebhookServer(mock_onMessage);
    const port = await server.start();
    const payload = makeValidPayload();

    // Act
    await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Assert
    expect(mock_onMessage).toHaveBeenCalledWith(payload);
  });

  it('postMessage_validPayload_payloadChannelIdEqualsC1', async () => {
    // Arrange
    let receivedPayload: MessagePayload | undefined;
    const capture_onMessage = vi.fn().mockImplementation(async (p: MessagePayload) => {
      receivedPayload = p;
    });
    server = new WebhookServer(capture_onMessage);
    const port = await server.start();

    // Act
    await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });

    // Assert
    expect(receivedPayload?.message.channel_id).toBe(CHANNEL_ID);
  });

  it('postMessage_validPayload_payloadTextEqualsHello', async () => {
    // Arrange
    let receivedPayload: MessagePayload | undefined;
    const capture_onMessage = vi.fn().mockImplementation(async (p: MessagePayload) => {
      receivedPayload = p;
    });
    server = new WebhookServer(capture_onMessage);
    const port = await server.start();

    // Act
    await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });

    // Assert
    expect(receivedPayload?.message.text).toBe(MESSAGE_TEXT);
  });

  it('postMessage_validPayload_payloadIsDmIsFalse', async () => {
    // Arrange
    let receivedPayload: MessagePayload | undefined;
    const capture_onMessage = vi.fn().mockImplementation(async (p: MessagePayload) => {
      receivedPayload = p;
    });
    server = new WebhookServer(capture_onMessage);
    const port = await server.start();

    // Act
    await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });

    // Assert
    expect(receivedPayload?.message.is_dm).toBe(false);
  });
});

describe('WebhookServer — POST /message with malformed JSON', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('postMessage_malformedJson_returns500', async () => {
    // Arrange
    const mock_onMessage = noopOnMessage();
    server = new WebhookServer(mock_onMessage);
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    // Assert
    expect(res.status).toBe(500);
  });

  it('postMessage_malformedJson_onMessageNotCalled', async () => {
    // Arrange
    const mock_onMessage = noopOnMessage();
    server = new WebhookServer(mock_onMessage);
    const port = await server.start();

    // Act
    await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    // Assert
    expect(mock_onMessage).not.toHaveBeenCalled();
  });
});

describe('WebhookServer — POST /message when onMessage throws', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('postMessage_onMessageThrows_returns500', async () => {
    // Arrange
    const throwing_onMessage = vi.fn().mockRejectedValue(new Error('boom'));
    server = new WebhookServer(throwing_onMessage);
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });

    // Assert
    expect(res.status).toBe(500);
  });

  it('postMessage_onMessageThrows_bodyContainsErrorMessage', async () => {
    // Arrange
    const throwing_onMessage = vi.fn().mockRejectedValue(new Error('boom'));
    server = new WebhookServer(throwing_onMessage);
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });
    const body = await res.text();

    // Assert
    expect(body).toContain('boom');
  });
});

describe('WebhookServer — unknown route', () => {
  let server: WebhookServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('getUnknownRoute_runningServer_returns404', async () => {
    // Arrange
    server = new WebhookServer(noopOnMessage());
    const port = await server.start();

    // Act
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);

    // Assert
    expect(res.status).toBe(404);
  });
});

describe('WebhookServer.stop()', () => {
  it('stop_runningServer_serverNoLongerAcceptsConnections', async () => {
    // Arrange
    const server = new WebhookServer(noopOnMessage());
    const port = await server.start();

    // Act
    await server.stop();

    // Assert — subsequent fetch should fail (ECONNREFUSED)
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
