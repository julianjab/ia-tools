/**
 * Sub-task #2 — DaemonClient
 *
 * Tests for the NOT-YET-CREATED module: src/daemon-client.ts
 *
 * Contract (from REQ-MCP-REFACTOR):
 *   DaemonClient(daemonUrl: string, webhookPort: number)
 *     - subscribe(filters, regexp?, label?)
 *         POSTs to ${daemonUrl}/subscribe with { port, filters, regexp?, label? }
 *         Returns true on 200, throws "subscribe failed … <status>" on non-2xx
 *         Throws "DAEMON_URL is not set" when constructed with falsy URL
 *     - unsubscribe()
 *         DELETEs to ${daemonUrl}/subscribe/${webhookPort}
 *         Returns true on 200, false on non-2xx (tolerant)
 *     - claim(messageTs)
 *         POSTs to ${daemonUrl}/claim/${messageTs} with { subscriber_port: webhookPort }
 *         Returns ClaimResponse JSON
 *     - port getter returns the webhookPort
 *
 * RED phase: src/daemon-client.ts does NOT exist yet — import will fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackFilters } from '../config.js';
// RED: this module does not exist yet
import { DaemonClient } from '../daemon-client.js';
import type { ClaimResponse, SubscriptionFilters } from '../shared/types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DAEMON_URL = 'http://localhost:3800';
const WEBHOOK_PORT = 9999;
const MESSAGE_TS = '1234.5678';

const STUB_FILTERS: SubscriptionFilters = {
  channels: ['C1'],
  users: [],
  threads: [],
};

// ─── fetch mock helpers ──────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn>;

function makeFetchOk(body: unknown = {}): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function makeFetchError(status: number, text = 'Internal Server Error'): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: text }),
    text: async () => text,
  });
}

function makeFetchNetworkFailure(): FetchMock {
  return vi.fn().mockRejectedValue(new Error('fetch failed'));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DaemonClient constructor', () => {
  it('constructor_daemonUrlAndWebhookPort_portGetterReturnsWebhookPort', () => {
    // Arrange / Act
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Assert
    expect(client.port).toBe(WEBHOOK_PORT);
  });
});

describe('DaemonClient.subscribe() — happy path', () => {
  let stub_fetch: FetchMock;

  beforeEach(() => {
    stub_fetch = makeFetchOk();
    vi.stubGlobal('fetch', stub_fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribe_withFilters_postsToSubscribeEndpoint', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.subscribe(STUB_FILTERS);

    // Assert
    expect(stub_fetch).toHaveBeenCalledOnce();
    const [url] = stub_fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_URL}/subscribe`);
  });

  it('subscribe_withFilters_usesPostMethod', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.subscribe(STUB_FILTERS);

    // Assert
    const [, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    expect((init.method as string).toUpperCase()).toBe('POST');
  });

  it('subscribe_withFilters_requestBodyContainsPortAndFilters', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.subscribe(STUB_FILTERS);

    // Assert
    const [, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.port).toBe(WEBHOOK_PORT);
    expect(body.filters).toEqual(STUB_FILTERS);
  });

  it('subscribe_withRegexpAndLabel_requestBodyContainsRegexpAndLabel', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);
    const stub_regexp: SlackFilters = { channel: '^dev-' };
    const stub_label = 'my-label';

    // Act
    await client.subscribe(STUB_FILTERS, stub_regexp, stub_label);

    // Assert
    const [, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.regexp).toEqual(stub_regexp);
    expect(body.label).toBe(stub_label);
  });

  it('subscribe_withoutRegexpOrLabel_requestBodyDoesNotContainRegexpOrLabelKeys', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.subscribe(STUB_FILTERS);

    // Assert
    const [, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('regexp');
    expect(body).not.toHaveProperty('label');
  });

  it('subscribe_daemonReturns200_resolvesToTrue', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    const result = await client.subscribe(STUB_FILTERS);

    // Assert
    expect(result).toBe(true);
  });
});

describe('DaemonClient.subscribe() — error cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribe_daemonReturns500_throwsErrorContainingSubscribeFailed', async () => {
    // Arrange
    vi.stubGlobal('fetch', makeFetchError(500));
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act / Assert
    await expect(client.subscribe(STUB_FILTERS)).rejects.toThrow(/subscribe failed/i);
  });

  it('subscribe_daemonReturns500_errorMessageContainsStatusCode', async () => {
    // Arrange
    vi.stubGlobal('fetch', makeFetchError(500));
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act / Assert
    await expect(client.subscribe(STUB_FILTERS)).rejects.toThrow('500');
  });

  it('subscribe_daemonUrlNotSet_throwsErrorContainingDaemonUrlIsNotSet', async () => {
    // Arrange — DaemonClient constructed with an empty/falsy-equivalent URL should throw
    // The spec says: when DAEMON_URL is undefined/null, subscribe() throws
    // We test this by constructing with an empty string (no DAEMON_URL scenario)
    vi.stubGlobal('fetch', makeFetchOk());
    const client = new DaemonClient('', WEBHOOK_PORT);

    // Act / Assert
    await expect(client.subscribe(STUB_FILTERS)).rejects.toThrow(/DAEMON_URL is not set/);
  });
});

describe('DaemonClient.unsubscribe() — happy path', () => {
  let stub_fetch: FetchMock;

  beforeEach(() => {
    stub_fetch = makeFetchOk();
    vi.stubGlobal('fetch', stub_fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unsubscribe_called_sendsDeleteToSubscribeWithPort', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.unsubscribe();

    // Assert
    expect(stub_fetch).toHaveBeenCalledOnce();
    const [url, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_URL}/subscribe/${WEBHOOK_PORT}`);
    expect((init.method as string).toUpperCase()).toBe('DELETE');
  });

  it('unsubscribe_daemonReturns200_resolvesToTrue', async () => {
    // Arrange
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    const result = await client.unsubscribe();

    // Assert
    expect(result).toBe(true);
  });
});

describe('DaemonClient.unsubscribe() — error cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unsubscribe_daemonReturns404_resolvesToFalse', async () => {
    // Arrange
    vi.stubGlobal('fetch', makeFetchError(404));
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    const result = await client.unsubscribe();

    // Assert
    expect(result).toBe(false);
  });
});

describe('DaemonClient.claim() — happy path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('claim_messageTs_postsToClaimEndpointWithTs', async () => {
    // Arrange
    const stub_fetch = makeFetchOk({ claimed: true });
    vi.stubGlobal('fetch', stub_fetch);
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.claim(MESSAGE_TS);

    // Assert
    const [url] = stub_fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAEMON_URL}/claim/${MESSAGE_TS}`);
  });

  it('claim_messageTs_requestBodyContainsSubscriberPort', async () => {
    // Arrange
    const stub_fetch = makeFetchOk({ claimed: true });
    vi.stubGlobal('fetch', stub_fetch);
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.claim(MESSAGE_TS);

    // Assert
    const [, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.subscriber_port).toBe(WEBHOOK_PORT);
  });

  it('claim_messageTs_usesPostMethod', async () => {
    // Arrange
    const stub_fetch = makeFetchOk({ claimed: true });
    vi.stubGlobal('fetch', stub_fetch);
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    await client.claim(MESSAGE_TS);

    // Assert
    const [, init] = stub_fetch.mock.calls[0] as [string, RequestInit];
    expect((init.method as string).toUpperCase()).toBe('POST');
  });

  it('claim_daemonReturnsClaimed_resolvesToClaimedTrue', async () => {
    // Arrange
    const stub_claimResponse: ClaimResponse = { claimed: true };
    vi.stubGlobal('fetch', makeFetchOk(stub_claimResponse));
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    const result = await client.claim(MESSAGE_TS);

    // Assert
    expect(result).toEqual({ claimed: true });
  });

  it('claim_daemonReturnsAlreadyClaimed_resolvesToClaimedFalseWithClaimedBy', async () => {
    // Arrange
    const OTHER_PORT = 8888;
    const stub_claimResponse: ClaimResponse = { claimed: false, claimed_by: OTHER_PORT };
    vi.stubGlobal('fetch', makeFetchOk(stub_claimResponse));
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act
    const result = await client.claim(MESSAGE_TS);

    // Assert
    expect(result.claimed).toBe(false);
    expect(result.claimed_by).toBe(OTHER_PORT);
  });
});

describe('DaemonClient.claim() — network error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('claim_networkError_throwsError', async () => {
    // Arrange
    vi.stubGlobal('fetch', makeFetchNetworkFailure());
    const client = new DaemonClient(DAEMON_URL, WEBHOOK_PORT);

    // Act / Assert
    await expect(client.claim(MESSAGE_TS)).rejects.toThrow();
  });
});
