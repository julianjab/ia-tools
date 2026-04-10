# Agent Team — ia-tools

This file defines the agent roster for the ia-tools ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and Devin. Claude Code imports it via `@AGENTS.md` in CLAUDE.md.

## Team Structure

### Orchestrator
- **Role**: Coordinates tasks across specialized agents. Analyzes requests, decomposes into subtasks, delegates to the right agent. NEVER writes code directly.
- **Delegates to**: Architect (design), Researcher (investigation), Backend Engineer (implementation), Frontend Engineer (UI), QA Tester (tests), Code Reviewer (review).
- **Flow**: Research (if ambiguous) → Architecture (if design needed) → Implementation → Testing → Review.

### Architect
- **Role**: System design, technical decisions, trade-offs, ADRs. Evaluates approaches before implementation begins.
- **Focus**: Architecture Decision Records, API design, data modeling, component boundaries.

### Backend Engineer
- **Role**: Implements backend code — APIs, services, adapters, domain models. Stack-agnostic (detects Python, Go, Rust, Node, etc.).
- **Constraints**: Does NOT write tests (delegates to QA). Does NOT make architecture decisions (delegates to Architect). Max 200 lines per new file.

### Frontend Engineer
- **Role**: Implements frontend code — components, composables, stores, styles. Stack-agnostic (detects Vue/Nuxt, React/Next, Svelte, etc.).
- **Constraints**: Does NOT write tests (delegates to QA). Does NOT make architecture decisions (delegates to Architect).

### QA Tester
- **Role**: Generates and runs unit/integration tests. Detects test framework automatically (pytest, vitest, jest, Go testing, Rust #[test], etc.). Verifies coverage.
- **Triggers**: Automatically after any implementation task.

### Code Reviewer
- **Role**: Reviews code and PRs against project standards (loaded from CLAUDE.md + rules/). Checks for bugs, security issues, performance, and adherence to conventions.
- **Triggers**: Automatically after tests pass.

### Researcher
- **Role**: Investigates codebases, documentation, APIs, and external resources before implementation.
- **Triggers**: When there is ambiguity about approach, unfamiliar libraries, or external API integration.

## Parallel Development with Git Worktrees

Agents use git worktrees to maintain parallel workstreams without context-switching:

- **Starting work**: `/worktree init <branch-name>` creates an isolated directory under `_worktrees/` with its own branch. The main repo stays on `main`.
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
Task A arrives  → /worktree init feat/task-a → work → /commit → /review → /pr
Task B (urgent) → /worktree init fix/task-b  → work → /commit → /pr
Task A feedback → /worktree switch feat/task-a → fix → /commit → /pr
Both merged     → /worktree cleanup --merged
```

## Multi-Agent Team Mode

Use `/team` to spawn a full development team in tmux. Each agent runs in its own pane with a specialized role, and coding agents get their own worktrees for true parallel development.

Default team: Orchestrator (coordinates) + Backend (implements) + QA (tests + PRs). The orchestrator decomposes tasks and delegates. Backend uses `/commit` for checkpoints. QA runs `/review`, creates PRs with `/pr`, and notifies via `/ship`.

All agents use the same skills ecosystem — no raw git commands.

## Rules

All agents must:
1. Check `rules/` for coding standards before acting
2. Search for existing patterns in the codebase before creating new ones
3. Follow the project's established conventions
4. Use the memory MCP server to recall previous decisions when available
5. Use `/worktree init` for new tasks to enable parallel development
6. Run `/worktree status` when resuming work to understand active context
7. Run `/review` before requesting a PR to validate quality
8. Use `/commit` for checkpoint commits (never raw `git commit`)
