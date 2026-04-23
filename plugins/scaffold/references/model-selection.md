# Model selection and effort tuning

Pick the right model + effort for an agent. Applies to `model:` and `effort:` in agent frontmatter and to `model:`/`effort:` in skill frontmatter.

## Decision table — model

| Task profile | Model | Why |
|--------------|-------|-----|
| Read-only exploration (grep, glob, file survey) | `haiku` | Fast, cheap; volume over judgment. |
| Bulk, cost-sensitive worker | `haiku` | Use with strict `tools` allowlist. |
| Implementation (writing code, fixing tests) | `sonnet` | Default. 90% of Opus quality, higher speed. |
| Refactoring with known patterns | `sonnet` | Patterns carry more weight than novel reasoning. |
| Architecture / API contract design | `opus` | Cross-cutting tradeoffs; quality compounds. |
| Security review / gate decisions | `opus` | False negatives cost more than speed. |
| Orchestrator / team lead | `opus` | Delegation quality compounds across the team. |
| Main session router (classification) | `sonnet` | High-volume, structured outputs — Sonnet is enough. |
| Code review / audit | `opus` | Gate decisions; fresh context reduces anchoring. |

## Resolution order

1. `CLAUDE_CODE_SUBAGENT_MODEL` env var (overrides everything)
2. Per-invocation `model` parameter (if spawned via `Agent(subtype, model=…)`)
3. Frontmatter `model:`
4. Main session's model

Default is `inherit` — fine for subagents that should match the parent.

## Effort — reasoning budget

Valid values (model-dependent availability): `low`, `medium`, `high`, `xhigh`, `max`.

| Value | Use |
|-------|-----|
| `low` | Lookups, trivial classification. Rare. |
| `medium` | Cost-sensitive bulk work. Simple edits. |
| `high` | Default on Opus 4.6 / Sonnet 4.6. Standard implementation work. |
| `xhigh` | Default on Opus 4.7. Coding and agentic subagents. |
| `max` | Only when evals show measurable headroom beyond `xhigh`. Expensive. |

Rule of thumb: **do not bump effort to solve a bad prompt**. If the agent misbehaves, fix the prompt (body, description, output format) before raising effort.

## `maxTurns` — conversation cap

No default, no hard limit. Use to bound runaway loops:

| Role | Suggested `maxTurns` |
|------|----------------------|
| Auditor, gate, one-shot reviewer | 10–30 |
| Implementer teammate (backend/frontend) | 60–100 |
| Orchestrator / team lead | 100–200 |
| Read-only explorer | 20–40 |

Subagents return results when `maxTurns` is reached. Teammates stop claiming tasks.

## Matching `memory:` to model

- Agents with `memory: project` benefit more from `sonnet`/`opus` — they apply past patterns.
- `haiku` with memory works for recall, less for synthesis.
- No-memory agents get no benefit from longer effort on repeat tasks.

## Common mistakes

- Opus on a read-only explorer (waste).
- Haiku on a security gate (false negatives).
- Max effort to compensate for a vague prompt (throws money at the problem).
- MaxTurns 200 on a one-shot auditor (no loop to cap anyway).
- MaxTurns 10 on a teammate implementer (premature halt mid-iteration).

## Cost awareness

Rough order of magnitude (input + output, excluding cache discounts):

- Haiku: baseline (1×)
- Sonnet: ~3×
- Opus: ~15×

Use Opus where the decision quality compounds (gates, architecture, orchestration). Use Sonnet for the bulk of implementation. Use Haiku for read-only volume.
