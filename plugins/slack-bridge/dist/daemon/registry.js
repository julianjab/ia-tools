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
import { log } from './logger.js';
/** Merge two optional string arrays, deduplicating values. */
function union(a, b) {
    if (!a?.length && !b?.length)
        return [];
    return [...new Set([...(a ?? []), ...(b ?? [])])];
}
function tryMatch(pattern, value) {
    try {
        // Extract inline flags like (?i) — not supported natively by JS RegExp constructor
        const inlineFlags = pattern.match(/^\(\?([gimsuy]+)\)/);
        const flags = inlineFlags ? inlineFlags[1] : undefined;
        const src = inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern;
        return new RegExp(src, flags).test(value);
    }
    catch {
        return true; // invalid regexp — don't filter
    }
}
export class Registry {
    healthCheckMs;
    subscribers = new Map();
    healthInterval;
    constructor(healthCheckMs = 30_000) {
        this.healthCheckMs = healthCheckMs;
    }
    add(port, filters, regexp, label) {
        const existing = this.subscribers.get(port);
        if (existing) {
            // Always merge into the existing subscription for this port
            const sub = {
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
            };
            this.subscribers.set(port, sub);
            return sub;
        }
        const sub = {
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
    remove(port) {
        return this.subscribers.delete(port);
    }
    get(port) {
        return this.subscribers.get(port);
    }
    all() {
        return [...this.subscribers.values()];
    }
    /** Find subscribers whose filters match the given message. */
    match(msg) {
        return this.all().filter((sub) => this.matches(sub.filters, sub.regexp, msg));
    }
    matches(filters, regexp, msg) {
        // Level 0 — Thread bypass (independent)
        const hasThreadFilter = (filters.threads?.length ?? 0) > 0;
        if (hasThreadFilter && msg.thread_ts != null && filters.threads?.includes(msg.thread_ts)) {
            return this.matchesRegexp(regexp, msg);
        }
        // Level 1 — Channel / DM (required gate: empty = nothing allowed)
        const hasChannelFilter = (filters.channels?.length ?? 0) > 0;
        const hasDmFilter = (filters.dms?.length ?? 0) > 0;
        if (!hasChannelFilter && !hasDmFilter)
            return false;
        const channelMatch = hasChannelFilter && (filters.channels?.includes(msg.channel_id) ?? false);
        const dmMatch = hasDmFilter && msg.is_dm && (filters.dms?.includes(msg.user_id) ?? false);
        if (!channelMatch && !dmMatch)
            return false;
        // Level 2 — User refinement (optional: if specified, user must match)
        const hasUserFilter = (filters.users?.length ?? 0) > 0;
        if (hasUserFilter && !(filters.users?.includes(msg.user_id) ?? false))
            return false;
        // Level 3 — Regexp AND matching (all patterns must pass)
        return this.matchesRegexp(regexp, msg);
    }
    matchesRegexp(regexp, msg) {
        if (!regexp)
            return true;
        if (regexp.channel && !tryMatch(regexp.channel, msg.channel_name))
            return false;
        if (regexp.user && !tryMatch(regexp.user, msg.user_name))
            return false;
        if (regexp.message && !tryMatch(regexp.message, msg.text ?? ''))
            return false;
        if (regexp.thread && !tryMatch(regexp.thread, msg.thread_ts ?? ''))
            return false;
        return true;
    }
    markSeen(port) {
        const sub = this.subscribers.get(port);
        if (sub)
            sub.lastSeen = new Date().toISOString();
    }
    startHealthChecks(checkFn) {
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
    stopHealthChecks() {
        if (this.healthInterval)
            clearInterval(this.healthInterval);
    }
}
//# sourceMappingURL=registry.js.map