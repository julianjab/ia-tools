---
name: session
description: >
  Open a dedicated sub-session for a single task. Creates a git worktree,
  seeds `.sdlc/tasks.md`, opens a Claude Code instance in a tmux window
  booted with the `orchestrator` system prompt. Supports two modes:
  **slack** (subscribed to a Slack thread — used by `session-manager`) and
  **local** (no Slack — used when a human runs `/session` directly from a
  main session). The mode is determined by whether `--thread`/`--channel`
  are passed.
  Examples:
    `/session feat/google-login --thread 1728591234.001 --channel C07815S0XNX --description "arregla el login de Google"`
    `/session feat/refactor-foo --description "refactorea el módulo foo"`
    `/session review/pr-42 --review 42`
argument-hint: "<branch-name> [--thread <ts> --channel <id>] [--description <text>] [--review <pr>] [--base main]"
disable-model-invocation: false
---

## /session — Open a Sub-session

`/session` opens a worktree + tmux window + Claude Code sub-session booted with the
orchestrator system prompt. It runs in one of two modes:

| Mode    | How it is triggered                                                                                                    | Communication                                                     |
|---------|------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| `slack` | `session-manager` calls `/session` after classifying a Slack message as `change`, passing `--thread` + `--channel` | Orchestrator publishes plan, approvals, and PR links in the thread |
| `local` | A human runs `/session` directly from a Claude Code main session, without Slack flags                              | Orchestrator prints the plan in the sub-session and blocks on `AskUserQuestion` |

The mode is detected by the presence of `--thread` AND `--channel`. Both must
be set (slack mode), or both omitted (local mode). Mixing is rejected.

A sub-session owns one task for its entire life — if another task is needed,
open a new one.

## Contract

```
/session <branch-name>
         [--thread <slack-ts> --channel <slack-channel-id>]
         [--description "<raw user message>"]
         [--review <pr-number>]
         [--base <branch>]
         [--resume-from <path-to-.sessions/<label>/>]
```

| Flag | Required? | Purpose |
|------|-----------|---------|
| `<branch-name>` | ✅ | The branch to create (e.g., `feat/google-login`). In slack mode session-manager derived it; in local mode the user or caller provides it. |
| `--thread <ts>` | Slack mode only | Slack thread timestamp. Must be paired with `--channel`. |
| `--channel <id>` | Slack mode only | Slack channel containing the thread. Must be paired with `--thread`. |
| `--description "<text>"` | Either this or `--review` | Free-text description of what to do (passed into the boot prompt as context). |
| `--review <pr>` | Either this or `--description` | PR number to review. Creates branch `review/pr-<N>` tracking that PR. |
| `--base <branch>` | ❌ | Base branch for the worktree. Defaults to `main`, falls back to `master`. Passed to `/worktree init`. |
| `--resume-from <path>` | ❌ | Activates **resume-from mode**. `start-session.sh` SKIPS worktree creation and launches the orchestrator with CWD = consumer repo root (derived from `<path>`, which is `<consumer-repo-root>/.sessions/<label>/`). The orchestrator reads `<path>/plan-draft.md` as the Phase 1 seed. The approval gate still runs. |

**Rules:**

- `--thread` and `--channel` must both be set or both be omitted. Setting only
  one is an error.
- If neither is set, `/task` runs in local mode and skips every slack-bridge
  call.

## Operating modes

| Mode | How triggered | Worktree | CWD of orchestrator |
|------|--------------|----------|---------------------|
| Standard (single-repo) | No `--resume-from` | Created via `/worktree init` | The new worktree |
| Resume-from (multi-repo) | `--resume-from <path>` + `<path>/plan-draft.md` exists | NOT created (skipped) | Consumer repo root |

In **resume-from mode**, the orchestrator runs in the consumer repo root
(e.g. `/Users/julianbuitrago/development/lahaus/`) and creates N worktrees
(one per target repo) via `/worktree init --repo <path>`. It coordinates
stack teammates, each assigned to one worktree.

## What /session does, in order

1. **Validate inputs** (see contract above). Reject mixed Slack flags.

2. **If `--resume-from <path>` is set** (resume-from mode):
   - Verify `<path>/plan-draft.md` exists. If not, reject.
   - Derive `<consumer-repo-root>` = `git -C <path>/../.. rev-parse --show-toplevel`
     (the file lives at `<root>/.sessions/<label>/`, two parent levels up).
   - SKIP worktree creation. SKIP `.sdlc/tasks.md` seeding.
   - Set `TMUX_CWD = <consumer-repo-root>`.
   - Set `IA_TOOLS_SESSION_DIR = <path>`.
   - Continue from step 3b (write `.claude/settings.local.json`).

   **If `--resume-from` is NOT set** (standard single-repo mode):

2b. **Create the worktree** via `/worktree init <branch-name> --base <base>`.
   - If `--review <pr>` was passed, use `--review` mode instead.
   - Reuse the existing `/worktree` skill — do NOT duplicate its logic.

