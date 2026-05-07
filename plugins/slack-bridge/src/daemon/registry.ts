/**
 * Subscriber registry — tracks MCP instances and their topic subscriptions.
 * Health-checks subscribers periodically and removes dead ones.
 *
 * Matching: a message is delivered to a subscriber if ANY of its topics match
 * (OR logic). Each topic is parsed by parseTopic() and tested by matchesTopic().
 *
 * Topic formats:
 *   "{channel}"                  → any message in channel
 *   "{channel}:{user}"           → channel + specific user
 *   "{channel}:*:{thread}"       → specific thread, any user
 *   "{channel}:{user}:{thread}"  → specific thread + specific user
 *   "DM:{user}"                  → DMs from a specific user
 */

import type { Logger } from '../logger.js';
import type { SlackMessage, Subscriber, TopicSpec } from '../shared/types.js';
import { matchesTopic, parseTopic } from '../shared/types.js';

/**
 * Specificity score for a TopicSpec — counts the non-empty filter fields on
 * its parsed form. Wildcards (`*`) and absent segments contribute 0; the
 * `type` field doesn't count (every topic has a type).
 *
 *   "C123"             → channel only            → 1
 *   "DM:U1"            → dm + user               → 1
 *   "C123:U1"          → channel + user          → 2
 *   "C123:*:thread1"   → channel + thread        → 2
 *   "C123:U1:thread1"  → channel + user + thread → 3
 *
 * Used by `match()` to pre-empt less-specific subscribers when a message
 * also matches a more-specific topic.
 */
function topicSpecificity(spec: TopicSpec): number {
  const p = parseTopic(spec.topic);
  let s = 0;
  if (p.channel) s++;
  if (p.user) s++;
  if (p.thread) s++;
  return s;
}

/**
 * Merge two TopicSpec lists by `topic` string. Later entries' labels win
 * (callers can rebrand a topic by re-subscribing with a new label).
 */
function mergeTopics(existing: TopicSpec[], incoming: TopicSpec[]): TopicSpec[] {
  const map = new Map<string, TopicSpec>();
  for (const t of existing) map.set(t.topic, t);
  for (const t of incoming) {
    const prev = map.get(t.topic);
    map.set(t.topic, {
      topic: t.topic,
      ...(t.label ? { label: t.label } : prev?.label ? { label: prev.label } : {}),
    });
  }
  return [...map.values()];
}

/**
 * No-op Logger — used when callers don't supply one. Keeps the Registry
 * usable in tests without setting up a real logger.
 */
const NOOP_LOGGER: Logger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export interface RegistryOptions {
  /** Logger for registry events (subscriber removal). Defaults to a no-op. */
  logger?: Logger;
  /** Health check interval in ms. Defaults to 30s. */
  healthCheckMs?: number;
}

export class Registry {
  private subscribers = new Map<number, Subscriber>();
  private healthInterval: ReturnType<typeof setInterval> | undefined;
  private readonly logger: Logger;
  private readonly healthCheckMs: number;

  constructor(opts: RegistryOptions | number = {}) {
    // Back-compat: `new Registry(30_000)` still works.
    if (typeof opts === 'number') {
      this.healthCheckMs = opts;
      this.logger = NOOP_LOGGER;
    } else {
      this.healthCheckMs = opts.healthCheckMs ?? 30_000;
      this.logger = opts.logger ?? NOOP_LOGGER;
    }
  }

  add(port: number, topics: TopicSpec[], sessionId?: string): Subscriber {
    const existing = this.subscribers.get(port);
    if (existing) {
      const merged: Subscriber = {
        ...existing,
        topics: mergeTopics(existing.topics, topics),
        lastSeen: new Date().toISOString(),
        // Refresh session_id if a new one is provided; otherwise preserve.
        ...(sessionId && sessionId.length > 0
          ? { session_id: sessionId }
          : existing.session_id
            ? { session_id: existing.session_id }
            : {}),
      };
      this.subscribers.set(port, merged);
      return merged;
    }

    const sub: Subscriber = {
      port,
      topics,
      registeredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      ...(sessionId && sessionId.length > 0 ? { session_id: sessionId } : {}),
    };
    this.subscribers.set(port, sub);
    return sub;
  }

