/**
 * Sub-task 2 — addThinkingAck
 *
 * Tests for the NOT-YET-CREATED module: src/daemon/ack.ts
 *
 * Contract (from api-contract.md):
 *   addThinkingAck(app, msg, { emoji, status }):
 *     1. Calls app.client.reactions.add({ name: emoji, channel: msg.channel_id, timestamp: msg.message_ts })
 *     2. Calls app.client.assistant.threads.setStatus({
 *          channel_id: msg.channel_id,
 *          thread_ts: msg.thread_ts ?? msg.message_ts,
 *          status: opts.status
 *        })
 *     3. Both rejections are swallowed — the function always resolves.
 *     4. Env vars SLACK_ACK_EMOJI / SLACK_ACK_STATUS are consumed at call site (passed as opts).
 *
 * RED phase: src/daemon/ack.ts does not exist — import will fail.
 */

import { describe, expect, it, vi } from 'vitest';
// RED: this module does not exist yet
import { addThinkingAck } from '../daemon/ack.js';
import type { SlackMessage } from '../shared/types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const CHANNEL_ID = 'C1';
const DM_CHANNEL_ID = 'D1';
const MESSAGE_TS = '111.222';
const THREAD_TS = '999.000';
const DEFAULT_EMOJI = 'eyes';
const DEFAULT_STATUS = 'thinking...';
const CUSTOM_EMOJI = 'hourglass_flowing_sand';
const CUSTOM_STATUS = 'working...';

// ─── Stub builders ──────────────────────────────────────────────────────────

function makeSlackMessage(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    channel_id: CHANNEL_ID,
    channel_name: 'general',
    user_id: 'U001',
    user_name: 'alice',
    text: 'hello',
    message_ts: MESSAGE_TS,
    is_dm: false,
    ...overrides,
  };
}

type AppMock = {
  client: {
    reactions: { add: ReturnType<typeof vi.fn> };
    assistant: { threads: { setStatus: ReturnType<typeof vi.fn> } };
  };
};

function makeAppMock(
  options: {
    reactionsAddResult?: Promise<unknown>;
    setStatusResult?: Promise<unknown>;
  } = {},
): AppMock {
  return {
    client: {
      reactions: {
        add: vi.fn().mockReturnValue(options.reactionsAddResult ?? Promise.resolve({ ok: true })),
      },
      assistant: {
        threads: {
          setStatus: vi
            .fn()
            .mockReturnValue(options.setStatusResult ?? Promise.resolve({ ok: true })),
        },
      },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('addThinkingAck — reactions.add call', () => {
  it('addThinkingAck_MatchingSubscriber_CallsReactionsAddWithCorrectArgs', async () => {
    // Arrange
    const stub_app = makeAppMock();
    const msg = makeSlackMessage({ channel_id: CHANNEL_ID, message_ts: MESSAGE_TS });
    const opts = { emoji: DEFAULT_EMOJI, status: DEFAULT_STATUS };

    // Act
    await addThinkingAck(stub_app as never, msg, opts);

    // Assert
    expect(stub_app.client.reactions.add).toHaveBeenCalledOnce();
    expect(stub_app.client.reactions.add).toHaveBeenCalledWith({
      name: DEFAULT_EMOJI,
      channel: CHANNEL_ID,
      timestamp: MESSAGE_TS,
    });
  });

  it('addThinkingAck_CustomEmoji_CallsReactionsAddWithCustomEmoji', async () => {
    // Arrange
    const stub_app = makeAppMock();
    const msg = makeSlackMessage();
    const opts = { emoji: CUSTOM_EMOJI, status: DEFAULT_STATUS };

    // Act
    await addThinkingAck(stub_app as never, msg, opts);

    // Assert
    expect(stub_app.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: CUSTOM_EMOJI }),
    );
  });
});

describe('addThinkingAck — assistant.threads.setStatus call', () => {
  it('addThinkingAck_DmNoThread_SetsStatusOnMessageTs', async () => {
    // Arrange
    const stub_app = makeAppMock();
    const msg = makeSlackMessage({
      channel_id: DM_CHANNEL_ID,
      is_dm: true,
      message_ts: '333.444',
      thread_ts: undefined,
    });
    const opts = { emoji: DEFAULT_EMOJI, status: DEFAULT_STATUS };

    // Act
    await addThinkingAck(stub_app as never, msg, opts);

    // Assert
    expect(stub_app.client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: DM_CHANNEL_ID,
      thread_ts: '333.444',
      status: DEFAULT_STATUS,
    });
  });

  it('addThinkingAck_ThreadedMessage_SetsStatusOnExistingThreadTs', async () => {
    // Arrange
    const stub_app = makeAppMock();
    const msg = makeSlackMessage({ thread_ts: THREAD_TS });
    const opts = { emoji: DEFAULT_EMOJI, status: DEFAULT_STATUS };

    // Act
    await addThinkingAck(stub_app as never, msg, opts);

    // Assert
    expect(stub_app.client.assistant.threads.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: THREAD_TS }),
    );
  });

  it('addThinkingAck_CustomStatus_SetsStatusWithCustomStatus', async () => {
    // Arrange
    const stub_app = makeAppMock();
    const msg = makeSlackMessage();
    const opts = { emoji: DEFAULT_EMOJI, status: CUSTOM_STATUS };

    // Act
    await addThinkingAck(stub_app as never, msg, opts);

    // Assert
    expect(stub_app.client.assistant.threads.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: CUSTOM_STATUS }),
    );
  });
});

describe('addThinkingAck — error swallowing (best-effort)', () => {
  it('addThinkingAck_ReactionsAddRejects_DoesNotThrow', async () => {
    // Arrange
    const stub_app = makeAppMock({
      reactionsAddResult: Promise.reject(new Error('already_reacted')),
    });
    const msg = makeSlackMessage();
    const opts = { emoji: DEFAULT_EMOJI, status: DEFAULT_STATUS };

    // Act / Assert — must resolve, never reject
    await expect(addThinkingAck(stub_app as never, msg, opts)).resolves.toBeUndefined();
  });

  it('addThinkingAck_SetStatusRejects_DoesNotThrow', async () => {
    // Arrange
    const stub_app = makeAppMock({
      setStatusResult: Promise.reject(new Error('not_allowed_token_type')),
    });
    const msg = makeSlackMessage();
    const opts = { emoji: DEFAULT_EMOJI, status: DEFAULT_STATUS };

    // Act / Assert
    await expect(addThinkingAck(stub_app as never, msg, opts)).resolves.toBeUndefined();
  });

  it('addThinkingAck_ReactionsAddRejects_SetStatusStillCalled', async () => {
    // Arrange
    const stub_app = makeAppMock({
      reactionsAddResult: Promise.reject(new Error('already_reacted')),
    });
    const msg = makeSlackMessage();
    const opts = { emoji: DEFAULT_EMOJI, status: DEFAULT_STATUS };

    // Act
    await addThinkingAck(stub_app as never, msg, opts);

    // Assert — setStatus must still be attempted despite reactions.add failing
    expect(stub_app.client.assistant.threads.setStatus).toHaveBeenCalledOnce();
  });
});
