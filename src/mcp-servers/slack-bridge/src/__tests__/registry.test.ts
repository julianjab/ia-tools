/**
 * Registry filter matching tests.
 *
 * Matching levels:
 *   0 — threads: independent bypass
 *   1 — channel/DM: required gate (empty = nothing allowed)
 *   2 — user: optional refinement within matched channel
 *   3 — regexp: AND filters
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

describe('Registry.match — Level 0: thread bypass', () => {
  it('threadMatch_passesRegardlessOfChannelOrUser', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'], threads: ['111.000'] });
    // channel is C2 (mismatch), but thread matches → pass
    expect(reg.match(makeMsg({ channel_id: 'C2', thread_ts: '111.000' }))).toHaveLength(1);
  });

  it('threadMatch_passesWithNoOtherFilters', () => {
    const reg = new Registry();
    reg.add(1, { threads: ['111.000'] });
    expect(reg.match(makeMsg({ thread_ts: '111.000' }))).toHaveLength(1);
  });

  it('threadMismatch_doesNotBypass', () => {
    const reg = new Registry();
    reg.add(1, { threads: ['111.000'] });
    expect(reg.match(makeMsg({ thread_ts: '999.000' }))).toHaveLength(0);
  });

  it('noThreadOnMessage_threadBypassDoesNotFire', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'], threads: ['111.000'] });
    // Has channel filter + thread filter, but message has no thread_ts
    // thread bypass doesn't fire; channel filter passes since C1 matches
    expect(reg.match(makeMsg({ channel_id: 'C1', thread_ts: null }))).toHaveLength(1);
  });
});

describe('Registry.match — Level 1: channel / DM gate', () => {
  it('noFilters_blocksAll', () => {
    const reg = new Registry();
    reg.add(1, {});
    expect(reg.match(makeMsg())).toHaveLength(0);
  });

  it('emptyChannelsAndDms_blocksAll', () => {
    const reg = new Registry();
    reg.add(1, { channels: [], dms: [] });
    expect(reg.match(makeMsg())).toHaveLength(0);
  });

  describe('channels', () => {
    it('matchingChannel_passes', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'] });
      expect(reg.match(makeMsg({ channel_id: 'C1' }))).toHaveLength(1);
    });

    it('differentChannel_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'] });
      expect(reg.match(makeMsg({ channel_id: 'C2' }))).toHaveLength(0);
    });
  });

  describe('dms', () => {
    it('dmMessage_matchingUser_passes', () => {
      const reg = new Registry();
      reg.add(1, { dms: ['U1'] });
      expect(reg.match(makeMsg({ user_id: 'U1', is_dm: true }))).toHaveLength(1);
    });

    it('channelMessage_matchingUser_blocked_dmFilterOnly', () => {
      const reg = new Registry();
      reg.add(1, { dms: ['U1'] });
      // Same user but not a DM → blocked at level 1
      expect(reg.match(makeMsg({ user_id: 'U1', is_dm: false }))).toHaveLength(0);
    });

    it('dmMessage_differentUser_blocked', () => {
      const reg = new Registry();
      reg.add(1, { dms: ['U1'] });
      expect(reg.match(makeMsg({ user_id: 'U2', is_dm: true }))).toHaveLength(0);
    });
  });

  describe('channels AND dms together', () => {
    it('channelMatch_orDmMatch_eitherPasses', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], dms: ['U1'] });

      // Channel match (non-DM in C1)
      expect(reg.match(makeMsg({ channel_id: 'C1', user_id: 'U99', is_dm: false }))).toHaveLength(1);
      // DM match (DM from U1 in some other channel)
      expect(reg.match(makeMsg({ channel_id: 'C2', user_id: 'U1', is_dm: true }))).toHaveLength(1);
    });

    it('neitherChannelNorDmMatch_blocked', () => {
      const reg = new Registry();
      reg.add(1, { channels: ['C1'], dms: ['U1'] });
      // channel C2 ≠ C1, not a DM → blocked
      expect(reg.match(makeMsg({ channel_id: 'C2', user_id: 'U2', is_dm: false }))).toHaveLength(0);
    });
  });
});

describe('Registry.match — Level 2: user refinement', () => {
  it('channelMatch_noUserFilter_anyUserPasses', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'] });
    expect(reg.match(makeMsg({ channel_id: 'C1', user_id: 'U99' }))).toHaveLength(1);
  });

  it('channelMatch_userFilter_matchingUser_passes', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'], users: ['U1'] });
    expect(reg.match(makeMsg({ channel_id: 'C1', user_id: 'U1' }))).toHaveLength(1);
  });

  it('channelMatch_userFilter_differentUser_blocked', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'], users: ['U1'] });
    expect(reg.match(makeMsg({ channel_id: 'C1', user_id: 'U2' }))).toHaveLength(0);
  });

  it('dmMatch_userFilter_matchingUser_passes', () => {
    const reg = new Registry();
    reg.add(1, { dms: ['U1'], users: ['U1'] });
    expect(reg.match(makeMsg({ user_id: 'U1', is_dm: true }))).toHaveLength(1);
  });

  it('dmMatch_userFilter_differentUser_blocked', () => {
    const reg = new Registry();
    // dms: ['U1'] passes level 1 for DMs from U1, but users: ['U2'] blocks at level 2
    reg.add(1, { dms: ['U1'], users: ['U2'] });
    expect(reg.match(makeMsg({ user_id: 'U1', is_dm: true }))).toHaveLength(0);
  });
});

describe('Registry.match — Level 3: regexp filters', () => {
  it('regexpChannelMatch_passes', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'] }, { channel: 'general' });
    expect(reg.match(makeMsg({ channel_id: 'C1', channel_name: 'general' }))).toHaveLength(1);
  });

  it('regexpChannelMismatch_blocked', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'] }, { channel: 'general' });
    expect(reg.match(makeMsg({ channel_id: 'C1', channel_name: 'random' }))).toHaveLength(0);
  });

  it('invalidRegexp_treatedAsAlwaysMatch', () => {
    const reg = new Registry();
    reg.add(1, { channels: ['C1'] }, { message: '[invalid' });
    expect(reg.match(makeMsg({ channel_id: 'C1' }))).toHaveLength(1);
  });
});
