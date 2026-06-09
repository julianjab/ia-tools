# Changelog

All notable changes to the `agent-harness` plugin will be documented
in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/julianjab/ia-tools/compare/agent-harness-v0.1.0...agent-harness-v0.2.0) (2026-06-09)


### Features

* **agent-harness:** introduce composable harness plugin (v0.1.0) ([#132](https://github.com/julianjab/ia-tools/issues/132)) ([751cd2f](https://github.com/julianjab/ia-tools/commit/751cd2fd301acda6f3db4b9d79cb81335d5bf331))


### Bug Fixes

* **team-workflow:** release hook removal so installed consumers stop running it ([#128](https://github.com/julianjab/ia-tools/issues/128)) ([06eea39](https://github.com/julianjab/ia-tools/commit/06eea39886944f979a66c48c078d71703a1d02e7))

## [0.1.0] - 2026-06-08

Initial release.

### Features

- Composable pipeline: `intake` → `repo-detect` → `repo-fetch` →
  `worktree` → `agent-scan` → `task-plan` → `dispatch`.
- Single `state.yaml` contract per session; each stage reads/writes
  only its own section.
- `harness-events.log` (JSONL) per session for the improvement loop.
- Three inferential stages (`intake`, `repo-detect`, `task-plan`)
  driven by `claude -p --json-schema`.
- Dispatch spawns `claude -p` per task with the correct worktree,
  agent, and `--permission-mode acceptEdits`. Supports `--dry-run`.
- `agents/harness.md` orchestrator + `skills/harness/SKILL.md`
  operator UI.
- Per-user config at `~/.agent-harness/config.yaml`, per-repo overlay
  at `<repo>/.agent-harness/config.yaml`, env-var override.
- `bin/harness-improve.sh` aggregates events across sessions and
  reports per-stage error/skip patterns.
- `bin/harness-eval.sh` runs fixture-based evals on inferential
  stages; ships three intake fixtures.
- Workflow-agnostic by design: no role taxonomy, no ordering
  invariants, no dependency on `team-workflow`, Slack, or tmux.
