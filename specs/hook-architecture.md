# Spec — Hook architecture by purpose

**Branch:** follow-up to `fix/session-end-determinism`
**Status:** exploratory — for review, not yet wired in.

## Goal

Hooks today are named after the Claude Code event they listen to
(`task-completed.sh`, `enforce-worktree.sh`, `session-end.sh`). That
naming has decayed into multi-purpose scripts:

- `task-completed.sh` enforces invariants 2 + 3 (block on missing
  markers), audits the completion to `hook-audit.log`, **and** now writes
  the structured `events:` block + `local_phase` transitions.
- `session-end.sh` extracts learnings, writes lead memory, writes per-
  agent memory, **and** opens chore PRs in consumer repos.

Three problems follow from that:

1. **Mixed enforcement and side-effects.** A script that can `exit 2` to
   block a task and a script that just appends prose to a markdown file
   should not share the same binary — one bug in the bookkeeping path
   can take down task completion.
2. **No place to grow detection logic.** We want to capture
   user-correction signals (retracts, plan edits, mid-flight Slack
   messages, task reopens). Their inputs come from at least four
   different events. With event-named scripts we either fan the logic
   out to 4 files or pile it into one file that fights its own event
   contract.
3. **Hard to evolve.** Adding "detect retract" means touching multiple
   event scripts and remembering which ones are allowed to block and
   which aren't.

This spec proposes reorganizing the plugin hooks by **purpose**, while
keeping Claude Code's hook contract intact at the event boundary.

## Invariant we must NOT break

Claude Code hooks are event-driven at the harness layer. You cannot
invent your own events. `hooks.json` still binds scripts to one of the
documented event names (`PreToolUse`, `PostToolUse`, `TaskCreated`,
`TaskCompleted`, `TeammateIdle`, `UserPromptSubmit`, `SessionStart`,
`SessionEnd`). The reorg is purely on the script side; the JSON keeps
mapping events to scripts.

The four plugin invariants from `AGENTS.md` (approval gate, QA-first,
security-APPROVED-per-PR, `/pr`-only-path-to-main) remain enforced; the
scripts that enforce them just live in a different directory.

## Three buckets

```
plugins/team-workflow/hooks/scripts/
├── enforcement/
│   ├── enforce-worktree.sh
│   ├── enforce-task-invariants.sh
│   └── enforce-teammate-idle.sh
├── bookkeeping/
│   ├── record-state-event.sh
│   └── update-local-phase.sh
└── intelligence/
    ├── detect-user-correction.sh
    ├── detect-retract.sh
    └── extract-memory-signal.sh
```

Each bucket has a fixed contract.

### `enforcement/` — may block

- Single responsibility: guard one invariant.
- May `exit 2` with feedback on stderr; the harness blocks the tool call
  or task completion.
- Reads only the payload + filesystem; never invokes `claude -p`, never
  writes user-facing files (`state.md`, memory).
- Fast: must return in < 100 ms in the happy path.

Current → target mapping:

| Current script              | Target                                              |
|-----------------------------|-----------------------------------------------------|
| `enforce-worktree.sh`        | `enforcement/enforce-worktree.sh` (unchanged)       |
| `task-completed.sh` (block part) | `enforcement/enforce-task-invariants.sh`         |
| `teammate-idle.sh`           | `enforcement/enforce-teammate-idle.sh` (unchanged)  |
| `tool-guard.sh`              | `enforcement/enforce-tool-policy.sh`                |

### `bookkeeping/` — side-effect only

- Records structured state. Always `exit 0`.
- Outputs are deterministic transformations of payload + state.md.
- May not call `claude -p` (latency budget too tight; bookkeeping must
  not delay task completion).
- Idempotent — running the same script twice on the same payload yields
  the same final state.

Current → target mapping:

| Current responsibility                            | Target                                  |
|---------------------------------------------------|-----------------------------------------|
| `task-completed.sh` (audit-log append + events:)  | `bookkeeping/record-state-event.sh`     |
| `task-completed.sh` (local_phase update)          | `bookkeeping/update-local-phase.sh`     |
| `task-created.sh` (audit only)                    | `bookkeeping/record-state-event.sh`     |

