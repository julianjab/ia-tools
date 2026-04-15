# Agent Team — ia-tools

This file defines the agent roster and the pipeline for the ia-tools ecosystem.
It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and Devin.
Claude Code imports it via `@AGENTS.md` in `CLAUDE.md`.

## Session model — main vs sub

The ia-tools plugin runs in **two distinct Claude Code session modes**, driven
by the `IA_TOOLS_ROLE` env var and injected by the `SessionStart` hook:

```
┌─────────────────────────────────────────────────────────┐
│ MAIN SESSION  (IA_TOOLS_ROLE unset → triage)            │
│ - Always alive, listens to Slack DMs + subscribed chans │
│ - System prompt: agents/triage.md                       │
│ - Tool whitelist: read-only (Read/Grep/Glob/Bash-ro)    │
│ - Classifies every message into 2 intents:              │
│     read-only → reply inline in the thread              │
│     change    → call /task → spawn sub-session          │
│ - NEVER plans, NEVER edits, NEVER delegates via Agent   │
└─────────────────────────────────────────────────────────┘
                         │ /task
                         ▼
┌─────────────────────────────────────────────────────────┐
│ SUB-SESSION  (IA_TOOLS_ROLE=orchestrator)               │
│ - One per Slack thread / task                           │
│ - System prompt: agents/orchestrator.md                 │
│ - Lives in a dedicated worktree + tmux window           │
│ - Subscribed to exactly one Slack thread                │
│ - Owns the plan → approval → pipeline → PR lifecycle    │
│ - Stays alive after /pr for follow-ups (2h idle timeout)│
└─────────────────────────────────────────────────────────┘
```

There is no third mode. A Claude session is either a triage main session or a
task sub-session. The `IA_TOOLS_ROLE` env var is the only switch.

## Pipeline — deterministic, no shortcuts

Every change-intent message flows through the same fixed pipeline, in order.
No phase skipping, no phase merging, no phase reordering. The only exception
is the architect phase, which is conditional on the plan's `API contract`
field (`none` → skip, `new` / `changed` → invoke).

```
Slack message arrives
    ↓
PHASE 0 — TRIAGE             (triage, main session)
  Input:  raw Slack message (text, URL, DM, etc.)
  Output: classified intent — read-only OR change

    ├─ read-only → reply inline in the thread. DONE.
    │
    └─ change → call /task and forget:
         ↓
PHASE 1 — TASK BOOTSTRAP     (/task skill, run by triage)
  Output: worktree created + .sdlc/tasks.md seeded +
          Slack announcement posted + tmux sub-session
          spawned + boot prompt delivered to orchestrator
    ↓
PHASE 2 — PLAN               (orchestrator, sub-session)
  Output: plan written to .sdlc/tasks.md +
          published to the Slack thread
    ↓
PHASE 3 — APPROVAL GATE      (orchestrator, BLOCKING)
  Wait for ONE of:
    ✅ reaction on the plan message → proceed
    ❌ reaction                      → cancel + exit
    text reply                       → edits, loop back to Phase 2
    2h timeout                       → cancel + exit
    ↓
PHASE 4 — SPEC               (orchestrator)
  Output: .sdlc/specs/REQ-<NNN>/requirement.md
          with acceptance criteria + BDD scenarios
    ↓
PHASE 5 — CONTRACT           (architect, CONDITIONAL)
  Runs only if plan says `api_contract: new` or `changed`.
  Output: api-contract.md in the same REQ folder.
    ↓
PHASE 6 — RED TESTS          (qa)
  Output: failing tests in the repo, confirmed failing
          for the right reason.
    ↓
PHASE 7 — GREEN              (backend / frontend / mobile)
  Output: tests pass, lint clean, typecheck clean.
    ↓
PHASE 8 — SECURITY GATE      (security)
  Output: APPROVED, or HIGH/MEDIUM findings → escalate to user.
    ↓
PHASE 9 — PR                 (/pr skill)
  Output: PR open + URL posted to the Slack thread.
    ↓
PHASE 10 — FOLLOW-UP         (orchestrator, sub-session still alive)
  Handle review comments, CI failures, re-runs.
  Any fix re-enters Phase 6 → 7 → 8 → push.
    ↓
PHASE 11 — SELF-KILL         (orchestrator)
  Triggered by 2 hours of thread inactivity AND PR in
  terminal state. Closes tmux window cleanly.
```

## Team Structure — 8 agents

