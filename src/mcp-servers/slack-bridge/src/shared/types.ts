/**
 * Shared types for slack-bridge daemon ↔ subscriber communication.
 */

export type { SlackConfig } from "../config.js";

/** A Slack message forwarded by the daemon to subscribers. */
export interface SlackMessage {
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  text: string;
  message_ts: string;
  thread_ts?: string;
}

/** Subscription filters — OR logic: match ANY to receive the message. */
export interface SubscriptionFilters {
  channels?: string[];
  users?: string[];
  threads?: string[];
}

/** POST /subscribe */
export interface SubscribeRequest {
  port: number;
  filters: SubscriptionFilters;
  label?: string;
}

/** Subscriber record in the daemon registry */
export interface Subscriber {
  port: number;
  filters: SubscriptionFilters;
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
