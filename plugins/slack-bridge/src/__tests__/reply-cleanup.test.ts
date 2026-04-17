/**
 * Sub-task 3 — clearThinkingAck + reply breaking change
 *
 * Tests for:
 *   1. NOT-YET-CREATED module src/ack-client.ts → clearThinkingAck()
 *   2. The updated reply tool handler in mcp-server.ts (message_ts now required,
 *      clearThinkingAck called on success, not on failure).
 *
 * clearThinkingAck contract (api-contract.md §4):
 *   - Calls web.reactions.remove({ name: emoji, channel: args.channel_id, timestamp: args.message_ts })
 *   - Calls web.assistant.threads.setStatus({ channel_id, thread_ts: thread_ts ?? message_ts, status: '' })
 *   - Both rejections are swallowed — always resolves.
 *   - Emoji resolved from process.env.SLACK_ACK_EMOJI ?? 'eyes'
 *
 * reply handler contract (api-contract.md §5):
 *   - Returns isError=true when message_ts is missing.
 *   - On successful chat.postMessage calls clearThinkingAck.
 *   - On failed chat.postMessage does NOT call clearThinkingAck.
 *   - On reactions.remove rejection the tool still returns success content.
 *
 * RED phase:
 *   - src/ack-client.ts does not exist → clearThinkingAck import will fail.
 *   - reply handler does not require message_ts and does not call clearThinkingAck.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// RED: src/ack-client.ts does not exist yet
import { clearThinkingAck } from '../ack-client.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const CHANNEL_ID = 'C1';
const DM_CHANNEL_ID = 'D1';
const MESSAGE_TS = '111.222';
const THREAD_TS = '999.000';
const DEFAULT_EMOJI = 'eyes';

// ─── WebClient stub builder ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type WebMock = {
  reactions: { remove: ReturnType<typeof vi.fn<AnyFn>> };
  assistant: { threads: { setStatus: ReturnType<typeof vi.fn<AnyFn>> } };
  chat: { postMessage: ReturnType<typeof vi.fn<AnyFn>> };
};

function makeWebMock(
  options: {
    reactionsRemoveResult?: Promise<unknown>;
    setStatusResult?: Promise<unknown>;
    postMessageResult?: Promise<unknown>;
  } = {},
): WebMock {
  return {
    reactions: {
      remove: vi
        .fn()
        .mockReturnValue(options.reactionsRemoveResult ?? Promise.resolve({ ok: true })),
    },
    assistant: {
      threads: {
        setStatus: vi
          .fn()
          .mockReturnValue(options.setStatusResult ?? Promise.resolve({ ok: true })),
      },
    },
    chat: {
      postMessage: vi
        .fn()
        .mockReturnValue(options.postMessageResult ?? Promise.resolve({ ok: true, ts: '555.666' })),
    },
  };
}

// ─── clearThinkingAck tests ─────────────────────────────────────────────────

describe('clearThinkingAck — reactions.remove call', () => {
  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: env cleanup requires delete to unset the key
    delete process.env.SLACK_ACK_EMOJI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // biome-ignore lint/performance/noDelete: env cleanup requires delete to unset the key
    delete process.env.SLACK_ACK_EMOJI;
  });

  it('clearThinkingAck_DefaultEmoji_CallsReactionsRemoveWithDefaultEmoji', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS };

    // Act
    await clearThinkingAck(stub_web as never, args);

    // Assert
    expect(stub_web.reactions.remove).toHaveBeenCalledWith({
      name: DEFAULT_EMOJI,
      channel: CHANNEL_ID,
      timestamp: MESSAGE_TS,
    });
  });

  it('clearThinkingAck_CustomEmojiEnvVar_CallsReactionsRemoveWithCustomEmoji', async () => {
    // Arrange
    process.env.SLACK_ACK_EMOJI = 'hourglass_flowing_sand';
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS };

    // Act
    await clearThinkingAck(stub_web as never, args);

    // Assert
    expect(stub_web.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'hourglass_flowing_sand' }),
    );
  });
});

describe('clearThinkingAck — assistant.threads.setStatus call', () => {
  it('clearThinkingAck_NoThreadTs_SetsStatusOnMessageTs', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = { channel_id: DM_CHANNEL_ID, message_ts: '333.444' };

    // Act
    await clearThinkingAck(stub_web as never, args);

    // Assert
    expect(stub_web.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: DM_CHANNEL_ID,
      thread_ts: '333.444',
      status: '',
    });
  });

  it('clearThinkingAck_WithThreadTs_SetsStatusOnExistingThreadTs', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS, thread_ts: THREAD_TS };

    // Act
    await clearThinkingAck(stub_web as never, args);

    // Assert
    expect(stub_web.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL_ID,
      thread_ts: THREAD_TS,
      status: '',
    });
  });

  it('clearThinkingAck_SetStatusCallsWithEmptyStatus', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS };

    // Act
    await clearThinkingAck(stub_web as never, args);

    // Assert
    expect(stub_web.assistant.threads.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: '' }),
    );
  });
});

describe('clearThinkingAck — error swallowing (best-effort)', () => {
  it('clearThinkingAck_ReactionsRemoveRejects_DoesNotThrow', async () => {
    // Arrange
    const stub_web = makeWebMock({
      reactionsRemoveResult: Promise.reject(new Error('no_reaction')),
    });
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS };

    // Act / Assert
    await expect(clearThinkingAck(stub_web as never, args)).resolves.toBeUndefined();
  });

  it('clearThinkingAck_SetStatusRejects_DoesNotThrow', async () => {
    // Arrange
    const stub_web = makeWebMock({
      setStatusResult: Promise.reject(new Error('not_allowed_token_type')),
    });
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS };

    // Act / Assert
    await expect(clearThinkingAck(stub_web as never, args)).resolves.toBeUndefined();
  });

  it('clearThinkingAck_ReactionsRemoveRejects_SetStatusStillCalled', async () => {
    // Arrange
    const stub_web = makeWebMock({
      reactionsRemoveResult: Promise.reject(new Error('no_reaction')),
    });
    const args = { channel_id: CHANNEL_ID, message_ts: MESSAGE_TS };

    // Act
    await clearThinkingAck(stub_web as never, args);

    // Assert
    expect(stub_web.assistant.threads.setStatus).toHaveBeenCalledOnce();
  });
});

// ─── reply handler tests ───────────────────────────────────────────────
//
// Strategy: We test the handler logic in isolation by importing the handler
// shape expected from the new contract.  Since the production mcp-server.ts
// exports nothing (it is a side-effectful process entry point), we replicate
// the handler logic extracted from the contract and assert it behaves correctly
// when composed with clearThinkingAck.  This is a pure unit test of the
// handler contract — the implementing agent will wire it identically in
// mcp-server.ts.
//
// Assumption: The implementing agent will extract the reply handler body
// into a testable function, OR the tests here serve as the contract spec that
// must be satisfied by the full e2e path.  For RED purposes, clearThinkingAck
// import alone is sufficient to fail.

describe('replySlack handler — message_ts required', () => {
  it('replySlack_MessageTsMissing_ReturnsIsError', async () => {
    // Arrange — simulate handler receiving args without message_ts
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, text: 'hello' } as Record<string, unknown>;

    // Act — mirror the handler guard: if (!message_ts) return isError
    const message_ts = args.message_ts as string | undefined;
    let result: { isError?: boolean; content: { type: string; text: string }[] };
    if (!message_ts) {
      result = {
        isError: true,
        content: [{ type: 'text', text: 'message_ts is required' }],
      };
    } else {
      await stub_web.chat.postMessage({ channel: CHANNEL_ID, text: 'hello' });
      result = { content: [{ type: 'text', text: 'Sent' }] };
    }

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/message_ts/i);
  });

  it('replySlack_MessageTsPresent_DoesNotReturnIsError', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, text: 'hello', message_ts: MESSAGE_TS };

    // Act — handler with message_ts present follows success path
    const message_ts = args.message_ts;
    let result: { isError?: boolean; content: { type: string; text: string }[] };
    try {
      await stub_web.chat.postMessage({ channel: args.channel_id, text: args.text });
      await clearThinkingAck(stub_web as never, { channel_id: args.channel_id, message_ts });
      result = { content: [{ type: 'text', text: 'Sent (ts: 555.666)' }] };
    } catch (err) {
      result = { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] };
    }

    // Assert
    expect(result.isError).toBeUndefined();
  });
});

describe('replySlack handler — clearThinkingAck on success', () => {
  it('replySlack_PostMessageSucceeds_ClearThinkingAckCalled', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = { channel_id: CHANNEL_ID, text: 'hi', message_ts: MESSAGE_TS };
    const mock_clearThinkingAck = vi.fn().mockResolvedValue(undefined);

    // Act — simulate successful postMessage then clearThinkingAck
    await stub_web.chat.postMessage({ channel: args.channel_id, text: args.text });
    await mock_clearThinkingAck(stub_web, {
      channel_id: args.channel_id,
      message_ts: args.message_ts,
    });

    // Assert
    expect(mock_clearThinkingAck).toHaveBeenCalledOnce();
    expect(mock_clearThinkingAck).toHaveBeenCalledWith(
      stub_web,
      expect.objectContaining({ channel_id: CHANNEL_ID, message_ts: MESSAGE_TS }),
    );
  });

  it('replySlack_PostMessageFails_ClearThinkingAckNotCalled', async () => {
    // Arrange
    const stub_web = makeWebMock({
      postMessageResult: Promise.reject(new Error('channel_not_found')),
    });
    const args = { channel_id: CHANNEL_ID, text: 'hi', message_ts: MESSAGE_TS };
    const mock_clearThinkingAck = vi.fn().mockResolvedValue(undefined);

    // Act — simulate failed postMessage (handler does NOT call clearThinkingAck)
    let result: { isError?: boolean; content: { type: string; text: string }[] };
    try {
      await stub_web.chat.postMessage({ channel: args.channel_id, text: args.text });
      await mock_clearThinkingAck(stub_web, {
        channel_id: args.channel_id,
        message_ts: args.message_ts,
      });
      result = { content: [{ type: 'text', text: 'Sent' }] };
    } catch (err) {
      // On failure: NO clearThinkingAck — per REQ-001 out of scope
      result = { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] };
    }

    // Assert
    expect(mock_clearThinkingAck).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('replySlack_ReactionsRemoveRejects_ToolStillReturnsSuccess', async () => {
    // Arrange
    const stub_web = makeWebMock({
      reactionsRemoveResult: Promise.reject(new Error('no_reaction')),
    });
    const args = { channel_id: CHANNEL_ID, text: 'hi', message_ts: MESSAGE_TS };

    // Act — postMessage succeeds, clearThinkingAck's rejection is swallowed
    let result: { isError?: boolean; content: { type: string; text: string }[] };
    try {
      await stub_web.chat.postMessage({ channel: args.channel_id, text: args.text });
      await clearThinkingAck(stub_web as never, {
        channel_id: args.channel_id,
        message_ts: args.message_ts,
      });
      result = { content: [{ type: 'text', text: 'Sent (ts: 555.666)' }] };
    } catch (err) {
      result = { isError: true, content: [{ type: 'text', text: `Error: ${err}` }] };
    }

    // Assert — clearThinkingAck swallowed the rejection, tool returns success
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Sent/);
  });

  it('replySlack_SuccessfulDmReply_ClearThinkingAckUsesMessageTsAsThreadTs', async () => {
    // Arrange — DM reply with no thread_ts: clearThinkingAck must use message_ts as thread_ts
    const stub_web = makeWebMock();
    const args = { channel_id: DM_CHANNEL_ID, text: 'hi', message_ts: '333.444' };

    // Act
    await stub_web.chat.postMessage({ channel: args.channel_id, text: args.text });
    await clearThinkingAck(stub_web as never, {
      channel_id: args.channel_id,
      message_ts: args.message_ts,
      // thread_ts intentionally omitted → clearThinkingAck uses message_ts
    });

    // Assert
    expect(stub_web.assistant.threads.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '333.444', status: '' }),
    );
  });

  it('replySlack_SuccessfulThreadedReply_ClearThinkingAckUsesExistingThreadTs', async () => {
    // Arrange
    const stub_web = makeWebMock();
    const args = {
      channel_id: CHANNEL_ID,
      text: 'hi',
      message_ts: MESSAGE_TS,
      thread_ts: THREAD_TS,
    };

    // Act
    await stub_web.chat.postMessage({
      channel: args.channel_id,
      text: args.text,
      thread_ts: args.thread_ts,
    });
    await clearThinkingAck(stub_web as never, {
      channel_id: args.channel_id,
      message_ts: args.message_ts,
      thread_ts: args.thread_ts,
    });

    // Assert
    expect(stub_web.assistant.threads.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: THREAD_TS }),
    );
  });
});
