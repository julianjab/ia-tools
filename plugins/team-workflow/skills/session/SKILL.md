---
name: session
description: >
  Spawn a Claude orchestrator sub-session in a dedicated tmux window.
  Defaults to the `lead` agent (`team-workflow:lead`) with worktree
  provisioning, but `--agent` / `--topic-worker-agent` / `--provision`
  / `--repo-url[s]` let the caller pick a different persona — e.g.
  `team-workflow:repo-worker` with `clone` provisioning for single-repo
  pod work, or a persona pod (`team-workflow:kubito-worker`) for
  Slack-resident agents. Routes the user's request, Slack-bridge topic,
  feature label, and persona config into the wrapper. The spawned
  orchestrator creates its own worktree(s)/clone, state.md, and task
  list on boot — this skill only spawns the process.

  Examples:
    /session feat-google-login --description "arregla el login de Google"
    /session feat-payment-tracking --topic "C07815S0XNX:*:1728591234.001" --description "payment tracking across repos"
    /session feat-logout-button --agent team-workflow:repo-worker --provision clone --repo-url "https://github.com/org/frontend.git" --description "agrega botón de logout"
argument-hint: "<feature-name> [--topic <topic>] [--agent <plugin:name>] [--topic-worker-agent <plugin:name>] [--provision worktree-local|clone] [--repo-url <url>] [--repo-urls <csv>] --description <text>"
disable-model-invocation: false
---

## /session — Spawn a lead sub-session

`/session` opens a fresh tmux session running Claude Code with the
`lead` agent preloaded. All runtime context (feature label, user
request, Slack topic) travels via environment variables that the wrapper
sets up. The lead is responsible for the entire downstream flow:
plan, approval gate, worktree provisioning per touched repo, agent
discovery, task list, dispatch loop, and PR creation.

## Contract

```
/session <feature-name> [--topic <topic-string>] --description "<text>"
```

| Flag | Required | Purpose |
|---|---|---|
| `<feature-name>` | ✅ | Feature label. Used as the tmux session name AND the branch name for every worktree/clone the orchestrator creates. Must not contain `.` or `:` (tmux target syntax). |
| `--topic <topic-string>` | Slack mode | Single slack-bridge topic string. Shapes: `<channel>:*:<thread_ts>` (thread), `<channel>` (channel-wide), `DM:<user>` (direct messages). Plumbed unchanged into `SLACK_TOPICS` so the slack-bridge MCP auto-subscribes at orchestrator boot. |
| `--agent <plugin:name>` | — | Orchestrator persona to boot. Default `team-workflow:lead`. Exported as `IA_TW_AGENT`. Use `team-workflow:repo-worker` for single-repo pod sessions, or a persona-specific name. |
| `--topic-worker-agent <plugin:name>` | — | topic-worker persona the router spawns for answer/ask intents. Default `team-workflow:topic-worker`. Exported as `IA_TW_TOPIC_WORKER_AGENT`. Lets a persona pod (kubito, gordo, …) answer info questions as itself. |
| `--provision <strategy>` | — | `worktree-local` (default — worktree of a sibling host repo) or `clone` (git clone of `--repo-url[s]`). Exported as `IA_TW_PROVISION`. |
| `--repo-url <git-url>` | when `--provision clone` and single repo | Git URL the orchestrator clones. Exported as `IA_TW_REPO_URL`. |
| `--repo-urls <csv>` | when `--provision clone` and multi repo | Comma-separated git URLs for multi-repo pods. Exported as `IA_TW_REPO_URLS`. |
| `--description "<text>"` | ✅ | User's raw request. Exported as `IA_TW_REQUEST` and delivered as the first user message inside the spawned session. |

Mode rules:
- `--topic` set → Slack mode. The orchestrator replies through the channel's `reply` tool.
- `--topic` omitted → local mode. The orchestrator uses `AskUserQuestion` for the approval gate.

### Argument parsing

Tokenize `$ARGUMENTS` once at the start of the skill:

