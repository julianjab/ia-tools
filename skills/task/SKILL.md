---
name: task
description: >
  Open a dedicated sub-session for a single task. Creates a git worktree,
  seeds `.sdlc/tasks.md`, opens a Claude Code instance in a tmux window
  subscribed to the Slack thread where the task was requested, and boots
  it with the `orchestrator` system prompt. This skill replaces the old
  `/worktree spawn` — it's the only way the main `triage` session can hand
  off work to a sub-session.
  Examples:
    `/task feat/google-login --thread 1728591234.001 --channel C07815S0XNX --description "arregla el login de Google"`
    `/task review/pr-42 --thread 1728591234.001 --channel C07815S0XNX --review 42`
argument-hint: "<branch-name> --thread <ts> --channel <id> [--description <text>] [--review <pr-number>] [--base main]"
disable-model-invocation: false
---

## /task — Open a Task Sub-session

`/task` is called **exclusively** by the `triage` main session when it classifies
an incoming Slack message as `change` intent. It is never called by humans
directly from the terminal, and never by sub-sessions (a sub-session owns one
task for its entire life — if another task is needed, open a new Slack thread).

## Contract

```
/task <branch-name> --thread <slack-ts> --channel <slack-channel-id>
      [--description "<raw user message>"]
      [--review <pr-number>]
      [--base main]
```

| Flag | Required? | Purpose |
|------|-----------|---------|
| `<branch-name>` | ✅ | The branch to create (e.g., `feat/google-login`). Triage derived it from the message. |
| `--thread <ts>` | ✅ | Slack thread timestamp where the request arrived. The sub-session subscribes only to this thread. |
| `--channel <id>` | ✅ | Slack channel containing the thread. |
| `--description "<text>"` | Either this or `--review` | Free-text description of what to do (passed into the boot prompt as context). |
| `--review <pr>` | Either this or `--description` | PR number to review. Creates branch `review/pr-<N>` tracking that PR. |
| `--base <branch>` | ❌ | Base branch for the worktree. Defaults to `main`, falls back to `master`. |

**Missing `--thread` or `--channel` → STOP.** These are not optional — without
them the sub-session cannot subscribe to its Slack context, and the whole flow
breaks.

## What /task does, in order

1. **Validate inputs** (see contract above). Fail loudly on missing flags.

2. **Create the worktree** via `/worktree init <branch-name> --base <base>`.
   - If `--review <pr>` was passed, use `--review` mode instead.
   - Reuse the existing `/worktree` skill — do NOT duplicate its logic.

3. **Seed `.sdlc/tasks.md`** inside the new worktree with a minimal stub:

   ```markdown
   # Task: <branch-name>

   **Slack thread**: <channel>/<thread-ts>
   **Created**: <ISO timestamp>
   **Status**: PENDING_PLAN

   ## Request

   <verbatim --description text, or "Review PR #N" if --review>

   ## Plan

   _(The orchestrator will fill this in during Phase 1 and publish it to
   Slack for approval.)_
   ```

4. **Post a Slack announcement** to the thread (via slack-bridge MCP):

   ```
   reply_slack(
     thread_ts="<slack-ts>",
     channel="<slack-channel>",
     text="🚀 Abriendo sub-sesión para `<branch-name>`.\n\nWorktree: `.worktrees/<dir-name>`\nEspera el plan en este hilo."
   )
   ```

5. **Delegate to `skills/task/scripts/start-task.sh`**, which:
   - Opens (or reuses) a tmux session
   - Creates a new window named after the branch, CWD = worktree path
   - Launches `claude --dangerously-skip-permissions` inside, with env vars:
     - `SLACK_THREAD_TS=<ts>`
     - `SLACK_CHANNELS=<channel>`
     - `IA_TOOLS_ROLE=orchestrator` ← read by the SessionStart hook to inject the right system prompt
   - Sends the boot prompt to the new Claude instance

6. **Report** back to `triage`:

   ```
   ✅ Sub-session started
     Branch:   <branch-name>
     Worktree: .worktrees/<dir-name>
     tmux:     session=<name> window=<name>
     Slack:    thread=<ts> channel=<id>
   ```

   `triage` then posts a brief confirmation in the thread and forgets the task.

## Boot prompt (injected into the sub-session)

```
You are the orchestrator of task <branch-name>.

Your Slack thread: ts=<thread-ts> channel=<channel-id>.
Your worktree:     <absolute-path>.
Your task file:    .sdlc/tasks.md (read it first).
The user's raw request: <description or "Review PR #N">

Follow the pipeline in agents/orchestrator.md starting from the boot sequence.
Phase 1 is your first action: build and publish the plan, then BLOCK on the
approval gate until you see a ✅ reaction.
```

## Pre-conditions enforced before spawning

| Check | Failure mode |
|-------|--------------|
| `<branch-name>` is valid git-ref syntax | STOP with clear error |
| `--thread` is set and non-empty | STOP — spawn requires a Slack context |
| `--channel` is set and non-empty | STOP — spawn requires a Slack context |
| `tmux` available in PATH | STOP with install hint |
| `claude` CLI available in PATH | STOP with install hint |
| Worktree directory not already in use | If `/worktree init` says "already exists", reuse it and just spawn |
| `.sdlc/tasks.md` writable inside the worktree | STOP |

## What /task does NOT do

- **Does not plan.** Planning is the orchestrator's first phase inside the sub-session.
- **Does not write specs.** Same — the orchestrator owns `.sdlc/specs/`.
- **Does not wait for approval.** The orchestrator waits inside the sub-session.
- **Does not monitor the sub-session.** Once spawned, `triage` forgets and
  `/task` returns.
- **Does not open DMs.** It only subscribes to the one thread it was given.

## Delegate script

```bash
bash "$(git rev-parse --show-toplevel)/skills/task/scripts/start-task.sh" \
  "<branch-name>" "<slack-thread-ts>" "<slack-channel-id>" \
  "<description-or-review-arg>"
```

The script returns the worktree path, tmux session/window, and exit code.

## Errors and recovery

| Error | Action |
|-------|--------|
| `/worktree init` fails | Abort, do not spawn tmux, do not post to Slack |
| tmux launch fails | Clean up the worktree (`/worktree cleanup <branch-name>`), report |
| Slack announcement fails | Still spawn (the thread exists), but warn `triage` so it can retry the announce |
| Boot prompt fails to inject | Kill the tmux window, clean up the worktree, report |
| Branch already exists as an open worktree | Reuse it — jump straight to step 4 (announce) and step 5 (spawn) without recreating |
