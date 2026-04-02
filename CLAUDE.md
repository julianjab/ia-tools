# ia-tools — AI Toolbox for Development Teams

@AGENTS.md

## About This Repo

Centralized AI ecosystem. Contains shared agents, rules, MCP servers, prompts, and evaluations consumed by multiple app repos via symlinks.

## Structure

- `agents/` — 7 subagent definitions (orchestrator, architect, backend, frontend, QA, reviewer, researcher)
- `rules/` — Coding standards (distributed to app repos via symlinks)
- `skills/` — Reusable skills (security-audit, pr-review, test-generation)
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

## Rules

All rules in `rules/` use markdown with optional `paths:` frontmatter for context-specific loading. When editing rules, keep them under 150 lines and actionable (not generic).
