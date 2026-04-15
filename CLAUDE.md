# ia-tools — AI Toolbox for Development Teams

> ## 🚨 PIPELINE IS MANDATORY
>
> **Every change flows through one deterministic pipeline.** No shortcuts,
> no "trivial" edits, no autonomous execution without an approved plan.
>
> 1. **Triage** (main Slack session) classifies the message into `read-only`
>    or `change`. `read-only` → reply inline. `change` → call `/task`.
> 2. **`/task`** spawns a sub-session: worktree + tmux + orchestrator boot.
> 3. **Orchestrator** writes the plan to `.sdlc/tasks.md`, publishes it to the
>    Slack thread, and **BLOCKS on a ✅ reaction**.
> 4. After approval: spec → [architect if API new] → **QA RED** → **stack GREEN**
>    → **security gate** → **`/pr`** → follow-up → self-kill after 2h of thread
>    inactivity.
>
> **Two hooks enforce the rules:**
> - `SessionStart` (`hooks/scripts/session-start.sh`) — injects the triage or
>   orchestrator system prompt based on `IA_TOOLS_ROLE`.
> - `PreToolUse` (`hooks/scripts/enforce-worktree.sh`) — blocks
>   `Edit`/`Write`/`MultiEdit` on protected paths when the current branch is
>   `main`/`master`. If you see `Pipeline violation: you are on main`, run
>   `/worktree init feat/<name>` — the block is intentional.

@AGENTS.md

## About This Repo

Centralized AI ecosystem. Ships shared Claude Code agents, skills, hooks, and
the Slack bridge MCP server as a single plugin. Installed in consumer repos
where it runs the main triage session and spawns task sub-sessions on demand.

## Structure

- `agents/` — 8 stack-agnostic agent definitions (triage, orchestrator, architect,
  backend, frontend, mobile, qa, security)
- `skills/` — Reusable Claude Code skills (task, worktree, commit, review, pr,
  ship, sync-docs, pr-review, security-audit, test-generation)
- `hooks/` — SessionStart + PreToolUse enforcement scripts
- `src/mcp-servers/*` — pnpm workspace with standalone MCP servers (today:
  `slack-bridge`)
- `.claude-plugin/plugin.json` — Root Claude Code plugin manifest
- `.claude-plugin/plugins/*` — Nested Claude plugins; each one owns its
  `plugin.json` + `.mcp.json`

## Session model

Every Claude session in this plugin is **either** a triage main session **or**
a task sub-session. The switch is one env var:

| `IA_TOOLS_ROLE` | Role | System prompt injected by SessionStart hook |
|-----------------|------|---------------------------------------------|
| unset           | triage | `agents/triage.md` |
| `orchestrator`  | orchestrator | `agents/orchestrator.md` |

The main session starts with no env var → triage. `/task` spawns tmux with
`IA_TOOLS_ROLE=orchestrator` → orchestrator. No other roles exist.

## Development

- Install deps: `pnpm install`
- Build TS: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint/format (Biome): `pnpm lint`, `pnpm lint:fix`, `pnpm format`
- Git hooks: `pre-commit install` (enforces Biome, JSON/YAML hygiene, and
  Conventional Commits on `commit-msg`)

## MCP Servers

The Slack bridge is a self-contained Claude plugin at `plugins/slack-bridge/`.
Its `.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js`, and the
plugin's own `package.json` / `tsconfig.json` / `src/` / `dist/` all live inside
that directory. The built `dist/` is committed so marketplace consumers don't
need a build step; `scripts/check-slack-bridge-dist.sh` enforces it stays in
sync with the sources. Running the bridge requires the daemon
(`pnpm --filter @ia-tools/slack-bridge daemon`) and
`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env vars.

## Skills

- `/task` — Open a task sub-session linked to a Slack thread. Called exclusively
  by triage when it classifies a message as `change`. Creates the worktree,
  seeds `.sdlc/tasks.md`, spawns tmux + Claude with the orchestrator system
  prompt. **Replaces the old `/worktree spawn`.**
- `/worktree` — Git worktree management only (`init`, `list`, `switch`,
  `cleanup`, `status`). No Claude spawning, no Slack subscription.
- `/commit` — Conventional commits: format, stage, commit with soft test
  validation.
- `/review` — Quality gate: formatting, tests, coverage, coding standards.
- `/pr` — Push + PR: invokes `/review`, resolves conflicts, creates PR with
  architecture diagrams.
- `/ship` — PR review request: waits for CI, notifies Slack channel.
- `/sync-docs` — CLAUDE.md synchronization: detects and fixes documentation
  drift.
- `/pr-review`, `/security-audit`, `/test-generation` — Specialized helpers
  used by sub-session agents.

## Parallel Development

Uses `git worktree` to maintain multiple active tasks simultaneously. Each
task sub-session has its own worktree under `.worktrees/` (gitignored) and its
own tmux window. See `/worktree` skill and `AGENTS.md` for workflow details.
