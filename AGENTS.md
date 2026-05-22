# Agent Team — ia-tools

This file defines the agent roster and the invariants for the ia-tools
ecosystem. It is read natively by Cursor, Windsurf, Copilot, Codex, Amp, and
Devin. Claude Code imports it via `@AGENTS.md` in `CLAUDE.md`.

## Session model — 2 roles

The operator picks the persona at boot via `claude --agent <plugin>:<name>`.
slack-bridge is pure I/O transport — it does NOT inject any role, does
NOT inspect argv, does NOT classify or orchestrate. See
`specs/deterministic-router-dispatch.md` for the original rationale (the
2-role simplification superseded the 3-role split it described).

```
┌──────────────────────────────────────────────────────────────────────┐
│ MAIN SESSION — router  (claude --agent team-workflow:router)         │
│ - Always alive. Receives every inbound message.                      │
│ - Prompt: plugins/team-workflow/agents/router.md                     │
│ - On first inbound per topic: bootstraps                             │
│     $IA_TW_STATE_DIR/state.md          (frontmatter + audit log)     │
│     $IA_TW_STATE_DIR/messages.md       (rolling conversation log)    │
│ - Per message:                                                       │
│     1. Resolve topic → session_id = sha1(topic)[:12].                │
│     2. Read state.md + messages.md (recover pending_ask, phase, …).  │
│     3. Classify inline into THREE intents:                           │
│         answer   → reply via /ask-user (Agent(Explore) when deep;    │
│                    Agent(general-purpose) + gh org list / gh repo    │
│                    clone --depth 1 for repos not in cache)           │
│         ask      → reply asking for confirmation; pending ask in     │
│                    state.md frontmatter                              │
│         dispatch → load /session skill + EXPLICIT Bash call to       │
│                    start-lead.sh; the skill body documents the       │
│                    contract but does NOT auto-execute                │
│ - NEVER edits source files; code work flows through `lead`.          │
└──────────────────────────────────────────────────────────────────────┘
                              │ start-lead.sh (with IA_TW_STATE_DIR
                              ▼  inherited from the router)
┌──────────────────────────────────────────────────────────────────────┐
│ SUB-SESSION — lead  (claude --agent team-workflow:lead)              │
│ - One tmux session per topic/feature.                                │
│ - Prompt: plugins/team-workflow/agents/lead.md                       │
│ - Boot rule: Read $IA_TW_STATE_DIR/state.md AND messages.md BEFORE   │
│   any other work. No agent boots blind on a topic that already has  │
│   prior context.                                                     │
│ - Per-repo worktrees / clones provisioned on the fly.                │
│ - Spawns sub-agents (implementer / qa / security / one-shots) that  │
│   ALL inherit the same $IA_TW_STATE_DIR.                             │
└──────────────────────────────────────────────────────────────────────┘
```

No `IA_TOOLS_ROLE` env var, no `SessionStart` hook, no argv-sniffing.
Personas come from `--agent` only. Every agent that ends up on the
same topic shares `$IA_TW_STATE_DIR`; the per-topic state.md +
messages.md is the single source of truth.

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
   no local merges. In multi-repo tasks: N PRs (one per touched consumer
   repo). Each PR goes through its own security gate. Single-repo tasks
   still produce one PR.

Outside these four rules — which teammates to spawn, whether to parallelize,
whether `architect` is needed, whether `security` runs as a teammate or a
one-shot — lead decides at runtime based on the approved plan.

## Workflow shape

