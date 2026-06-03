# Spec — Harness Agent Development Flow (`harness-forge` plugin)

**Branch:** `claude/harness-agent-plugin-zCcGP`
**Status:** PROPOSED — plan/spec for review, nothing wired in yet.
**Author:** Julian Buitrago
**Date:** 2026-06-03

---

## 0. TL;DR

Add a fifth plugin, **`harness-forge`**, that treats *harness
engineering* as a first-class development discipline with its own
repeatable flow. Where `scaffold` builds individual artifacts (one
agent, one skill, one MCP, one script) and `team-workflow` *is* one
concrete harness instance, `harness-forge` sits one level up: it helps
a team **design, assemble, verify, and evolve the whole environment**
that surrounds an agent — its constraints, tool orchestration,
verification loops, memory, and observability.

The deliverable of this document is **the plan only**. No code is
created yet.

---

## 1. What "harness engineering" means here

> Harness engineering is the discipline of building the environment and
> infrastructure surrounding an AI agent, shifting focus from
> "prompting" to **system design**. It integrates constraints, tool
> executions, feedback loops, and memory, allowing models to operate
> reliably and autonomously over long, complex tasks.
> — operator's framing

The 2026 industry consensus converges on a **five-subsystem** model
wrapping a central agent loop. We adopt it verbatim as the plugin's
backbone:

| # | Subsystem | What it owns | Failure it prevents |
|---|-----------|--------------|---------------------|
| S1 | **Constraints / Guardrails** | Plan-vs-Normal mode, tool allow/deny, branch & write boundaries, deterministic CI enforcement | Agent drifting from spec; unsafe writes |
| S2 | **Tool orchestration** | Which tools exist, when they fire, Plan-Mode (read-only) vs Normal-Mode (read-write) | Wrong/over-broad tool access |
| S3 | **Verification loops** | Plan→Execute→Verify, RED-before-GREEN, contract checks, the recovery loop that re-injects intent on premature exit | Early stopping; incoherence across context windows |
| S4 | **Context & memory** | Durable state across context windows, rules files, correction→rule capture | Forgetting; repeated mistakes |
| S5 | **Observability** | Trajectory capture, component/decision/experience observability, drift detection | Blind operation; no learning signal |

Grounding sources (see §11): LangChain "Anatomy of an Agent Harness",
the Plan-Execute-Verify and Ralph-Loop patterns, and the
observability-driven harness-evolution literature.

**Key realization:** `ia-tools` already implements these subsystems —
but as *hardcoded, lahaus-specific* policy inside `team-workflow`. The
four invariants (approval gate, QA-first, security gate, PR-only) ARE
an instance of S1+S3. `session-forge` IS an instance of S5. What's
missing is the **meta-flow** that lets a team build *their own*
harness for *their own* repos without re-deriving these patterns by
hand. That is the gap `harness-forge` fills.

---

## 2. Relationship to existing plugins (decision)

The operator delegated this call to the plan. **Recommendation: a new
sibling plugin `harness-forge`, not an extension of `team-workflow`.**

Rationale:

- **`team-workflow` is a harness *instance*, not a harness *factory*.**
  It encodes one opinionated flow (router→lead, Slack/tmux, lahaus
  multi-repo). Folding a general "how to engineer a harness" meta-flow
  into it would blur a plugin that today has a sharp, single purpose,
  and would couple harness-authoring to Slack/tmux assumptions it
  shouldn't carry.
- **`scaffold` is the right *peer*, one altitude down.** Scaffold emits
  atomic artifacts (`/new-agent`, `/new-skill`, `/new-mcp`,
  `/new-script`) validated against rule sets (A1–A14, S1–S20). A
  harness is a *composition* of those artifacts plus constraints, loops,
  memory wiring, and observability config. `harness-forge` should
  **orchestrate `scaffold`**, not duplicate it — it decides *what*
  artifacts a harness needs and *how they interlock*, then delegates
  the actual file authoring to `scaffold`'s `*-author` subagents.
- **`session-forge` is the data source for S5.** `harness-forge`'s
  "evolve" phase reads the SQLite store session-forge already captures,
  rather than re-instrumenting events.

So the dependency graph is:

