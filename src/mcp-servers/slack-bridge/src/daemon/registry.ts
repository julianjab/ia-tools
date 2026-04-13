/**
 * Subscriber registry — tracks MCP instances and their filters.
 * Health-checks subscribers periodically and removes dead ones.
 */

import type { Subscriber, SubscriptionFilters, SlackMessage } from '../shared/types.js';

export class Registry {
  private subscribers = new Map<number, Subscriber>();
  private healthInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private healthCheckMs = 30_000) {}

  add(port: number, filters: SubscriptionFilters, label?: string): Subscriber {
    const sub: Subscriber = {
      port,
      filters,
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

  /** Find subscribers whose filters match the given message. */
  match(msg: SlackMessage): Subscriber[] {
    return this.all().filter((sub) => this.matches(sub.filters, msg));
  }

  private matches(filters: SubscriptionFilters, msg: SlackMessage): boolean {
    // Empty filters = match everything
    const hasAnyFilter =
      (filters.channels?.length ?? 0) > 0 ||
      (filters.users?.length ?? 0) > 0 ||
      (filters.threads?.length ?? 0) > 0;

    if (!hasAnyFilter) return true;

    // OR logic: match ANY filter
    if (filters.channels?.includes(msg.channel_id)) return true;
    if (filters.users?.includes(msg.user_id)) return true;
    if (msg.thread_ts && filters.threads?.includes(msg.thread_ts)) return true;

    return false;
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
          console.log(`[registry] removing dead subscriber :${port} (${sub.label ?? 'no label'})`);
          this.subscribers.delete(port);
        }
      }
    }, this.healthCheckMs);
  }

  stopHealthChecks(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
  }
}
