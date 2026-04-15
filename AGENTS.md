# Agent Team — ia-tools

This file defines the agent roster for the ia-tools ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and Devin. Claude Code imports it via `@AGENTS.md` in CLAUDE.md.

## Development Pipeline

All work follows this pipeline. No phase begins until the previous one is complete.

```
PHASE 0 — Intake + Assessment  (Orchestrator)
  └─ Input:  any request — raw text, issue URL, Slack message, plain description
  └─ Output: complexity assessment + clarifying questions (max 3)

PHASE 0.5 — Isolation  (Orchestrator → /worktree init or /worktree spawn)
  └─ Input:  task name derived from request
  └─ Output: isolated worktree + feature branch + task list in .sdlc/tasks.md
  ⚠️  BLOCKING — no agent writes code on main. All subsequent phases run inside the worktree.
  ℹ️  /worktree spawn only when engineer explicitly requests Slack-linked async work.

PHASE 1 — Refinement  (Orchestrator → Issue Refiner, only if complex)
  └─ Input:  raw request + initial codebase context
  └─ Output: refined sub-tasks with BDD seeds  [SKIPPED for simple/direct tasks]

PHASE 2 — Specification  (Orchestrator)
  └─ Input:  refined sub-tasks OR direct request (if simple/direct)
  └─ Output: complete BDD scenarios + api-contract.md (if applicable)

PHASE 3 — Tests in RED  (QA Agent)
  └─ Input:  BDD scenarios
  └─ Output: tests written and failing (RED confirmed)
  ⚠️  BLOCKING — nobody implements without RED tests

PHASE 4 — Implementation  (Leads → Specialists, via Agent tool)
  └─ Input:  RED tests
  └─ Output: code that makes the tests pass (GREEN)
  DDD order: Domain Agent → API Agent → UI/Mobile Agent

PHASE 5 — Security gate  (Security Reviewer)
  └─ Input:  GREEN tests
  └─ Output: APPROVED or list of findings
  ⚠️  BLOCKING — no APPROVED means no merge

PHASE 6 — Delivery  (/pr → /ship)
  └─ PR open + CI green + team notification
```

## Team Structure

### Phase 0 — Orchestrator (`agents/orchestrator.md`)

**Always the first agent invoked. No exceptions.**

Receives any request directly from the engineer. Asks up to 3 clarifying questions to assess complexity, then creates the worktree and task list before any spec or implementation. Decides autonomously whether to invoke the Issue Refiner or proceed directly to spec.

Flow: Intake → Worktree → [Issue Refiner if complex] → Spec → QA (RED) → Leads (GREEN) → Security → PR.

### Phase 1 (optional) — Issue Refiner (`agents/issue-refiner.md`)

Invoked by the Orchestrator when task complexity is HIGH. Coordinates deep codebase exploration (Explore agents + Architect + Leads) to produce refined sub-tasks with BDD seeds. Returns output to the Orchestrator — not to the engineer directly.

Skipped for simple or already well-specified tasks.

### Design — Architect (`agents/architect.md`)

Designs API contracts, ADRs, and cross-repo technical specs. Participates in Phase 0 (refinement) and Phase 1 (contracts before implementation). NEVER writes implementation code.

### Leads

- **Backend Lead** (`agents/backend-lead.md`) — owns backend: coordinates QA → Domain → API in the TDD cycle.
- **Frontend Lead** (`agents/frontend-lead.md`) — owns web frontend: coordinates QA → UI Agent.
- **Mobile Lead** (`agents/mobile-lead.md`) — owns mobile: coordinates QA → Mobile Agent.

### Specialists

- **API Agent** (`agents/api-agent.md`) — HTTP layer, controllers, adapters.
- **Domain Agent** (`agents/domain-agent.md`) — domain models, use cases, business rules (DDD).
- **UI Agent** (`agents/ui-agent.md`) — components, composables, stores, styles.
- **Mobile Agent** (`agents/mobile-agent.md`) — native / cross-platform implementation.
- **QA Agent** (`agents/qa-agent.md`) — writes RED tests before implementation; verifies GREEN + coverage. Activated automatically after each spec.
- **Security Reviewer** (`agents/security-reviewer.md`) — final gate before merge; OWASP, secret leaks, permissions. Activated automatically after GREEN.

## Parallel Development with Git Worktrees

