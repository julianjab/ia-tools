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
import type { SlackFilters, SlackMessage, Subscriber, SubscriptionFilters } from '../shared/types.js';
export declare class Registry {
    private healthCheckMs;
    private subscribers;
    private healthInterval;
    constructor(healthCheckMs?: number);
    add(port: number, filters: SubscriptionFilters, regexp?: SlackFilters, label?: string): Subscriber;
    remove(port: number): boolean;
    get(port: number): Subscriber | undefined;
    all(): Subscriber[];
    /** Find subscribers whose filters match the given message. */
    match(msg: SlackMessage): Subscriber[];
    private matches;
    private matchesRegexp;
    markSeen(port: number): void;
    startHealthChecks(checkFn: (port: number) => Promise<boolean>): void;
    stopHealthChecks(): void;
}
//# sourceMappingURL=registry.d.ts.map