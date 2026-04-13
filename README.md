# ia-tools

Centralized AI toolbox for development teams. Ships shared Claude Code agents, skills, and the Slack bridge MCP server as a single plugin.

## Quick Start

```bash
pnpm install            # install workspace deps (Biome + slack-bridge)
pnpm build              # build TypeScript packages
pre-commit install      # set up commit-msg + pre-commit hooks
```

## Structure

```
.
├── .claude-plugin/
│   ├── plugin.json              # Root ia-tools plugin manifest
│   └── plugins/
│       └── slack-bridge/        # Nested Claude plugin
│           ├── plugin.json
│           └── .mcp.json        # Points at src/mcp-servers/slack-bridge/dist/mcp-server.js
├── agents/                      # Stack-agnostic agent definitions
├── skills/                      # Reusable Claude Code skills
├── src/
│   └── mcp-servers/             # pnpm workspace: standalone MCP servers
│       └── slack-bridge/        # Slack daemon + MCP server (TypeScript)
├── biome.json                   # Lint + format config (TS/JS/JSON)
├── .pre-commit-config.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Workspace

TypeScript packages live under `src/mcp-servers/*` and are wired through `pnpm-workspace.yaml`. Today the only package is `src/mcp-servers/slack-bridge`. Its build output (`dist/mcp-server.js`) is referenced from `.claude-plugin/plugins/slack-bridge/.mcp.json`, which is how the nested Claude plugin exposes the server.

## Linting & Formatting

- **Biome** (TS/JS/JSON): `pnpm lint`, `pnpm lint:fix`, `pnpm format`
- **pre-commit**: whitespace/EOL/JSON/YAML hygiene + Biome + Conventional Commits on `commit-msg`

Install hooks once:
```bash
pre-commit install --install-hooks
```

## Agents & Skills

- `agents/` — 11 stack-agnostic agent definitions (orchestrator, architect, leads, specialists)
- `skills/` — `/worktree`, `/commit`, `/review`, `/pr`, `/deliver`, `/team`, `/ship`, `/sync-docs`, `/pr-review`, `/security-audit`, `/test-generation`

## Cross-CLI Compatibility

- `AGENTS.md` — read natively by Cursor, Windsurf, Copilot, Codex, Amp, Devin
- `CLAUDE.md` — Claude Code specific (imports `AGENTS.md`)
- MCP servers — standard protocol, works across all MCP-compatible tools
