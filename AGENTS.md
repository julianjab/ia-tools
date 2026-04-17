# Agent Team — ia-tools

This file defines the agent roster and the invariants for the ia-tools
ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and
Devin. Claude Code imports it via `@AGENTS.md` in `CLAUDE.md`.

## Session model — main vs sub

The ia-tools plugin runs in **two distinct Claude Code session modes**, driven
by the `IA_TOOLS_ROLE` env var and injected by the `SessionStart` hook:

```
┌─────────────────────────────────────────────────────────┐
│ MAIN SESSION  (IA_TOOLS_ROLE unset → session-manager)   │
│ - Always alive, listens to Slack DMs + subscribed chans │
│ - System prompt: agents/session-manager.md              │
│ - Tool whitelist: read-only (Read/Grep/Glob/Bash-ro)    │
│ - Classifies every message into 5 intents:              │
│     read-only       → reply inline in the thread        │
│     trivial-config  → Agent(orchestrator), no branch    │
│     small-change    → branch + Agent(orchestrator)      │
│     scope-check     → /scope-check → verdict → route    │
│     change          → /session → spawn sub-session      │
│ - NEVER plans, NEVER edits without delegating           │
└─────────────────────────────────────────────────────────┘
         │ /scope-check (inline, no tmux)    │ /session
         ▼                                   ▼
┌──────────────────────┐     ┌───────────────────────────────────────────┐
│ SCOPE-CHECK (inline) │     │ SUB-SESSION  (IA_TOOLS_ROLE=orchestrator) │
│ orchestrator subagent│     │ - One per Slack thread / session          │
│ mode=scope-check     │     │ - System prompt: agents/orchestrator.md   │
│ Writes:              │     │ - Standard: dedicated worktree + tmux     │
│   .sessions/         │     │ - Resume-from (--resume-from):            │
│     scope.md         │     │   CWD = consumer repo root; orchestrator  │
│     plan-draft.md    │     │   creates N worktrees, assigns each to a  │
│     verdict.json     │     │   stack teammate                          │
│ Returns verdict JSON │     │ - Main-thread agent: team lead            │
└──────────────────────┘     │ - Subscribed to one Slack thread (slack)  │
                             └───────────────────────────────────────────┘
```

A Claude session is either a session-manager main session or a sub-session.
`IA_TOOLS_ROLE` is the only switch.

## Invariants — not negotiable

The orchestrator used to execute a fixed 11-phase pipeline. As of the
agent-teams refactor, it is a **team lead** that decides at runtime which
teammates to spawn, in what order, and with what parallelism. The only
workflow rules that remain hardcoded are these four:

1. **Approval gate.** Every change-intent message goes through plan →
   approval (✅ in slack, `Aprobar` in local) before any code changes.
   No autonomous execution of the plan.
2. **QA writes tests first.** No stack teammate (`backend`, `frontend`,
   `mobile`) leaves plan mode until `qa` reports `✅ RED confirmed` on
   the shared task list. Enforced via: (a) `blockedBy: qa:red` on every
   stack task, (b) spawning stack teammates with plan approval mode.
3. **Security APPROVED required per PR (once per touched consumer repo).**
   `security` must return `APPROVED` for each PR before it is opened.
   In multi-repo mode: security runs once per teammate worktree, BEFORE
   that teammate runs `/pr`. `HIGH`/`MEDIUM` findings are blocking and
   escalate to the user. `LOW`-only findings pass through as PR comments.
4. **`/pr` is the only path to main — per repo.** No `git push origin main`,
   no local merges, no amended commits on a remote-tracked branch.
   In multi-repo tasks: N PRs (one per touched consumer repo). Each PR
   goes through its own security gate. Single-repo tasks still produce
   one PR.

Everything outside these four rules — which teammates to spawn, whether
to parallelize, whether `architect` is needed, whether `security` runs
as a teammate or a one-shot — the orchestrator decides in runtime based
on the approved plan.

## Workflow shape