| Agent | File | Role | Model | Invoked by |
|-------|------|------|-------|------------|
| `triage` | `agents/triage.md` | Main session router. Classifies Slack messages, answers read-only, spawns sub-sessions via `/task`. | sonnet | SessionStart hook (default) |
| `orchestrator` | `agents/orchestrator.md` | Sub-session brain. Plan → approval → pipeline → PR → follow-up → self-kill. | opus | SessionStart hook (when `IA_TOOLS_ROLE=orchestrator`) |
| `architect` | `agents/architect.md` | API contracts + ADRs. Conditional on plan. | opus | orchestrator Phase 5 |
| `qa` | `agents/qa.md` | TDD RED tests + GREEN verification. | sonnet | orchestrator Phases 6 and 7 |
| `backend` | `agents/backend.md` | Backend implementation (DDD layers collapsed). | sonnet | orchestrator Phase 7 |
| `frontend` | `agents/frontend.md` | Web frontend implementation. | sonnet | orchestrator Phase 7 |
| `mobile` | `agents/mobile.md` | Mobile implementation (iOS/Android/cross-platform). | sonnet | orchestrator Phase 7 |
| `security` | `agents/security.md` | Security gate before PR. | opus | orchestrator Phase 8 |

**Removed in the April 2026 reorganization:** `issue-refiner`, `backend-lead`,
`frontend-lead`, `mobile-lead`, `api-agent`, `domain-agent`, `ui-agent`,
`mobile-agent`. Their responsibilities were collapsed into the 8 agents above.

## Parallel Development with Git Worktrees

Every task sub-session lives in its own git worktree under `.worktrees/<dir-name>`.
Worktrees are created by `/worktree init` (local-only) or `/task` (Slack-linked).

- **Committing**: `/commit` works identically inside worktrees.
- **Quality checks**: `/review` validates formatting, tests, coverage, standards.
- **PRs**: `/pr` runs `/review --fix` before pushing, then opens the PR.
- **Reviews**: `/worktree init --review 42` or `/task review/pr-42 --review 42 ...`.
- **Cleanup**: `/worktree cleanup --merged` removes merged worktrees.
- **Overview**: `/worktree status` for all active worktrees.

### Workflow cadence

```
Slack message  → triage classifies
              ├─ read-only: reply inline
              └─ change: /task → worktree init + tmux + orchestrator boot
                         → plan → ✅ approval → spec → [architect?] → qa RED →
                           stack GREEN → security → /pr → follow-up → self-kill

Multiple tasks → N sub-sessions in parallel, each in its own worktree + tmux
                 window, each subscribed to its own Slack thread.
```

## Rules

All agents must:

1. **Triage is the only main session.** No other agent listens to DMs or
   classifies incoming messages. No other agent edits code from the main
   session.
2. **Every change runs the full pipeline.** No shortcuts, no "trivial" edits
   bypassing `/task`. A one-line doc fix goes through plan → approval → PR.
3. **The plan must be approved before execution.** Orchestrator blocks on the
   Slack approval gate with a ✅ reaction. No autonomous execution of the plan.
4. **Architect is conditional.** It runs only when the plan explicitly declares
   a new or changed API contract. Do not invoke it for refactors or bug fixes.
5. **QA writes tests first.** No stack agent (`backend`, `frontend`, `mobile`)
   starts until `qa` reports `✅ RED confirmed`.
6. **Stack agents never touch each other's code.** `backend` does not touch
   `frontend/`, `frontend` does not touch `mobile/`, etc. Cross-stack coordination
   happens through `api-contract.md`.
7. **Security gate is blocking for HIGH/MEDIUM findings.** LOW-only findings
   pass through as PR comments.
8. **Branch rule.** Nothing merges directly to main. The only path to main is
   via PR. Use `/pr`, never `git push origin main`.
9. **Worktree commands use `-C`.** Always `git -C <worktree-path>` and
   `pnpm --dir <worktree-path>`. Never `cd` into a worktree.
10. **Logs never reach the repo.** `.gitignore` already covers `*.log`. If a log
    file appears as untracked, extend `.gitignore` — never stage it.
11. **Plugin is repo-agnostic.** Agents must detect the consumer repo's stack
    via `skills/shared/stack-detection.md` rather than hardcoding paths. The
    only paths hardcoded in this plugin are its own (`.sdlc/`, `.worktrees/`).

## Autonomy boundaries

The orchestrator is autonomous **between phases**. It is NOT autonomous across:

- **The approval gate.** Always blocks on ✅.
- **Security HIGH/MEDIUM findings.** Always escalates to the user.
- **Ambiguous merge conflicts.** Always asks before force-pushing or discarding.
- **Spec drift.** If `.sdlc/tasks.md` and actual work diverge, stop and report.

Within those boundaries, the orchestrator executes phases without prompting the
user for confirmation of "the next step". Once the plan is approved, phases 4
through 9 run autonomously unless a hard blocker appears.

Triage is autonomous on classification, never on execution — it only ever
replies or calls `/task`. It never delegates via the `Agent` tool.

## Branch & Merge Rules

- Implementation happens on feature branches inside worktrees.
- The only path to main is `/pr` → review → merge.
- Agents never run `git push origin main` or `git merge main ...`.
- If an agent wakes up on main, the PreToolUse hook blocks writes to protected
  paths. See `hooks/scripts/enforce-worktree.sh`.
