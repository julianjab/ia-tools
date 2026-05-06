/**
 * Shared types for slack-bridge daemon ↔ subscriber communication.
 */

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
 * A parsed topic describing what messages a subscriber wants to receive.
 *
 * Topic string formats (raw → matched messages):
 *   "{channel}"                  → any message in channel (any user, any thread)
 *   "{channel}:{user}"           → messages from a specific user in a channel
 *   "{channel}:*:{thread}"       → all replies in a specific thread (any user)
 *   "{channel}:{user}:{thread}"  → replies from a specific user in a thread
 *   "DM:{user}"                  → direct messages from a specific user
 *
 * Use "*" as a wildcard for the channel or user segment.
 */
export interface ParsedTopic {
  /** "channel" for normal messages, "dm" for direct messages. */
  type: 'channel' | 'dm';
  /** Channel ID filter. Absent means any channel. */
  channel?: string;
  /** User ID filter. Absent means any user. */
  user?: string;
  /** Thread timestamp filter. Absent means both threaded and non-threaded messages pass. */
  thread?: string;
}

/** Parse a topic string into a structured filter. */
export function parseTopic(topic: string): ParsedTopic {
  if (topic.startsWith('DM:')) {
    const user = topic.slice(3);
    return { type: 'dm', user: user || undefined };
  }
  const parts = topic.split(':');
  const rawChannel = parts[0];
  const rawUser = parts[1];
  const rawThread = parts[2];
  return {
    type: 'channel',
    channel: rawChannel && rawChannel !== '*' ? rawChannel : undefined,
    user: rawUser && rawUser !== '*' ? rawUser : undefined,
    thread: rawThread && rawThread !== '*' ? rawThread : undefined,
  };
}

/**
 * Returns true if a message matches a parsed topic.
 * Subscribers use OR across their topics list — one match is enough.
 */
export function matchesTopic(parsed: ParsedTopic, msg: SlackMessage): boolean {
  if (parsed.type === 'dm') {
    return msg.is_dm && (!parsed.user || msg.user_id === parsed.user);
  }
  if (parsed.channel && msg.channel_id !== parsed.channel) return false;
  if (parsed.thread && msg.thread_ts !== parsed.thread) return false;
  if (parsed.user && msg.user_id !== parsed.user) return false;
  return true;
}

/** POST /subscribe */
export interface SubscribeRequest {
  port: number;
  topics: string[];
  label?: string;
}

/** Subscriber record in the daemon registry */
export interface Subscriber {
  port: number;
  topics: string[];
  label?: string;
  registeredAt: string;
  lastSeen?: string;
}

/** POST /message — daemon → subscriber */
export interface MessagePayload {
  message: SlackMessage;
  /** Topics from the subscriber's list that matched this message. */
  matched_topics: string[];
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
  pid: number;
  entrypoint: string;
}