```
Slack message arrives
    ↓
SESSION-MANAGER classifies (main session)
    ├─ read-only → reply inline in the thread. DONE.
    ├─ trivial-config → Agent(orchestrator) inline. DONE.
    ├─ small-change → branch + Agent(orchestrator) inline. DONE.
    │
    ├─ scope-check → /scope-check (inline, no tmux)
    │                    ↓
    │               verdict = read-only  → reply inline. DONE.
    │               verdict = inline     → downgrade to small-change/trivial-config.
    │               verdict = new-session
    │                    ↓
    │               CONFIRMATION GATE (unless explicit session-open phrase)
    │                    ↓
    │               /session --resume-from <sessions_dir>
    │
    └─ change → /session → worktree + tmux + orchestrator boot
                 ↓
             (both change and scope-check/new-session converge here)
                 ↓
             PLAN (orchestrator)
               - resume-from: reads plan-draft.md from sessions_dir as seed
               - single-repo: writes .sdlc/tasks.md from scratch
               both: publish plan + BLOCK on approval gate
                 ↓
             APPROVAL GATE ← ✅ / ❌ / text-edit / timeout
                 ↓
             SPEC (.sdlc/specs/REQ-NNN/requirement.md + research.md)
                 ↓
             DECIDE DELEGATIONS: orchestrator picks teammates, creates
             the agent team. In multi-repo mode, orchestrator creates one
             worktree per target repo via /worktree init --repo <path>, then
             assigns each worktree to a stack teammate. Task dependencies:
               qa:red BLOCKS every stack:* task
               stack:* GREEN (no PR yet) BLOCKS security:audit (per worktree)
               security:audit APPROVED BLOCKS pr:open (per worktree)
                 ↓
             TEAM RUNS (each stack teammate works in its assigned worktree;
             orchestrator runs security per worktree before /pr;
             N PRs open in sequence; orchestrator writes prs.md)
                 ↓
             DONE SUMMARY → all N PR URLs reported
                 ↓
             FOLLOW-UP (orchestrator stays alive; each fix re-enters
             the team via new tasks with the same dependency shape)
                 ↓
             CLEAN UP TEAM + exit (slack: auto after 2h idle + terminal
             PR; local: on user request)
```

## End-to-end example — lahaus multi-repo task

**Scenario**: "agrega tracking de pagos que se refleje en la app y el backend"
touching `backend/python/subscriptions` (new endpoint) and `mobile/ai-mobile-app`
(new UI screen).

```
User DM: "agrega tracking de pagos que se refleje en la app y el backend"
    ↓
session-manager: intent = scope-check
    ↓
/scope-check --description "agrega tracking..."
    → orchestrator (inline, scope-check context)
    → writes .sessions/feat-payment-tracking/{scope.md, plan-draft.md, verdict.json}
    → returns verdict = new-session, touched_repos = [subscriptions, ai-mobile-app]
    ↓
session-manager: confirmation gate
    reply: "El análisis detectó cambios en 2 repos:
            - backend/python/subscriptions (POST /payments)
            - mobile/ai-mobile-app (UI de tracking)
            ¿Abro sesión? ✅ para continuar."
    ↓
User confirms (✅ reaction or text reply)
    ↓
/session feat-payment-tracking
         --resume-from /lahaus/.sessions/feat-payment-tracking
         --thread <ts-of-confirmation> --channel <channel>
    ↓
start-session.sh: resume-from mode
  - skips worktree creation
  - orchestrator CWD = /lahaus/
  - writes /lahaus/.claude/settings.local.json
    (IA_TOOLS_SESSION_DIR=<sessions_dir>)
    ↓
ORCHESTRATOR (resume-from mode)
  reads plan-draft.md → expands → publishes plan → APPROVAL GATE
    ↓
APPROVAL (✅)
    ↓
SPEC → DELEGATE
  orchestrator creates worktrees:
    /worktree init feat/payment-tracking --repo /lahaus/backend/python/subscriptions
    /worktree init feat/payment-tracking --repo /lahaus/mobile/ai-mobile-app
  orchestrator creates team: qa, backend, mobile
  backend receives: "Work in /lahaus/backend/python/subscriptions/.worktrees/feat-payment-tracking"
  mobile receives:  "Work in /lahaus/mobile/ai-mobile-app/.worktrees/feat-payment-tracking"
    ↓
qa writes RED tests → ✅ RED confirmed
    ↓
backend + mobile (unblocked, parallel):
  each /worktree init feat/payment-tracking --repo <target_repo>
  each implement + tests GREEN (local, PR not yet opened)
    ↓
SECURITY (per teammate, before /pr):
  orchestrator → Agent(security, worktree_path=backend-worktree) → APPROVED
  orchestrator → tells backend to run /pr
  orchestrator → Agent(security, worktree_path=backend-worktree) → APPROVED
  orchestrator → tells backend to run /pr
  backend opens PR #123 in subscriptions, reports URL to orchestrator
  orchestrator → writes prs.md entry for PR #123
  orchestrator → Agent(security, worktree_path=mobile-worktree) → APPROVED
  orchestrator → tells mobile to run /pr
  mobile opens PR #456 in ai-mobile-app, reports URL to orchestrator
  orchestrator → writes prs.md entry for PR #456
    ↓
DONE SUMMARY:
  ✅ 2 PRs opened:
    - https://github.com/lahaus/subscriptions/pull/123 (backend)
    - https://github.com/lahaus/ai-mobile-app/pull/456 (mobile)
```

