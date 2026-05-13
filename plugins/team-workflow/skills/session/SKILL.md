---
name: session
description: >
  Spawn a Claude sub-session in a dedicated tmux window, booted as the
  team-lead agent (`team-workflow:team-lead`). Routes the user's request,
  Slack-bridge topic, and feature label into the wrapper. The team-lead
  creates its own worktree(s), state.md, and task list on boot — this
  skill only spawns the process.

  Examples:
    /session feat-google-login --description "arregla el login de Google"
    /session feat-payment-tracking --topic "C07815S0XNX:*:1728591234.001" --description "payment tracking across repos"
argument-hint: "<feature-name> [--topic <topic-string>] --description <text>"
disable-model-invocation: false
---

## /session — Spawn a team-lead sub-session

`/session` opens a fresh tmux session running Claude Code with the
`team-lead` agent preloaded. All runtime context (feature label, user
request, Slack topic) travels via environment variables that the wrapper
sets up. The team-lead is responsible for the entire downstream flow:
plan, approval gate, worktree provisioning per touched repo, agent
discovery, task list, dispatch loop, and PR creation.

## Contract

```
/session <feature-name> [--topic <topic-string>] --description "<text>"
```

| Flag | Required | Purpose |
|---|---|---|
| `<feature-name>` | ✅ | Feature label. Used as the tmux session name AND the branch name for every worktree the team-lead creates. Must not contain `.` or `:` (tmux target syntax). |
| `--topic <topic-string>` | Slack mode | Single slack-bridge topic string. Shapes: `<channel>:*:<thread_ts>` (thread), `<channel>` (channel-wide), `DM:<user>` (direct messages). Plumbed unchanged into `SLACK_TOPICS` so the slack-bridge MCP auto-subscribes at team-lead boot. |
| `--description "<text>"` | ✅ | User's raw request. Exported as `IA_TW_REQUEST` and delivered as the first user message inside the spawned session. |

Mode rules:
- `--topic` set → Slack mode. team-lead replies through the channel's `reply` tool.
- `--topic` omitted → local mode. team-lead uses `AskUserQuestion` for the approval gate.

## What it does

1. Parses args, validates `<feature-name>`.
2. Computes `topic_hash` from the topic (or `local:<feature>` if no topic) and prepares `~/.claude/team-workflow/state/<topic_hash>/`.
3. Exports the IA_TW_* env vars + `SLACK_TOPICS` (when topic is set) + OAuth token (if present).
4. Creates a tmux session named `<feature-name>` and launches `claude --agent team-workflow:team-lead --dangerously-load-development-channels plugin:slack-bridge@ia-tools --dangerously-skip-permissions <description>` inside it.
5. Dismisses the boot-time dev-channels and trust-folder prompts automatically (background poller, 30s window).
6. Reports the tmux attach command and the state directory path.

## What it does NOT do

- Does NOT create any worktree. team-lead does this in its Provision phase via `/worktree init`.
- Does NOT write `state.md`. team-lead writes it at boot.
- Does NOT post to Slack. The caller (`session-manager`) already posted the ack reply that anchored the topic.
- Does NOT monitor the sub-session. Once spawned, it returns.

## Delegate script

```bash
!bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/start-team-lead.sh" \
  "<feature-name>" "<topic-string-or-empty>" "<description>"
```

Pass an empty string for `<topic-string>` in local mode.

## Errors and recovery

| Situation | Action |
|---|---|
| `<feature-name>` empty or contains `.` / `:` | Reject. |
| `--topic` value contains newline / CR | Reject. |
| `tmux` or `claude` not on PATH | Abort with install hint; nothing spawned. |
| tmux session `<feature-name>` already exists | Warn and reuse; do not relaunch claude. |
| `<description>` contains newline or NUL | Reject. |
