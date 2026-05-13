# Agent Team — ia-tools

This file defines the agent roster and the invariants for the ia-tools
ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and
Devin. Claude Code imports it via `@AGENTS.md` in `CLAUDE.md`.

## Session model — main vs sub

The operator picks the persona at boot via `claude --agent <plugin>:<name>`.
slack-bridge is pure I/O transport — it does NOT inject any role and does
NOT inspect argv.

```
┌────────────────────────────────────────────────────────────┐
│ MAIN SESSION  (claude --agent team-workflow:router)│
│ - Always alive, listens to Slack DMs + subscribed channels  │
│ - Prompt: plugins/team-workflow/agents/router.md   │
│ - Tool inheritance: disallowedTools = Edit/Write/Multi/Note │
│   (everything else inherits, including MCP)                 │
│ - Classifies every message into one of THREE intents:       │
│     answer    → reply inline (with Agent(Explore) if deep)  │
│     ask       → reply with proposed action; wait for OK     │
│     dispatch  → /session → spawn lead sub-session      │
│ - NEVER edits files; only routes                            │
└────────────────────────────────────────────────────────────┘
                              │ /session
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ SUB-SESSION  (claude --agent team-workflow:lead,       │
│   booted by /session via start-lead.sh)                │
│ - One per Slack topic / feature                             │
│ - Prompt: plugins/team-workflow/agents/lead.md         │
│ - Dedicated tmux session, subscribed to the topic           │
│ - Per-repo worktrees provisioned on the fly                 │
│ - State persisted at $HOME/.claude/team-workflow/state/...  │
└─────────────────────────────────────────────────────────────┘
```

No `IA_TOOLS_ROLE` env var, no `SessionStart` hook, no argv-sniffing. Personas
come from `--agent` only.

## Invariants — not negotiable

lead decides at runtime which teammates to spawn, in what order, and
with what parallelism. The four invariants below are the only hardcoded
workflow rules:

1. **Approval gate.** Every change-intent message goes through plan →
   approval (text reply `aprobar` in Slack, `AskUserQuestion` in local)
   before any code changes. No autonomous execution of the plan.
2. **QA writes tests first.** No `impl:green` task may complete until the
   matching `qa:red` task is completed and `state.md` records the marker
   `✅ RED confirmed for <wt_prefix>`. Enforced via `blockedBy: qa:red`
   in the task list and the `TaskCompleted` hook.
3. **Security APPROVED required per PR (once per touched consumer repo).**
   The `security` task must record `security: APPROVED for <wt_prefix>` in
   `state.md` before the `:pr` task can complete. In multi-repo mode:
   security runs once per worktree, BEFORE that worktree's `:pr` task.
   `HIGH`/`MEDIUM` findings escalate to the user; `LOW`-only findings pass
   through as PR comments.
4. **`/pr` is the only path to main — per repo.** No `git push origin main`,
   no local merges, no amended commits on a remote-tracked branch. In
   multi-repo tasks: N PRs (one per touched consumer repo). Each PR goes
   through its own security gate. Single-repo tasks still produce one PR.

Outside these four rules — which teammates to spawn, whether to parallelize,
whether `architect` is needed, whether `security` runs as a teammate or a
one-shot — lead decides at runtime based on the approved plan.

## Workflow shape

```
Slack message arrives
    ↓
ROUTER classifies (main session)
    ├─ answer   → reply inline (Agent(Explore) when deep). DONE.
    ├─ ask      → reply proposing action; wait for 'aprobar' / 'cancelar' / edit text.
    │             on 'aprobar' → re-classify as dispatch.
    └─ dispatch → /session → spawns lead in tmux
                 ↓
             lead boot:
               - reads $IA_TW_TOPIC / $IA_TW_FEATURE / $IA_TW_REQUEST / $IA_TW_STATE_DIR
               - if state.md exists → resumes from recorded phase
               - else → boot guard (list_subscriptions probe), then Plan phase
                 ↓
             PLAN (lead)
               - Agent(general-purpose) for pre-analysis (multi-repo detection,
                 acceptance criteria, repo-local agent discovery)
               - Publish plan to topic (Slack reply or AskUserQuestion locally)
               - BLOCK on aprobar / cancelar / text-edit
                 ↓
             APPROVAL GATE ← aprobar / cancelar / text-edit / timeout
                 ↓
             PROVISION (1..N worktrees)
               - For each touched repo:
                 /worktree init $IA_TW_FEATURE --repo <repo-abs>
                  → init.sh + auto /add-dir (via SlashCommand) ← single contract
                 Glob <worktree>/.claude/agents/*.md → classify into
                 impl/qa/sec/arch buckets, fall back to plugin
                 'implementer' / 'lead' when bucket is empty.
                 Append entry to state.md.
                 ↓
             BUILD TASK LIST (declarative, single pass)
               For each worktree (let P = wt_prefix):
                 P:qa:red       → owner = bucket.qa
                 P:impl:green   → owner = bucket.impl       (blockedBy P:qa:red)
                 P:security     → owner = bucket.sec        (blockedBy P:impl:green)
                 P:pr           → owner = bucket.impl       (blockedBy P:security)
               + optional feature:arch:contract when api_contract != none.
                 ↓
             DISPATCH LOOP (until all tasks completed)
               - Pick lowest-id pending task with deps satisfied.
               - Spawn via Agent() / SendMessage based on owner type.
               - lead does it inline when owner = 'lead'.
                 ↓
             N PRs opened (one per touched repo).
                 ↓
             CLEAN UP team + report (slack: auto after merge + idle;
             local: on user request).
```

