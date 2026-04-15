/**
 * Subscriber registry — tracks MCP instances, their ID filters, and regexp filters.
 * Health-checks subscribers periodically and removes dead ones.
 *
 * Matching logic:
 *
 *   Level 0 — Threads (independent bypass)
 *     If threads is non-empty and msg.thread_ts is in the list → PASS immediately.
 *
 *   Level 1 — Channel / DM (required: empty means "nothing allowed")
 *     If both channels and dms are empty → BLOCK (no subscription).
 *     Otherwise the message must satisfy at least one of:
 *       - channels contains msg.channel_id
 *       - dms contains msg.user_id AND msg.is_dm === true
 *     If neither → BLOCK.
 *
 *   Level 2 — User refinement (optional, applies after Level 1)
 *     If users is non-empty, msg.user_id must be in the list; otherwise BLOCK.
 *     If users is empty, any user passes.
 *
 *   Level 3 — Regexp filters (AND): all patterns must match.
 */

import type {
  SlackFilters,
  SlackMessage,
  Subscriber,
  SubscriptionFilters,
} from '../shared/types.js';
import { log } from './logger.js';

/** Merge two optional string arrays, deduplicating values. */
function union(a: string[] | undefined, b: string[] | undefined): string[] {
  if (!a?.length && !b?.length) return [];
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

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
  /**
   * Thread ownership map: thread_ts → port of the subscriber that claimed it.
   * Populated by the daemon when a subscriber claims a message; consulted on
   * every routing decision so the daemon can guarantee exclusivity.
   */
  private threadOwners = new Map<string, number>();
  private healthInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private healthCheckMs = 30_000) {}

  add(
    port: number,
    filters: SubscriptionFilters,
    regexp?: SlackFilters,
    label?: string,
  ): Subscriber {
    const existing = this.subscribers.get(port);
    const sub: Subscriber = existing
      ? {
          ...existing,
          filters: {
            channels: union(existing.filters.channels, filters.channels),
            dms: union(existing.filters.dms, filters.dms),
            users: union(existing.filters.users, filters.users),
            threads: union(existing.filters.threads, filters.threads),
          },
          regexp: regexp ?? existing.regexp,
          label: label ?? existing.label,
          lastSeen: new Date().toISOString(),
        }
      : {
          port,
          filters,
          regexp,
          label,
          registeredAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        };

    this.subscribers.set(port, sub);

    // Scope exclusivity: only one subscriber may own a given channel / dm /
    // thread at any time. The newest subscription wins; any previous owner
    // loses that specific scope item, and is removed entirely if it ends up
    // with no channels / dms / threads left.
    this.enforceExclusiveScope(port, sub.filters);

    return sub;
  }

  /**
   * Evict the given scope items from every other subscriber. The caller is
   * the new exclusive owner; any other subscriber that still references one
   * of these items has it stripped. A subscriber that is left with no
   * channels / dms / threads at all is dropped from the registry.
   */
  private enforceExclusiveScope(newOwnerPort: number, filters: SubscriptionFilters): void {
    const newChannels = new Set(filters.channels ?? []);
    const newDms = new Set(filters.dms ?? []);
    const newThreads = new Set(filters.threads ?? []);
    if (newChannels.size === 0 && newDms.size === 0 && newThreads.size === 0) return;

    for (const [otherPort, other] of this.subscribers) {
      if (otherPort === newOwnerPort) continue;

      const strippedChannels = (other.filters.channels ?? []).filter((c) => !newChannels.has(c));
      const strippedDms = (other.filters.dms ?? []).filter((d) => !newDms.has(d));
      const strippedThreads = (other.filters.threads ?? []).filter((t) => !newThreads.has(t));

      const channelsChanged = strippedChannels.length !== (other.filters.channels?.length ?? 0);
      const dmsChanged = strippedDms.length !== (other.filters.dms?.length ?? 0);
      const threadsChanged = strippedThreads.length !== (other.filters.threads?.length ?? 0);
      if (!channelsChanged && !dmsChanged && !threadsChanged) continue;

      const hasAnyScope =
        strippedChannels.length > 0 || strippedDms.length > 0 || strippedThreads.length > 0;

      if (!hasAnyScope) {
        log(
          `[registry] evicting :${otherPort} (${other.label ?? '-'}) — all scope owned by :${newOwnerPort}`,
        );
        this.remove(otherPort);
        continue;
      }

      log(
        `[registry] stripping scope from :${otherPort} (${other.label ?? '-'}) in favor of :${newOwnerPort} — channels=-${newChannels.size ? [...newChannels].filter((c) => (other.filters.channels ?? []).includes(c)).length : 0} dms=-${newDms.size ? [...newDms].filter((d) => (other.filters.dms ?? []).includes(d)).length : 0} threads=-${newThreads.size ? [...newThreads].filter((t) => (other.filters.threads ?? []).includes(t)).length : 0}`,
      );
      this.subscribers.set(otherPort, {
        ...other,
        filters: {
          ...other.filters,
          channels: strippedChannels,
          dms: strippedDms,
          threads: strippedThreads,
        },
        lastSeen: new Date().toISOString(),
      });
    }
  }

  remove(port: number): boolean {
    // Release every thread this subscriber owned so future messages in those
    // threads fall back to the general fan-out.
    for (const [threadTs, ownerPort] of this.threadOwners) {
      if (ownerPort === port) this.threadOwners.delete(threadTs);
    }
    return this.subscribers.delete(port);
  }

  /** Assign exclusive ownership of a thread to a subscriber port. */
  setThreadOwner(threadTs: string, port: number): void {
    this.threadOwners.set(threadTs, port);
  }

  /** Current owner of a thread, if any. */
  getThreadOwner(threadTs: string): number | undefined {
    return this.threadOwners.get(threadTs);
  }

  get(port: number): Subscriber | undefined {
    return this.subscribers.get(port);
  }

  all(): Subscriber[] {
    return [...this.subscribers.values()];
  }

  /**
   * Find subscribers whose filters match the given message.
   *
   * Thread ownership is authoritative: if the message's thread_ts (or its
   * own message_ts when the message is the thread root) has been claimed by
   * a subscriber, that subscriber — and only that subscriber — receives the
   * message. The daemon does NOT fan out owned-thread messages to other
   * channel/dm/general subscribers, so a claimed task cannot be stolen by
   * another session.
   *
   * When no owner is registered, routing falls back to the normal filter
   * matching across all subscribers.
   */
  match(msg: SlackMessage): Subscriber[] {
    // Ownership lookup: check both the explicit thread_ts and the message_ts
    // itself (a top-level message acts as the thread root once replied).
    const anchors = [msg.thread_ts, msg.message_ts].filter(
      (ts): ts is string => typeof ts === 'string' && ts.length > 0,
    );
    for (const anchor of anchors) {
      const ownerPort = this.threadOwners.get(anchor);
      if (ownerPort === undefined) continue;
      const owner = this.subscribers.get(ownerPort);
      if (owner) return [owner];
      // Dangling owner (subscriber disappeared) — release and keep looking.
      this.threadOwners.delete(anchor);
    }

    return this.all().filter((sub) => this.matches(sub.filters, sub.regexp, msg));
  }

  private matches(
    filters: SubscriptionFilters,
    regexp: SlackFilters | undefined,
    msg: SlackMessage,
  ): boolean {
    // Level 0 — Thread bypass (independent)
    const hasThreadFilter = (filters.threads?.length ?? 0) > 0;
    if (hasThreadFilter && msg.thread_ts != null && filters.threads?.includes(msg.thread_ts)) {
      return this.matchesRegexp(regexp, msg);
    }

    // Level 1 — Channel / DM (required gate: empty = nothing allowed)
    const hasChannelFilter = (filters.channels?.length ?? 0) > 0;
    const hasDmFilter = (filters.dms?.length ?? 0) > 0;

    if (!hasChannelFilter && !hasDmFilter) return false;

    const channelMatch = hasChannelFilter && (filters.channels?.includes(msg.channel_id) ?? false);
    const dmMatch = hasDmFilter && msg.is_dm && (filters.dms?.includes(msg.user_id) ?? false);
    if (!channelMatch && !dmMatch) return false;

    // Level 2 — User refinement (optional: if specified, user must match)
    const hasUserFilter = (filters.users?.length ?? 0) > 0;
    if (hasUserFilter && !(filters.users?.includes(msg.user_id) ?? false)) return false;

    // Level 3 — Regexp AND matching (all patterns must pass)
    return this.matchesRegexp(regexp, msg);
  }

  private matchesRegexp(regexp: SlackFilters | undefined, msg: SlackMessage): boolean {
    if (!regexp) return true;
    if (regexp.channel && !tryMatch(regexp.channel, msg.channel_name)) return false;
    if (regexp.user && !tryMatch(regexp.user, msg.user_name)) return false;
    if (regexp.message && !tryMatch(regexp.message, msg.text ?? '')) return false;
    if (regexp.thread && !tryMatch(regexp.thread, msg.thread_ts ?? '')) return false;
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