| Token shape | Extract into |
|---|---|
| First positional (no `--` prefix), no `.`/`:` | `FEATURE` |
| `--topic <value>` (two tokens) OR `--topic=<value>` | `TOPIC` |
| `--agent <value>` OR `--agent=<value>` | `AGENT` |
| `--topic-worker-agent <value>` OR `--topic-worker-agent=<value>` | `TOPIC_WORKER_AGENT` |
| `--provision <value>` OR `--provision=<value>` | `PROVISION` |
| `--repo-url <value>` OR `--repo-url=<value>` | `REPO_URL` |
| `--repo-urls <csv>` OR `--repo-urls=<csv>` | `REPO_URLS` |
| `--description "<value>"` (capture quoted string OR everything after `--description` up to next `--`) | `DESCRIPTION` |
| Anything else | reject with a usage hint |

If `FEATURE` is empty → STOP with the usage line above.
If `DESCRIPTION` is empty → STOP with the usage line above.
`TOPIC` empty is valid (local mode).
`AGENT` / `TOPIC_WORKER_AGENT` / `PROVISION` empty are valid (defaults apply).
If `PROVISION=clone` and both `REPO_URL` and `REPO_URLS` are empty → STOP: clone provisioning requires at least one repo URL.

All flags overlay whatever the consumer repo's `.claude/team-workflow.yaml`
declares; `start-lead.sh` sources that file via `load-tw-config.sh` and any
env var already set (including these flag-derived ones) wins.

## What it does

1. Parses args, validates `<feature-name>`.
2. Computes `topic_hash` from the topic (or `local:<feature>` if no topic) and prepares `~/.claude/team-workflow/state/<topic_hash>/`.
3. Exports the IA_TW_* env vars + `SLACK_TOPICS` (when topic is set) + OAuth token (if present).
4. Creates a tmux session named `<feature-name>` and launches `claude --agent team-workflow:lead --dangerously-load-development-channels plugin:slack-bridge@ia-tools --dangerously-skip-permissions <description>` inside it.
5. Dismisses the boot-time dev-channels and trust-folder prompts automatically (background poller, 30s window).
6. Reports the tmux attach command and the state directory path.

## What it does NOT do

- Does NOT create any worktree. lead does this in its Provision phase via `/worktree init`.
- Does NOT write `state.md`. lead writes it at boot.
- Does NOT post to Slack. The caller (`router`) already posted the ack reply that anchored the topic.
- Does NOT monitor the sub-session. Once spawned, it returns.

## Delegate script

The wrapper takes 3 positional args and reads the persona / provisioning
strategy from env vars (`IA_TW_AGENT`, `IA_TW_TOPIC_WORKER_AGENT`,
`IA_TW_PROVISION`, `IA_TW_REPO_URL`, `IA_TW_REPO_URLS`). Prefix the
invocation with whichever flags were parsed; omit them to get the
`lead` + `worktree-local` defaults plus whatever
`.claude/team-workflow.yaml` provides.

```bash
# Default — lead with worktree provisioning:
!bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/start-lead.sh" \
  "<feature-name>" "<topic-string-or-empty>" "<description>"

# Non-default — e.g. repo-worker with clone provisioning, persona pod:
!IA_TW_AGENT="<agent>" \
 IA_TW_TOPIC_WORKER_AGENT="<topic-worker-agent>" \
 IA_TW_PROVISION="<provision>" \
 IA_TW_REPO_URL="<url>" \
 IA_TW_REPO_URLS="<csv-of-urls>" \
  bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/start-lead.sh" \
  "<feature-name>" "<topic-string-or-empty>" "<description>"
```

Pass an empty string for `<topic-string>` in local mode. Only include
the env-var prefixes for flags that were actually provided.

## Errors and recovery

| Situation | Action |
|---|---|
| `<feature-name>` empty or contains `.` / `:` | Reject. |
| `--topic` value contains newline / CR | Reject. |
| `tmux` or `claude` not on PATH | Abort with install hint; nothing spawned. |
| tmux session `<feature-name>` already exists | Warn and reuse; do not relaunch claude. |
| `<description>` contains newline or NUL | Reject. |
