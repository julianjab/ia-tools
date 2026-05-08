/**
 * Authorization gates for the Slack bridge.
 *
 * subscribe/unsubscribe gate:
 *   - `requested_by` absent  → local CLI invocation. Always allowed.
 *   - `requested_by` present → originated from a Slack message. Always blocked.
 *     Subscription changes from Slack are unconditionally rejected to prevent
 *     any Slack user from rerouting bot traffic.
 *
 * Message allowlists (ALLOWED_USERS_MENTIONS, ALLOWED_USERS_DM):
 *   - Empty set → block all (deny by default).
 *   - Non-empty → only listed user IDs pass through.
 */

import type { Logger } from './logger.js';

/** Parse a comma-separated env value into a Set of trimmed user-id strings. */
export function parseAllowedUsers(envValue?: string): Set<string> {
  return new Set(
    (envValue ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Run the auth gate for a subscribe/unsubscribe tool invocation.
 * Returns the tool error response when blocked, or `null` when allowed.
 */
export function gateSubscribeChange(
  args: Record<string, unknown>,
  op: 'subscribe' | 'unsubscribe',
  logger: Logger,
): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  const raw = args.requested_by;
  const requestedBy = typeof raw === 'string' && raw.length > 0 ? raw : null;
  if (!requestedBy) {
    return null;
  }
  logger.warn(`[gate] ${op} rejected — Slack-originated subscription changes are not allowed`);
  return {
    content: [
      {
        type: 'text' as const,
        text: `Refused: ${op}_slack cannot be triggered from a Slack message. Subscription changes must come from the local Claude Code session.`,
      },
    ],
    isError: true,
  };
}
