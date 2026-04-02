# ia-tools

Centralized AI toolbox for development teams. Provides shared agent definitions, coding rules, MCP servers, prompts, and evaluations that multiple application repos consume via symlinks.

## Quick Start

```bash
# Install dependencies
pnpm install && pnpm build  # MCP servers (TypeScript)
uv sync                      # Scripts and evals (Python)

# Sync to an app repo
bin/ia-sync /path/to/your-app
```

## Structure

- `agents/` — 7 shared subagent definitions (orchestrator, architect, backend, frontend, QA, reviewer, researcher)
- `rules/` — Coding standards distributed to app repos
- `skills/` — Reusable Claude Code skills
- `mcp-servers/` — Custom MCP servers (memory, conventions)
- `prompts/` — System prompts and templates
- `evals/` — Agent quality evaluation datasets and runners
- `scripts/` — Utility scripts (sync, memory CLI)

## How App Repos Consume This

```bash
# One-time setup (or use bin/ia-sync)
ln -s ~/ia-tools/agents  .claude/agents/shared
ln -s ~/ia-tools/rules   .claude/rules/shared
ln -s ~/ia-tools/skills  .claude/skills/shared
```

Then in your app's `CLAUDE.md`:
```markdown
@.claude/rules/shared/base.md
@.claude/rules/shared/python.md
```

## Cross-CLI Compatibility

- `AGENTS.md` — Read natively by Cursor, Windsurf, Copilot, Codex, Amp, Devin
- `CLAUDE.md` — Claude Code specific (imports AGENTS.md)
- MCP servers — Standard protocol, works across all MCP-compatible tools
