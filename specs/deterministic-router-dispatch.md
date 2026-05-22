# Spec — Deterministic router dispatch

**Status:** SUPERSEDED — kept for historical context.

This spec proposed a 3-role split (router → topic-worker → lead).
The 2-role simplification (router handles classification inline;
`topic-worker` removed) shipped in PR #106 (`feat(team-workflow)!:
collapse router+worker, per-topic state.md is source of truth`). The
canonical, current behaviour lives in:

- `plugins/team-workflow/agents/router.md` — inline `answer` / `ask` /
  `dispatch` + state-dir bootstrap.
- `plugins/team-workflow/agents/lead.md` — boots from
  `$IA_TW_STATE_DIR` (created by the router) instead of recomputing
  the topic-hash; reads `state.md` + `messages.md` before doing
  anything else.
- `plugins/team-workflow/hooks/scripts/bookkeeping/append-message.sh`
  — writes `messages.md` from four native Claude Code hook events
  (`UserPromptSubmit`, `Stop`, `SubagentStop`,
  `PostToolUse:reply|reply_update`).

The original spec text below documents the design that motivated the
move from "main session classifies" to "deterministic dispatcher".
Where it mentions `topic-worker`, the equivalent in the current
architecture is "the router itself, holding pending-ask state in
`state.md`".

## Goal

An agent should run **the least logic possible**, and the system should
be **as deterministic as possible**. The deepest LLM judgment (classify
intent, draft replies, decide a plan) happens in one place — the
per-topic worker — and it happens **once per topic activation**, not
once per message.

This also gives us:

- **Bounded router context** — the router's context grows *only* with
  the set of topics it manages, because its context literally **is** the
  `topic → worker` registry.
- **No agent-boot per message** — an active topic reuses its worker via
  `SendMessage`; boot happens once per topic, not per message.
- **Request concurrency** — workers for different topics run in
  parallel; the router's per-message work is a near-deterministic
  registry lookup.

## Invariant we must NOT break

`slack-bridge` is **pure I/O transport**. It does not classify, does not
run `tmux` / `start-lead.sh`, does not manage the team, does not inject
roles. It delivers messages and carries replies. All routing and
orchestration lives in Claude sessions (`router`, `worker`, `lead`) —
because `SendMessage`, `Agent()`, and `SlashCommand` are harness tools
the daemon does not have.

The first draft of this spec violated this by putting a deterministic
classifier + `start-lead.sh` execution in the daemon. **That was wrong.**
This version keeps the daemon untouched.

## Three roles

```
Slack event
   │  (daemon: pure transport — unchanged)
   ▼
ROUTER  (long-lived Claude session, --agent team-workflow:router)
   │  per message: look up topic in the topic→worker registry
   │
   ├─ worker exists for this topic   → SendMessage(worker, raw message)
   └─ no worker for this topic       → Agent(worker, ...) + register it
   │
   ▼
WORKER  (one long-lived agent per active topic)
   │  classify the message → act:
   │
   ├─ answer    → reply via Slack tool (inline, cheap)
   ├─ ask       → reply asking confirmation; remember the pending ask
   │              in its own context (it is long-lived for this topic)
   └─ dispatch  → run /session → start-lead.sh  (hands off to lead)
   │
   ▼
