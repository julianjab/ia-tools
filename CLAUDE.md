# ia-tools — AI Toolbox for Development Teams

> ## 🚨 INVARIANTS ARE MANDATORY
>
> **Every change flows through four hard invariants.** Everything else is up
> to the orchestrator (acting as agent-team lead) to decide at runtime.
>
> 1. **Approval gate.** `session-manager` classifies Slack messages; `change`
>    and `scope-check/new-session` intents call `/session`, which spawns a
>    sub-session. The orchestrator writes the plan (or expands `plan-draft.md`)
>    and **BLOCKS on ✅** (slack) or the `Aprobar` option (local) before
>    touching any code.
> 2. **QA writes tests first.** No stack teammate leaves plan mode until
>    `qa` reports `✅ RED confirmed`. Enforced via shared task dependencies
>    (`stack:* blockedBy qa:red`) and plan-approval-mode on stack teammates.
> 3. **Security APPROVED required per PR (once per touched consumer repo).**
>    `security` must return `APPROVED` before each PR is opened. The
>    orchestrator runs security once per worktree, BEFORE telling the teammate
>    to run `/pr`. `HIGH`/`MEDIUM` findings are blocking and escalate to the
>    user. `LOW`-only findings pass through as PR comments.
> 4. **`/pr` is the only path to main — per repo.** Never `git push origin main`,
>    never local merges into main. Multi-repo sessions produce N PRs (one per
>    touched consumer repo); each goes through its own security gate.
>
> Outside those four rules, the orchestrator decides at runtime what team
> to spawn, in what order, and with what parallelism — see
> `agents/orchestrator.md`.
>
> **Two hooks enforce the rules:**
> - `SessionStart` (`hooks/scripts/session-start.sh`) — injects the session-manager
>   or orchestrator system prompt based on `IA_TOOLS_ROLE`.
> - `PreToolUse` (`hooks/scripts/enforce-worktree.sh`) — blocks
>   `Edit`/`Write`/`MultiEdit` on protected paths when the current branch is
>   `main`/`master`. If you see `Pipeline violation: you are on main`, run
>   `/worktree init feat/<name>` — the block is intentional.
>
> **Consumer `.gitignore` guidance.** Add these to your consumer repo's root
> `.gitignore`:
> ```
> .worktrees/
> .sessions/
> ```
> `.sessions/` is ephemeral per-session coordination state (scope.md,
> plan-draft.md, prs.md). Never committed. Same category as `.worktrees/`.
>
> **Prerequisite: Claude Code ≥ v2.1.32 with agent teams enabled.** Every
> sub-session spawned by `/session` gets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
> written to `.claude/settings.local.json` by `start-session.sh`, so the
> orchestrator can create and coordinate teams. The same `settings.local.json`
> disables `slack@claude-plugins-official` to avoid conflict with the
> `slack-bridge` MCP shipped by this plugin.

@AGENTS.md

## About This Repo

Centralized AI ecosystem. Ships shared Claude Code agents, skills, hooks, and
the Slack bridge MCP server as a single plugin. Installed in consumer repos
where it runs the main session-manager session and spawns sub-sessions on demand.

## Plugin frontmatter limitations (read before editing `agents/*.md`)

`ia-tools` ships as a plugin. Two Claude Code documentation limits apply:

1. **Plugin subagents ignore `hooks`, `mcpServers`, `permissionMode`.** These
   three frontmatter fields are silently dropped when an agent is loaded
   from a plugin. Do not set them in any `agents/*.md` file in this repo.
   If enforcement is needed, use the `tools:` allowlist (the only
   plugin-enforceable capability restriction), instruct the body, or move
   the rule to `settings.json` at the consumer level.
2. **Teammates ignore `skills:` and `mcpServers:`.** When an agent runs as
   a teammate in an agent team (qa, backend, frontend, mobile by default),
   those two fields are dropped. Skill preload is done instead by having
   the agent body invoke the skill on boot (see `agents/qa.md`,
   `agents/security.md`).

Fields that DO work in plugin agents: `name`, `description`, `tools`,
`disallowedTools`, `model`, `maxTurns`, `memory`, `background`, `effort`,
`isolation`, `color`, `initialPrompt`, `skills` (only when the agent runs
as a one-shot subagent, not as a teammate).

## Structure

- `agents/` — 8 stack-agnostic agent definitions (session-manager, orchestrator,
  architect, backend, frontend, mobile, qa, security). `orchestrator` is a
  main-thread agent that acts as an **agent-team lead**; qa/backend/frontend/mobile
  are its default teammates; architect/security are one-shot subagents by
  default. `session-manager` is the only main session in the plugin.
- `skills/` — Reusable Claude Code skills (task, worktree, commit, review, pr,
  ship, sync-docs, pr-review, security-audit, test-generation)
- `hooks/` — SessionStart + PreToolUse enforcement scripts
- `src/mcp-servers/*` — pnpm workspace with standalone MCP servers (today:
  `slack-bridge`)
- `.claude-plugin/plugin.json` — Root Claude Code plugin manifest
- `.claude-plugin/plugins/*` — Nested Claude plugins; each one owns its
  `plugin.json` + `.mcp.json`

## Session model

Every Claude session in this plugin is **either** a `session-manager` main
session **or** a sub-session. The switch is one env var:

| `IA_TOOLS_ROLE` | Role | System prompt injected by SessionStart hook |
|-----------------|------|---------------------------------------------|
| unset           | session-manager | `agents/session-manager.md` |
| `orchestrator`  | orchestrator    | `agents/orchestrator.md` |

The main session starts with no env var → session-manager. `/session` spawns
tmux with `IA_TOOLS_ROLE=orchestrator` → orchestrator. No other roles exist.

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

- `/session` — Open a sub-session linked to a Slack thread. Called by
  `session-manager` when it classifies a message as `change` or after a
  `scope-check` returns `new-session`. Creates the worktree, seeds
  `.sdlc/tasks.md`, spawns tmux + Claude with the orchestrator system prompt.
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

Uses `git worktree` to maintain multiple active sessions simultaneously. Each
sub-session has its own worktree under `.worktrees/` (gitignored) and its
own tmux window. See `/worktree` skill and `AGENTS.md` for workflow details.
