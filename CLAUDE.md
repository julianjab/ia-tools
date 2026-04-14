# ia-tools — AI Toolbox for Development Teams

> ## 🚨 PIPELINE IS MANDATORY
>
> Any change under `src/`, `agents/`, `skills/`, `scripts/`, or `profiles/` MUST
> go through the pipeline defined in `AGENTS.md`:
>
> 1. `Agent(ia-tools:issue-refiner)` — refine the problem into BDD sub-tasks
> 2. `/worktree init feat/<name>` — create an isolated worktree **before anything else**
> 3. `Agent(ia-tools:orchestrator)` — produce the spec + contract (runs inside the worktree)
> 4. QA writes **RED** tests before any implementation
> 5. Leads/specialists make them **GREEN**
> 6. `Agent(ia-tools:security-reviewer)` — security gate
> 7. `/pr` — open the PR
>
> **This plugin ships a `PreToolUse` hook (`hooks/scripts/enforce-worktree.sh`)
> that BLOCKS `Edit`/`Write`/`MultiEdit` on protected paths when the current
> branch is `main`/`master`.** If you see `Pipeline violation: you are on main`,
> run `/worktree init feat/<name>` — the block is intentional.

@AGENTS.md

## About This Repo

Centralized AI ecosystem. Ships shared Claude Code agents, skills, and the Slack bridge MCP server as a single plugin.

## Structure

- `agents/` — Stack-agnostic agent definitions (orchestrator, architect, leads, specialists)
- `skills/` — Reusable Claude Code skills (worktree, commit, review, pr, deliver, team, ship, sync-docs, …)
- `src/mcp-servers/*` — pnpm workspace with standalone MCP servers (today: `slack-bridge`)
- `.claude-plugin/plugin.json` — Root Claude Code plugin manifest
- `.claude-plugin/plugins/*` — Nested Claude plugins; each one owns its `plugin.json` + `.mcp.json`

## Development

- Install deps: `pnpm install`
- Build TS: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint/format (Biome): `pnpm lint`, `pnpm lint:fix`, `pnpm format`
- Git hooks: `pre-commit install` (enforces Biome, JSON/YAML hygiene, and Conventional Commits on `commit-msg`)

## MCP Servers

The Slack bridge is a nested Claude plugin at `.claude-plugin/plugins/slack-bridge/`. Its `.mcp.json` points at `src/mcp-servers/slack-bridge/dist/mcp-server.js`. It requires the daemon (`pnpm --filter @ia-tools/slack-bridge daemon`) and `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env vars.

## Skills

- `/worktree` — Parallel development: create/list/switch/cleanup/spawn git worktrees; `spawn` opens a Claude session in tmux subscribed to a Slack thread
- `/commit` — Conventional commits: format, stage, commit with soft test validation
- `/review` — Quality gate: formatting, tests, coverage, coding standards
- `/pr` — Push + PR: invokes `/review`, resolves conflicts, creates PR with architecture diagrams
- `/deliver` — Smart orchestrator: detects state, invokes the right skills in sequence
- `/ship` — PR review request: waits for CI, notifies Slack channel
- `/sync-docs` — CLAUDE.md synchronization: detects and fixes documentation drift

## Parallel Development

Uses `git worktree` to maintain multiple active branches simultaneously. Worktrees are created under `.worktrees/` (gitignored). See `/worktree` skill and `AGENTS.md` for workflow details.
