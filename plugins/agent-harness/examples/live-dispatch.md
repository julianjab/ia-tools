# Live dispatch — recipe and what it validates

This example walks through running the harness end-to-end against a
sandbox of two empty repos, then executing the planned tasks for
real (no `--dry-run`). It is the integration test for the dispatch
stage.

## Setup

```bash
ROOT=/tmp/agent-harness-live
mkdir -p $ROOT/{origins,catalog,harness-home}

# Two bare origins
for r in customer-api mobile-app; do
  git init --bare -q $ROOT/origins/$r.git -b main
  git clone -q $ROOT/origins/$r.git $ROOT/catalog/$r
  mkdir -p $ROOT/catalog/$r/.claude/agents
done
```

Drop a minimal agent per repo at `$ROOT/catalog/<repo>/.claude/agents/<name>.md`.
For a smoke test the agent body can be a one-step "write a marker
file" instruction. Use `tools: Write, Read` — `Read` is required by
Claude's safety check even when the target file does not yet exist.

Commit and push the agents to the bare origin so worktrees can
branch off them.

## Run the pipeline

```bash
export AGENT_HARNESS_HOME=$ROOT/harness-home
export AGENT_HARNESS_SESSION_ROOT=$ROOT/harness-home/sessions
export AGENT_HARNESS_REPO_ROOTS=$ROOT/catalog

PLUGIN=/path/to/plugins/agent-harness
REQ="crear endpoint customer y mostrar vista en app"
SLUG="live-customer"
HASH=$(printf '%s' "$REQ" | shasum | cut -c1-8)
STATE=$AGENT_HARNESS_SESSION_ROOT/${SLUG}_${HASH}/state.yaml

bash $PLUGIN/stages/intake/run.sh      $STATE "$REQ"
bash $PLUGIN/stages/repo-detect/run.sh $STATE
bash $PLUGIN/stages/repo-fetch/run.sh  $STATE
bash $PLUGIN/stages/worktree/run.sh    $STATE --branch feat/live-test
bash $PLUGIN/stages/agent-scan/run.sh  $STATE
bash $PLUGIN/stages/task-plan/run.sh   $STATE
bash $PLUGIN/stages/dispatch/run.sh    $STATE        # live
```

`dispatch/run.sh` spawns one `claude -p` per ready task with:

- `--add-dir <worktree>` so the worktree-local `.claude/agents/` are
  visible.
- `--agent <assigned_to>` so the chosen agent runs.
- `--permission-mode acceptEdits` so Write / Edit run without a
  human prompt. Override per-shell with
  `AGENT_HARNESS_DISPATCH_PERMISSION_MODE`.
- `--output-format json` so the full transcript is captured to
  `<session>/runs/<task-id>.json`.

## What success looks like

```
▶ [customer-api.customer-endpoint] api-developer @ customer-api: "..."
▶ [mobile-app.customer-view] flutter-developer @ mobile-app: "..."
✓ dispatch complete — 2 done, 0 failed, 0 skipped, 0 pending
```

`state.yaml`:
- `.tasks[].status` flips to `completed` / `failed` per task.
- `.runs[]` records the per-task run file + status + reason.
- `.phase` advances to `done` only when no task is pending or failed.

`harness-events.log` gains:
- one `dispatch/outcome` event per finished task.
- one final `dispatch/outcome` summary event (totals).

## What dispatch does NOT validate

The dispatcher treats a `claude -p` exit 0 as success. It does NOT
check what the agent actually produced. Semantic correctness of the
work is a task for a **sensor**, not the dispatcher.

Fixture agents in this example sometimes ignore their own body and
ask clarifying questions (which then fail under
`--permission-mode acceptEdits`, since `AskUserQuestion` isn't a
file-edit). When this happens the dispatcher still reports
"completed" because `claude -p` exited cleanly. That is intentional:
the harness is workflow-agnostic and does not impose a "did the
agent honor its prompt" check. Add a sensor per task if you need
that guarantee.

## Reuse for CI

The recipe above is deterministic enough to script. Wire it into
`bin/harness-eval.sh` as a `dispatch` stage runner once a fixture
captures the bare-repo bootstrap as data rather than as an inline
script.
