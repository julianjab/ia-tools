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
  /**
   * Thread context saved by the Slack Agent (channel/workspace the user was
   * viewing when they opened the Assistant thread). Forwarded to subscribers
   * so the agent knows the originating context.
   */
  thread_context?: Record<string, unknown>;
  /**
   * Emoji name (without colons) when this event represents a reaction_added event,
   * e.g. "white_check_mark" or "x". Absent for regular messages.
   */
  reaction?: string;
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

/**
 * A topic with an optional label. The label is application-level metadata
 * the subscriber attaches to give the agent context about why this topic
 * exists (e.g. "ship-pr-42" for a thread subscription opened by /ship).
 * The label is forwarded to the agent on every matched delivery.
 */
export interface TopicSpec {
  topic: string;
  label?: string;
}

/** Normalize a topic input that may be a bare string or a TopicSpec. */
export function normalizeTopic(input: string | TopicSpec): TopicSpec {
  if (typeof input === 'string') return { topic: input };
  return { topic: input.topic, ...(input.label ? { label: input.label } : {}) };
}

/** POST /subscribe */
export interface SubscribeRequest {
  port: number;
  topics: Array<string | TopicSpec>;
  /**
   * Optional Claude session id (CLAUDE_CODE_SESSION_ID or
   * ~/.claude/sessions/<ppid>.json). Used purely for log correlation in the
   * central daemon log — never written to per-session files.
   */
  session_id?: string;
}

/** Subscriber record in the daemon registry */
export interface Subscriber {
  port: number;
  topics: TopicSpec[];
  registeredAt: string;
  lastSeen?: string;
  /** See SubscribeRequest.session_id — kept for log correlation. */
  session_id?: string;
}

/** POST /message — daemon → subscriber */
export interface MessagePayload {
  message: SlackMessage;
  /** TopicSpecs from the subscriber's list that matched this message. */
  matched_topics: TopicSpec[];
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
