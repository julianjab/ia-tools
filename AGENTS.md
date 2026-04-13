# Agent Team — ia-tools

This file defines the agent roster for the ia-tools ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and Devin. Claude Code imports it via `@AGENTS.md` in CLAUDE.md.

## Development Pipeline

All work follows this pipeline. No phase begins until the previous one is complete.

```
PHASE 0 — Refinement
  Issue Refiner  ← Explore agents + Architect + Leads
  └─ Input:  problem description (GitHub, Linear, Slack, URL, plain text)
  └─ Output: sub-tasks with BDD seeds + technical context

PHASE 1 — Specification  (Orchestrator)
  └─ Input:  refined sub-task
  └─ Output: complete BDD scenarios + api-contract.md (if applicable)

PHASE 2 — Tests in RED  (QA Agent)
  └─ Input:  BDD scenarios
  └─ Output: tests written and failing (RED confirmed)
  ⚠️  BLOCKING — nobody implements without RED tests

PHASE 3 — Implementation  (Leads → Specialists)
  └─ Input:  RED tests
  └─ Output: code that makes the tests pass (GREEN)
  DDD order: Domain Agent → API Agent → UI/Mobile Agent

PHASE 4 — Security gate  (Security Reviewer)
  └─ Input:  GREEN tests
  └─ Output: APPROVED or list of findings
  ⚠️  BLOCKING — no APPROVED means no merge

PHASE 5 — Delivery  (/pr → /ship)
  └─ PR open + CI green + team notification
```

## Team Structure

### Phase 0 — Issue Refiner (`agents/issue-refiner.md`)

**First agent in the pipeline.** No other agent starts without going through here.

Receives a problem description in any format (GitHub issue, Linear ticket, Slack message, URL, or plain text) and coordinates an exploration team to produce technically refined sub-tasks with BDD seeds. Its output is the input of the Orchestrator.

### Phase 1 — Orchestrator (`agents/orchestrator.md`)

Receives a refined sub-task (with BDD seeds) from the Issue Refiner and converts it into a complete spec following SDD → BDD → TDD. Coordinates all implementation agents. NEVER writes code.

Flow: Architect (contracts) → QA (RED) → Leads (GREEN) → Security → PR.

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
Raw issue      → Issue Refiner → refined sub-tasks with BDD
Sub-task #1    → /worktree init feat/sub-task-1 → Orchestrator → work → /commit → /review → /pr
Sub-task #2    → /worktree init feat/sub-task-2 → Orchestrator → work → /commit → /pr  (parallel)
Both merged    → /worktree cleanup --merged
```

## Multi-Agent Team Mode

Use `/team` to spawn a full development team in tmux. Each agent runs in its own pane with a specialized role, and coding agents get their own worktrees for true parallel development.

Default team: Orchestrator (coordinates) + Backend Lead (implements) + QA (tests + PRs). The orchestrator decomposes tasks and delegates. Leads use `/commit` for checkpoints. QA runs `/review`, creates PRs with `/pr`, and notifies via `/ship`.

All agents use the same skills ecosystem — no raw git commands.

## Rules

All agents must:
1. **Issue Refiner first** — never work on an issue without going through Phase 0.
2. Search for existing patterns in the codebase before creating new ones.
3. Follow the project's established conventions.
4. Use `/worktree init` for new tasks to enable parallel development.
5. Run `/worktree status` when resuming work to understand active context.
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
