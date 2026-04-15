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
│   └── marketplace.json
├── agents/                      # Stack-agnostic agent definitions
├── skills/                      # Reusable Claude Code skills
├── plugins/                     # Nested Claude plugins (workspace packages)
│   ├── slack-bridge/            # Self-contained: src/, dist/, .mcp.json
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .mcp.json            # Points at ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js
│   │   ├── package.json         # @ia-tools/slack-bridge
│   │   ├── src/                 # Daemon + MCP server (TypeScript)
│   │   └── dist/                # Committed build output (shipped to marketplace)
│   └── team-workflow/
├── biome.json                   # Lint + format config (TS/JS/JSON)
├── .pre-commit-config.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Workspace

TypeScript packages live under `plugins/*` and are wired through `pnpm-workspace.yaml`. Today the only workspace package is `plugins/slack-bridge` (`@ia-tools/slack-bridge`). Its build output (`plugins/slack-bridge/dist/mcp-server.js`) is referenced from the plugin's own `.mcp.json` via `${CLAUDE_PLUGIN_ROOT}`, so the plugin is fully self-contained and ships prebuilt. Staleness between `src/` and `dist/` is enforced by `scripts/check-slack-bridge-dist.sh`, which runs as a prebuild check and in CI.

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