```
harness-forge  ──uses──▶ scaffold        (author the artifacts)
      │        ──reads──▶ session-forge   (observability signal for evolve)
      │        ──can-target──▶ team-workflow (one example output harness)
      ▼
  a harness manifest + wired subsystems in a target repo
```

`harness-forge` stays transport-agnostic (no Slack/tmux coupling) and
emits artifacts into a target repo's `.claude/`.

---

## 3. The development flow — six phases

The plugin codifies a named, repeatable loop. Each phase maps to
subsystem(s) and is driven by one skill.

```
FRAME ──▶ CONSTRAIN ──▶ WIRE ──▶ LOOP ──▶ OBSERVE ──▶ EVOLVE ──┐
  ▲                                                            │
  └────────────────────── feedback ───────────────────────────┘
```

| Phase | Subsystem | Question answered | Primary skill | Output |
|-------|-----------|-------------------|---------------|--------|
| **FRAME** | — | What is this agent for, over what horizon, in what repo(s)? | `/harness-frame` | `harness.manifest.yaml` skeleton |
| **CONSTRAIN** | S1, S2 | What may it touch? Plan vs Normal mode? Tool allow/deny? Hard gates? | `/harness-constrain` | guardrail hooks + tool policy |
| **WIRE** | S2 | Which agents/skills/MCPs compose the harness? | `/harness-wire` (delegates to `scaffold`) | `.claude/agents`, `skills`, MCP config |
| **LOOP** | S3 | What is the verify contract? PEV? RED-before-GREEN? recovery on early-exit? | `/harness-loop` | verification hooks + contract file |
| **OBSERVE** | S5 | What trajectory signal do we capture? | `/harness-observe` | observability config (session-forge wiring) |
| **EVOLVE** | S4, S5 | What did the signal teach us? Which corrections become rules? | `/harness-evolve` | memory/rules diffs, harness-version bump |

A single entry skill **`/harness`** runs the whole flow interactively
(like `/new-agent` runs its sub-steps), or jumps to a phase:
`/harness frame|constrain|wire|loop|observe|evolve|audit`.

---

## 4. Proposed plugin structure

Mirrors the conventions mapped from the four existing plugins.

```
plugins/harness-forge/
├── .claude-plugin/
│   └── plugin.json                         # name, version 0.1.0, author, MIT
├── README.md
├── CHANGELOG.md
├── agents/
│   ├── harness-engineer.md                 # opus, orchestrates the 6-phase flow
│   └── harness-auditor.md                  # read-only, scores a harness H1–Hn
├── skills/
│   ├── harness/SKILL.md                     # /harness — entry, dispatches phases
│   ├── harness-frame/SKILL.md               # /harness-frame
│   ├── harness-constrain/SKILL.md           # /harness-constrain
│   ├── harness-wire/SKILL.md                # /harness-wire (calls scaffold:*)
│   ├── harness-loop/SKILL.md               # /harness-loop
│   ├── harness-observe/SKILL.md            # /harness-observe
│   ├── harness-evolve/SKILL.md             # /harness-evolve
│   └── harness-audit/SKILL.md              # /harness-audit (scores manifest+wiring)
├── references/
│   ├── harness-subsystems.md               # the S1–S5 canon + checklists
│   ├── harness-patterns.md                 # PEV, Ralph/recovery loop, Plan-Mode
│   ├── harness-anti-patterns.md            # H1–Hn rules the auditor enforces
│   ├── harness-manifest-schema.md          # harness.manifest.yaml field reference
│   └── verification-contracts.md           # how to express a verify contract
├── hooks/
│   ├── hooks.json
│   └── scripts/
│       ├── enforcement/
│       │   └── enforce-manifest-coverage.sh # block /harness-* completion if a
│       │                                     # subsystem is undeclared
│       ├── bookkeeping/
│       │   └── record-harness-event.sh      # append to harness-version log
│       └── intelligence/
│           └── suggest-harness-evolution.sh # claude -p over session-forge data
└── templates/
    ├── harness.manifest.yaml                # the artifact a harness is described by
    ├── verify-contract.md
    └── rules.md
```

### 4.1 The central artifact: `harness.manifest.yaml`

A harness is declared by one file, version-controlled in the target
repo at `.claude/harness.manifest.yaml`. It is the single source of
truth the auditor scores and the evolve phase bumps.

