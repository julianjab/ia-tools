# Agent Team — ia-tools

This file defines the agent roster and the invariants for the ia-tools
ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and
Devin. Claude Code imports it via `@AGENTS.md` in `CLAUDE.md`.

## Session model — main vs sub

The ia-tools plugin runs in **two distinct Claude Code session modes**, driven
by the `IA_TOOLS_ROLE` env var and injected by the `SessionStart` hook:

```
┌─────────────────────────────────────────────────────────┐
│ MAIN SESSION  (IA_TOOLS_ROLE unset → triage)            │
│ - Always alive, listens to Slack DMs + subscribed chans │
│ - System prompt: agents/triage.md                       │
│ - Tool whitelist: read-only (Read/Grep/Glob/Bash-ro)    │
│ - Classifies every message into 2 intents:              │
│     read-only → reply inline in the thread              │
│     change    → call /task → spawn sub-session          │
│ - NEVER plans, NEVER edits, NEVER delegates via Agent   │
└─────────────────────────────────────────────────────────┘
                         │ /task
                         ▼
┌─────────────────────────────────────────────────────────┐
│ SUB-SESSION  (IA_TOOLS_ROLE=orchestrator)               │
│ - One per Slack thread / task                           │
│ - System prompt: agents/orchestrator.md                 │
│ - Lives in a dedicated worktree + tmux window           │
│ - Main-thread agent: can spawn subagents + create team  │
│ - Runs as **agent-team lead**                           │
│ - Subscribed to exactly one Slack thread (slack mode)   │
└─────────────────────────────────────────────────────────┘
```

A Claude session is either a triage main session or a task sub-session.
`IA_TOOLS_ROLE` is the only switch.

## Invariants — not negotiable

The orchestrator used to execute a fixed 11-phase pipeline. As of the
agent-teams refactor, it is a **team lead** that decides at runtime which
teammates to spawn, in what order, and with what parallelism. The only
workflow rules that remain hardcoded are these four:

1. **Approval gate.** Every change-intent message goes through plan →
   approval (✅ in slack, `Aprobar` in local) before any code changes.
   No autonomous execution of the plan.
2. **QA writes tests first.** No stack teammate (`backend`, `frontend`,
   `mobile`) leaves plan mode until `qa` reports `✅ RED confirmed` on
   the shared task list. Enforced via: (a) `blockedBy: qa:red` on every
   stack task, (b) spawning stack teammates with plan approval mode.
3. **Security gate before `/pr`.** `security` must return `APPROVED`.
   `HIGH`/`MEDIUM` findings are blocking and escalate to the user.
   `LOW`-only findings pass through as a PR comment.
4. **`/pr` is the only path to main.** No `git push origin main`, no
   local merges, no amended commits on a remote-tracked branch.

Everything outside these four rules — which teammates to spawn, whether
to parallelize, whether `architect` is needed, whether `security` runs
as a teammate or a one-shot — the orchestrator decides in runtime based
on the approved plan.

## Workflow shape

```
Slack message arrives
    ↓
TRIAGE classifies (main session)
    ├─ read-only → reply inline in the thread. DONE.
    │
    └─ change → /task → worktree + tmux + orchestrator boot
                 ↓
             PLAN (orchestrator) → .sdlc/tasks.md + publish
                 ↓
             APPROVAL GATE ← ✅ / ❌ / text-edit / timeout
                 ↓
             SPEC (.sdlc/specs/REQ-NNN/requirement.md + research.md)
                 ↓
             DECIDE DELEGATIONS: orchestrator picks teammates, creates
             the agent team, spawns + assigns tasks with dependencies:
               qa:red BLOCKS every stack:* task
               stack:* BLOCK security:audit
               security:audit BLOCKS pr:open
                 ↓
             TEAM RUNS (teammates work in parallel where possible,
             serialized where dependencies force it)
                 ↓
             SECURITY GATE ← APPROVED / HIGH|MEDIUM escalate / LOW pass
                 ↓
             /pr → push + PR + diagrams
                 ↓
             FOLLOW-UP (orchestrator stays alive; each fix re-enters
             the team via new tasks with the same dependency shape)
                 ↓
             CLEAN UP TEAM + exit (slack: auto after 2h idle + terminal
             PR; local: on user request)
```

## Team Structure — 8 agents

| Agent          | File                    | Primary mode                              | Model  | Color  | Why that mode                                                                 |
|----------------|-------------------------|-------------------------------------------|--------|--------|-------------------------------------------------------------------------------|
| `triage`       | `agents/triage.md`      | main-thread subagent                      | sonnet | cyan   | Router, single session, no parallelism needed.                                |
| `orchestrator` | `agents/orchestrator.md`| main-thread subagent + **team lead**      | opus   | purple | Only session allowed to spawn specialists + create the team.                  |
| `architect`    | `agents/architect.md`   | one-shot subagent (optional teammate)     | opus   | orange | Produces a single `api-contract.md` and exits.                                |
| `qa`           | `agents/qa.md`          | **teammate**                              | sonnet | yellow | Persistent context across RED → verify GREEN → re-test follow-ups.            |
| `backend`      | `agents/backend.md`     | **teammate**                              | sonnet | green  | Own slice of files; iterative GREEN cycles benefit from persistent context.   |
| `frontend`     | `agents/frontend.md`    | **teammate**                              | sonnet | blue   | Same.                                                                         |
| `mobile`       | `agents/mobile.md`      | **teammate**                              | sonnet | pink   | Same.                                                                         |
| `security`     | `agents/security.md`    | one-shot subagent (optional teammate)     | opus   | red    | Gate before `/pr`. Fresh context per invocation reduces anchoring bias.       |

