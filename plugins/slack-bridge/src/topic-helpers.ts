/**
 * TopicSpec helpers used by the MCP server's subscription handlers.
 *
 * Note: a similar `mergeTopics` exists in `daemon/registry.ts`. The two are
 * kept independent on purpose — the registry copy is the daemon's
 * server-side authority, and any divergence between the two should be
 * resolved deliberately, not via a silent shared import.
 */

import type { TopicSpec } from './shared/types.js';

/**
 * Merge two TopicSpec lists by topic string. Later entries' labels win
 * so a re-subscribe can rebrand a topic.
 */
export function mergeTopicSpecs(existing: TopicSpec[], incoming: TopicSpec[]): TopicSpec[] {
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

/** Render a TopicSpec as `label:topic` when labelled, else just `topic`. */
export function formatSpec(spec: TopicSpec): string {
  return spec.label ? `${spec.label}:${spec.topic}` : spec.topic;
}
