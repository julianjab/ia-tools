# agent-harness

Composable harness for coding-agent workflows, grounded in
[harness engineering](https://martinfowler.com/articles/harness-engineering.html):
**Agent = Model + Harness**. This plugin is the harness — a pipeline of
swappable stages, connected by a single file contract, with an event
log that feeds the harness improvement loop.

## Design goals

- **Composable.** Add, remove, or replace any stage without touching
  the others.
- **Agnostic between stages.** The only contract is `state.yaml`. A
  stage reads the sections it needs and writes its own.
- **Agnostic to workflow opinions.** The harness imposes NO role
  taxonomy (no `impl`/`qa`/`sec`/`arch`), NO ordering invariants
  (no "QA first", no "security before PR"), NO delivery shape (no
  required `/pr`, no Slack, no tmux). It discovers what each repo
  ships and works with that. Workflows like `team-workflow` are
  consumers built on top — never assumed below.
- **Resumable.** Pipeline state lives on disk; any stage can be
  re-run, skipped, or replayed.
- **Self-improving.** Every stage emits structured events to
  `harness-events.log`. Patterns of failure feed back into
  guides/sensors.
- **Standalone.** No dependency on `team-workflow`, Slack, or tmux.
  Other plugins may opt in to call it.

## Pipeline (initial draft)

| # | Stage         | Harness role             | Output section in `state.yaml` |
|---|---------------|--------------------------|--------------------------------|
| 1 | `intake`      | Guide / inferential      | `intake.intent`, `intake.signals` |
| 2 | `repo-detect` | Guide / inferential      | `repos.candidates`             |
| 3 | `repo-fetch`  | Guide / computational    | `repos.local`                  |
| 4 | `worktree`    | Guide / computational    | `worktrees[]`                  |
| 5 | `agent-scan`  | Guide / inferential      | `worktrees[].agents`           |
| 6 | `task-plan`   | Guide / inferential      | `tasks[]`                      |
| 7 | `dispatch`    | Agent loop               | `tasks[].status`, `runs[]`     |

Sensors (linters, tests, gates, LLM-as-judge) attach to specific
stages or run transversally. The pipeline can be invoked end-to-end
or one stage at a time.

## Status

`v0.1.0` — directory skeleton + design contract. No stages
implemented yet. See `docs/state-contract.md` for the `state.yaml`
schema (forthcoming).
