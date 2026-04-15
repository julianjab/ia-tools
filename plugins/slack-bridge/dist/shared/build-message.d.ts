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
export declare function buildSlackMessage(fields: SlackMessageFields): SlackMessage;
//# sourceMappingURL=build-message.d.ts.map