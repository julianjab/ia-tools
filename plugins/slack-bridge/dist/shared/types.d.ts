/**
 * Shared types for slack-bridge daemon ↔ subscriber communication.
 */
export type { SlackChannelConfig, SlackFilters, ChannelsConfig } from '../config.js';
import type { SlackFilters } from '../config.js';
/** A Slack message forwarded by the daemon to subscribers. */
export interface SlackMessage {
    channel_id: string;
    channel_name: string;
    user_id: string;
    user_name: string;
    text: string;
    message_ts: string;
    thread_ts?: string;
    /** True when the message originates from a DM channel (channel_id starts with 'D'). */
    is_dm: boolean;
}
/**
 * Subscription filters.
 *
 * Matching rules (see registry.ts for full logic):
 *   threads — independent: a thread match bypasses channels/users/dms
 *   dms     — independent: matches only when msg.is_dm === true AND user_id is in the list
 *   channels + users — AND logic: both must match if both are specified
 */
export interface SubscriptionFilters {
    channels?: string[];
    /** Any message from these user IDs regardless of channel type. */
    users?: string[];
    /** DMs only — matches messages where is_dm=true AND user_id is in this list. */
    dms?: string[];
    threads?: string[];
}
/** POST /subscribe */
export interface SubscribeRequest {
    port: number;
    filters: SubscriptionFilters;
    /** Optional regexp filters applied in the daemon (AND logic, all must match). */
    regexp?: SlackFilters;
    label?: string;
}
/** Subscriber record in the daemon registry */
export interface Subscriber {
    port: number;
    filters: SubscriptionFilters;
    /** Regexp filters stored per-subscriber so the daemon knows what each instance is filtering. */
    regexp?: SlackFilters;
    label?: string;
    registeredAt: string;
    lastSeen?: string;
}
/** POST /message — daemon → subscriber */
export interface MessagePayload {
    message: SlackMessage;
    daemon_ts: string;
}
/** POST /claim/:message_ts */
export interface ClaimRequest {
    subscriber_port: number;
}
export interface ClaimResponse {
    claimed: boolean;
    /** Who claimed it (port) — if already claimed by another */
    claimed_by?: number;
}
/** GET /health */
export interface DaemonHealth {
    status: 'ok';
    uptime: number;
    subscribers: number;
    socketMode: 'connected' | 'disconnected';
}
//# sourceMappingURL=types.d.ts.map