---
name: session
description: >
  Spawn a Claude sub-session in a dedicated tmux session, booted as the
  orchestrator agent (`team-workflow:orchestrator`). Passes the user's
  request via env vars (`SESSION_NAME`, `REQUEST`) and — if Slack-linked —
  `SLACK_THREADS` + `SLACK_CHANNEL`. The orchestrator creates its own
  worktree on boot; this skill only spawns the process.

  Examples:
    /session feat-google-login --description "arregla el login de Google"
    /session feat-payment-tracking --thread 1728591234.001 --channel C07815S0XNX --description "payment tracking across repos"
argument-hint: "<session-name> [--thread <ts> --channel <id>] --description <text>"
disable-model-invocation: false
---

## /session — Spawn a sub-session

`/session` opens a fresh tmux session running Claude Code with the
orchestrator agent preloaded. All runtime context (session label, user
request, Slack coordinates) travels via environment variables. The
orchestrator itself is responsible for creating a worktree and any session
state files once it boots.

## Contract

```
/session <session-name> [--thread <ts> --channel <id>] --description "<text>"
```

| Flag | Required | Purpose |
|------|----------|---------|
| `<session-name>` | ✅ | Label for the session. Used as the tmux session name. Must not contain `.` or `:` (tmux target syntax). |
| `--thread <ts>` | Slack mode | Slack thread timestamp. Must pair with `--channel`. |
| `--channel <id>` | Slack mode | Slack channel id. Must pair with `--thread`. |
| `--description "<text>"` | ✅ | User's raw request. Exported as `REQUEST` and typed as the first message to the orchestrator. For PR reviews, include the intent in the text (e.g. "revisa PR #42") — the orchestrator handles the fetch. |

**Mode rules:**
- `--thread` AND `--channel` set → slack mode. `SLACK_THREADS` and
  `SLACK_CHANNEL` exported.
- Both omitted → local mode. No Slack env vars exported; orchestrator
  uses `AskUserQuestion` for approvals.
- Exactly one set → error.

## What it does

1. Parses args, validates `<session-name>` and the Slack pairing rule.
2. Checks `tmux` and `claude` are on PATH.
3. Creates a tmux session named `<session-name>` (CWD = caller's cwd,
   typically the consumer repo root).
4. Launches `claude --agent team-workflow:orchestrator
   --dangerously-skip-permissions --teammateMode split-pane` inside the
   tmux session, with inline env vars:
   - `SESSION_NAME=<session-name>`
   - `REQUEST=<description>`
   - `SLACK_THREADS=<ts>` and `SLACK_CHANNEL=<id>` (slack mode only)
   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
   - `CLAUDE_CODE_OAUTH_TOKEN=<token>` (if `CLAUDE_TEAM_OAUTH_TOKEN` or
     `CLAUDE_CODE_OAUTH_TOKEN` is present in the caller's env)
5. Types `$REQUEST` as the first user message, then Enter.
6. Reports the session name, mode, and the `tmux attach` command.

## What it does NOT do

- **Does not create a worktree.** The orchestrator does this in its boot
  phase via `/worktree init $SESSION_NAME`.
- **Does not seed `.sdlc/tasks.md`.** Orchestrator's responsibility.
- **Does not post to Slack.** The caller (`session-manager`) already
  posted the acknowledgment reply that anchors the thread.
- **Does not write `settings.local.json`.** The orchestrator writes it
  inside its worktree.
- **Does not monitor the sub-session.** Once spawned, it returns.

## Delegate script

```bash
!bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/start-session.sh" \
  "<session-name>" "<slack-ts-or-empty>" "<slack-channel-or-empty>" "<description>"
```

Pass empty strings for `<slack-ts>` and `<slack-channel>` in local mode.

## Errors and recovery

| Situation | Action |
|-----------|--------|
| Only one of `--thread`/`--channel` provided | Reject with clear error — either both or neither. |
| `<session-name>` empty or contains `.` / `:` | Reject. |
| `tmux` or `claude` not on PATH | Abort with install hint; nothing spawned. |
| tmux session `<session-name>` already exists | Warn and reuse; do not fail. |
| `REQUEST` contains newline or NUL | Reject. |