All 6 non-main agents carry `memory: project` so they accumulate project
patterns across tasks in `.claude/agent-memory/<agent>/`.

**Removed in the April 2026 reorganization:** `issue-refiner`, `backend-lead`,
`frontend-lead`, `mobile-lead`, `api-agent`, `domain-agent`, `ui-agent`,
`mobile-agent`. Their responsibilities were collapsed into the 8 above.

**Removed in the agent-teams refactor (this PR):** the fixed `Phase 2..11`
pipeline in `orchestrator.md`. Replaced by the four invariants listed above
plus runtime team-lead decisions.

## Plugin frontmatter limitations

`ia-tools` ships as a Claude Code plugin (`.claude-plugin/plugin.json`).
Two documented limitations affect every agent file in this repo:

1. **Plugin subagents ignore `hooks`, `mcpServers`, and `permissionMode`.**
   These three frontmatter fields are silently dropped when an agent is
   loaded from a plugin. We do not set them in any agent file. Enforcement
   that would normally use them has been moved to:
   - **Tool allowlists** (`tools:` field) — the only plugin-enforceable
     capability restriction.
   - **Body instructions** — the agent is told what not to do; compliance
     is convention, not enforcement.
   - **`settings.json` at the plugin / consumer level** — hooks that need
     to fire go here (out of scope for this PR).
   Consumers who need `PreToolUse` hooks or `permissionMode: plan` must
   copy the relevant agent file into their own `.claude/agents/`.

2. **Teammates ignore `skills:` and `mcpServers:`.** When a subagent
   definition runs as a teammate (agent teams), those two fields are
   dropped. Skill preload that would happen via frontmatter is done
   instead by instructing the agent body to invoke the skill on boot
   (see `qa.md` and `security.md`). MCP servers must be configured at
   the session level.

Fields that DO work in plugin agents: `name`, `description`, `tools`,
`disallowedTools`, `model`, `maxTurns`, `memory`, `background`, `effort`,
`isolation`, `color`, `initialPrompt`, `skills` (as subagent, not as
teammate).

## Parallel development with git worktrees

Every task sub-session lives in its own worktree under `.worktrees/<dir-name>`.
Worktrees are created by `/worktree init` (local-only) or `/task` (Slack-linked).

- **Committing**: `/commit` works identically inside worktrees.
- **Quality checks**: `/review` validates formatting, tests, coverage, standards.
- **PRs**: `/pr` runs `/review --fix` before pushing, then opens the PR.
- **Reviews**: `/worktree init --review 42` or `/task review/pr-42 --review 42 …`.
- **Cleanup**: `/worktree cleanup --merged` removes merged worktrees.
- **Overview**: `/worktree status` for all active worktrees.

Each sub-session's worktree has its own `.claude/settings.local.json` generated by
`start-task.sh`. That file forces `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
so agent teams are available, and disables
`slack@claude-plugins-official` (which conflicts with `slack-bridge`). The
worktree does NOT inherit the repo root's `.claude/` directory.

## Rules — all agents

1. **Triage is the only main session.** No other agent listens to DMs or
   classifies incoming messages. No other agent edits code from the main
   session.
2. **Every change runs through approval.** A one-line doc fix still goes
   through plan → approval → PR. Shortcuts are prohibited.
3. **The plan must be approved before execution.** Orchestrator blocks on
   the approval gate. No autonomous execution of the plan.
4. **Architect is conditional.** It runs only when the plan explicitly
   declares a new or changed API contract. Not for refactors or bug fixes.
5. **QA writes tests first.** No stack teammate leaves plan mode until
   `qa` reports `✅ RED confirmed`. Enforced via task dependencies + plan
   approval mode.
6. **Stack agents never touch each other's code.** `backend` does not
   touch `frontend/`, `frontend` does not touch `mobile/`, etc.
   Cross-stack coordination happens through `api-contract.md`.
7. **Security gate is blocking** for HIGH/MEDIUM findings. LOW-only
   findings pass through as PR comments.
8. **Branch rule.** Nothing merges directly to main. The only path to
   main is via PR. Use `/pr`, never `git push origin main`.
9. **Worktree commands use `-C`.** Always `git -C <worktree-path>` and
   `pnpm --dir <worktree-path>`. Never `cd` into a worktree.
10. **Logs never reach the repo.** `.gitignore` covers `*.log`. If a log
    file appears as untracked, extend `.gitignore` — never stage it.
11. **Plugin is repo-agnostic.** Agents detect the consumer repo's stack
    via `skills/shared/stack-detection.md` rather than hardcoding paths.
    The only paths hardcoded in this plugin are its own (`.sdlc/`,
    `.worktrees/`).
12. **Only the team lead cleans up the team.** Teammates never run
    cleanup (per the agent-teams docs, teammate cleanup can leave
    resources in an inconsistent state).

## Autonomy boundaries

The orchestrator is autonomous **within** the invariants. It is NOT
autonomous across:

- **The approval gate.** Always blocks on ✅.
- **Security HIGH/MEDIUM findings.** Always escalates.
- **Ambiguous merge conflicts.** Always asks before force-push / discard.
- **Spec drift.** If `.sdlc/tasks.md` and actual work diverge, stop and
  report.

Within those boundaries, the orchestrator decides team composition,
parallelism, and dependency ordering without prompting the user.

Triage is autonomous on classification, never on execution — it only
replies or calls `/task`. It never delegates via `Agent`.

## Branch & merge rules

- Implementation happens on feature branches inside worktrees.
- The only path to main is `/pr` → review → merge.
- Agents never run `git push origin main` or `git merge main …`.
- If an agent wakes up on main, the PreToolUse hook in the consumer's
  `settings.json` blocks writes to protected paths. See
  `hooks/scripts/enforce-worktree.sh`.