## End-to-end example — lahaus multi-repo task

```
User DM (Slack): "agrega un endpoint mock GET /demo en client-api;
                  consúmelo desde mobile/ai-mobile-app en pantalla principal
                  y desde frontend/lh-seller-v2-frontend en un widget del dashboard"
    ↓
router: classify → dispatch (hard signal "agrega")
    - Derives feature name: `feat/demo-api-client-api`
    - Posts ack reply in the thread; captures `<channel>:*:<thread_ts>`.
    - bash start-lead.sh "feat/demo-api-client-api" "<topic>" "<request>"
    ↓
lead booted in tmux 'feat/demo-api-client-api'
    - $IA_TW_TOPIC = D0AMP0P0UKY:*:1778681006...
    - $IA_TW_STATE_DIR = ~/.claude/team-workflow/state/<hash>
    - Boot guard: list_subscriptions → OK
    - state.md created with phase: planning
    - Pre-analysis via general-purpose: 3 repos touched
    ↓
PLAN published to thread; user replies 'aprobar'
    ↓
PROVISION:
    /worktree init feat/demo-api-client-api --repo /lahaus/backend/python/subscriptions
      → /add-dir <wt-backend> → Glob → impl=python-developer, qa=python-unittest-expert
    /worktree init feat/demo-api-client-api --repo /lahaus/mobile/ai-mobile-app
      → /add-dir <wt-mobile>  → Glob → impl=flutter-dev, qa=flutter-test-writer, sec=flutter-reviewer
    /worktree init feat/demo-api-client-api --repo /lahaus/frontend/lh-seller-v2-frontend
      → /add-dir <wt-frontend>→ Glob → impl=vue-dev, qa=vue-test-writer, sec=vue-reviewer
    ↓
TASKS created (12 tasks: 4 per worktree). Dispatch loop runs them in
parallel where deps allow.
    ↓
3 PRs opened (one per repo). state.md final phase = merged.
```

## Team Structure — 3 plugin agents

| Agent             | File                                              | Role                                                     | Model  | Color  |
|-------------------|---------------------------------------------------|----------------------------------------------------------|--------|--------|
| `router` | `plugins/team-workflow/agents/router.md` | Main session router. Classifies + routes; never edits.    | sonnet | cyan   |
| `lead`       | `plugins/team-workflow/agents/lead.md`       | Per-feature orchestrator. Plan, provision, dispatch.      | opus   | purple |
| `implementer`     | `plugins/team-workflow/agents/implementer.md`     | Stack-aware fallback subagent when a repo has no impl.    | sonnet | green  |

Everything else — qa, security, architect, per-stack implementers — is
**discovered at runtime** from each touched repo's `<repo>/.claude/agents/`.
The plugin no longer ships fallback agents per stack; the single
`implementer` covers all stacks via boot-time CLAUDE.md / manifest detection.

`qa` and `security` have no plugin fallback: when a repo lacks them,
lead writes the tests / runs the audit itself (using its `Edit`/
`Write` tools and the `/security-audit` skill respectively). This
preserves the invariants (QA-first + Security-APPROVED before `/pr`)
regardless of repo coverage.

### Repo-local agent discovery

For every worktree provisioned, lead:

1. `/worktree init <branch> --repo <repo>` — provisions the worktree AND
   runs `/add-dir <worktree-abs>` (registered with the active session).
2. Globs `<worktree>/.claude/agents/*.md` and reads each frontmatter
   `name` + `description`.
3. Classifies by name regex:
   - `^(qa|tester)(-.*)?$` → `qa` bucket
   - `^(security|sec-review|sec)(-.*)?$` → `sec` bucket
   - `^(architect|api)(-.*)?$` → `arch` bucket
   - description aligns with worktree `stack` → `impl` bucket
   - else → ignored
4. Picks per bucket:
   - `impl`: first match; else `implementer` (plugin fallback)
   - `qa`:   first match; else `lead` (inline)
   - `sec`:  first match; else `lead` (runs `/security-audit`)
   - `arch`: first match; else `implementer`
5. Persists the choice in `state.md` under the worktree entry.

## Operating mode — coercive in lead

lead reads `$IA_TW_TOPIC` at boot. The result is permanent for the
session and gates all user-facing interaction:

- `IA_TW_TOPIC != "local"` → **Slack mode**. Replies via the channel's
  `reply` tool, always passes back the inbound `thread_ts`. `AskUserQuestion`
  is FORBIDDEN. Boot guard probes the channel via `list_subscriptions`;
  fails loudly if unreachable.
- `IA_TW_TOPIC == "local"` → **Local mode**. `AskUserQuestion` for gates,
  assistant messages for status. Slack tools are not used.