LEAD  (unchanged — the existing per-feature orchestrator)
```

### Why this keeps the router context bounded

The router's only state is the registry: `topic → worker handle`. That
is exactly the growth axis the user asked for — "el contexto de router
no crezca más allá de las sesiones/hilos que maneja". The router does
**no classification, no file reading, no drafting**. Per message its
footprint is: one registry lookup + one tool call (`SendMessage` or
`Agent`). Entries leave the registry when a worker is evicted (idle).

### Why this removes agent-boot per message

The worker is **per topic**, not per message. A burst of 10 messages in
one thread = 1 `Agent()` boot + 9 `SendMessage` calls. The worker's own
conversation *is* the topic's context — no external context file needs
to be read on the hot path, and the `ask → aprobar` sequence is just two
messages to the same live worker, no re-classification.

## The router — near-deterministic dispatcher

`plugins/team-workflow/agents/router.md`. Per inbound message:

1. **Extract the topic** from the message metadata (deterministic, same
   rule as today: `<channel>:*:<thread_ts>` when `thread_ts` present,
   else `DM:<user>`).
2. **Look it up** in the in-context registry.
   - **Hit** → `SendMessage(to: <worker handle>, message: <raw text +
     thread metadata>)`. Done. The router does not read the message
     content — it forwards it verbatim.
   - **Miss** → `Agent(subagent_type: worker, name: <topic-derived>,
     run_in_background: true, prompt: <raw text + topic + seed context>)`.
     Record `topic → name` in the registry.
3. **Nothing else.** No reply drafting, no classification. The worker
   owns the conversation from here.

The only non-mechanical judgment the router ever makes: deriving a
stable `name` for a new worker from the topic. Everything else is a
lookup and a forward.

### Eviction

A worker idle for N minutes is dropped from the registry (and its
process ended). Its standing context is persisted to the MCP context
file (below) so a future message on the same topic re-seeds a fresh
worker. Eviction is the only thing that shrinks the router's context.

## The worker — per-topic conversational agent

New: `plugins/team-workflow/agents/topic-worker.md`. One instance per
active topic, long-lived, addressed by `SendMessage`. It holds the
topic's conversation in its own context, so it needs no external state
on the hot path.

Per message it receives, it classifies into `answer` / `ask` /
`dispatch` and acts:

- **`answer`** — reply inline via the Slack tool. Quick lookups allowed
  (≤3 small reads); deep multi-file research → delegate to
  `Agent(Explore)` and forward the ≤200-word report.
- **`ask`** — reply asking for confirmation; it simply remembers the
  pending ask in its own running context (it is alive for this topic, so
  no file needed). A later "aprobar" is the next message to the same
  worker — it resolves it directly.
- **`dispatch`** — run `/session` (→ `start-lead.sh`) to hand the
  feature off to a `lead`. After dispatch the worker stays alive for
  the topic but the `lead` owns the feature thread.

The deterministic-classification *guidance* (imperative-verb regex,
explicit dispatch phrases, env-op patterns, status patterns) lives in
the worker's body as a decision table — it is the worker that applies
it. We do not push it into the daemon.

## Per-topic context store — cold-start seed only

Owned via MCP tools (`remember_context` / `forget_context`), NOT read on
the hot path.

```
$HOME/.claude/team-workflow/context/
  threads/<channel_id>-<thread_ts>.md
  channels/<channel_id>.md
  dms/<user_id>.md
```

Purpose narrowed: this is the **seed** a freshly-spawned worker reads
*once on boot* (and the **eviction target** where a dying worker's
standing context is written). While a worker is alive, the live worker
*is* the context — the file is not consulted. This keeps it off the hot
path entirely.

File format: frontmatter (`scope`, `key`, `updated`, optional
`default_repo`) + ≤1KB free-text gist. No `pending_ask` field needed —
a live worker remembers its own pending ask; an evicted-then-revived
topic simply re-asks if needed.

## Concurrency

- **Across topics** — different workers, fully parallel.
- **Within a topic** — the same worker; `SendMessage` calls to one
  worker are processed in order. Serialization is implicit, no locks.

## Codebase changes

| Area | Change |
|------|--------|
| `plugins/slack-bridge/**` | **No change.** Daemon stays pure transport. Only addition: optional MCP tools `remember_context` / `forget_context` in `handlers/` — file CRUD, no team logic. |
| `plugins/team-workflow/agents/router.md` | Rewritten as the **near-deterministic dispatcher**: topic lookup → `SendMessage` or `Agent()`. No classification, no Slack drafting. |
| `plugins/team-workflow/agents/topic-worker.md` | **New.** Per-topic conversational agent: classify → answer / ask / dispatch. Holds topic context in its own session. |
| `plugins/team-workflow/skills/router/` | Unchanged — still boots the long-lived router session. |
| `CLAUDE.md` / `AGENTS.md` | Document the 3-role model: router (dispatcher) → worker (per-topic) → lead (per-feature). |

## Open questions

1. **Worker eviction policy** — fixed idle timeout, or LRU cap on the
   number of live workers? Who runs the timer — the router itself
   (a periodic self-check) or a lightweight harness mechanism?
2. **Registry durability** — the registry lives in the router's context.
   If the router session restarts, it is lost. Acceptable (workers
   re-spawn lazily on next message), or do we persist `topic → name` to
   a file the router reads on boot?
3. **`remember_context` writers** — operator + `lead` on feature close.
   Does the worker write its own gist on eviction, and if so, how is
   "I am being evicted" signalled to it?
4. **Worker ↔ lead overlap** — once a worker dispatches a `lead`, both
   are subscribed to the topic. Confirm the existing specificity
   pre-emption in `registry.ts` already routes follow-ups to `lead`.

## What this spec deliberately does NOT change

- `slack-bridge` daemon — pure transport, untouched.
- `lead` / `start-lead.sh` / the four invariants — untouched.
- The worktree / PR / security flow — untouched.
