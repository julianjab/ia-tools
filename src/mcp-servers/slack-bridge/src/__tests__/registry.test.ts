/**
 * Registry filter matching tests.
 *
 * Covers the two-layer matching logic:
 *   Layer 1a: threads are INDEPENDENT — a thread match bypasses channels/users
 *   Layer 1b: channels AND users use AND logic (both must match if both specified)
 *   Layer 2:  regexp filters (AND)
 */

import { describe, expect, it } from 'vitest';
import { Registry } from '../daemon/registry.js';
import type { SlackMessage } from '../shared/types.js';

function makeMsg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    channel_id: 'C1',
    channel_name: 'general',
    user_id: 'U1',
    user_name: 'alice',
    text: 'hello',
    message_ts: '111.000',
    thread_ts: null,
    is_dm: false,
    ...overrides,
  };
}

describe('Registry.match — ID layer', () => {
  it('noFilters_allMessagesPass', () => {
    const reg = new Registry();
    reg.add(1, { channels: [], users: [], threads: [] });
    expect(reg.match(makeMsg())).toHaveLength(1);
  });

  describe('channel-only filter', () => {
    it('matchingChannel_passes', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: [], threads: [] });
      expect(reg.match(makeMsg({ channel_id: 'C1' }))).toHaveLength(1);
    });

    it('differentChannel_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: [], threads: [] });
      expect(reg.match(makeMsg({ channel_id: 'C2' }))).toHaveLength(0);
    });
  });

  describe('user-only filter', () => {
    it('matchingUser_passes', () => {
      const reg = new Registry();
      reg.add(1, { channels: [], users: ['U1'], threads: [] });
      expect(reg.match(makeMsg({ user_id: 'U1' }))).toHaveLength(1);
    });

    it('differentUser_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: [], users: ['U1'], threads: [] });
      expect(reg.match(makeMsg({ user_id: 'U2' }))).toHaveLength(0);
    });
  });

  describe('channel AND user filter (AND logic)', () => {
    it('matchingBoth_passes', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: ['U1'], threads: [] });
      expect(reg.match(makeMsg({ channel_id: 'C1', user_id: 'U1' }))).toHaveLength(1);
    });

    it('matchingChannelOnly_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: ['U1'], threads: [] });
      expect(reg.match(makeMsg({ channel_id: 'C1', user_id: 'U2' }))).toHaveLength(0);
    });

    it('matchingUserOnly_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: ['U1'], threads: [] });
      expect(reg.match(makeMsg({ channel_id: 'C2', user_id: 'U1' }))).toHaveLength(0);
    });

    it('matchingNeither_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: ['U1'], threads: [] });
      expect(reg.match(makeMsg({ channel_id: 'C2', user_id: 'U2' }))).toHaveLength(0);
    });
  });

  describe('thread filter — independent of channels/users', () => {
    it('threadMatch_passesEvenWhenChannelMismatch', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: [], threads: ['111.000'] });
      // channel doesn't match C1, but thread matches — should pass
      expect(
        reg.match(makeMsg({ channel_id: 'C2', thread_ts: '111.000' })),
      ).toHaveLength(1);
    });

    it('threadMatch_passesEvenWhenUserMismatch', () => {
      const reg = new Registry();
      reg.add(1, { channels: [], users: ['U1'], threads: ['111.000'] });
      expect(
        reg.match(makeMsg({ user_id: 'U2', thread_ts: '111.000' })),
      ).toHaveLength(1);
    });

    it('threadMatch_passesEvenWhenBothMismatch', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: ['U1'], threads: ['111.000'] });
      expect(
        reg.match(makeMsg({ channel_id: 'C2', user_id: 'U2', thread_ts: '111.000' })),
      ).toHaveLength(1);
    });

    it('noThreadOnMessage_doesNotBypass', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], users: ['U1'], threads: ['111.000'] });
      // message has no thread_ts — thread filter can't trigger, channels AND users must both match
      expect(
        reg.match(makeMsg({ channel_id: 'C2', user_id: 'U2', thread_ts: null })),
      ).toHaveLength(0);
    });
  });
});

describe('Registry.match — regexp layer', () => {
  it('regexpChannelMatch_passes', () => {
    const reg = new Registry();
    reg.add(1, { channels: [], users: [], threads: [] }, { channel: 'general' });
    expect(reg.match(makeMsg({ channel_name: 'general' }))).toHaveLength(1);
  });

  it('regexpChannelMismatch_blocked', () => {
    const reg = new Registry();
    reg.add(1, { channels: [], users: [], threads: [] }, { channel: 'general' });
    expect(reg.match(makeMsg({ channel_name: 'random' }))).toHaveLength(0);
  });

  it('invalidRegexp_treatedAsAlwaysMatch', () => {
    const reg = new Registry();
    reg.add(1, { channels: [], users: [], threads: [] }, { message: '[invalid' });
    expect(reg.match(makeMsg())).toHaveLength(1);
  });
});
