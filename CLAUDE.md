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
> `plugins/team-workflow/agents/orchestrator.md`.
>
> **Role selection and hook enforcement.**
> - **slack-bridge is a pure I/O transport.** It exposes Slack tools and a
>   short mechanical guide as its `instructions`, but does NOT inject any
>   role prompt and does NOT sniff the parent argv. The persona of the
>   Claude session is whatever the operator selected with
>   `claude --agent <plugin>:<name>`. By convention:
>   - Main session (Slack router): `claude --agent team-workflow:session-manager`
>   - Sub-sessions (executor): `claude --agent team-workflow:orchestrator`
>     (this is what `/session` boots)
>   - No `--agent` flag: Claude runs without a role; only the slack-bridge
>     tools and its short mechanical guide are visible.
>   There is no `SessionStart` hook and no `IA_TOOLS_ROLE` env var.
> - **`PreToolUse` hook** (`plugins/team-workflow/hooks/scripts/enforce-worktree.sh`)
>   blocks `Edit`/`Write`/`MultiEdit` on protected paths when the current
>   branch is `main`/`master`. If you see `Pipeline violation: you are on
>   main`, run `/worktree init feat/<name>` — the block is intentional.
> - **Quality-gate hooks** for agent teams
>   (`plugins/team-workflow/hooks/scripts/{task-created,task-completed,teammate-idle}.sh`)
>   enforce invariants 2 and 3 at task completion / teammate idle time.
>   See AGENTS.md → "Hook-enforced quality gates".
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

## Plugin frontmatter limitations (read before editing `plugins/team-workflow/agents/*.md`)

`ia-tools` ships as a plugin. Two Claude Code documentation limits apply:

1. **Plugin subagents ignore `hooks`, `mcpServers`, `permissionMode`.** These
   three frontmatter fields are silently dropped when an agent is loaded
   from a plugin. Do not set them in any `plugins/team-workflow/agents/*.md` file in this repo.
   If enforcement is needed, use the `tools:` allowlist (the only
   plugin-enforceable capability restriction), instruct the body, or move
   the rule to `settings.json` at the consumer level.
2. **Teammates ignore `skills:` and `mcpServers:`.** When an agent runs as
   a teammate in an agent team (qa, backend, frontend, mobile by default),
   those two fields are dropped. Skill preload is done instead by having
   the agent body invoke the skill on boot (see `plugins/team-workflow/agents/qa.md`,
   `plugins/team-workflow/agents/security.md`).

Fields that DO work in plugin agents: `name`, `description`, `tools`,
`disallowedTools`, `model`, `maxTurns`, `memory`, `background`, `effort`,
`isolation`, `color`, `initialPrompt`, `skills` (only when the agent runs
as a one-shot subagent, not as a teammate).

## Structure

- `plugins/team-workflow/agents/` — 8 stack-agnostic agent definitions (session-manager, orchestrator,
  architect, backend, frontend, mobile, qa, security). `session-manager`
  is the main-session router (load it with
  `claude --agent team-workflow:session-manager`). `orchestrator` is the
  sub-session executor + **agent-team lead** (booted by `/session`); `qa`
  is its default teammate, `architect`/`security` are one-shot subagents.
  `backend`/`frontend`/`mobile` are **fallback** implementers — the
  orchestrator prefers per-repo agents from `<repo>/.claude/agents/`
  when they exist (discovered after `/add-dir <worktree>`), and uses
  `general-purpose` for the Phase-1 pre-analysis pass.
- `plugins/team-workflow/skills/` — Reusable Claude Code skills (session, worktree, commit, review, pr,
  ship, sync-docs, pr-review, security-audit, test-generation, scope-check)
- `plugins/team-workflow/hooks/` — PreToolUse enforcement script (worktree guard)
- `plugins/slack-bridge/` — Self-contained Slack bridge MCP plugin
- `plugins/scaffold/` — Scaffolding/audit/edit skills for agents, skills, MCPs
- `.claude-plugin/marketplace.json` — Marketplace manifest listing the three plugins above

