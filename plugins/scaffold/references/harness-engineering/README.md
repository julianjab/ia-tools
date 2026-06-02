# Harness Engineering — Audit References

Harness engineering is the discipline of designing the control systems that
govern AI agents: how they perceive their environment, select actions,
validate outputs, and stay observable. Formalized in early 2026 by
Lopopolo (OpenAI) and Hashimoto (HashiCorp) as the fourth paradigm of AI
engineering, after prompt engineering, context engineering, and agent
engineering. The formula: **Agent = Model + Harness**.

These references distill harness engineering into auditable checklists
for the three artifact types this plugin produces:

- [`agents.md`](agents.md) — rules HE-A1…HE-A10 for `agents/*.md`
- [`skills.md`](skills.md) — rules HE-S1…HE-S10 for `skills/<name>/SKILL.md`
- [`mcps.md`](mcps.md) — rules HE-M1…HE-M10 for MCP server plugins

Used by `/audit-harness` to audit a single artifact, or by `audit-agent`,
`audit-skill`, `audit-mcp` when invoked with `--harness`.

## Foundational equation

> "Agent = Model + Harness. If you're not the model, you're the harness."
> — Lopopolo (OpenAI), Hashimoto

> "Humans steer. Agents execute." — Lopopolo, *Harness Engineering* (OpenAI, Feb 2026)

A "decent model with a great harness beats a great model with a bad
harness" (AddyOsmani). When auditing, treat every gap as a harness
defect, not a model defect.

## Three harness layers (Augment Code, derived from OpenAI)

1. **Constraint harnesses (feedforward)** — reduce the agent's solution
   space before generation begins. Lives in `AGENTS.md` / `CLAUDE.md` /
   `SKILL.md`, schemas, lint configs.
2. **Feedback loops (corrective)** — structured error signals that
   enable autonomous self-correction. Hooks, typecheck/lint/test
   post-edit, tool output envelopes.
3. **Quality gates (enforcement)** — prevent non-compliant artifacts
   from merging. CI failures, `/audit-*` verdicts, `/pr` review gate.

Rules that live as prose in a prompt are probabilistic.
Rules wired through a hook or a verifier are deterministic.
Harness engineering prefers the second.

## Five universal harness pillars

Every artifact-level rule (HE-A*, HE-S*, HE-M*) maps to one of these:

1. **Perception (context)** — what the agent can see. Repo-first,
   progressive disclosure, no flooding, no stale lineage.
2. **Action selection (tools)** — bounded capability, deny-by-default
   tool registry, explicit scope limits.
3. **Verification loops** — intermediate quality checks, not deferred
   to the end. Mitigates *victory declaration bias*.
4. **Guardrails** — human-in-the-loop for sensitive ops, budget /
   scope ceilings, structured failure modes.
5. **Observability** — telemetry, audit logs, traceable outputs.
   "If a reviewer can't reverse-engineer intent, the harness is broken."

## Two cross-cutting meta-rules

These apply at all three layers and to all three artifact types.

### The Ratchet (Hashimoto / Lopopolo / AddyOsmani)

Every agent failure should trigger a permanent harness change. Every
rule in a prompt or hook must trace to either (a) a documented past
incident or (b) a named behavior gap the model cannot close alone.
Rules that exist "just in case" are dead weight — they dilute attention
and waste context. When the model class improves enough to make a rule
redundant, REMOVE it. Mistake-to-rule conversion is one-way; rule
removal is the other half of the discipline.

### Behavior-first component justification (AddyOsmani)

"If you cannot name the specific behavior a component delivers, it
likely shouldn't exist." Every agent / skill / tool / hook in a
harness must justify its existence by the behavior it enforces. The
inverse of rule accumulation.

## Anti-patterns common to all artifacts

| Anti-pattern | Origin | Symptom |
|---|---|---|
| Victory declaration bias | Lopopolo | Marks done without verifying outcome |
| Context anxiety | Faros | Rushes to finish as context fills |
| One-shotting overreach | Faros | Attempts whole problem in one execution |
| Model lock-in | Medium / Visrow | Business logic baked into prompt instead of harness |
| Silent failure / silent success | AddyOsmani | Success should be silent; failure verbose and actionable |
| Probabilistic reliance | Medium | Trusts model output without validation |
| Overloaded context | Medium | Floods context with everything available |
| Rigid harness | NxCode | Can't be simplified as models improve |
| Blame-and-wait | AddyOsmani | "Wait for a better model" instead of fixing the harness |
| Rule accumulation w/o justification | AddyOsmani | Adding constraints based on speculation, not observed failures |
| Inline-suppression of rules | Augment | Agent suppresses violations (`// eslint-disable`) instead of fixing them |
| Monolithic tool design | AddyOsmani | 50 overlapping tools instead of ~10 focused + bash fallback |
| Untethered context | AddyOsmani | No filesystem / VCS integration; copy-paste workflow |

## Anti-patterns common to all artifacts

| Anti-pattern | Origin | Symptom |
|---|---|---|
| Victory declaration bias | Lopopolo | Marks done without verifying outcome |
| Context anxiety | Faros | Rushes to finish as context fills |
| One-shotting overreach | Faros | Attempts whole problem in one execution |
| Model lock-in | Medium / Visrow | Business logic baked into prompt instead of harness |
| Silent failures | Multiple | Errors swallowed; no structured envelope |
| Probabilistic reliance | Medium | Trusts model output without validation |
| Overloaded context | Medium | Floods context with everything available |
| Rigid harness | NxCode | Can't be simplified as models improve |