```
Slack message arrives (or terminal /session with a feature)
    ↓
ROUTER (main session)
    1. Resolve topic → session_id; create $IA_TW_STATE_DIR on first inbound.
    2. Read state.md + messages.md (recover pending_ask / phase / default_repo).
    3. Classify inline:
        ├─ answer   → reply via /ask-user (Agent(Explore) when deep). DONE.
        ├─ ask      → reply asking for confirmation; pending ask written to
        │             state.md frontmatter. On next inbound: 'aprobar' →
        │             dispatch; 'cancelar' → drop; other text → re-classify.
        └─ dispatch → load /session skill + EXPLICIT Bash call to
                      start-lead.sh (passing $IA_TW_STATE_DIR so the lead
                      inherits the topic's state dir, not a new one).
                 ↓
             lead boot:
               - reads $IA_TW_STATE_DIR (inherited) + state.md + messages.md.
               - state.md already exists with `phase: chatting`; lead
                 transitions to `planning`.
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
router: resolve topic `<channel>:*:<thread_ts>` (new topic)
    - Bootstrap $IA_TW_STATE_DIR/{state.md,messages.md}.
    - append-message hook records the inbound in messages.md.
    - Classify inline → dispatch (hard signal "agrega").
    - Derive feature name: `feat/demo-api-client-api`.
    - Post ack reply via /ask-user.
    - Load /session skill, then Bash: start-lead.sh "feat/demo-api-client-api"
        "<topic>" "<request>"   # IA_TW_STATE_DIR already exported
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

## Team Structure — plugin agents

| Agent          | File                                          | Role                                                            | Model  | Color  |
|----------------|-----------------------------------------------|-----------------------------------------------------------------|--------|--------|
| `router`       | `plugins/team-workflow/agents/router.md`      | Main-session dispatcher AND inline conversational agent. Classifies (answer/ask/dispatch); never edits source. | sonnet | cyan   |
| `lead`         | `plugins/team-workflow/agents/lead.md`        | Per-feature orchestrator. Plan, provision, dispatch.            | opus   | purple |
| `implementer`  | `plugins/team-workflow/agents/implementer.md` | Stack-aware fallback subagent when a repo has no impl.          | sonnet | green  |

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

Discovery is fully delegated to the
`intelligence/detect-repo-capabilities.sh` hook. The lead's only
responsibility is to **provision the worktree and append a minimal
entry to `state.md`**; the hook does the rest synchronously inside the
PostToolUse Edit/Write that wrote the entry.

For every worktree provisioned, lead:

1. `/worktree init <branch> --repo <repo>` — provisions the worktree
   AND runs `/add-dir <worktree-abs>` (registered with the active
   session).
2. Writes a worktree entry to `state.md` with fields: `repo`,
   `worktree`, `branch`, `wt_prefix`, `local_phase: planning`, empty
   `markers`, empty `pr_url`. The hook fires on this Edit and
   splices `stack:`, `agents:`, and `capabilities:` in place.
3. Reads the entry back to consume the resolved `agents:` map.

The hook pipeline (see `plugins/team-workflow/hooks/scripts/intelligence/detect-repo-capabilities.sh`):

| Step | What the hook does | How |
|------|--------------------|-----|
| Stack | Detects backend / frontend / mobile / infra | Manifest probe (pubspec, package.json+UI dep, pyproject, Cargo, go.mod, *.tf) |
| Agents (qa/sec/arch) | First-pass classification | Name regex: `^(qa\|tester)…`, `^(security\|sec-review\|sec)…`, `^(architect\|api)…` |
| Agents (impl + leftover arch) | LLM reasoning | Haiku via `_fast_claude.sh` — reads each unclassified agent's description and picks the implementer/architect given the detected stack |
| Bucket assignment | Resolves with full fallback chain | Haiku pick (repo-local, prefixed via sync-agents) → plugin fallback (`impl-<wt_prefix>` for impl, `lead` for qa/sec, `implementer` for arch) |
| Capabilities | Probes the repo | `pre_push_hook`, `agent_memory_dir`, `team_review_config`, `conventional_commits_enforced`, `base_branch` |

Idempotent — entries that already declare `agents:` are skipped. The
hook also emits a `kind: repo_capabilities` event so the SessionEnd
feedback aggregator can include it in the `feedback_<feature>.md`
auto-memory file.

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

## State and persistence — single source of truth per topic

Every topic owns a self-contained session workspace outside every
consumer repo. **The same `$IA_TW_STATE_DIR` is shared by router,
lead, implementer, and every sub-agent that ends up on this topic.**
The router bootstraps it on the first inbound; subsequent agents
inherit it via env (`start-lead.sh` propagates `$IA_TW_STATE_DIR` to
the lead, the lead's spawn prompts to its sub-agents).

```
$IA_TW_STATE_ROOT/<topic_hash>/            ← session workspace ($IA_TW_STATE_DIR)
  state.md                                 YAML frontmatter + plan + worktrees + audit log;
                                           trailing `@include messages.md` marker
  messages.md                              Append-only rolling conversation log; one entry
                                           per turn (user / router / lead / implementer / …)
                                           written by the append-message.sh hook
  hook-audit.log                           TaskCreated / TaskCompleted log
  session-env.yaml                         Capa A/B env snapshot (no tokens)
  api-contract.md                          (optional) when api_contract != none
  .claude/
    settings.local.json                    envs + MCPs + additionalDirectories
    agents/                                ← $IA_TW_AGENT_LINK_DIR
      <repo>-<agent>.md                    materialized by sync-agents.sh
  worktrees/                               ← $IA_TW_WORKTREE_ROOT
    <basename(repoA)>/                     git worktree on the feature branch
    <basename(repoB)>/
    ...

$HOME/.claude/team-workflow/archive/<topic_hash>/   ← $IA_TW_ARCHIVE_DIR
  state.md, messages.md, hook-audit.log, ARCHIVED sentinel
                                                  (written by archive-on-merge when
                                                   phase ∈ merged/closed)