Key points:
- **Two PRs** opened (one per touched consumer repo)
- **Two security passes** (one per worktree, before each `/pr`)
- **Orchestrator** creates both worktrees and writes `prs.md` — stack agents focus only on implementation
- Single-repo consumers route to `change` directly; no scope-check, no `.sessions/`

## Team Structure — 8 agents

| Agent          | File                    | Primary mode                              | Model  | Color  | Why that mode                                                                 |
|----------------|-------------------------|-------------------------------------------|--------|--------|-------------------------------------------------------------------------------|
| `session-manager` | `agents/session-manager.md` | main-thread subagent               | sonnet | cyan   | Router, single session, no parallelism needed.                                |
| `orchestrator` | `agents/orchestrator.md`| main-thread subagent + **team lead**      | opus   | purple | Only session allowed to spawn specialists + create the team.                  |
| `architect`    | `agents/architect.md`   | one-shot subagent (optional teammate)     | opus   | orange | Produces a single `api-contract.md` and exits.                                |
| `qa`           | `agents/qa.md`          | **teammate**                              | sonnet | yellow | Persistent context across RED → verify GREEN → re-test follow-ups.            |
| `backend`      | `agents/backend.md`     | **teammate**                              | sonnet | green  | Own slice of files; iterative GREEN cycles benefit from persistent context.   |
| `frontend`     | `agents/frontend.md`    | **teammate**                              | sonnet | blue   | Same.                                                                         |
| `mobile`       | `agents/mobile.md`      | **teammate**                              | sonnet | pink   | Same.                                                                         |
| `security`     | `agents/security.md`    | one-shot subagent (optional teammate)     | opus   | red    | Gate before `/pr`. Fresh context per invocation reduces anchoring bias.       |

All 6 non-main agents carry `memory: project` so they accumulate project
patterns across tasks in `.claude/agent-memory/<agent>/`.

**Removed in the April 2026 reorganization:** `issue-refiner`, `backend-lead`,
`frontend-lead`, `mobile-lead`, `api-agent`, `domain-agent`, `ui-agent`,
`mobile-agent`. Their responsibilities were collapsed into the 8 above.

**Removed in the agent-teams refactor:** the fixed `Phase 2..11` pipeline in
`orchestrator.md`. Replaced by the four invariants listed above plus runtime
team-lead decisions.

## Plugin frontmatter limitations

`ia-tools` ships as a Claude Code plugin (`.claude-plugin/plugin.json`).
Two documented limitations affect every agent file in this repo:

1. **Plugin subagents ignore `hooks`, `mcpServers`, and `permissionMode`.**
   These three frontmatter fields are silently dropped when an agent is
   loaded from a plugin. We do not set them in any agent file. Enforcement
   that would normally use them has been moved to:
   - **Tool allowlists** (`tools:` field) — the only plugin-enforceable
     capability restriction.
   - **Body instructions** — the agent is told what not to do; compliance
     is convention, not enforcement.
   - **`settings.json` at the plugin / consumer level** — hooks that need
     to fire go here (out of scope for this PR).
   Consumers who need `PreToolUse` hooks or `permissionMode: plan` must
   copy the relevant agent file into their own `.claude/agents/`.

2. **Teammates ignore `skills:` and `mcpServers:`.** When a subagent
   definition runs as a teammate (agent teams), those two fields are
   dropped. Skill preload that would happen via frontmatter is done
   instead by instructing the agent body to invoke the skill on boot
   (see `qa.md` and `security.md`). MCP servers must be configured at
   the session level.

Fields that DO work in plugin agents: `name`, `description`, `tools`,
`disallowedTools`, `model`, `maxTurns`, `memory`, `background`, `effort`,
`isolation`, `color`, `initialPrompt`, `skills` (as subagent, not as
teammate).

## Parallel development with git worktrees

Single-repo sessions: the orchestrator lives in its own worktree under
`.worktrees/<dir-name>`.

Multi-repo sessions: the orchestrator runs in the consumer repo root (no dedicated
worktree). The orchestrator creates one worktree per target repo via
`/worktree init <branch> --repo <target_repo>`, then assigns each to a stack teammate.

Worktrees are created by `/worktree init` (local-only) or `/session` (Slack-linked).

