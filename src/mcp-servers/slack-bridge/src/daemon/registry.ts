/**
 * Subscriber registry — tracks MCP instances, their ID filters, and regexp filters.
 * Health-checks subscribers periodically and removes dead ones.
 *
 * Matching logic (two layers):
 *   1. ID filters (OR)  — channels / users / threads: match ANY to pass
 *   2. Regexp filters (AND) — channel_name / user_name / text / thread_ts: ALL must match
 */

import { log } from './logger.js';
import type {
  Subscriber,
  SubscriptionFilters,
  SlackMessage,
  SlackFilters,
} from '../shared/types.js';

function tryMatch(pattern: string, value: string): boolean {
  try {
    // Extract inline flags like (?i) — not supported natively by JS RegExp constructor
    const inlineFlags = pattern.match(/^\(\?([gimsuy]+)\)/);
    const flags = inlineFlags ? inlineFlags[1] : undefined;
    const src = inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern;
    return new RegExp(src, flags).test(value);
  } catch {
    return true; // invalid regexp — don't filter
  }
}

export class Registry {
  private subscribers = new Map<number, Subscriber>();
  private healthInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private healthCheckMs = 30_000) {}

  add(
    port: number,
    filters: SubscriptionFilters,
    regexp?: SlackFilters,
    label?: string,
  ): Subscriber {
    const sub: Subscriber = {
      port,
      filters,
      regexp,
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
    return this.all().filter((sub) => this.matches(sub.filters, sub.regexp, msg));
  }

  private matches(
    filters: SubscriptionFilters,
    regexp: SlackFilters | undefined,
    msg: SlackMessage,
  ): boolean {
    // Layer 1 — ID-based OR matching
    const hasAnyIdFilter =
      (filters.channels?.length ?? 0) > 0 ||
      (filters.users?.length ?? 0) > 0 ||
      (filters.threads?.length ?? 0) > 0;

    if (hasAnyIdFilter) {
      const matchesId =
        (filters.channels?.includes(msg.channel_id) ?? false) ||
        (filters.users?.includes(msg.user_id) ?? false) ||
        (msg.thread_ts != null && (filters.threads?.includes(msg.thread_ts) ?? false));
      if (!matchesId) return false;
    }

    // Layer 2 — Regexp AND matching (all patterns must pass)
    if (regexp) {
      if (regexp.channel && !tryMatch(regexp.channel, msg.channel_name)) return false;
      if (regexp.user && !tryMatch(regexp.user, msg.user_name)) return false;
      if (regexp.message && !tryMatch(regexp.message, msg.text ?? '')) return false;
      if (regexp.thread && !tryMatch(regexp.thread, msg.thread_ts ?? '')) return false;
    }

    return true;
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
