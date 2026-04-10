# ia-tools — AI Toolbox for Development Teams

@AGENTS.md

## About This Repo

Centralized AI ecosystem. Contains shared agents, rules, MCP servers, prompts, and evaluations consumed by multiple app repos via symlinks.

## Structure

- `agents/` — Stack-agnostic agent definitions (senior-developer, test-expert) + stack-specific examples in `agents/python/`
- `rules/` — Coding standards (distributed to app repos via symlinks)
- `skills/` — Reusable skills (worktree, commit, review, pr, deliver, team, ship, sync-docs)
- `mcp-servers/` — TypeScript MCP servers (memory, conventions)
- `prompts/` — System prompts and templates per agent
- `evals/` — Quality evaluation datasets and runners (Python)
- `scripts/` — Utilities (sync, memory CLI)

## Development

- MCP servers: `pnpm install && pnpm build` (TypeScript)
- Scripts/evals: `uv sync` (Python)
- Lint TS: `pnpm typecheck`
- Lint Python: `uv run ruff check .`

## MCP Servers

Memory server: `node mcp-servers/memory/dist/index.js`
Conventions server: `node mcp-servers/conventions/dist/index.js`
Slack bridge: `node mcp-servers/slack-bridge/dist/index.js` (requires `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` env vars)

All servers are configured in `.mcp.json` at the project root.

## Skills

- `/worktree` — Parallel development: create/list/switch/cleanup git worktrees
- `/commit` — Conventional commits: format, stage, commit with soft test validation
- `/review` — Quality gate: formatting, tests, coverage, coding standards
- `/pr` — Push + PR: invokes `/review`, resolves conflicts, creates PR with architecture diagrams
- `/deliver` — Smart orchestrator: detects state, invokes the right skills in sequence
- `/team` — Multi-agent: spawns tmux session with specialized agents (orchestrator, backend, QA), each in its own worktree
- `/ship` — PR review request: waits for CI, notifies Slack channel
- `/sync-docs` — CLAUDE.md synchronization: detects and fixes documentation drift

## Parallel Development

Uses `git worktree` to maintain multiple active branches simultaneously. Worktrees are created under `_worktrees/` (gitignored). See `/worktree` skill and `AGENTS.md` for workflow details.

## Rules

All rules in `rules/` use markdown with optional `paths:` frontmatter for context-specific loading. When editing rules, keep them under 150 lines and actionable (not generic).