Agents use git worktrees to maintain parallel workstreams without context-switching:

- **Starting work**: `/worktree init <branch-name>` creates an isolated directory under `.worktrees/` with its own branch. The main repo stays on `main`.
- **Parallel tasks**: Each task gets its own worktree. An agent can work on `feat/notification-service` while another worktree holds `fix/calendar-bug` — no stash, no checkout.
- **Committing**: `/commit` works identically inside worktrees. The branch is implicit from the worktree.
- **Quality checks**: `/review` validates formatting, tests, coverage, and coding standards.
- **PRs**: `/pr` invokes `/review --fix` before pushing, then creates the PR with diagrams.
- **Reviews**: `/worktree init --review 42` checks out a PR into its own worktree for isolated review.
- **Cleanup**: `/worktree cleanup --merged` removes worktrees for branches already merged.
- **Overview**: `/worktree status` shows all active worktrees, their branches, uncommitted changes, and PR state.
- **Full pipeline**: `/deliver` auto-detects state and orchestrates all skills in sequence.

### Workflow Cadence

```
Any request  → Orchestrator (assess complexity + questions)
             → /worktree init feat/<name>     [always]
             → [Issue Refiner]                [only if complex]
             → Spec + task list
             → QA (RED) → Leads (GREEN) → Security → /pr

Async request → Orchestrator → /worktree spawn feat/<name> --slack-thread <ts> --channel <id>
             → Claude session in tmux, subscribed to Slack thread
             → Spec + task list → QA → Leads → Security → /pr

Multiple tasks → /worktree init feat/task-1  (parallel)
                 /worktree init feat/task-2
                 Both merged → /worktree cleanup --merged
```

## Multi-Agent Mode

Parallelism is handled via the `Agent` tool — each specialist (QA, Domain, API, UI, Mobile, Security) is spawned as a subagent and works inside the same worktree. No tmux multi-pane setup is needed for agents.

For async human-AI collaboration over Slack, use `/worktree spawn` to open a dedicated Claude session in tmux subscribed to a thread (see `/worktree` skill).

## Rules

All agents must:
1. **Orchestrator first, always** — every request goes to the Orchestrator. It decides whether to invoke the Issue Refiner.
2. **Worktree before spec or code** — the Orchestrator creates the worktree immediately after assessing complexity. No spec, no implementation, no file edit touches `main`.
3. **Task list before implementation** — the Orchestrator writes `.sdlc/tasks.md` inside the worktree before delegating to any agent.
4. **spawn only when explicitly requested** — use `/worktree spawn` only when the engineer asks for Slack-linked async work or a long-running task session. Default is `/worktree init`.
5. Search for existing patterns in the codebase before creating new ones.
6. Follow the project's established conventions.
7. Run `/worktree status` when resuming work to understand active context.
6. Run `/review` before requesting a PR to validate quality.
7. Use `/commit` for checkpoint commits (never raw `git commit`) — messages must follow Conventional Commits (enforced by `pre-commit` on `commit-msg`).
8. **Worktree commands use `-C`** — always `git -C <worktree-path>` and `pnpm --dir <worktree-path>` when operating on a worktree. Never `cd` into a worktree directory.

## Autonomy

**The default mode is autonomous execution. Agents do not pause to confirm obvious next steps.**

Interrupt the engineer only when there is a genuine blocker:
- Input is incomplete or ambiguous and cannot be resolved by exploring the codebase
- A conflict between agents that cannot be resolved without a design decision
- Security findings (HIGH or MEDIUM) with no clear fix

Never interrupt for:
- Confirming the next phase of the pipeline — execute it
- Applying fixes whose solution is explicit in the finding
- Reporting progress mid-task — report only at phase boundaries

When in doubt about whether to pause: if the next action is derivable from the issue, the codebase, or the pipeline definition — do it without asking.

## Branch & Merge Rules

**Agents never merge directly to `main`.** The only path to main is via PR.

- Implementation agents commit and push their feature branch, then use `/pr` to create the PR.
- The merge happens when the PR is approved — not before, not manually.
- If an agent is on `main` when it tries to commit: STOP, run `/worktree init` first.

**Log files never reach the repo.** Root `.gitignore` already covers `*.log`. If a log file appears as untracked, add it to `.gitignore` before committing — never stage it.