```yaml
# .claude/harness.manifest.yaml
harness:
  name: client-api-backend
  version: 0.3.0
  horizon: long          # short | medium | long  (drives recovery-loop need)
  targets: [./]          # repos/dirs this harness governs

constraints:             # S1 + S2
  mode_policy: plan-then-normal      # plan-only | normal | plan-then-normal
  tool_allow: [Read, Grep, Glob, Edit, Write, Bash]
  tool_deny:  [NotebookEdit]
  hard_gates: [tests-green, no-direct-main]

tools:                   # S2 — composed artifacts (authored via scaffold)
  agents:  [implementer, qa, security]
  skills:  [commit, review, pr]
  mcp:     []

loops:                   # S3
  strategy: plan-execute-verify
  red_before_green: true
  recovery_on_early_exit: true       # the Ralph/re-inject pattern
  contract: .claude/verify-contract.md

memory:                  # S4
  store: .claude/agent-memory/
  rules: .claude/rules.md
  capture_corrections: true

observability:           # S5
  source: session-forge
  drift_detection: true
```

---

## 5. Agents

| Agent | Model | Tools | Role |
|-------|-------|-------|------|
| `harness-engineer` | opus, effort high, maxTurns ~120 | full impl set | Orchestrates FRAME→EVOLVE. Owns the manifest. Delegates artifact authoring to `scaffold:*-author` subagents; never hand-writes an agent/skill if scaffold can. |
| `harness-auditor` | sonnet, maxTurns ~25 | `Read, Grep, Glob` (read-only) | Scores a manifest + its wiring against H-rules in `harness-anti-patterns.md`; returns a fixed-format report. Mirrors scaffold's `/audit-*`. |

Both follow the repo's agent body contract (persona → responsibility →
inputs → output format → decision tables → escalation) and respect the
plugin-frontmatter limits (no `hooks`/`mcpServers`/`permissionMode`).

---

## 6. Hooks (enforcement of the harness invariants)

`harness-forge` introduces **one hard invariant of its own**, enforced
by hooks so it can't be skipped:

> **Coverage invariant.** A harness manifest may not be marked
> `complete` (and `/harness-audit` may not pass) while any of the five
> subsystems S1–S5 is undeclared or empty. Every subsystem must have an
> explicit decision — including an explicit "not needed, because …".

| Hook | Event | Effect |
|------|-------|--------|
| `enforcement/enforce-manifest-coverage.sh` | `PostToolUse:Write\|Edit` on `harness.manifest.yaml` (+ optionally `TaskCompleted`) | Exit 2 if a subsystem block is missing/empty without an explicit waiver. |
| `bookkeeping/record-harness-event.sh` | `PostToolUse` on manifest writes | Append `{phase, subsystem, version}` to a harness-version log (always exit 0). |
| `intelligence/suggest-harness-evolution.sh` | `SessionEnd` (async) | `claude -p` over the session-forge SQLite store → proposes rule/memory diffs for the EVOLVE phase. Non-blocking. |

This reuses the bucketed-hooks convention (`enforcement/` may exit 2,
`bookkeeping/` always exit 0, `intelligence/` may call `claude -p`).

---

## 7. Reference docs (the canon)

These make the plugin *teach* harness engineering, the way `scaffold`'s
references encode A/S rules:

- **`harness-subsystems.md`** — the S1–S5 model, with a per-subsystem
  checklist the FRAME/CONSTRAIN/.../OBSERVE skills walk.
- **`harness-patterns.md`** — Plan-Execute-Verify; the recovery/Ralph
  loop (re-inject intent on premature exit into a compacted context);
  Plan-Mode (read-only) vs Normal-Mode (read-write); correction→rule
  feedback layer.
- **`harness-anti-patterns.md`** — H-rules the auditor enforces, e.g.
  *H1: every subsystem declared; H2: long-horizon harness MUST set
  `recovery_on_early_exit`; H3: `plan-then-normal` mode requires a
  read-only tool set for the plan phase; H4: `red_before_green` implies
  a QA artifact exists in `tools.agents`; …*
- **`harness-manifest-schema.md`** — full field reference for §4.1.
- **`verification-contracts.md`** — how to write the `verify-contract.md`
  a loop checks against.

