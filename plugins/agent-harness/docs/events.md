# `harness-events.log` — the improvement loop

The improvement loop of harness engineering needs a trace of *what
each stage decided and what came of it*. That trace lives here.

## Format

JSON Lines, append-only. One event per line.

```jsonc
{
  "ts": "2026-06-07T20:14:00Z",
  "session_id": "feat-x_a1b2c3d4e5f6",
  "stage": "repo-detect",
  "kind": "decision | sensor | outcome | error",
  "summary": "<one-line human description>",
  "data": { /* stage-specific */ }
}
```

## Conventions

- `kind: decision` — stage made a choice (e.g. picked 3 repos).
- `kind: sensor`   — a guard fired (linter, judge, gate).
- `kind: outcome`  — final result of the stage (success/skip/fail).
- `kind: error`    — unhandled failure, includes stack/context.

## Why

The log is the input to **harness improvement**: scan for repeating
failure modes per stage, then add a guide (prevent it) or a sensor
(catch it). It is also the audit trail when operators replay a
session.

## Retention

The log lives next to `state.yaml` inside the session workspace. On
archival of the session, the log is preserved verbatim — it is the
primary artifact future stages of improvement work from.
