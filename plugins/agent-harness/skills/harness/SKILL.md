---
name: harness
description: >
  Drive the agent-harness pipeline as an operator. Subcommands: `run "<request>"`
  (full pipeline up to dispatch), `next` (advance the current session by one
  stage), `status [<id>]` (show state.yaml + recent events), `resume <id>`
  (continue an existing session), `dispatch [--dry-run]` (execute the plan).
argument-hint: "run \"<request>\" | next | status [<id>] | resume <id> | dispatch [--dry-run]"
disable-model-invocation: false
---

# /harness — operator UI over the agent-harness pipeline

Thin wrapper over `${CLAUDE_PLUGIN_ROOT}/stages/<name>/run.sh`. Each
subcommand maps to one or more stage invocations and reports back. The
skill itself does no LLM work; reasoning happens inside the stages.

## Arguments

| First token              | Action |
|--------------------------|--------|
| `run "<request>"`        | Bootstrap a session from a new request and run stages 1–6 (intake → task-plan). |
| `next`                   | Run the next pending stage of the most recently touched session. |
| `list [--all]`           | One line per session (id, phase, updated_at, task summary). Top 10 by default. |
| `status [<id>]`          | Print the state.yaml summary + last 10 events. Defaults to the most recent session. |
| `resume <id>`            | Identify session `<id>` (slug or `slug_hash`) and run `next` against it. |
| `dispatch [--dry-run]`   | Execute the task plan. `--dry-run` validates the loop without spawning per-task `claude -p`. |
| _(empty)_                | Print usage and stop. |
| anything else            | Print `unknown subcommand <x>` and stop. |

## Preconditions

| Condition | Action |
|-----------|--------|
| `yq` or `jq` not on PATH | STOP — "yq and jq are required. Install: `brew install yq jq`." |
| `${AGENT_HARNESS_HOME:-$HOME/.agent-harness}` missing | Auto-created by `stages/intake/run.sh` on first `run`. |
| `run` called without a request | STOP — "usage: /harness run \"<request>\"". |
| `resume` / `status <id>` called with no matching session dir | STOP — list available sessions and exit. |

## Steps — `run`

1. Resolve session id (always through `lib/session.sh` so other
   callers compute the same id for the same input):
   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   source "$PLUGIN/lib/config.sh"
   source "$PLUGIN/lib/session.sh"
   REQ="$1"
   SESSION_ID="$(session_id_for "$REQ")"
   SESSION_DIR="$(session_dir_for "$SESSION_ID")"
   STATE="$(state_file_for "$SESSION_ID")"
   ```
2. Run stages in order; stop at the first failure:
   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   bash "$PLUGIN/stages/intake/run.sh"      "$STATE" "$REQ"        || exit 1
   bash "$PLUGIN/stages/repo-detect/run.sh" "$STATE"                || exit 1
   bash "$PLUGIN/stages/repo-fetch/run.sh"  "$STATE"                || exit 1
   bash "$PLUGIN/stages/worktree/run.sh"    "$STATE"                || exit 1
   bash "$PLUGIN/stages/agent-scan/run.sh"  "$STATE"                || exit 1
   bash "$PLUGIN/stages/task-plan/run.sh"   "$STATE"                || exit 1
   ```
3. Print the final plan block (see `agents/harness.md` § Output format).
   Always print the absolute `$STATE` path on the last line so the
   operator can copy/paste.

## Steps — `next`

1. Find the most recently touched session via
   `$(latest_session_dir)` (from `lib/session.sh`).
2. Read its `phase`.
3. Run the next stage according to this map:

   | Current phase | Next script |
   |---------------|-------------|
   | (no file)     | refuse — `/harness next` needs an existing session |
   | `intake`      | `repo-detect` |
   | `repo-detect` | `repo-fetch`  |
   | `repo-fetch`  | `worktree`    |
   | `worktree`    | `agent-scan`  |
   | `agent-scan`  | `task-plan`   |
   | `task-plan`   | `dispatch` (via `/harness dispatch`) |
   | `dispatch`    | resume `dispatch` (re-run; idempotent on completed tasks) |
   | `done`        | print "session done" and stop |

## Steps — `status`

1. Resolve the session as in `next` (or use `<id>` argument).
2. Print:
   ```
   Session:  <id>
   Phase:    <phase>
   Repos:    <names from .repos.local[]>
   Tasks:    <n total> (<n done>/<n pending>/<n failed>/<n skipped>)
   ```
3. Print the last 10 events from `harness-events.log`:
   ```bash
   tail -n 10 "$SESSION_DIR/harness-events.log" \
     | jq -r '.ts + "  [" + .stage + "/" + .kind + "] " + .summary'
   ```
4. Print the state file path on the last line.

## Steps — `resume`

1. Resolve via `bin/harness-sessions.sh resume "<id>"` — prints the
   matching session dir on stdout. Exit codes: 0 ok, 1 no match,
   2 ambiguous (multiple matches printed to stderr).
2. If exactly one matches, treat that session as current and run
   `next`.
3. If multiple match, print the candidates and stop.
4. If none match, print "no matching session" and stop.

## Steps — `dispatch`

1. Resolve session as in `next`.
2. Run `stages/dispatch/run.sh "$STATE"`. Forward `--dry-run` if
   given.
3. After exit, print a one-line summary derived from the last
   `dispatch/outcome` event.

## Output format

Every subcommand ends with three lines:

```
✓ <subcommand>: <one-line summary>
state: <abs path to state.yaml>
events: <abs path to harness-events.log>
```

`run` prints, before those three lines, the per-worktree task block
described in `agents/harness.md` § Output format.

## Error handling

| Condition | Behavior |
|-----------|----------|
| A stage exits non-zero | Surface its stderr verbatim and stop. `state.yaml` is owned by the stage scripts — wait for the user to resolve before re-running. |
| Multiple sessions match `status` / `resume` | List them and stop. |
| `dispatch` reports pending tasks after a run | Suggest `/harness dispatch` again or `/harness status` to inspect. |

## Scope

Own: invoking stage scripts and presenting their results to the
operator.

Boundaries: no LLM calls of its own, no editing of `state.yaml`
beyond what the stage scripts do. The skill is a UI; reasoning
lives in the stages and in the `harness` agent.
