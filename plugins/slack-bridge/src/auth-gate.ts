/**
 * Authorization gate for `subscribe_slack` / `unsubscribe_slack`.
 *
 * The agent passes `requested_by` to declare the source of the request:
 *   - `requested_by` absent  → local CLI invocation (the operator typing
 *     in Claude Code). Always allowed; the operator is implicitly trusted.
 *   - `requested_by` present → request originated from a Slack message
 *     (the agent should set it to the user_id from the triggering
 *     notification). In this case:
 *       - allowlist empty  → REJECTED. Slack-originated requests must be
 *         explicitly authorized via SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS.
 *       - allowlist set    → must include `requested_by`, otherwise
 *         REJECTED.
 */

import type { Logger } from './logger.js';

/**
 * Parse the comma-separated `SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS` env value
 * into a Set of trimmed user-id strings. An unset / empty value yields an
 * empty Set, which the gate treats as "no allowlist configured".
 */
export function parseAllowedSubscribeUsers(envValue?: string): Set<string> {
  return new Set(
    (envValue ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Run the auth gate for a subscribe/unsubscribe tool invocation.
 *
 * Returns the tool error response when blocked, or `null` when the call may
 * proceed.
 */
export function gateSubscribeChange(
  args: Record<string, unknown>,
  op: 'subscribe' | 'unsubscribe',
  allowedSubscribeUsers: Set<string>,
  logger: Logger,
): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  const raw = args.requested_by;
  const requestedBy = typeof raw === 'string' && raw.length > 0 ? raw : null;
  if (!requestedBy) {
    // Local CLI invocation — implicitly trusted operator.
    return null;
  }
  if (allowedSubscribeUsers.size === 0) {
    logger.warn(`[gate] ${op} rejected — Slack-originated, no allowlist configured`);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Refused: ${op}_slack requests originating from Slack messages are blocked because no allowlist is configured. Set SLACK_BRIDGE_SUBSCRIBE_ALLOWED_USERS in the MCP env to authorize specific users.`,
        },
      ],
      isError: true,
    };
  }
  if (!allowedSubscribeUsers.has(requestedBy)) {
    logger.warn(`[gate] ${op} rejected — ${requestedBy} not in allowlist`);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Refused: user ${requestedBy} is not authorized to change subscriptions. Allowed: ${[...allowedSubscribeUsers].join(', ')}.`,
        },
      ],
      isError: true,
    };
  }
  return null;
}