The mode is fixed at boot. lead must not silently downgrade.

## State and persistence

Per-feature state lives outside any repo:

```
$HOME/.claude/team-workflow/state/<topic_hash>/
  state.md          ← YAML frontmatter + plan + worktrees + audit log
  hook-audit.log    ← TaskCreated / TaskCompleted log
  api-contract.md   ← (optional) when api_contract != none
```

- `<topic_hash>` = `sha1(IA_TW_TOPIC)[:12]` or `sha1("local:<feature>")[:12]`.
- Resume: a lead boot that sees an existing `state.md` reads it,
  reconstructs the worktree map, and continues from the recorded phase —
  it does NOT re-run pre-analysis.

## Hook-enforced quality gates

Three plugin hooks turn the invariants from convention into enforced rules.
They live under `plugins/team-workflow/hooks/scripts/` and resolve the
state dir via `$IA_TW_STATE_DIR` (or fall back to a v1 `.sessions/<label>/`
layout during a transition window).

| Hook            | Script                  | Effect                                                                                                          |
|-----------------|-------------------------|-----------------------------------------------------------------------------------------------------------------|
| `TaskCreated`   | `task-created.sh`       | Audit-only — logs each task subject; warns when a stack/pr task is created without a clear `blockedBy` prefix. |
| `TaskCompleted` | `task-completed.sh`     | Blocks (exit 2) `*:pr*` completion when `state.md` lacks `security: APPROVED for <wt_prefix>`; blocks `*:green*` without `RED confirmed for <wt_prefix>`. |
| `TeammateIdle`  | `teammate-idle.sh`      | Blocks `qa` teammates from idling until the transcript contains `RED confirmed`; blocks `security` teammates until verdict.                              |

The hooks scan transcripts and `state.md`; when they cannot reach those
(no state dir), they fall back to allow.

## Plugin frontmatter limitations

`ia-tools` ships as a Claude Code plugin. Two documented limits affect every
agent file:

1. **Plugin subagents ignore `hooks`, `mcpServers`, and `permissionMode`.**
   These three fields are silently dropped. Don't set them; use the
   `tools:`/`disallowedTools:` field for capability gating and the body
   for behavioral rules. Hooks live in `hooks/hooks.json` at the plugin
   level instead.
2. **Teammates ignore `skills:` and `mcpServers:`.** Tool inheritance is
   the path. Use `disallowedTools` to deny, and let everything else
   (including MCP tools) inherit by default.

Fields that DO work: `name`, `description`, `tools`, `disallowedTools`,
`model`, `maxTurns`, `memory`, `background`, `effort`, `isolation`, `color`,
`initialPrompt`, `skills` (only as one-shot subagent, not as teammate).

## Parallel development with git worktrees

Each lead provisions one worktree per touched consumer repo via
`/worktree init <feature> --repo <repo>`. The worktree:

- lives at `<repo>/.worktrees/<feature-as-dirname>/`
- has `.worktrees/` added to the repo's `.gitignore` if missing
- gets registered with the active Claude Code session via `/add-dir`
  (the `/worktree` skill runs this automatically — repo-local agents
  inside the worktree are then callable via `Agent(...)`).

The `enforce-worktree.sh` PreToolUse hook is **gitignore-aware**: it
blocks Edit/Write/MultiEdit on any tracked file outside a
`.worktrees/*` path when the session has `IA_TW_FEATURE` set, and
blocks tracked-file edits on `main`/`master` in any session.

## Consumer `.gitignore` guidance

Consumer repos need:

```
.worktrees/
```

The `/worktree init` skill auto-adds this on first use. No `.sessions/`
entry needed in v2 — state lives outside the repo.

## Rules — all agents

1. **router is the only main session.** No other agent listens to
   DMs or classifies incoming messages. No other agent edits code from
   the main session.
2. **Every change runs through approval.** Even a one-line doc fix goes
   through plan → approval → PR. Shortcuts are prohibited.
3. **QA writes tests first.** No impl task GREEN completes until the
   matching qa:red is completed and the marker is in state.md.
4. **Security gate is blocking** for HIGH/MEDIUM findings. LOW-only
   findings pass through as PR comments.
5. **Branch rule.** Nothing merges directly to main. The only path to
   main is via PR. Use `/pr`, never `git push origin main`.
6. **Worktree commands use `-C`.** Always `git -C <worktree-path>` and
   the stack's equivalent path flag. Never `cd` into a worktree.
7. **`.claude/agent-memory/` is the only memory path.** Plugin-owned;
   agents append, never delete.
8. **N PRs per session.** Multi-repo sessions produce one PR per touched
   consumer repo. Security APPROVED required per PR.

## Autonomy boundaries

lead is autonomous **within** the invariants. It is NOT autonomous
across:

- The approval gate. Always blocks on aprobar.
- Security HIGH/MEDIUM findings. Always escalates.
- Ambiguous merge conflicts. Always asks before force-push / discard.
- Spec drift. If state.md and actual work diverge, stop and report.

router is autonomous on classification, never on execution — it
only replies, asks for confirmation, or calls `/session`.
