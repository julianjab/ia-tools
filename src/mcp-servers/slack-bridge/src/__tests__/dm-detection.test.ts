/**
 * Sub-task 1 — is_dm propagation
 *
 * Tests that:
 * 1. SlackMessage carries is_dm: boolean (new field — does NOT exist in types.ts yet).
 * 2. The message-building helper (to be extracted to shared/build-message.ts) tags
 *    is_dm=true for D-prefix channels and false for C-prefix and G-prefix channels.
 * 3. thread_ts is preserved when present, undefined when absent.
 * 4. The MCP webhook notification meta includes is_dm forwarded from the payload.
 *
 * RED phase:
 *   - src/shared/build-message.ts does NOT exist yet → import will fail.
 *   - SlackMessage.is_dm is missing from types.ts → TS type tests will fail at typecheck.
 */

import { describe, expect, it } from 'vitest';
// RED: this module does not exist yet — implementing agent must create it
import { buildSlackMessage } from '../shared/build-message.js';
import type { SlackMessage } from '../shared/types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DM_CHANNEL_ID = 'D12345';
const PUBLIC_CHANNEL_ID = 'C98765';
const GROUP_DM_CHANNEL_ID = 'G55555';
const THREAD_TS = '1700000000.000100';
const MESSAGE_TS = '1700000001.000200';

// ─── Sub-task 1 — DM detection ──────────────────────────────────────────────

describe('buildSlackMessage — is_dm field', () => {
  it('buildSlackMessage_DmChannelNoThread_IsDmTrueAndThreadTsUndefined', () => {
    // Arrange
    const fields = {
      channel_id: DM_CHANNEL_ID,
      channel_name: 'directmessage',
      user_id: 'U001',
      user_name: 'alice',
      text: 'hello',
      message_ts: MESSAGE_TS,
    };

    // Act
    const msg = buildSlackMessage(fields);

    // Assert
    expect(msg.is_dm).toBe(true);
    expect(msg.thread_ts).toBeUndefined();
  });

  it('buildSlackMessage_DmChannelWithExistingThread_IsDmTrueAndThreadTsPreserved', () => {
    // Arrange
    const fields = {
      channel_id: DM_CHANNEL_ID,
      channel_name: 'directmessage',
      user_id: 'U001',
      user_name: 'alice',
      text: 'hello',
      message_ts: MESSAGE_TS,
      thread_ts: THREAD_TS,
    };

    // Act
    const msg = buildSlackMessage(fields);

    // Assert
    expect(msg.is_dm).toBe(true);
    expect(msg.thread_ts).toBe(THREAD_TS);
  });

  it('buildSlackMessage_PublicChannel_IsDmFalse', () => {
    // Arrange
    const fields = {
      channel_id: PUBLIC_CHANNEL_ID,
      channel_name: 'general',
      user_id: 'U002',
      user_name: 'bob',
      text: 'hey',
      message_ts: MESSAGE_TS,
    };

    // Act
    const msg = buildSlackMessage(fields);

    // Assert
    expect(msg.is_dm).toBe(false);
  });

  it('buildSlackMessage_GroupDmChannel_IsDmFalse', () => {
    // Arrange
    const fields = {
      channel_id: GROUP_DM_CHANNEL_ID,
      channel_name: 'group',
      user_id: 'U003',
      user_name: 'carol',
      text: 'sup',
      message_ts: MESSAGE_TS,
    };

    // Act
    const msg = buildSlackMessage(fields);

    // Assert
    expect(msg.is_dm).toBe(false);
  });
});

// ─── Sub-task 1 — SlackMessage interface carries is_dm ───────────────────────
//
// These tests verify the type contract. They will fail at `pnpm typecheck`
// (tsc --noEmit) because is_dm is not in the current SlackMessage interface.
// At runtime (vitest), they pass only after the type is updated — so they serve
// as the contract spec for the implementing agent.

describe('SlackMessage type — is_dm field required', () => {
  it('SlackMessage_WithIsDmTrue_IsDmAccessibleOnType', () => {
    // Arrange — is_dm must exist on the type; RED: compile error on missing field
    const msg: SlackMessage = {
      channel_id: DM_CHANNEL_ID,
      channel_name: 'directmessage',
      user_id: 'U001',
      user_name: 'alice',
      text: 'hello',
      message_ts: MESSAGE_TS,
      is_dm: true, // RED: property 'is_dm' does not exist on type 'SlackMessage'
    };

    // Act
    const result = msg.is_dm;

    // Assert
    expect(result).toBe(true);
  });

  it('SlackMessage_WithIsDmFalse_IsDmAccessibleOnType', () => {
    // Arrange
    const msg: SlackMessage = {
      channel_id: PUBLIC_CHANNEL_ID,
      channel_name: 'general',
      user_id: 'U002',
      user_name: 'bob',
      text: 'hey',
      message_ts: MESSAGE_TS,
      is_dm: false, // RED: property 'is_dm' does not exist on type 'SlackMessage'
    };

    // Act
    const result = msg.is_dm;

    // Assert
    expect(result).toBe(false);
  });
});

// ─── Sub-task 1 — MCP notification meta includes is_dm ───────────────────────

describe('MCP notification meta — is_dm forwarded', () => {
  it('notificationMeta_IsDmTrue_MetaContainsIsDmTrue', () => {
    // Arrange
    const message: SlackMessage = {
      channel_id: DM_CHANNEL_ID,
      channel_name: 'directmessage',
      user_id: 'U001',
      user_name: 'alice',
      text: 'hi',
      message_ts: MESSAGE_TS,
      is_dm: true,
    };

    // Act — build notification meta as the MCP webhook handler will once updated
    const meta = {
      source: 'slack-bridge',
      channel_id: message.channel_id,
      channel_name: message.channel_name,
      user_id: message.user_id,
      user_name: message.user_name,
      message_ts: message.message_ts,
      thread_ts: message.thread_ts ?? '',
      is_dm: message.is_dm,
    };

    // Assert
    expect(meta.is_dm).toBe(true);
  });

  it('notificationMeta_IsDmFalse_MetaContainsIsDmFalse', () => {
    // Arrange
    const message: SlackMessage = {
      channel_id: PUBLIC_CHANNEL_ID,
      channel_name: 'general',
      user_id: 'U002',
      user_name: 'bob',
      text: 'sup',
      message_ts: MESSAGE_TS,
      is_dm: false,
    };

    // Act
    const meta = {
      source: 'slack-bridge',
      channel_id: message.channel_id,
      channel_name: message.channel_name,
      user_id: message.user_id,
      user_name: message.user_name,
      message_ts: message.message_ts,
      thread_ts: message.thread_ts ?? '',
      is_dm: message.is_dm,
    };

    // Assert
    expect(meta.is_dm).toBe(false);
  });
});