3. **Seed `.sdlc/tasks.md`** inside the new worktree. The source line depends
   on mode:

   ```markdown
   # Session: <branch-name>

   **Mode**: <slack|local>
   **Slack thread**: <channel>/<thread-ts>     ← slack mode
   **Source**: local (no Slack)                 ← local mode
   **Created**: <ISO timestamp>
   **Status**: PENDING_PLAN

   ## Request

   <verbatim --description text, or "Review PR #N" if --review>

   ## Plan

   _(The orchestrator fills this in during Phase 1 and either publishes it to
   Slack (slack mode) or prints it in the sub-session (local mode).)_
   ```

4. **Post a Slack announcement** (slack mode only, via slack-bridge MCP):

   ```
   reply(
     thread_ts="<slack-ts>",
     channel="<slack-channel>",
     text="🚀 Abriendo sesión para `<branch-name>`.\n\nWorktree: `.worktrees/<dir-name>`\nEspera el plan en este hilo."
   )
   ```

   In local mode this step is skipped entirely — no MCP call.

5. **Delegate to `skills/session/scripts/start-session.sh`**, which:
   - Opens (or reuses) a tmux session
   - Creates a new window named after the branch, CWD = worktree path
   - Launches `claude --dangerously-skip-permissions` inside, with env vars:
     - `IA_TOOLS_ROLE=orchestrator` ← read by the SessionStart hook to inject the orchestrator system prompt
     - `SLACK_THREAD_TS=<ts>` and `SLACK_CHANNELS=<channel>` — slack mode only. Their presence is the mode switch: both set → slack, otherwise → local. The SessionStart hook derives the mode from them and injects it into the system prompt header.
   - Sends a mode-aware boot prompt to the new Claude instance

6. **Report** back to the caller:

   ```
   ✅ Session started
     Branch:   <branch-name>
     Mode:     <slack|local>
     Worktree: .worktrees/<dir-name>
     tmux:     session=<name> window=<name>
     Slack:    thread=<ts> channel=<id>       ← slack mode only
   ```

   In slack mode `session-manager` posts a brief confirmation in the thread and
   forgets the session. In local mode the user attaches to the tmux window to
   interact with the orchestrator.

## Boot prompt (injected into the sub-session)

Slack mode:
```
You are the orchestrator of session <branch-name>. Mode: slack.
Your Slack thread: ts=<thread-ts> channel=<channel-id>.
Your worktree:     <absolute-path>.
Your task file:    .sdlc/tasks.md (read it first).
The user's raw request: <description or "Review PR #N">

Follow the pipeline in agents/orchestrator.md starting from the boot sequence.
Phase 1 is your first action: build and publish the plan in the thread, then
BLOCK on the approval gate until you see a ✅ reaction.
```

Local mode:
```
You are the orchestrator of session <branch-name>. Mode: local (no Slack).
Your worktree:     <absolute-path>.
Your task file:    .sdlc/tasks.md (read it first).
The user's raw request: <description or "Review PR #N">

Follow the pipeline in agents/orchestrator.md starting from the boot sequence.
Phase 1 is your first action: build and print the plan in this session, then
BLOCK on the approval gate using AskUserQuestion. Do NOT call any slack-bridge
MCP tool.
```

## Pre-conditions enforced before spawning

| Check | Failure mode |
|-------|--------------|
| `<branch-name>` is valid git-ref syntax | STOP with clear error |
| `--thread` and `--channel` both set OR both unset | STOP on mixed flags |
| `tmux` available in PATH | STOP with install hint |
| `claude` CLI available in PATH | STOP with install hint |
| Worktree directory not already in use | If `/worktree init` says "already exists", reuse it and just spawn |
| `.sdlc/tasks.md` writable inside the worktree | STOP |

## What /session does NOT do

- **Does not plan.** Planning is the orchestrator's first phase inside the sub-session.
- **Does not write specs.** Same — the orchestrator owns `.sdlc/specs/`.
- **Does not wait for approval.** The orchestrator waits inside the sub-session.
- **Does not monitor the sub-session.** Once spawned, the caller returns.
- **Does not open DMs.** In slack mode it only subscribes to the one thread
  it was given. In local mode it makes zero Slack calls.

## Delegate script

```bash
bash "$(git rev-parse --show-toplevel)/skills/task/scripts/start-session.sh" \
  "<branch-name>" "<slack-thread-ts-or-empty>" "<slack-channel-id-or-empty>" \
  "<description-or-review-arg>" "<base-branch-or-empty>" "<resume-from-path-or-empty>"
```

Pass empty strings for thread/channel in local mode. Pass empty string for
`--base` to use the default (`main` → `master` fallback). Pass empty string for
`--resume-from` to use standard single-repo mode. The script returns the
worktree path (or consumer repo root in resume-from mode), tmux
session/window, mode, and exit code.

## Errors and recovery

| Error | Action |
|-------|--------|
| `/worktree init` fails | Abort, do not spawn tmux, do not post to Slack |
| tmux launch fails | Clean up the worktree (`/worktree cleanup <branch-name>`), report |
| Slack announcement fails (slack mode) | Still spawn (the thread exists), warn caller so it can retry the announce |
| Boot prompt fails to inject | Kill the tmux window, clean up the worktree, report |
| Branch already exists as an open worktree | Reuse it — jump straight to step 4 (announce) and step 5 (spawn) without recreating |
| Only one of `--thread`/`--channel` provided | Reject with clear error — either both or neither |
