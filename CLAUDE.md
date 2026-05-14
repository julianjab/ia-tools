# ia-tools — AI Toolbox for Development Teams

> ## 🚨 INVARIANTS ARE MANDATORY
>
> **Every change flows through four hard invariants.** Outside these rules,
> the per-feature `lead` agent decides everything at runtime.
>
> 1. **Approval gate.** `router` forwards each inbound message to its
>    per-topic `topic-worker` (one per Slack thread/channel/DM). The
>    `topic-worker` classifies into `answer` / `ask` / `dispatch`; on
>    `dispatch` it runs `/session`, which spawns a `lead` sub-session.
>    lead publishes a plan and BLOCKS on `aprobar` (Slack text reply) or
>    `AskUserQuestion` (local) before any code change.
> 2. **QA writes tests first.** No `impl:green` task may complete until the
>    matching `qa:red` task is completed AND `state.md` records
>    `✅ RED confirmed for <wt_prefix>`. Enforced via the `TaskCompleted`
>    hook + task `blockedBy` deps.
> 3. **Security APPROVED required per PR (once per touched consumer repo).**
>    Each worktree's `:security` task must record
>    `security: APPROVED for <wt_prefix>` in `state.md` before the same
>    worktree's `:pr` task can complete. HIGH/MEDIUM findings escalate to
>    the user. LOW findings pass through as PR comments.
> 4. **`/pr` is the only path to main — per repo.** No `git push origin main`,
>    no local merges. Multi-repo sessions produce N PRs (one per touched
>    repo); each has its own security gate.
>
> See `plugins/team-workflow/agents/lead.md` for the orchestration body.
>
> **Role selection and hooks.**
> - **slack-bridge is pure I/O transport.** Exposes Slack tools (`reply`,
>   `claim_message`, `subscribe_slack`, etc.) but does NOT inject any role
>   prompt and does NOT sniff argv. The persona of the Claude session is
>   whatever the operator selected with `claude --agent <plugin>:<name>`.
>   Conventional boots:
>   - Main session: `claude --agent team-workflow:router` — a thin
>     dispatcher. Per message: resolve topic → `SendMessage` to the
>     topic's `topic-worker`, or `Agent()` a new one. Never classifies.
>   - Per-topic worker: `team-workflow:topic-worker`, spawned by the
>     router (not boot-launched). One per Slack thread/channel/DM;
>     owns that conversation and classifies its messages.
>   - Sub-session: `claude --agent team-workflow:lead`
>     (booted by `/session` via `start-lead.sh`)
>   - No `--agent`: only slack-bridge tools visible.
>   No `SessionStart` hook, no `IA_TOOLS_ROLE` env var.
> - **`PreToolUse` hook** (`plugins/team-workflow/hooks/scripts/enforce-worktree.sh`)
>   is gitignore-aware: blocks `Edit`/`Write`/`MultiEdit` on tracked files
>   when on `main`/`master`, or on any tracked file outside `.worktrees/*`
>   inside a `lead` session. Edits to gitignored / non-repo files pass.
> - **Quality-gate hooks** for agent teams
>   (`plugins/team-workflow/hooks/scripts/{task-created,task-completed,teammate-idle}.sh`)
>   enforce invariants 2 and 3 at task completion / teammate-idle time.
>   See AGENTS.md → "Hook-enforced quality gates".
>
> **Consumer `.gitignore` guidance.** Add to your consumer repo's root
> `.gitignore`:
> ```
> .worktrees/
> ```
> `/worktree init` auto-adds this on first use. v2 state lives outside
> the repo (`$HOME/.claude/team-workflow/state/<topic-hash>/`), so no
> `.sessions/` entry is needed.
>
> **Prerequisite: Claude Code ≥ v2.1.32 with agent teams enabled.** The
> `start-lead.sh` wrapper exports `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
> on boot so lead can spawn agent-team teammates.

@AGENTS.md

## About This Repo

Centralized AI ecosystem. Ships shared Claude Code agents, skills, hooks,
and the Slack bridge MCP server as a single plugin. Installed in consumer
repos where it runs a main `router` session and spawns
`lead` sub-sessions on demand.

## Plugin frontmatter limitations

`ia-tools` ships as a plugin. Two Claude Code documentation limits apply
to every `plugins/team-workflow/agents/*.md`:

1. **Plugin subagents ignore `hooks`, `mcpServers`, `permissionMode`.**
   These three fields are silently dropped when an agent is loaded from
   a plugin. Don't set them. Use `tools:`/`disallowedTools:` for
   capability gating, the body for behavioral rules, and
   `plugins/team-workflow/hooks/hooks.json` for hooks.
2. **Teammates ignore `skills:` and `mcpServers:`.** Tool inheritance is
   the path. Default to `disallowedTools:` for denial; let everything
   else (including MCP tools) inherit.

Fields that DO work in plugin agents: `name`, `description`, `tools`,
`disallowedTools`, `model`, `maxTurns`, `memory`, `background`, `effort`,
`isolation`, `color`, `initialPrompt`, `skills` (one-shot subagent only,
not teammate).

## Structure

- `plugins/team-workflow/agents/` — plugin agent definitions:
  - `router.md` — main-session dispatcher. Resolves each message's
    topic and forwards it (`SendMessage` to an existing worker, or
    `Agent()` a new one). Runs no classification.
  - `topic-worker.md` — per-topic conversational agent. One per Slack
    thread/channel/DM; classifies its messages into
    `answer` / `ask` / `dispatch` and acts. Spawned by `router`.
  - `lead.md` — per-feature orchestrator (plan, provision, dispatch)
  - `implementer.md` — stack-aware fallback subagent (used when a touched
    repo has no repo-local implementer agent)
  Everything else — qa, security, architect, per-stack implementers — is
  discovered at runtime from each touched repo's `<repo>/.claude/agents/`.
- `plugins/team-workflow/skills/` — Reusable Claude Code skills:
  `router`, `session`, `worktree`, `commit`, `review`, `pr`,
  `team-review`, `sync-docs`, `pr-review`, `security-audit`.
- `plugins/team-workflow/hooks/` — `enforce-worktree.sh` (PreToolUse,
  gitignore-aware), `task-created.sh` / `task-completed.sh` /
  `teammate-idle.sh` (agent-teams quality gates).
- `plugins/slack-bridge/` — Self-contained Slack bridge MCP plugin.
- `plugins/scaffold/` — Scaffolding/audit/edit skills for agents, skills, MCPs.
- `.claude-plugin/marketplace.json` — Marketplace manifest.

## Session model

Roles are decided by the operator at boot via `--agent <plugin>:<name>`.
slack-bridge does NOT inject a role.

| Boot command | Role | Prompt source |
|--------------|------|---------------|
| `claude --agent team-workflow:router` | main dispatcher | `plugins/team-workflow/agents/router.md` |
| _(spawned by `router` via `Agent()`)_ | per-topic worker | `plugins/team-workflow/agents/topic-worker.md` |
| `claude --agent team-workflow:lead` | sub-session orchestrator (booted by `/session`) | `plugins/team-workflow/agents/lead.md` |
| `claude` (no `--agent`) | unspecialised | none — slack-bridge surfaces only its tools |

The 3-role flow: `router` (dispatch) → `topic-worker` (classify + act
per topic) → `lead` (orchestrate a feature). See
`specs/deterministic-router-dispatch.md` for the rationale.

The main router is started by the operator (once per machine, persistent
tmux window). `/session` launches sub-sessions with `--agent
team-workflow:lead`.

## Development

- Install deps: `pnpm install`
- Build TS: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint/format (Biome): `pnpm lint`, `pnpm lint:fix`, `pnpm format`
- Git hooks: `pre-commit install`

## CI / Release

GitHub Actions enforces build, lint, typecheck, and tests on every PR;
releases are cut by [release-please](https://github.com/googleapis/release-please)
on push to `main`.

- **`.github/workflows/verify.yml`** — runs on every PR and push to `main`.
  Steps: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
  `pnpm build`, drift check + auto-rebuild of `plugins/slack-bridge/dist/`,
  and `scripts/check-slack-bridge-dist.sh`. When `dist/` drifts on a
  same-repo PR, the workflow rebuilds and pushes the result back as
  `chore(slack-bridge): rebuild dist [skip ci]`. Fork PRs hard-fail on drift.
- **`.github/workflows/release.yml`** — runs on push to `main`. Uses
  `googleapis/release-please-action@v4` in manifest mode:
  - Config: `.github/release-please-config.json`
  - State: `.github/.release-please-manifest.json`
  - Each plugin (`team-workflow`, `slack-bridge`, `scaffold`) versions
    independently from conventional-commit scopes.
  - Tags `<plugin>-v<x.y.z>` with per-plugin `CHANGELOG.md`.
  - `extra-files` keeps `<plugin>/.claude-plugin/plugin.json` in sync.

**Pinning recommendation for consumers.** Reference a tagged version
(e.g. `git fetch --tags && git checkout team-workflow-v0.4.0`) rather
than tracking `main`.

## MCP Servers

The Slack bridge is a self-contained Claude plugin at
`plugins/slack-bridge/`, acting as **pure I/O transport** — no role
injection, no argv sniffing. Its `.mcp.json` points at
`${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js`. The built `dist/` is committed
so marketplace consumers don't need a build step;
`scripts/check-slack-bridge-dist.sh` enforces it stays in sync.

Running the bridge requires the daemon (`pnpm --filter @ia-tools/slack-bridge
daemon`) and `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env vars. Auto-subscribe
happens at MCP init via the `SLACK_TOPICS` env var (set by
`start-lead.sh`).

## Skills

- `/router` — Boot the always-on `router` router in tmux.
  One per machine. Hides `--dangerously-load-development-channels`
  behind a wrapper. Pass the Slack topic (e.g. `DM:U02M1QFA0AF`).
- `/session` — Spawn a lead sub-session in tmux. Invokes
  `start-lead.sh` with feature label, topic, and request. Used by
  `router` on `dispatch` intent.
- `/worktree` — Git worktree management (`init`, `list`, `switch`,
  `cleanup`, `status`). `init` now auto-runs `/add-dir` via the
  `SlashCommand` tool so repo-local agents are immediately spawnable.
- `/commit` — Conventional commits: format, stage, commit.
- `/review` — Quality gate: formatting, tests, coverage, standards.
- `/pr` — Push + PR: invokes `/review`, resolves conflicts, creates PR.
- `/team-review` — Request team review for an open PR: preflight, wait CI, notify configured Slack channel + reviewers, subscribe to the thread. Config via `settings.local.json` env (`TEAM_REVIEW_CHANNEL`, `TEAM_REVIEW_MENTIONS`).
- `/sync-docs` — CLAUDE.md synchronization across docs.
- `/pr-review`, `/security-audit`, `/test-generation` — Specialized
  helpers used by lead or stack implementers.

## Parallel Development

`git worktree` keeps multiple active features simultaneously. lead
provisions worktrees per touched consumer repo via `/worktree init
<feature> --repo <repo>`. Each worktree lives at
`<repo>/.worktrees/<feature-as-dirname>/` and `.worktrees/` is auto-added
to the repo's `.gitignore`.

See `/worktree` skill and `AGENTS.md` for workflow details.
