---
name: session
description: >
  Spawn a Claude sub-session in a dedicated tmux session, booted as the
  orchestrator agent (`team-workflow:orchestrator`). Passes the user's
  request via env vars (`SESSION_NAME`, `REQUEST`) and — if Slack-linked —
  `SLACK_TOPIC` (a single topic string in slack-bridge format, e.g.
  `C06Q8SNF93P:*:1778078158.577219` for a thread or `DM:U02M1QFA0AF` for a
  DM). The orchestrator creates its own worktree on boot; this skill only
  spawns the process.

  Examples:
    /session feat-google-login --description "arregla el login de Google"
    /session feat-payment-tracking --topic "C07815S0XNX:*:1728591234.001" --description "payment tracking across repos"
argument-hint: "<session-name> [--topic <topic-string>] --description <text>"
disable-model-invocation: false
---

## /session — Spawn a sub-session

`/session` opens a fresh tmux session running Claude Code with the
orchestrator agent preloaded. All runtime context (session label, user
request, Slack topic) travels via environment variables. The orchestrator
itself is responsible for creating a worktree and any session state files
once it boots.

## Contract

```
/session <session-name> [--topic <topic-string>] [--mode tmux|bg] --description "<text>"
```

| Flag | Required | Purpose |
|------|----------|---------|
| `<session-name>` | ✅ | Label for the session. Used as the tmux session name. Must not contain `.` or `:` (tmux target syntax). |
| `--topic <topic-string>` | Slack mode | Single slack-bridge topic string. Common shapes: `<channel>:*:<thread_ts>` (thread), `<channel>` (channel-wide), `DM:<user>` (direct messages). slack-bridge's `parseTopic` is the source of truth — this skill plumbs the string through unchanged. |
| `--mode tmux\|bg` | optional | Runtime selector. `tmux` (default) opens a dedicated tmux session and runs claude inside it — recommended for Slack-anchored work that must outlive the agent-view supervisor's ~1h idle cull. `bg` invokes `claude --bg --agent team-workflow:orchestrator` so the session surfaces in `claude agents` and uses worktrees under `.claude/worktrees/`. See https://code.claude.com/docs/en/agent-view. |
| `--description "<text>"` | ✅ | User's raw request. Exported as `REQUEST` and typed as the first message to the orchestrator. For PR reviews, include the intent in the text (e.g. "revisa PR #42") — the orchestrator handles the fetch. |

**Mode rules:**
- `--topic` set → slack mode. `SLACK_TOPIC` exported.
- `--topic` omitted → local mode. No Slack env vars exported; orchestrator
  uses `AskUserQuestion` for approvals.

## What it does

1. Parses args, validates `<session-name>`.
2. Checks `tmux` and `claude` are on PATH.
3. Creates a tmux session named `<session-name>` (CWD = caller's cwd,
   typically the consumer repo root).
4. Launches `claude --agent team-workflow:orchestrator
   --dangerously-skip-permissions --teammate-mode tmux` inside the
   tmux session, with inline env vars:

   `--teammate-mode tmux` is intentional: every teammate opens as a new
   pane inside the same tmux window as the orchestrator, so a single
   `tmux attach -t <session-name>` surfaces the lead and the whole team.
   `in-process` would hide teammates behind `Shift+Down` cycling and
   `auto` would do the same when the operator runs `/session` from
   outside tmux. Override per-session with `--mode bg` (see "Background
   mode" below) if you want to use the supervisor + `claude agents`
   view instead.
   - `SESSION_NAME=<session-name>`
   - `REQUEST=<description>`
   - `SLACK_TOPIC=<topic-string>` (slack mode only)
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
  posted the acknowledgment reply that anchors the topic.
- **Does not write `settings.local.json`.** The orchestrator writes it
  inside its worktree.
- **Does not monitor the sub-session.** Once spawned, it returns.

## Delegate script

```bash
!bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/start-session.sh" \
  "<session-name>" "<topic-string-or-empty>" "<description>" "<run-mode>"
```

Pass an empty string for `<topic-string>` in local mode. `<run-mode>` is
`tmux` (default, omit for backward compatibility) or `bg`.

## Errors and recovery

| Situation | Action |
|-----------|--------|
| `<session-name>` empty or contains `.` / `:` | Reject. |
| `--topic` value contains newline / CR | Reject. |
| `tmux` or `claude` not on PATH | Abort with install hint; nothing spawned. |
| tmux session `<session-name>` already exists | Warn and reuse; do not fail. |
| `REQUEST` contains newline or NUL | Reject. |