### `intelligence/` — signal extraction, may use LLM

- Detects high-value signals (user correction, retract, repeated
  question, completion pattern) and emits structured events / memory.
- May `exit 0` even on errors — best-effort.
- May call `claude -p` (Haiku) for cheap classification, but must
  degrade gracefully when CLI is unavailable (fall back to deterministic
  heuristic or skip).
- Runs **after** enforcement and bookkeeping in the hook chain.

New scripts:

| Script                          | Listens to                                              | Output                                                |
|---------------------------------|---------------------------------------------------------|-------------------------------------------------------|
| `detect-user-correction.sh`     | `UserPromptSubmit`, `PostToolUse(slack.*reply)`         | `events:{kind: user_correction, note, source, ts}`    |
| `detect-retract.sh`             | `PostToolUse(Edit\|Write)` on `state.md`                | `events:{kind: marker_retracted, wt_prefix, ts}`      |
| `detect-task-replaced.sh`       | `TaskCreated` with `metadata.replaces`                  | `events:{kind: task_replaced, old_id, new_id, ts}`    |
| `detect-coverage-gate.sh`       | `PostToolUse(Bash)` matching push pre-hook failure      | `events:{kind: coverage_gate_iteration, wt_prefix}`   |
| `extract-memory-signal.sh`      | `SessionEnd`                                            | Calls existing memory extraction; routes feedback     |
|                                 |                                                         | candidates into auto-memory `feedback_<slug>.md`.     |

## hooks.json shape

