---
name: router
description: >
  Spawn the main `router` agent in a detached tmux session, subscribed
  to a Slack topic. Hides the `--dangerously-load-development-channels`
  flag in the wrapper script so the operator doesn't type it on every
  boot. Use this once per machine to get the always-on router
  listening; `/session` then handles per-feature sub-sessions. Trigger
  words: "start router", "boot router", "levanta el router".
argument-hint: "<slack-topic> [tmux-session-name]"
disable-model-invocation: false
---

## /router — Boot the router agent

`/router` spawns the always-on Slack router in a detached tmux
session. The `router` agent classifies every inbound message and
dispatches `lead` sub-sessions on `dispatch` intent. It's the
counterpart to `/session` (which boots one `lead` per feature) — you
need exactly one router running per machine.

### Argument parsing

Tokenize `$ARGUMENTS`:

| Token shape | Extract into |
|---|---|
| First positional matching `DM:U.*` / `C.*` / `C.*:\*:<ts>` | `TOPIC` |
| Second positional (no `.` or `:`) | `SESSION_NAME` (default: `sm`) |
| Anything else | reject with usage hint |

If `TOPIC` is empty → STOP with `Usage: /router <slack-topic> [tmux-session-name]`.

### Step 1 — Verify dependencies

| Check | If false |
|---|---|
| `command -v tmux` succeeds | STOP — "tmux not installed" |
| `command -v claude` succeeds | STOP — "claude CLI not on PATH" |
| slack-bridge daemon reachable on `http://localhost:3800/health` (best-effort probe) | warn but continue (the MCP will retry) |

### Step 2 — Invoke the wrapper script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/router/scripts/start-router.sh" \
  "<TOPIC>" "<SESSION_NAME or empty>"
```

The wrapper:

1. Refuses if a tmux session with that name is already running (the
   router is meant to be a singleton).
2. Exports `SLACK_TOPICS=<TOPIC>` so the slack-bridge MCP
   auto-subscribes at init and persists the subscription to
   `/tmp/slack-bridge/<session-id>/slack-bridge.json` (per the
   persistence fix shipped in this PR).
3. Spawns `claude --agent team-workflow:router
   --dangerously-load-development-channels plugin:slack-bridge@ia-tools
   --dangerously-skip-permissions` inside the tmux session.
4. Starts a 30s background poller that dismisses the dev-channels
   and trust-folder prompts automatically.

### Step 3 — Report

```
✅ Router booted
   tmux:     <SESSION_NAME>
   topic:    <TOPIC>
   attach:   tmux attach -t <SESSION_NAME>
   state:    /tmp/slack-bridge/<session-id>/slack-bridge.json (auto-populated)
```

### What it does NOT do

- Does NOT spawn any lead. That's `/session`'s job, invoked
  later by the running router on `dispatch` intent.
- Does NOT create a worktree. The router is read-only on the codebase.
- Does NOT support multiple topics in one call. If you need multiple
  subscriptions (e.g. DM + channel), supply them comma-separated in
  `TOPIC` — `SLACK_TOPICS` accepts a comma-separated list.

### Error handling

| Situation | Action |
|---|---|
| `TOPIC` empty | Reject with usage hint. |
| `SESSION_NAME` contains `.` or `:` | Reject (tmux target syntax). |
| tmux session with same name already exists | Warn and reuse; do not relaunch claude. |
| `tmux` or `claude` not on PATH | Abort with install hint. |
| slack-bridge daemon not running | Warn — the MCP will run in read-only mode until the daemon is up. |

### Examples

```bash
# Most common: subscribe to your DM channel with the bot
/router DM:U02M1QFA0AF

# Custom tmux session name
/router DM:U02M1QFA0AF main-router

# Subscribe to a public channel where the bot is invited
/router C06Q8SNF93P

# Subscribe to one specific thread (rare — usually for testing)
/router "C06Q8SNF93P:*:1778078158.577219"
```

### Relationship to other skills

- **`/router`** — spawns ONE router per machine. Read-only.
- **`/session`** — spawns ONE lead per feature. Boots inside a
  worktree. Invoked by the router on `dispatch` intent.
- **`/worktree init`** — invoked by lead per touched repo;
  auto-runs `/add-dir`.