---

## 8. Registration checklist (when we build it)

Per the conventions mapped from the repo:

1. `plugins/harness-forge/.claude-plugin/plugin.json` — `name`,
   `version: 0.1.0`, description, author (Julian/MIT), homepage/repo.
2. Add a `plugins[]` entry in
   `.claude-plugin/marketplace.json` — `category: tooling` (or a new
   `category: harness`), keywords `[harness, agents, constraints,
   verification, memory, observability, meta]`.
3. Add a package block in `.github/release-please-config.json`
   (`release-type: simple`, `component: harness-forge`, `extra-files`
   syncing `.claude-plugin/plugin.json` `$.version`).
4. Add `"plugins/harness-forge": "0.1.0"` to
   `.github/.release-please-manifest.json`.
5. Conventional-commit scope: `harness-forge`.
6. CI (`verify.yml`) needs no change — it's not an MCP plugin, so the
   slack-bridge dist drift check is irrelevant.

---

## 9. Phased rollout (one PR per phase)

Keeps each PR small and independently shippable, matching the repo's
PR-per-increment habit.

- **PR1 (v0.1.0) — Skeleton + canon.** plugin.json, marketplace +
  release registration, README, the five `references/*.md`, the
  `harness.manifest.yaml` template. No behavior yet. Lets reviewers
  ratify the S1–S5 model and the manifest schema before code.
- **PR2 (v0.2.0) — FRAME + AUDIT.** `/harness` entry skill,
  `/harness-frame`, `/harness-audit`, the `harness-auditor` agent, and
  `enforce-manifest-coverage.sh`. End-to-end on an empty manifest.
- **PR3 (v0.3.0) — CONSTRAIN + WIRE.** `harness-engineer` agent,
  `/harness-constrain`, `/harness-wire` (delegating to `scaffold:*`),
  guardrail-hook generation.
- **PR4 (v0.4.0) — LOOP.** `/harness-loop`, verify-contract template,
  PEV + recovery-loop wiring + `verification-contracts.md`.
- **PR5 (v0.5.0) — OBSERVE + EVOLVE.** `/harness-observe`,
  `/harness-evolve`, `record-harness-event.sh`,
  `suggest-harness-evolution.sh` reading session-forge.
- **PR6 (v1.0.0) — Dogfood.** Re-express `team-workflow`'s four
  invariants as a `harness.manifest.yaml` to prove the model is
  expressive enough (validation milestone, not a rewrite of
  team-workflow).

---

## 10. Open questions for the operator

1. **Name.** `harness-forge` (parallels `session-forge`/`scaffold`) vs
   `harness-flow` vs `agent-harness`. Default: `harness-forge`.
2. **Marketplace category.** Reuse `tooling`, or introduce a new
   `harness` category? Default: `tooling`.
3. **Manifest format.** YAML (proposed, human-first) vs JSON (parser-
   first, matches plugin.json). Default: YAML.
4. **Scope of S5.** Hard-depend on `session-forge` for observability, or
   keep it pluggable with session-forge as the default adapter?
   Default: pluggable, session-forge default.
5. **Dogfood depth (PR6).** Just *express* team-workflow as a manifest
   (validation), or actually *drive* team-workflow from it (migration)?
   Default: express-only for v1.0.0.

---

## 11. Sources

- [The Anatomy of an Agent Harness — LangChain](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)
- [Harness Engineering: Making AI Coding Agents Work in 2026 — Faros.ai](https://www.faros.ai/blog/harness-engineering)
- [Harness Engineering for AI Coding Agents — Augment Code](https://www.augmentcode.com/guides/harness-engineering-ai-coding-agents)
- [Agent Harness Engineering — The Rise of the AI Control Plane (Adnan Masood)](https://medium.com/@adnanmasood/agent-harness-engineering-the-rise-of-the-ai-control-plane-938ead884b1d)
- [Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses (arXiv)](https://arxiv.org/html/2604.25850v3)
- [awesome-harness-engineering (GitHub)](https://github.com/ai-boost/awesome-harness-engineering)
- Internal: `CLAUDE.md`, `AGENTS.md`, `specs/hook-architecture.md`, and the four existing plugins under `plugins/`.
