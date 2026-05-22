---
name: session
description: >
  Spawn a Claude orchestrator sub-session in tmux (default) or iTerm2 (via osascript, when IA_TW_TERMINAL=iterm or as fallback if tmux is missing).
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
argument-hint: "[<feature-name> [--topic <topic>] [--agent <plugin:name>] [--topic-worker-agent <plugin:name>] [--provision worktree-local|clone] [--repo-url <url>] [--repo-urls <csv>] --description <text>] | rehydrate [--feature <name> | --state-dir <abs path>]"
disable-model-invocation: false
---

## /session — Sub-session lifecycle (spawn + rehydrate)

`/session` is a dispatcher on its first positional token:

| First token | Sub-command | Purpose |
|---|---|---|
| `rehydrate` | `rehydrate` | Re-register every active worktree of an existing session via `/add-dir` and regenerate its `.claude/settings.local.json`. Use after `/compact`, `/clear`, or a fresh `/resume` when repo-local agent spawns start failing with "agent type not found", or after an `ia-tools` update changed the per-session settings schema. |
| anything else (a `<feature-name>`) | `spawn` (default) | Open a fresh terminal host (tmux by default, iTerm2 on demand) running Claude Code with the `lead` agent preloaded. The lead owns the downstream flow: plan, approval gate, worktree provisioning per touched repo, agent discovery, task list, dispatch loop, PR creation. |

The spawn flow is documented below from "Terminal host" onward.
`rehydrate` lives in its own section near the end (`## Sub-command: rehydrate`).

### Terminal host

Selection is driven by the `IA_TW_TERMINAL` env var:

| `IA_TW_TERMINAL` | Behavior |
|---|---|
| unset / `auto` (default) | tmux if installed, else iTerm2, else abort with install hint. |
| `tmux` | Detached tmux session named `<feature>`. Fail if tmux missing. |
| `iterm` | New iTerm2 window driven by AppleScript. Fail if iTerm2 missing. |

Default is tmux-first because the rest of the system — notably
`/send-session-message` — speaks tmux send-keys natively.
`/send-session-message` auto-detects the host (tmux first, iTerm2
fallback), so iTerm2-hosted leads still receive forwarded messages.

If neither host is available the wrapper exits with code 2 and prints
install instructions (`brew install tmux` or `https://iterm2.com`).

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
5. Dismisses the boot-time dev-channels and trust-folder prompts automatically (background poller, 30s window). Works on both hosts: tmux uses `capture-pane` + `send-keys Enter`; iTerm2 uses `contents of session` + `write text "" newline YES`.
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
| Neither tmux nor iTerm2 available (default `auto`) | Exit 2 with install hint (`brew install tmux` / `https://iterm2.com`); nothing spawned. |
| `IA_TW_TERMINAL=tmux` and tmux missing | Exit 2; print `brew install tmux`. |
| `IA_TW_TERMINAL=iterm` and iTerm2 missing | Exit 2; print iTerm2 install URL. |
| `claude` not on PATH | Abort with install hint; nothing spawned. |
| tmux session `<feature-name>` already exists | Warn and reuse; do not relaunch claude. |
| iTerm2 window with the same session name already exists | A new window is created; the previous one stays. Operator manages duplicates. |
| `<description>` contains newline or NUL | Reject. |

## Sub-command: `rehydrate`

**Purpose**: re-register every active worktree of an existing session
via `/add-dir`, and regenerate that session's
`$state_dir/.claude/settings.local.json` so envs + MCP servers match
the current spawner schema. Use after `/compact`, `/clear`, or a fresh
`/resume` when repo-local agent spawns start failing with "agent type
not found", or after an `ia-tools` update changed the per-session
settings layout. Works inside a lead session (auto-resolves from
`$IA_TW_STATE_DIR`) and outside one (lists every active session and
asks which to rehydrate).

After context loss the worktrees still exist on disk and `state.md`
still records them, but the Claude Code session forgot the `/add-dir`
registrations that `init` set up, and the per-session settings file
may be missing (e.g. blown away by a fresh checkout of state). This
sub-command repairs both.

### Arguments

| Form | Action |
|------|--------|
| `/session rehydrate` | Auto-resolve: use `$IA_TW_STATE_DIR` if set, else list every session via `scripts/list-sessions.sh` and prompt the operator to pick one. |
| `/session rehydrate --feature <name>` | Find the session whose `feature:` field matches `<name>` (substring match allowed) and rehydrate it. Errors if zero or multiple match. |
| `/session rehydrate --state-dir <abs path>` | Use the given state dir directly. Bypasses discovery and prompts. |
| `/session rehydrate ... --skip-settings` | Re-register worktrees only; do NOT regenerate `settings.local.json`. Use when the file is intentionally hand-edited. |

