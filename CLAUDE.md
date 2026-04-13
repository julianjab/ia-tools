# ia-tools — AI Toolbox for Development Teams

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

- `/worktree` — Parallel development: create/list/switch/cleanup git worktrees
- `/commit` — Conventional commits: format, stage, commit with soft test validation
- `/review` — Quality gate: formatting, tests, coverage, coding standards
- `/pr` — Push + PR: invokes `/review`, resolves conflicts, creates PR with architecture diagrams
- `/deliver` — Smart orchestrator: detects state, invokes the right skills in sequence
- `/team` — Multi-agent: spawns tmux session with specialized agents, each in its own worktree
- `/ship` — PR review request: waits for CI, notifies Slack channel
- `/sync-docs` — CLAUDE.md synchronization: detects and fixes documentation drift

## Parallel Development

Uses `git worktree` to maintain multiple active branches simultaneously. Worktrees are created under `.worktrees/` (gitignored). See `/worktree` skill and `AGENTS.md` for workflow details.
