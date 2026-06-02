# Harness Engineering — Agent Audit Rules (HE-A1…HE-A11)

Apply these checks to `agents/<name>.md`. Each rule maps to one of the
five harness pillars (see [`README.md`](README.md)). Rules complement —
they do not replace — the structural checks in
[`../agent-anti-patterns.md`](../agent-anti-patterns.md) (A1-A14).

## Contents

- HE-A1 Separation of concerns — action
- HE-A2 Bounded capability — action
- HE-A3 Context strategy declared — perception
- HE-A4 Approval gates listed — guardrails
- HE-A5 Self-verification loop — verification
- HE-A6 Observability sink — observability
- HE-A7 No model lock-in — action
- HE-A8 Drift resistance — perception
- HE-A9 Rippability — meta
- HE-A10 Failure-as-design / The Ratchet — verification
- HE-A11 Behavior-first component justification — meta
- Report shape

## HE-A1 — Separation of concerns (pillar: action)

Frontmatter declares capability, body declares behavior. Fail if the body
contains tool gating prose ("you may only use Read") instead of
`tools:` / `disallowedTools:` in frontmatter, or if frontmatter contains
behavioral rules ("always run tests first") instead of the body.

- **Check**: scan body for `(may|must|cannot)\s+use\s+(the\s+)?[A-Z][a-z]+` matched against tool names.
- **Severity**: HIGH if behavior is in frontmatter; MEDIUM if capability gating is in body.

## HE-A2 — Bounded capability (pillar: action)

Tool surface is explicit and deny-by-default. Fail if neither `tools:`
nor `disallowedTools:` is set on a non-orchestrator agent, OR if
`tools: "*"` is used without an accompanying `disallowedTools:` list.

- **Check**: frontmatter contains `tools:` OR `disallowedTools:`.
- **Severity**: HIGH if both missing; MEDIUM if `tools: *` without denies.

## HE-A3 — Context strategy declared (pillar: perception)

Agent describes how it discovers state on boot — what files it reads
(CLAUDE.md, AGENTS.md, state.md, manifests), in what order. "Repository-
first" is the rule: knowledge lives in the repo, not in the prompt.

- **Check**: body contains a "Boot" / "On start" / "First action" / "Context"
  section that names at least one repo file.
- **Severity**: MEDIUM if missing; LOW if mentioned but no order specified.

## HE-A4 — Approval gates listed with explicit tier (pillar: guardrails)

Sensitive operations (push, deploy, merge, drop, force, delete) are
named with the gate that protects them. The canonical tiering
(Augment Code, GitHub) is:

- **Always** — agent may perform autonomously (log + UTC timestamps).
- **Ask First** — requires explicit user approval each time.
- **Never** — absolute prohibition (no flag, no override).

Agents that mention sensitive verbs without classifying them into one
of the three tiers fail this rule.

- **Check**: grep body for `\b(push|deploy|merge|drop|force|delete|rm -rf|send|publish)\b`.
  If any match, body must also contain "approval" / "confirm" / "gate" /
  "aprobar" / "Ask First" / `AskUserQuestion` near it (±20 lines), OR a
  table classifying the action.
- **Severity**: HIGH if sensitive verb without a nearby gate.

## HE-A5 — Self-verification loop (pillar: verification)

Agent describes how it checks its own output before declaring done.
Mitigates *victory declaration bias*. A "Done means" / "Definition of
done" / "Verify before reporting" section is the canonical shape.

- **Check**: body mentions "verify" / "validate" / "check" / "confirm"
  in a non-prose section (heading, list, or table).
- **Severity**: MEDIUM if missing.

## HE-A6 — Observability sink (pillar: observability)

Agent writes its decisions / state transitions to a known location
(state.md, audit log, structured task updates). Black-box agents fail
this check.

- **Check**: body names at least one persistent artifact
  (`state.md`, `.claude/agent-memory/`, task updates, PR description).
- **Severity**: MEDIUM if missing.

## HE-A7 — No model lock-in (pillar: action)

Business logic (workflow rules, repo conventions) lives in the body or
linked repo docs — not in `model:` / `effort:` / temperature tricks.
A swap from sonnet → opus should not break behavior.

- **Check**: body contains no phrases like "because opus" / "only with
  thinking enabled" / "requires extended context" tied to behavior.
- **Severity**: LOW.

## HE-A8 — Drift resistance (pillar: perception)

Agent references repo-local conventions docs (CLAUDE.md, AGENTS.md)
rather than hardcoding them. When repo conventions change, the agent
adapts without an edit.

- **Check**: body mentions `CLAUDE.md` or `AGENTS.md` OR uses a
  discovery hook (e.g. "read all `.claude/agents/`").
- **Severity**: LOW if missing on a project agent.

## HE-A9 — Rippability (pillar: meta)

Agent body is no longer than necessary. Defensive scaffolding for
problems the current model class no longer exhibits is a code smell.
Long agents (> 250 lines) get LOW unless they also declare which
sections are "model-class shims" candidates for removal.

- **Check**: line count; presence of "# Legacy" / "# Shim" / dated
  comments justifying retained scaffolding.
- **Severity**: LOW.

## HE-A10 — Failure-as-design / The Ratchet (pillar: verification)

When the agent has documented mistakes (in CHANGELOG, "Known issues",
or `.claude/agent-memory/<agent>/`), the prompt encodes the lesson.
Lopopolo's formulation: *"Anytime an agent makes a mistake, engineer a
solution so it never makes that mistake again."* Hashimoto / AddyOsmani
add the inverse: **every rule must trace to a documented incident OR a
named behavior gap.** Rules that exist "just in case" are dead weight.

- **Check (forward)**: cross-reference with `.claude/agent-memory/<agent>/`
  or CHANGELOG entries naming this agent. If 3+ corrections recorded but
  body has no matching guidance → MEDIUM.
- **Check (inverse)**: body has 5+ rule-shaped statements (
  "always X", "never Y") with no traceable incident or behavior-gap
  rationale → MEDIUM "rule accumulation".
- **Severity**: MEDIUM.

## HE-A11 — Behavior-first component justification (pillar: meta)

Every section of the agent body justifies its existence by the behavior
it enforces or unlocks. Filler sections ("About this agent",
"Philosophy", "Notes") are anti-patterns: they consume context without
shaping behavior. AddyOsmani: *"If you cannot name the specific
behavior a component delivers, it likely shouldn't exist."*

- **Check**: each top-level body heading is a verb or names a behavior
  ("Boot", "Plan", "Provision", "Dispatch", "Error handling"). Headings
  that name only nouns ("About", "Notes", "Philosophy", "Background")
  → LOW per heading.
- **Severity**: LOW; MEDIUM if 3+ noun-only headings.

## Report shape

```
| Severity | Rule  | Finding                                       | Location |
| HIGH     | HE-A4 | `git push` named without an approval gate     | L42      |
| MEDIUM   | HE-A5 | No self-verification step before reporting    | body     |
```