- **Committing**: `/commit` works identically inside worktrees.
- **Quality checks**: `/review` validates formatting, tests, coverage, standards.
- **PRs**: `/pr` runs `/review --fix` before pushing, then opens the PR.
- **Reviews**: `/worktree init --review 42` or `/session review/pr-42 --review 42 …`.
- **Cleanup**: `/worktree cleanup --merged` removes merged worktrees.
- **Overview**: `/worktree status` for all active worktrees.

Each sub-session's worktree has its own `.claude/settings.local.json` generated by
`start-session.sh`. That file forces `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
so agent teams are available, and disables
`slack@claude-plugins-official` (which conflicts with `slack-bridge`). The
worktree does NOT inherit the repo root's `.claude/` directory.

## Consumer `.gitignore` guidance

Consumer repos should add the following to their root `.gitignore`:

```
.worktrees/
.sessions/
```

- **`.worktrees/`** — git worktrees created by `/worktree init` and `/session`. These
  are ephemeral per-session isolation; never committed.
- **`.sessions/`** — per-session coordination state created by `/scope-check` and
  `/session --resume-from`. Contains `scope.md`, `plan-draft.md`, `verdict.json`,
  `prs.md`. Never committed; retained after `/pr` for audit; cleaned up
  by `/worktree cleanup` or manually.

`start-session.sh` automatically adds `.worktrees/` to `.gitignore` if missing.
`.sessions/` must be added manually by the consumer repo admin (or done once
per consumer via a setup script).

## Rules — all agents

1. **`session-manager` is the only main session.** No other agent listens to
   DMs or classifies incoming messages. No other agent edits code from the
   main session.
2. **Every change runs through approval.** A one-line doc fix still goes
   through plan → approval → PR. Shortcuts are prohibited.
3. **The plan must be approved before execution.** Orchestrator blocks on
   the approval gate. No autonomous execution of the plan.
4. **Architect is conditional.** It runs only when the plan explicitly
   declares a new or changed API contract. Not for refactors or bug fixes.
5. **QA writes tests first.** No stack teammate leaves plan mode until
   `qa` reports `✅ RED confirmed`. Enforced via task dependencies + plan
   approval mode.
6. **Stack agents never touch each other's code.** `backend` does not
   touch `frontend/`, `frontend` does not touch `mobile/`, etc.
   Cross-stack coordination happens through `api-contract.md`.
7. **Security gate is blocking** for HIGH/MEDIUM findings. LOW-only
   findings pass through as PR comments.
8. **Branch rule.** Nothing merges directly to main. The only path to
   main is via PR. Use `/pr`, never `git push origin main`.
9. **Worktree commands use `-C`.** Always `git -C <worktree-path>` and
   the stack's equivalent path flag for build/test commands. Never `cd` into
   a worktree.
10. **Logs never reach the repo.** `.gitignore` covers `*.log`. If a log
    file appears as untracked, extend `.gitignore` — never stage it.
11. **Plugin is repo-agnostic.** Agents detect the consumer repo's stack
    via `skills/shared/stack-detection.md` rather than hardcoding paths.
    The only paths hardcoded in this plugin are its own (`.sdlc/`,
    `.worktrees/`, `.sessions/`).
12. **Only the team lead cleans up the team.** Teammates never run
    cleanup (per the agent-teams docs, teammate cleanup can leave
    resources in an inconsistent state).
13. **`.sessions/<label>/` is orchestrator-owned.** Only the orchestrator
    reads and writes under `.sessions/`. Stack agents never access it.
14. **N PRs per session.** Multi-repo sessions produce one PR per touched
    consumer repo. Security APPROVED is required per PR before `/pr` runs.
    Single-repo sessions produce one PR.

## Autonomy boundaries

The orchestrator is autonomous **within** the invariants. It is NOT
autonomous across:

- **The approval gate.** Always blocks on ✅.
- **Security HIGH/MEDIUM findings.** Always escalates.
- **Ambiguous merge conflicts.** Always asks before force-push / discard.
- **Spec drift.** If `.sdlc/tasks.md` and actual work diverge, stop and
  report.

Within those boundaries, the orchestrator decides team composition,
parallelism, and dependency ordering without prompting the user.

Session-manager is autonomous on classification, never on execution — it only
replies, calls `/scope-check`, or calls `/session`. It only delegates via `Agent`
to `orchestrator` (for `trivial-config` and `small-change` paths).

## Branch & merge rules

- Implementation happens on feature branches inside worktrees.
- The only path to main is `/pr` → review → merge.
- Agents never run `git push origin main` or `git merge main …`.
- If an agent wakes up on main, the PreToolUse hook in the consumer's
  `settings.json` blocks writes to protected paths. See
  `hooks/scripts/enforce-worktree.sh`.