  remove(port: number): boolean {
    return this.subscribers.delete(port);
  }

  get(port: number): Subscriber | undefined {
    return this.subscribers.get(port);
  }

  all(): Subscriber[] {
    return [...this.subscribers.values()];
  }

  /**
   * Find subscribers whose topics match the message.
   * Returns each matching subscriber paired with the TopicSpecs that matched
   * (preserving labels so the caller can forward them on delivery).
   *
   * Specificity pre-emption: a message in `C123` thread `t1` matches both
   * a subscriber on `C123` (whole channel) AND a subscriber on
   * `C123:*:t1` (the specific thread). Delivering to both produces
   * duplicates and lets a less-intentional subscriber see messages a more
   * specific one is actively handling. We compute the global maximum
   * specificity score across all matched topics and keep only matches at
   * that score; ties are preserved (multiple subscribers at the same
   * top score all receive the message). Within a single subscriber that
   * has both a wide and a narrow topic on the same message, only the
   * narrower spec is forwarded — the agent sees the most informative
   * label in `matched_topics`.
   */
  match(msg: SlackMessage): Array<{ subscriber: Subscriber; matched: TopicSpec[] }> {
    const all: Array<{ subscriber: Subscriber; matched: TopicSpec[] }> = [];
    for (const sub of this.all()) {
      const matched = sub.topics.filter((t) => matchesTopic(parseTopic(t.topic), msg));
      if (matched.length > 0) {
        all.push({ subscriber: sub, matched });
      }
    }
    if (all.length === 0) return [];

    let maxScore = 0;
    for (const { matched } of all) {
      for (const t of matched) {
        const s = topicSpecificity(t);
        if (s > maxScore) maxScore = s;
      }
    }

    const winners: Array<{ subscriber: Subscriber; matched: TopicSpec[] }> = [];
    for (const { subscriber, matched } of all) {
      const kept = matched.filter((t) => topicSpecificity(t) === maxScore);
      if (kept.length > 0) winners.push({ subscriber, matched: kept });
    }
    return winners;
  }

  /**
   * Count subscribers that would match `msg` BEFORE pre-emption — i.e. the
   * raw OR-of-topics check. Used by the daemon's fan-out logger to report
   * how many subscribers were pre-empted out by `match()`. Kept separate
   * from `match()` so its return shape stays stable.
   */
  countMatchingSubscribers(msg: SlackMessage): number {
    let count = 0;
    for (const sub of this.all()) {
      if (sub.topics.some((t) => matchesTopic(parseTopic(t.topic), msg))) count++;
    }
    return count;
  }

  /** Remove a list of topic strings from a subscriber. Returns the new spec list. */
  removeTopics(port: number, topicStrings: string[]): TopicSpec[] | undefined {
    const sub = this.subscribers.get(port);
    if (!sub) return undefined;
    const drop = new Set(topicStrings);
    const remaining = sub.topics.filter((t) => !drop.has(t.topic));
    if (remaining.length === 0) {
      this.subscribers.delete(port);
      return [];
    }
    this.subscribers.set(port, { ...sub, topics: remaining, lastSeen: new Date().toISOString() });
    return remaining;
  }

  markSeen(port: number): void {
    const sub = this.subscribers.get(port);
    if (sub) sub.lastSeen = new Date().toISOString();
  }

  startHealthChecks(checkFn: (port: number) => Promise<boolean>): void {
    this.healthInterval = setInterval(async () => {
      for (const [port, sub] of this.subscribers) {
        const alive = await checkFn(port);
        if (!alive) {
          this.logger.log(
            `[registry] removing dead subscriber :${port} (${sub.topics.length} topics)`,
          );
          this.subscribers.delete(port);
        }
      }
    }, this.healthCheckMs);
  }

  stopHealthChecks(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
  }
}