Each event binds to scripts in **fixed priority order**: enforcement →
bookkeeping → intelligence. Enforcement runs first because it can block.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command",
                    "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/enforcement/enforce-worktree.sh" }]},
      { "matcher": "Bash|Edit|Write|MultiEdit|WebFetch",
        "hooks": [{ "type": "command",
                    "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/enforcement/enforce-tool-policy.sh" }]}
    ],
    "TaskCompleted": [
      { "hooks": [
          { "type": "command", "command": "bash .../enforcement/enforce-task-invariants.sh" },
          { "type": "command", "command": "bash .../bookkeeping/record-state-event.sh" },
          { "type": "command", "command": "bash .../bookkeeping/update-local-phase.sh" },
          { "type": "command", "command": "bash .../intelligence/detect-retract.sh" }
      ]}
    ],
    "TaskCreated": [
      { "hooks": [
          { "type": "command", "command": "bash .../bookkeeping/record-state-event.sh" },
          { "type": "command", "command": "bash .../intelligence/detect-task-replaced.sh" }
      ]}
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
                    "command": "bash .../intelligence/detect-user-correction.sh" }]}
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command",
                    "command": "bash .../intelligence/detect-coverage-gate.sh" }]},
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command",
                    "command": "bash .../intelligence/detect-retract.sh" }]}
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command",
                    "command": "bash .../intelligence/extract-memory-signal.sh" }]}
    ]
  }
}
```

Reading priority is left-to-right within each event block. The harness
fires them sequentially; an enforcement `exit 2` short-circuits and
skips the rest of that event's chain — exactly the behavior we want.

## Hard rules for scripts

1. **One bucket per script.** Never mix enforcement and bookkeeping in
   the same file. Splitting them is the whole point.
2. **Always dispatch on `hook_event_name`.** Claude Code includes
   `hook_event_name` in every payload. Purpose-driven scripts that
   listen to N events must dispatch on it, not on payload shape
   sniffing.
3. **Intelligence scripts exit 0 always.** Even on parse failure.
   Logging via `>> "$state_dir/hook-audit.log"` is allowed; blocking is
   not.
4. **Bookkeeping is idempotent.** Use dedupe keys (e.g. `ts + subject +
   kind`) when appending events. SessionEnd may dedupe downstream, but
   the writer should not produce trivial duplicates.
5. **No `claude -p` in bookkeeping or enforcement.** That budget belongs
   to intelligence + session-end.
6. **All scripts read state via `$IA_TW_STATE_DIR`** when present, and
   fall back to v1 layout (`$cwd/.sessions/<label>/`) when not — same
   contract as today.
7. **Header doc-comment must declare the bucket + responsibility.**
   First 10 lines of every script:
   ```bash
   #!/usr/bin/env bash
   # Bucket: enforcement | bookkeeping | intelligence
   # Listens to: <event names>
   # Responsibility: <one sentence>
   # Blocking: yes (exit 2) | no (exit 0 always)
   ```

## Migration plan

Three commits, each independently revertable.

### Commit 1 — Move (no behavior change)

- Create `enforcement/`, `bookkeeping/`, `intelligence/` directories.
- Move existing scripts into `enforcement/` (their dominant
  responsibility today).
- Update `hooks.json` paths.
- Verify: existing tests + the dry-run from
  `fix/session-end-determinism` still pass.

### Commit 2 — Split mixed scripts

- Split `enforcement/task-completed.sh` (renamed from current
  `task-completed.sh`) into two scripts:
  - `enforcement/enforce-task-invariants.sh` (block path)
  - `bookkeeping/record-state-event.sh` + `bookkeeping/update-local-phase.sh`
    (side-effect path; lifted out of the enforcement script)
- `hooks.json` lists them in order: enforcement → bookkeeping.
- Verify: dry-run shows identical `state.md` deltas as before the split.

### Commit 3 — Add intelligence scripts

- Add `intelligence/detect-retract.sh`, `detect-user-correction.sh`,
  `detect-task-replaced.sh`, `detect-coverage-gate.sh`.
- Add `intelligence/extract-memory-signal.sh` that wraps the current
  `session-end.sh` body and routes detected user-corrections into
  auto-memory `feedback_<slug>.md` files (per the auto-memory schema:
  `name`, `description`, `metadata.type: feedback`, body with `Rule /
  Why / How to apply`).
- Each script is small and self-contained; landing them one at a time
  is safe.

## Testing strategy

A purpose-driven script gets tested with N payload fixtures (one per
event it listens to). Fixtures live under
`plugins/team-workflow/hooks/__tests__/fixtures/<event-name>/`.

Minimum coverage per script:
- Happy-path: signal present → expected output.
- Negative: signal absent → no-op output, exit 0.
- Malformed payload: script does not crash; exit 0; nothing written.

`enforcement/` scripts get an additional negative test: missing marker
→ exit 2 with the expected stderr message.

## Open questions

1. **Where does `detect-user-correction.sh` get the Haiku verdict cached?**
   If `UserPromptSubmit` fires often during a Slack-heavy session, the
   classifier could add real cost. Options: (a) sample 1-in-N and only
   classify mid-`implementing` phase; (b) require an explicit marker
   word ("no", "stop", "deberías") before invoking; (c) batch
   classification on `SessionEnd` only.
2. **Async or sync intelligence?** Today hooks are synchronous. A slow
   intelligence script delays the next task. Worth considering a
   fire-and-forget pattern (background bash + lockfile) for the
   non-blocking layer.
3. **Auto-memory mirror placement.** Settled in
   `fix/session-end-determinism` follow-up: `intelligence/
   extract-memory-signal.sh` writes both the per-consumer-repo
   `agent-memory/` (current behavior) and the auto-memory dirs
   `~/.claude/projects/<encoded>/memory/` (new; one entry per touched
   repo + one at `IA_TW_ROOT_DIR` for orchestration-level lessons).

## What this does NOT change

- Claude Code's hook contract (event names, JSON shape, exit-code
  semantics).
- The four invariants in `AGENTS.md`.
- `state.md` schema (already deterministic after
  `fix/session-end-determinism`).
- The plugin's frontmatter limitations (no `hooks` / `mcpServers` /
  `permissionMode` in plugin agents).

## Success criteria

- Each script's first 10 lines say which bucket it lives in and what
  one thing it does.
- Adding a new detector ("detect-figma-spec-mismatch") requires creating
  one file in `intelligence/` and editing `hooks.json` once — no
  changes to enforcement or bookkeeping.
- Memory entries of type `feedback` appear automatically in auto-memory
  dirs after a session ends, derived from `events:{kind:
  user_correction | marker_retracted | task_replaced}`.
- No regression in TaskCompleted latency or block behavior (measured
  against pre-refactor baseline).
