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

import type { SlackMessage, Subscriber } from '../shared/types.js';
import { matchesTopic, parseTopic } from '../shared/types.js';
import { log } from './logger.js';

export class Registry {
  private subscribers = new Map<number, Subscriber>();
  private healthInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private healthCheckMs = 30_000) {}

  add(port: number, topics: string[], label?: string): Subscriber {
    const existing = this.subscribers.get(port);
    if (existing) {
      const merged: Subscriber = {
        ...existing,
        topics: [...new Set([...existing.topics, ...topics])],
        label: label ?? existing.label,
        lastSeen: new Date().toISOString(),
      };
      this.subscribers.set(port, merged);
      return merged;
    }

    const sub: Subscriber = {
      port,
      topics,
      label,
      registeredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
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
   * Returns each matching subscriber paired with the topics that matched.
   */
  match(msg: SlackMessage): Array<{ subscriber: Subscriber; matched: string[] }> {
    const results: Array<{ subscriber: Subscriber; matched: string[] }> = [];
    for (const sub of this.all()) {
      const matched = sub.topics.filter((t) => matchesTopic(parseTopic(t), msg));
      if (matched.length > 0) {
        results.push({ subscriber: sub, matched });
      }
    }
    return results;
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
          log(`[registry] removing dead subscriber :${port} (${sub.label ?? 'no label'})`);
          this.subscribers.delete(port);
        }
      }
    }, this.healthCheckMs);
  }

  stopHealthChecks(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
  }
}