### Preconditions

| Condition | Action |
|-----------|--------|
| Helper script `worktree/scripts/active-worktrees.sh` missing | STOP — installation issue. |
| Helper script `worktree/scripts/list-sessions.sh` missing | STOP — installation issue. |
| Resolved `state.md` is missing | STOP — report the resolved path and ask the operator to check it. |

### Steps

1. **Resolve the target state dir**:
   - If `--state-dir <path>` was passed → use it.
   - Else if `--feature <name>` was passed → run
     `bash "${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/list-sessions.sh" --format tsv`
     and filter rows where `feature:` contains `<name>` (case-insensitive).
     One match → use its `state_dir`. Zero or multiple → report and exit.
   - Else if `$IA_TW_STATE_DIR` is set and the dir exists → use it.
   - Else → run `list-sessions.sh` (human format), present the numbered
     list to the operator, ask which row to rehydrate (via the
     `team-workflow:ask-user` skill, never raw `AskUserQuestion`), and
     use the selected row's `state_dir`.

2. **List active worktree paths** from the resolved state.md:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/active-worktrees.sh" \
        "<resolved-state-dir>/state.md"
   ```
   Empty output → report "No worktrees to rehydrate for <feature>"
   and continue to step 3 (settings can still be regenerated).

3. **Regenerate `settings.local.json`** unless `--skip-settings` was passed.
   Read the existing `state.md` frontmatter to recover the original
   spawn envs (`feature`, `topic`, `root_dir`, `agent`, `provision`,
   …) and the optional fields (`repo_url`, `repo_urls`,
   `repo_cache_dir`, `parent_sock`, `allowed_users_*`), then call:
   ```bash
   IA_TW_FEATURE="<feature>" \
   IA_TW_TOPIC="<topic-or-local>" \
   IA_TW_ROOT_DIR="<root_dir>" \
   IA_TW_STATE_DIR="<resolved-state-dir>" \
   IA_TW_AGENT="<agent>" \
   IA_TW_TOPIC_WORKER_AGENT="<topic_worker_agent>" \
   IA_TW_PROVISION="<provision>" \
   IA_TW_REPO_URL="<repo_url-or-empty>" \
   IA_TW_REPO_URLS="<repo_urls-or-empty>" \
   IA_TW_REPO_CACHE_DIR="<repo_cache-or-empty>" \
   IA_TW_PARENT_SOCK="<sock-or-empty>" \
   ALLOWED_USERS_DM="<dm-or-empty>" \
   ALLOWED_USERS_MENTIONS="<mentions-or-empty>" \
   DAEMON_URL="<daemon-or-empty>" \
     bash "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/generate-session-settings.sh" \
          "<resolved-state-dir>"
   ```
   The util writes `<state-dir>/.claude/settings.local.json` atomically.
   Skip silently if `jq` is missing (the util emits a warning).

4. **Always print the `/add-dir` commands** to the user before running
   them — this is the fallback path when `SlashCommand` cannot reach
   `/add-dir` in the current session. Output block:
   ```
   /session rehydrate — N worktrees to register for <feature>:
     /add-dir <path1>
     /add-dir <path2>
     /add-dir <path3>
   ```

5. **Re-register each path** by invoking `/add-dir <path>` via the
   `SlashCommand` tool. On failure (tool unavailable, permission
   denied), report which paths the operator must paste manually
   (taken from step 4's output).

6. **Verify by sampling**. Read the `.claude/agents/` listing of the
   first rehydrated worktree to confirm registration took effect.

### Output

```
/session rehydrate complete:
  feature:         <name>
  state_dir:       <abs path>
  settings:        regenerated | skipped (--skip-settings) | jq missing
  rehydrated:      <N>     (auto-registered via SlashCommand)
  printed-only:    <M>     (printed for manual paste — SlashCommand failed)
  skipped:         <list>  (terminal phases or paths that no longer exist)

Repo-local agents under each rehydrated worktree are now callable via
Agent(subagent_type=<name>).
```

### Error handling

| Condition | Action |
|-----------|--------|
| `active-worktrees.sh` prints nothing | Continue: regenerate settings if requested, then report "No worktrees to rehydrate" and exit 0. |
| `/add-dir` invocation fails for one path | Continue with remaining paths; include failures in the final report. |
| `generate-session-settings.sh` exits non-zero | Continue; print a warning. Worktree re-registration is still useful. |
