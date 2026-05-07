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
   */
  match(msg: SlackMessage): Array<{ subscriber: Subscriber; matched: TopicSpec[] }> {
    const results: Array<{ subscriber: Subscriber; matched: TopicSpec[] }> = [];
    for (const sub of this.all()) {
      const matched = sub.topics.filter((t) => matchesTopic(parseTopic(t.topic), msg));
      if (matched.length > 0) {
        results.push({ subscriber: sub, matched });
      }
    }
    return results;
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
