/**
 * Tool handlers for `subscribe_slack`, `unsubscribe_slack`, and
 * `list_subscriptions`. Extracted from `mcp-server.ts` for SRP.
 *
 * Each handler receives a small `deps` object (Interface Segregation) — it
 * does not reach into `McpBridgeServer` internals.
 */

import { gateSubscribeChange } from '../auth-gate.js';
import type { SlackChannelConfig } from '../config.js';
import type { DaemonClient } from '../daemon-client.js';
import type { Logger } from '../logger.js';
import type { TopicSpec } from '../shared/types.js';
import { normalizeTopic } from '../shared/types.js';
import { formatSpec, mergeTopicSpecs } from '../topic-helpers.js';

/** Dependencies shared by the subscription-related handlers. */
export interface SubscribeHandlerDeps {
  daemonClient: DaemonClient | null;
  logger: Logger;
  allowedSubscribeUsers: Set<string>;
  /** Display-only session id, surfaced in `list_subscriptions` output. */
  sessionId: string | undefined;
  /** Read the current persisted topic state. */
  readState: () => SlackChannelConfig;
  /** Write the persisted topic state. */
  writeState: (patch: Partial<SlackChannelConfig>) => void;
  /** Snapshot of the in-memory subscribed-topic list. */
  getSubscribedTopics: () => TopicSpec[];
  /** Replace the in-memory subscribed-topic list. */
  setSubscribedTopics: (next: TopicSpec[]) => void;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export async function handleSubscribe(
  args: Record<string, unknown>,
  deps: SubscribeHandlerDeps,
): Promise<ToolResult> {
  const blocked = gateSubscribeChange(args, 'subscribe', deps.allowedSubscribeUsers, deps.logger);
  if (blocked) return blocked;

  try {
    const raw = (args.topics as Array<string | TopicSpec> | undefined) ?? [];
    const incoming = raw.map(normalizeTopic);

    if (!incoming.length) {
      return {
        content: [{ type: 'text' as const, text: 'Error: topics[] must be non-empty' }],
        isError: true,
      };
    }

    if (!deps.daemonClient) {
      throw new Error('DAEMON_URL is not set — cannot subscribe');
    }

    await deps.daemonClient.subscribe(incoming, deps.sessionId);
    deps.setSubscribedTopics(mergeTopicSpecs(deps.getSubscribedTopics(), incoming));

    // Persist merged topics to the state file.
    try {
      const existing = deps.readState();
      const existingSpecs = (existing.topics ?? []).map(normalizeTopic);
      deps.writeState({ topics: mergeTopicSpecs(existingSpecs, incoming) });
    } catch (err) {
      deps.logger.warn(`could not persist subscription — ${err}`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Subscribed on :${deps.daemonClient.port} — topics: ${incoming.map(formatSpec).join(', ')}`,
        },
      ],
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
  }
}

export async function handleUnsubscribe(
  args: Record<string, unknown>,
  deps: SubscribeHandlerDeps,
): Promise<ToolResult> {
  const blocked = gateSubscribeChange(args, 'unsubscribe', deps.allowedSubscribeUsers, deps.logger);
  if (blocked) return blocked;

  const requested = (args.topics as string[] | undefined) ?? null;
  const isPartial = Array.isArray(requested) && requested.length > 0;

  // Always tear down the existing subscription on the daemon — the registry
  // doesn't expose a "remove these topics" op, so partial unsubscribe is
  // implemented as full unsubscribe + resubscribe with the remainder.
  if (deps.daemonClient) {
    await deps.daemonClient.unsubscribe();
  }

  const subscribedTopics = deps.getSubscribedTopics();
  let remaining: TopicSpec[] = [];
  let removed: TopicSpec[] = [];
  if (isPartial) {
    const toRemove = new Set(requested);
    removed = subscribedTopics.filter((t) => toRemove.has(t.topic));
    remaining = subscribedTopics.filter((t) => !toRemove.has(t.topic));
    if (deps.daemonClient && remaining.length > 0) {
      await deps.daemonClient.subscribe(remaining, deps.sessionId);
    }
  } else {
    removed = [...subscribedTopics];
  }

  deps.setSubscribedTopics(remaining);

  // Persist the new topic list (or empty) to the state file.
  try {
    deps.writeState({ topics: remaining });
  } catch (err) {
    deps.logger.warn(`could not persist unsubscribe — ${err}`);
  }

  const text = isPartial
    ? `Unsubscribed from: ${removed.map(formatSpec).join(', ') || '(none — topic was not subscribed)'}. Remaining: ${remaining.map(formatSpec).join(', ') || '(none)'}`
    : `Unsubscribed from all topics${removed.length ? ` (${removed.map(formatSpec).join(', ')})` : ''}`;
  return { content: [{ type: 'text' as const, text }] };
}

/** Dependencies for `list_subscriptions` — narrower than the others. */
export interface ListSubscriptionsDeps {
  sessionId: string | undefined;
  getSubscribedTopics: () => TopicSpec[];
}

export async function handleListSubscriptions(
  deps: ListSubscriptionsDeps,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const subscribedTopics = deps.getSubscribedTopics();
  const count = subscribedTopics.length;
  if (count === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No active subscriptions for this session.' }],
    };
  }
  const lines = subscribedTopics.map((t, i) => `  ${i + 1}. ${formatSpec(t)}`).join('\n');
  const json = JSON.stringify(subscribedTopics);
  const header = deps.sessionId
    ? `Active subscriptions (${count}) for session ${deps.sessionId}:`
    : `Active subscriptions (${count}):`;
  return {
    content: [
      {
        type: 'text' as const,
        text: `${header}\n${lines}\n\nJSON: ${json}`,
      },
    ],
  };
}