## Session model

Roles are decided by the operator at boot via `--agent <plugin>:<name>`.
slack-bridge does NOT inject a role and does NOT inspect argv. Common
configurations:

| Boot command | Role | Prompt source |
|--------------|------|---------------|
| `claude --agent team-workflow:session-manager` | main router | `plugins/team-workflow/agents/session-manager.md` |
| `claude --agent team-workflow:orchestrator` | sub-session executor (booted by `/session`) | `plugins/team-workflow/agents/orchestrator.md` |
| `claude` (no `--agent`) | unspecialised | none — slack-bridge surfaces only its tools and mechanical lifecycle guide |

The main router is started by the operator (typically once per machine
or as a long-lived tmux window). `/session` launches sub-sessions with
`--agent team-workflow:orchestrator`. Both agent files are normal plugin
agents — the team-workflow plugin loads them via Claude Code's native
agent discovery.

## Development

- Install deps: `pnpm install`
- Build TS: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint/format (Biome): `pnpm lint`, `pnpm lint:fix`, `pnpm format`
- Git hooks: `pre-commit install` (enforces Biome, JSON/YAML hygiene, and
  Conventional Commits on `commit-msg`)

## CI / Release

GitHub Actions enforces build, lint, typecheck, and tests on every PR; releases
are cut by [release-please](https://github.com/googleapis/release-please) on
push to `main`.

- **`.github/workflows/verify.yml`** — runs on every PR and push to `main`.
  Steps: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
  `pnpm build`, drift check + auto-rebuild of `plugins/slack-bridge/dist/`,
  and `scripts/check-slack-bridge-dist.sh`. The `slack-bridge` vitest step
  is currently disabled in the workflow (commented out) until the
  access-control refactor in `Registry.match` lands; see the inline note in
  `verify.yml`.
  When `dist/` drifts on a same-repo PR, the workflow rebuilds and pushes the
  result back to the PR branch as a `chore(slack-bridge): rebuild dist [skip ci]`
  commit so devs don't have to remember `pnpm build` before pushing. Fork PRs
  cannot push back, so the workflow hard-fails them on drift.
- **`.github/workflows/release.yml`** — runs on push to `main`. Uses
  `googleapis/release-please-action@v4` in **manifest mode**:
  - Config: `.github/release-please-config.json`
  - State: `.github/.release-please-manifest.json`
  - Each plugin (`team-workflow`, `slack-bridge`, `scaffold`) versions
    independently. Conventional-commit scopes drive bumps:
    - `feat(slack-bridge): …` → minor bump on `slack-bridge` only
    - `fix(team-workflow): …` → patch bump on `team-workflow` only
    - Commits without a known scope bump no plugin
  - Tags follow `<plugin>-v<x.y.z>` (e.g. `slack-bridge-v0.4.0`); each tag has
    its own GitHub Release + per-plugin `CHANGELOG.md`.
  - `release-please` keeps `<plugin>/.claude-plugin/plugin.json` in sync via
    `extra-files` so consumers always see the released version on the plugin
    manifest.

**Pinning recommendation for consumers.** Consumers should reference a tagged
version of the marketplace clone, e.g. `git fetch --tags && git checkout
slack-bridge-v0.4.0`, rather than tracking `main`. This isolates the consumer
from in-flight changes between releases.

## MCP Servers

The Slack bridge is a self-contained Claude plugin at `plugins/slack-bridge/`,
acting as **pure I/O transport** — no role injection, no argv sniffing.
Its `.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js`, and the
plugin's own `package.json` / `tsconfig.json` / `src/` / `dist/` all live inside
that directory. The built `dist/` is committed so marketplace consumers don't
need a build step; `scripts/check-slack-bridge-dist.sh` enforces it stays in
sync with the sources. Running the bridge requires the daemon
(`pnpm --filter @ia-tools/slack-bridge daemon`) and
`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env vars. The router agent
(`session-manager`) lives in `plugins/team-workflow/agents/`; load it
explicitly with `claude --agent team-workflow:session-manager`.

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