```

- `IA_TW_STATE_ROOT` defaults to `~/.claude/team-workflow/state`. Set
  to `/tmp/claude/team-workflow` for ephemeral pods.
- `<topic_hash>` = `sha1(IA_TW_TOPIC)[:12]` or `sha1("local:<feature>")[:12]`.
- **Boot rule (every agent).** When `$IA_TW_STATE_DIR/state.md`
  exists, the agent's first action is to read it AND `messages.md`.
  No agent boots blind on a topic that already has prior context.
- The router writes `state.md` skeleton on first inbound (phase:
  `chatting`). The lead transitions it to `phase: planning` on
  `/session` dispatch. Subsequent phases follow lead.md's table.
- Resume: a lead boot that sees an existing `state.md` reads it,
  reconstructs the worktree map, and continues from the recorded phase —
  it does NOT re-run pre-analysis.

## Hook-enforced quality gates

Three plugin hooks turn the invariants from convention into enforced rules.
They live under `plugins/team-workflow/hooks/scripts/<bucket>/` (see the
bucket conventions in `plugins/scaffold/references/script-style.md`) and
resolve the state dir via `$IA_TW_STATE_DIR` (or fall back to a v1
`.sessions/<label>/` layout during a transition window).

| Hook            | Script                                | Effect                                                                                                          |
|-----------------|---------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| `TaskCreated`   | `bookkeeping/task-created.sh`         | Audit-only — logs each task subject; warns when a stack/pr task is created without a clear `blockedBy` prefix. |
| `TaskCompleted` | `enforcement/enforce-task-invariants.sh` + `bookkeeping/record-state-event.sh` | Enforcement blocks (exit 2) `*:pr*` completion when `state.md` lacks `security: APPROVED for <wt_prefix>`; blocks `*:green*` without `RED confirmed for <wt_prefix>`. Bookkeeping (runs after) appends to hook-audit.log + state.md events: + transitions local_phase. |
| `TeammateIdle`  | `enforcement/teammate-idle.sh`        | Blocks `qa` teammates from idling until the transcript contains `RED confirmed`; blocks `security` teammates until verdict.                              |

The hooks scan transcripts and `state.md`; when they cannot reach those
(no state dir), they fall back to allow.

The full hook layout is:

```
plugins/team-workflow/hooks/scripts/
├── enforcement/   (may exit 2 — enforce-worktree, task-completed,
│                   teammate-idle, tool-guard, ci-poller)
├── bookkeeping/   (always exit 0, deterministic state writes —
│                   task-created, subagent-stop, session-start,
│                   instructions-loaded, pre-compact)
└── intelligence/  (may call claude -p — session-end)
```

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

- lives at `$IA_TW_WORKTREE_ROOT/<basename($repo)>/` — under the
  per-feature session workspace, NOT inside the consumer repo.
- is registered as a Claude Code root via `additionalDirectories` in
  `$IA_TW_STATE_DIR/.claude/settings.local.json` (written atomically
  by `/worktree init` → `generate-session-settings.sh`).
- has its repo-local agents materialized into
  `$IA_TW_AGENT_LINK_DIR` as `<basename>-<agent>.md` by the
  `sync-agents` hook, so the lead can spawn them with
  `Agent(subagent_type="<basename>-<agent>", ...)` without ever
  invoking `/add-dir` at runtime.

The `enforce-worktree.sh` PreToolUse hook is now **universal**: it
blocks Edit/Write/MultiEdit on tracked files when the file's repo is
checked out on `main`/`master`, regardless of session env or
worktree location. Feature-branch worktrees (wherever they live)
pass freely.

## Consumer `.gitignore` guidance

None required. Worktrees + per-session state both live outside the
consumer repo:

- worktrees: `$IA_TW_WORKTREE_ROOT/<basename>/`
- state:     `$IA_TW_STATE_ROOT/<topic_hash>/` (default `~/.claude/team-workflow/state/`)

## Rules — all agents

1. **router is the only main session.** It receives every inbound
   message, classifies it inline into `answer` / `ask` / `dispatch`,
   and acts. Source-file edits are NEVER done from the router —
   real code changes flow to `lead` via `/session` + an explicit
   `Bash` call to `start-lead.sh`.
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

router is autonomous on the `answer` / `ask` path (inline replies,
delegating deep reads to `Agent(Explore)`, discovering non-local
repos via `gh org list` + `gh repo clone --depth 1` through
`Agent(general-purpose)`) — never on source-file edits. On
`dispatch`, the router loads `/session` and runs the explicit Bash
call to `start-lead.sh`, handing the topic off to `lead`.
