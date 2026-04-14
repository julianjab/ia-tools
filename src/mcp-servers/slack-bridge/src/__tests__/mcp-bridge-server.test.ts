/**
 * Sub-task #3 — McpBridgeServer (+ Sub-task #4: ensureDaemon removed)
 *
 * Tests for the NOT-YET-CREATED class: McpBridgeServer in src/mcp-server.ts
 *
 * Contract (from REQ-MCP-REFACTOR):
 *   McpBridgeServer({ web, daemonClient, logger, webhookPort? })
 *     - Constructor registers ListToolsRequestSchema and CallToolRequestSchema handlers
 *     - connect(transport) delegates to mcp.connect(transport)
 *     - server getter exposes the underlying MCP Server instance
 *     - Tool handlers: subscribe_slack, unsubscribe_slack, claim_message, reply_slack,
 *       read_thread, read_channel, list_slack_channels
 *     - oninitialized: auto-subscribes from .claude/.channels.json when daemonClient present
 *     - ensureDaemon is NOT imported or called in mcp-server.ts
 *
 * RED phase: McpBridgeServer class does NOT exist yet — import will fail.
 *
 * Testing strategy:
 *   - Tool handlers are invoked via the internal _requestHandlers map
 *     (accessed as `(server.server as any)._requestHandlers`)
 *   - WebClient and DaemonClient are replaced with vi.fn() mocks
 *   - loadConfig / saveConfig are vi.mocked
 *   - ensureDaemon import check is done by reading mcp-server.ts file content
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonClient } from '../daemon-client.js';
import type { Logger } from '../logger.js';
// RED: McpBridgeServer class does not exist yet
import { McpBridgeServer } from '../mcp-server.js';

// ─── Mock modules ────────────────────────────────────────────────────────────

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({}),
    saveConfig: vi.fn(),
  };
});

vi.mock('../ack-client.js', () => ({
  clearThinkingAck: vi.fn().mockResolvedValue(undefined),
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'C1';
const USER_ID = 'U1';
const MESSAGE_TS = '1234.5678';
const REPLY_TS = '1234.9999';
const MESSAGE_TEXT = 'hello';

// ─── Stub / Mock builders ─────────────────────────────────────────────────────

function makeWebClientMock() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: REPLY_TS }),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [{ user: USER_ID, text: MESSAGE_TEXT }] }),
      history: vi.fn().mockResolvedValue({ messages: [{ user: USER_ID, text: MESSAGE_TEXT }] }),
    },
    users: {
      conversations: vi.fn().mockResolvedValue({
        channels: [{ name: 'general', id: CHANNEL_ID }],
      }),
    },
    reactions: {
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    apiCall: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeDaemonClientMock(): DaemonClient {
  return {
    subscribe: vi.fn().mockResolvedValue(true),
    unsubscribe: vi.fn().mockResolvedValue(true),
    claim: vi.fn().mockResolvedValue({ claimed: true }),
    port: 9999,
  } as unknown as DaemonClient;
}

function makeLogger(): Logger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ─── Helper: invoke a tool handler via the internal handler map ───────────────

type HandlerMap = Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;

function getHandlers(bridge: McpBridgeServer): HandlerMap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (bridge.server as any)._requestHandlers as HandlerMap;
}

async function invokeListTools(bridge: McpBridgeServer) {
  const handlers = getHandlers(bridge);
  const handler = handlers.get('tools/list');
  if (!handler) throw new Error('tools/list handler not registered');
  return handler({ method: 'tools/list' }, {}) as Promise<{
    tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  }>;
}

async function invokeTool(
  bridge: McpBridgeServer,
  name: string,
  args: Record<string, unknown> = {},
) {
  const handlers = getHandlers(bridge);
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler not registered');
  return handler({ method: 'tools/call', params: { name, arguments: args } }, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

// ─── Tests: construction ──────────────────────────────────────────────────────

describe('McpBridgeServer — construction', () => {
  it('constructor_withWebClientAndDaemonClient_doesNotThrow', () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const mock_daemonClient = makeDaemonClientMock();
    const stub_logger = makeLogger();

    // Act / Assert
    expect(
      () =>
        new McpBridgeServer({
          web: stub_web as never,
          daemonClient: mock_daemonClient,
          logger: stub_logger,
        }),
    ).not.toThrow();
  });

  it('constructor_created_listToolsHandlerIsRegistered', () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const handlers = getHandlers(bridge);

    // Assert
    expect(handlers.has('tools/list')).toBe(true);
  });

  it('constructor_created_callToolHandlerIsRegistered', () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const handlers = getHandlers(bridge);

    // Assert
    expect(handlers.has('tools/call')).toBe(true);
  });

  it('constructor_created_serverGetterReturnsUnderlyingMcpServer', () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const server = bridge.server;

    // Assert
    expect(server).toBeDefined();
    expect(typeof server.setRequestHandler).toBe('function');
  });
});

// ─── Tests: connect ───────────────────────────────────────────────────────────

describe('McpBridgeServer.connect()', () => {
  it('connect_withTransport_delegatesToMcpConnect', async () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });
    const stub_transport = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined,
      onerror: undefined,
      onclose: undefined,
      sessionId: 'test-session',
    };
    const mock_connect = vi.spyOn(bridge.server, 'connect').mockResolvedValue(undefined);

    // Act
    await bridge.connect(stub_transport as never);

    // Assert
    expect(mock_connect).toHaveBeenCalledOnce();
    expect(mock_connect).toHaveBeenCalledWith(stub_transport);
  });
});

// ─── Tests: ListTools ─────────────────────────────────────────────────────────

describe('McpBridgeServer — ListTools returns all 7 tools', () => {
  const EXPECTED_TOOL_NAMES = [
    'subscribe_slack',
    'unsubscribe_slack',
    'claim_message',
    'reply_slack',
    'read_thread',
    'read_channel',
    'list_slack_channels',
  ];

  it('listTools_called_returnsExactly7Tools', async () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeListTools(bridge);

    // Assert
    expect(result.tools).toHaveLength(7);
  });

  it('listTools_called_allToolsHaveNameDescriptionAndInputSchema', async () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeListTools(bridge);

    // Assert
    for (const tool of result.tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
    }
  });

  it('listTools_called_toolNamesMatchExpectedSet', async () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeListTools(bridge);
    const names = result.tools.map((t) => t.name);

    // Assert
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOL_NAMES));
  });
});

// ─── Tests: subscribe_slack ───────────────────────────────────────────────────

describe('McpBridgeServer — subscribe_slack tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribeSlack_withChannelsAndDms_callsDaemonClientSubscribe', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'subscribe_slack', { channels: [CHANNEL_ID], dms: [USER_ID] });

    // Assert
    expect(mock_daemonClient.subscribe).toHaveBeenCalledOnce();
  });

  it('subscribeSlack_withChannels_subscribeReceivesFiltersWithChannels', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'subscribe_slack', { channels: [CHANNEL_ID], dms: [USER_ID] });

    // Assert
    const [filters] = (mock_daemonClient.subscribe as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { channels: string[]; users: string[]; threads: string[] },
    ];
    expect(filters.channels).toEqual([CHANNEL_ID]);
    expect(filters.users).toEqual([USER_ID]);
    expect(filters.threads).toEqual([]);
  });

  it('subscribeSlack_success_responseContainsSubscribed', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'subscribe_slack', { channels: [CHANNEL_ID] });

    // Assert
    expect(result.content[0].text).toMatch(/subscribed/i);
  });

  it('subscribeSlack_daemonClientThrows_responseHasIsError', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    (mock_daemonClient.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'subscribe_slack', { channels: [CHANNEL_ID] });

    // Assert
    expect(result.isError).toBe(true);
  });

  it('subscribeSlack_daemonClientThrows_responseTextContainsErrorMessage', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    (mock_daemonClient.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'subscribe_slack', { channels: [CHANNEL_ID] });

    // Assert
    expect(result.content[0].text).toContain('connection refused');
  });
});

// ─── Tests: unsubscribe_slack ─────────────────────────────────────────────────

describe('McpBridgeServer — unsubscribe_slack tool', () => {
  it('unsubscribeSlack_called_callsDaemonClientUnsubscribe', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'unsubscribe_slack');

    // Assert
    expect(mock_daemonClient.unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribeSlack_success_responseContainsUnsubscribed', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'unsubscribe_slack');

    // Assert
    expect(result.content[0].text).toMatch(/unsubscribed/i);
  });
});

// ─── Tests: claim_message ─────────────────────────────────────────────────────

describe('McpBridgeServer — claim_message tool', () => {
  it('claimMessage_withMessageTs_callsDaemonClientClaim', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'claim_message', { message_ts: MESSAGE_TS });

    // Assert
    expect(mock_daemonClient.claim).toHaveBeenCalledWith(MESSAGE_TS);
  });

  it('claimMessage_claimedTrue_responseContainsClaimed', async () => {
    // Arrange
    const mock_daemonClient = makeDaemonClientMock();
    (mock_daemonClient.claim as ReturnType<typeof vi.fn>).mockResolvedValue({ claimed: true });
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'claim_message', { message_ts: MESSAGE_TS });

    // Assert
    expect(result.content[0].text).toMatch(/claimed/i);
  });

  it('claimMessage_claimedFalse_responseContainsAlreadyClaimed', async () => {
    // Arrange
    const OTHER_PORT = 8888;
    const mock_daemonClient = makeDaemonClientMock();
    (mock_daemonClient.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
      claimed: false,
      claimed_by: OTHER_PORT,
    });
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'claim_message', { message_ts: MESSAGE_TS });

    // Assert
    expect(result.content[0].text).toMatch(/already claimed/i);
  });

  it('claimMessage_claimedFalse_responseContainsClaimedByPort', async () => {
    // Arrange
    const OTHER_PORT = 8888;
    const mock_daemonClient = makeDaemonClientMock();
    (mock_daemonClient.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
      claimed: false,
      claimed_by: OTHER_PORT,
    });
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'claim_message', { message_ts: MESSAGE_TS });

    // Assert
    expect(result.content[0].text).toContain(String(OTHER_PORT));
  });
});

// ─── Tests: reply_slack ───────────────────────────────────────────────────────

describe('McpBridgeServer — reply_slack tool', () => {
  it('replySlack_withChannelAndText_callsWebChatPostMessage', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'reply_slack', {
      channel_id: CHANNEL_ID,
      text: MESSAGE_TEXT,
      message_ts: MESSAGE_TS,
    });

    // Assert
    expect(stub_web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, text: MESSAGE_TEXT }),
    );
  });

  it('replySlack_success_responseContainsSentAndTs', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'reply_slack', {
      channel_id: CHANNEL_ID,
      text: MESSAGE_TEXT,
      message_ts: MESSAGE_TS,
    });

    // Assert
    expect(result.content[0].text).toMatch(/sent/i);
    expect(result.content[0].text).toContain(REPLY_TS);
  });

  it('replySlack_missingMessageTs_stillSendsMessage', async () => {
    // message_ts is optional — omitting it skips clearThinkingAck but still sends
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'reply_slack', {
      channel_id: CHANNEL_ID,
      text: MESSAGE_TEXT,
      // message_ts intentionally omitted
    });

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Sent');
  });
});

// ─── Tests: read_thread ───────────────────────────────────────────────────────

describe('McpBridgeServer — read_thread tool', () => {
  it('readThread_withChannelAndThreadTs_callsConversationsReplies', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const THREAD_TS = '1234.5678';
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'read_thread', { channel_id: CHANNEL_ID, thread_ts: THREAD_TS });

    // Assert
    expect(stub_web.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, ts: THREAD_TS, limit: 20 }),
    );
  });

  it('readThread_withMessages_responseContainsUserAndText', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'read_thread', {
      channel_id: CHANNEL_ID,
      thread_ts: MESSAGE_TS,
    });

    // Assert
    expect(result.content[0].text).toContain(`${USER_ID}: ${MESSAGE_TEXT}`);
  });
});

// ─── Tests: read_channel ──────────────────────────────────────────────────────

describe('McpBridgeServer — read_channel tool', () => {
  it('readChannel_withChannelId_callsConversationsHistory', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'read_channel', { channel_id: CHANNEL_ID });

    // Assert
    expect(stub_web.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, limit: 20 }),
    );
  });

  it('readChannel_withMessages_responseContainsUserAndText', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'read_channel', { channel_id: CHANNEL_ID });

    // Assert
    expect(result.content[0].text).toContain(`${USER_ID}: ${MESSAGE_TEXT}`);
  });
});

// ─── Tests: list_slack_channels ───────────────────────────────────────────────

describe('McpBridgeServer — list_slack_channels tool', () => {
  it('listSlackChannels_called_callsUsersConversations', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    await invokeTool(bridge, 'list_slack_channels');

    // Assert
    expect(stub_web.users.conversations).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'public_channel,private_channel', limit: 100 }),
    );
  });

  it('listSlackChannels_withChannels_responseContainsHashNameAndId', async () => {
    // Arrange
    const stub_web = makeWebClientMock();
    const bridge = new McpBridgeServer({
      web: stub_web as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act
    const result = await invokeTool(bridge, 'list_slack_channels');

    // Assert
    expect(result.content[0].text).toContain('#general (C1)');
  });
});

// ─── Tests: unknown tool ──────────────────────────────────────────────────────

describe('McpBridgeServer — unknown tool', () => {
  it('unknownTool_invoked_throwsErrorContainingToolName', async () => {
    // Arrange
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: makeLogger(),
    });

    // Act / Assert
    await expect(invokeTool(bridge, 'nonexistent_tool')).rejects.toThrow(
      'Unknown tool: nonexistent_tool',
    );
  });
});

// ─── Tests: oninitialized auto-subscribe ─────────────────────────────────────

describe('McpBridgeServer — oninitialized auto-subscribe', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('oninitialized_configWithChannels_callsDaemonClientSubscribe', async () => {
    // Arrange
    const { loadConfig } = await import('../config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      channels: [CHANNEL_ID],
      bot: { label: 'auto' },
    });
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act — trigger the oninitialized callback
    await bridge.server.oninitialized?.();

    // Assert
    expect(mock_daemonClient.subscribe).toHaveBeenCalledOnce();
  });

  it('oninitialized_configWithChannels_subscribeReceivesChannelFilters', async () => {
    // Arrange
    const { loadConfig } = await import('../config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      channels: [CHANNEL_ID],
      bot: { label: 'auto' },
    });
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    await bridge.server.oninitialized?.();

    // Assert
    const [filters] = (mock_daemonClient.subscribe as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { channels: string[]; users: string[]; threads: string[] },
    ];
    expect(filters.channels).toEqual([CHANNEL_ID]);
    expect(filters.users).toEqual([]);
    expect(filters.threads).toEqual([]);
  });

  it('oninitialized_emptyConfig_daemonClientSubscribeNotCalled', async () => {
    // Arrange
    const { loadConfig } = await import('../config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({});
    const mock_daemonClient = makeDaemonClientMock();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: mock_daemonClient,
      logger: makeLogger(),
    });

    // Act
    await bridge.server.oninitialized?.();

    // Assert
    expect(mock_daemonClient.subscribe).not.toHaveBeenCalled();
  });

  it('oninitialized_daemonClientIsNull_noSubscriptionAttempted', async () => {
    // Arrange
    const { loadConfig } = await import('../config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      channels: [CHANNEL_ID],
    });
    const stub_logger = makeLogger();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: stub_logger,
    });

    // Act / Assert — should not throw
    await expect(bridge.server.oninitialized?.()).resolves.not.toThrow();
  });

  it('oninitialized_daemonClientIsNull_warningIsLogged', async () => {
    // Arrange
    const { loadConfig } = await import('../config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      channels: [CHANNEL_ID],
    });
    const mock_logger = makeLogger();
    const bridge = new McpBridgeServer({
      web: makeWebClientMock() as never,
      daemonClient: null,
      logger: mock_logger,
    });

    // Act
    await bridge.server.oninitialized?.();

    // Assert
    expect(mock_logger.warn).toHaveBeenCalled();
  });
});

// ─── Tests: ensureDaemon removed (Sub-task #4) ────────────────────────────────

describe('McpBridgeServer — ensureDaemon removed from mcp-server.ts', () => {
  const MCP_SERVER_PATH = join(new URL(import.meta.url).pathname, '../../mcp-server.ts');

  it('mcpServerFile_inspected_doesNotImportEnsureDaemon', () => {
    // Arrange
    const source = readFileSync(MCP_SERVER_PATH, 'utf8');

    // Act / Assert
    expect(source).not.toMatch(/import.*ensureDaemon/);
  });

  it('mcpServerFile_inspected_doesNotCallEnsureDaemon', () => {
    // Arrange
    const source = readFileSync(MCP_SERVER_PATH, 'utf8');

    // Act / Assert
    expect(source).not.toMatch(/await ensureDaemon\(/);
  });

  it('mcpServerFile_inspected_doesNotImportEnsureDaemonModule', () => {
    // Arrange
    const source = readFileSync(MCP_SERVER_PATH, 'utf8');

    // Act / Assert
    expect(source).not.toMatch(/from ['"].*ensure-daemon/);
  });
});
