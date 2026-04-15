/**
 * Shared helper for building a SlackMessage from raw event fields.
 *
 * Centralises the is_dm detection logic so both the daemon and tests
 * derive the flag from a single source of truth.
 */

import type { SlackMessage } from './types.js';

export interface SlackMessageFields {
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  text: string;
  message_ts: string;
  thread_ts?: string;
}

/**
 * Build a SlackMessage, deriving is_dm from the channel_id prefix.
 * Only channel IDs starting with 'D' (1-to-1 DMs) are flagged as DMs.
 * Group DMs ('G' prefix) and public/private channels ('C' prefix) are not.
 */
export function buildSlackMessage(fields: SlackMessageFields): SlackMessage {
  return {
    channel_id: fields.channel_id,
    channel_name: fields.channel_name,
    user_id: fields.user_id,
    user_name: fields.user_name,
    text: fields.text,
    message_ts: fields.message_ts,
    thread_ts: fields.thread_ts,
    is_dm: fields.channel_id.startsWith('D'),
  };
}
