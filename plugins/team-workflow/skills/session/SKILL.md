---
name: session
description: >
  Spawn a Claude orchestrator sub-session in a dedicated tmux window.
  Defaults to the `lead` agent (`team-workflow:lead`) with worktree
  provisioning, but `--agent` / `--provision` / `--repo-url` let the
  caller pick a different persona — e.g. `team-workflow:repo-worker`
  with `clone` provisioning for single-repo pod work. Routes the user's
  request, Slack-bridge topic, and feature label into the wrapper. The
  spawned orchestrator creates its own worktree(s)/clone, state.md, and
  task list on boot — this skill only spawns the process.

  Examples:
    /session feat-google-login --description "arregla el login de Google"
    /session feat-payment-tracking --topic "C07815S0XNX:*:1728591234.001" --description "payment tracking across repos"
    /session feat-logout-button --agent team-workflow:repo-worker --provision clone --repo-url "https://github.com/org/frontend.git" --description "agrega botón de logout"
argument-hint: "<feature-name> [--topic <topic>] [--agent <plugin:name>] [--provision worktree-local|clone] [--repo-url <git-url>] --description <text>"
disable-model-invocation: false
---

## /session — Spawn an orchestrator sub-session

`/session` opens a fresh tmux session running Claude Code with an
orchestrator agent preloaded. All runtime context (feature label, user
request, Slack topic, agent persona, provisioning strategy) travels via
environment variables that the wrapper sets up. The orchestrator is
responsible for the entire downstream flow: plan, approval gate,
worktree/clone provisioning, agent discovery, task list, dispatch loop,
and PR creation.

By default the persona is `team-workflow:lead` with `worktree-local`
provisioning (worktrees of sibling repos on the host). The `--agent`,
`--provision`, and `--repo-url` flags make this non-static — e.g. a
`router` on a developer host uses the defaults, while a `router`
running with a pod dispatch profile passes
`--agent team-workflow:repo-worker --provision clone --repo-url <url>`
to spawn a single-repo, clone-work-PR session inside a pod.

## Contract

```
/session <feature-name> [--topic <topic-string>] \
         [--agent <plugin:name>] [--provision worktree-local|clone] \
         [--repo-url <git-url>] --description "<text>"
```

| Flag | Required | Purpose |
|---|---|---|
| `<feature-name>` | ✅ | Feature label. Used as the tmux session name AND the branch name for every worktree/clone the orchestrator creates. Must not contain `.` or `:` (tmux target syntax). |
| `--topic <topic-string>` | Slack mode | Single slack-bridge topic string. Shapes: `<channel>:*:<thread_ts>` (thread), `<channel>` (channel-wide), `DM:<user>` (direct messages). Plumbed unchanged into `SLACK_TOPICS` so the slack-bridge MCP auto-subscribes at orchestrator boot. |
| `--agent <plugin:name>` | — | Orchestrator persona to boot. Default `team-workflow:lead`. Use `team-workflow:repo-worker` for single-repo pod sessions. Exported as `IA_TW_AGENT`. |
| `--provision <strategy>` | — | `worktree-local` (default — worktree of a sibling repo) or `clone` (git clone of `--repo-url`). Exported as `IA_TW_PROVISION`. |
| `--repo-url <git-url>` | when `--provision clone` | Git URL the orchestrator clones. Exported as `IA_TW_REPO_URL`. Ignored under `worktree-local`. |
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
| `--provision <value>` OR `--provision=<value>` | `PROVISION` |
| `--repo-url <value>` OR `--repo-url=<value>` | `REPO_URL` |
| `--description "<value>"` (capture quoted string OR everything after `--description` up to next `--`) | `DESCRIPTION` |
| Anything else | reject with a usage hint |

If `FEATURE` is empty → STOP with the usage line above.
If `DESCRIPTION` is empty → STOP with the usage line above.
`TOPIC` empty is valid (local mode).
`AGENT` empty is valid (defaults to `team-workflow:lead`).
`PROVISION` empty is valid (defaults to `worktree-local`).
If `PROVISION` is `clone` and `REPO_URL` is empty → STOP: `clone` provisioning requires `--repo-url`.

## What it does

1. Parses args, validates `<feature-name>`.
2. Computes `topic_hash` from the topic (or `local:<feature>` if no topic) and prepares `~/.claude/team-workflow/state/<topic_hash>/`.
3. Exports the IA_TW_* env vars (`IA_TW_AGENT`, `IA_TW_PROVISION`, and `IA_TW_REPO_URL` when set) + `SLACK_TOPICS` (when topic is set) + OAuth token (if present).
4. Creates a tmux session named `<feature-name>` and launches `claude --agent <IA_TW_AGENT> --dangerously-load-development-channels plugin:slack-bridge@ia-tools --dangerously-skip-permissions <description>` inside it.
5. Dismisses the boot-time dev-channels and trust-folder prompts automatically (background poller, 30s window).
6. Reports the tmux attach command and the state directory path.

## What it does NOT do

- Does NOT create any worktree or clone. The orchestrator does this in its Provision phase (`/worktree init` for `lead`, `git clone` for `repo-worker`).
- Does NOT write `state.md`. The orchestrator writes it at boot.
- Does NOT post to Slack. The caller (`router`) already posted the ack reply that anchored the topic.
- Does NOT monitor the sub-session. Once spawned, it returns.

## Delegate script

The wrapper takes 3 positional args and reads the persona / provisioning
strategy from env vars (`IA_TW_AGENT`, `IA_TW_PROVISION`,
`IA_TW_REPO_URL`). Prefix the invocation with whichever flags were
parsed; omit them to get the `lead` + `worktree-local` defaults.

```bash
# Default — lead with worktree provisioning:
!bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/start-lead.sh" \
  "<feature-name>" "<topic-string-or-empty>" "<description>"

# Non-default — e.g. repo-worker with clone provisioning:
!IA_TW_AGENT="<agent>" IA_TW_PROVISION="<provision>" IA_TW_REPO_URL="<repo-url>" \
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
