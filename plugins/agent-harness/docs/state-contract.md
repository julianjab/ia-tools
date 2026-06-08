# `state.yaml` — the only contract between stages

Every stage of the pipeline reads `state.yaml`, mutates the section it
owns, and writes it back. No stage reads or writes another stage's
section. This is the single coupling point.

## Layout (draft)

```yaml
# ─── meta ──────────────────────────────────────────────────────────
version: 1
session_id: <slug>_<hash>   # stable across reruns
created_at: <ISO8601>
updated_at: <ISO8601>
phase: intake | detect | fetch | provision | scan | plan | dispatch | done

# ─── stage 1: intake ───────────────────────────────────────────────
intake:
  request_raw: <string>          # the user message verbatim
  intent: feature | fix | refactor | review | question
  signals:                       # extracted hints, not commitments
    repos_hint: [<string>]
    stack_hint: [<string>]
    scope_hint: <string>

# ─── stage 2: repo-detect ──────────────────────────────────────────
repos:
  candidates:
    - name: <basename>
      remote: <url|null>
      reason: <why this repo was selected>
      confidence: high | medium | low

# ─── stage 3: repo-fetch ───────────────────────────────────────────
  local:
    - name: <basename>
      path: <abs>
      head: <sha>
      fetched_at: <ISO8601>

# ─── stage 4: worktree ─────────────────────────────────────────────
worktrees:
  - repo: <basename>
    path: <abs>
    branch: <feature-branch>
    base: <ref>

# ─── stage 5: agent-scan ───────────────────────────────────────────
    agents:                            # flat list, no fixed taxonomy
      - id: <agent-id>
        description: <one-line>        # raw, from the agent's frontmatter
        source: <abs-path-or-plugin>

# ─── stage 6: task-plan ────────────────────────────────────────────
tasks:
  - id: <stable-id>
    worktree: <basename>
    assigned_to: <agent-id|null>       # picked by task-plan from the
                                       # worktree's agents list, by
                                       # semantic match — no role bucket
    title: <string>
    blockedBy: [<task-id>]
    status: pending | in_progress | done | failed

# ─── stage 7: dispatch ─────────────────────────────────────────────
runs:
  - task_id: <stable-id>
    started_at: <ISO8601>
    finished_at: <ISO8601>
    outcome: success | retry | escalate
    artifacts: [<path>]
```

## Rules

1. A stage writes ONLY its section. Cross-section writes are bugs.
2. A stage MAY read any section it depends on; it MUST tolerate
   missing optional fields.
3. Every write bumps `meta.updated_at`.
4. Every stage also appends one or more events to
   `harness-events.log` (see `docs/events.md`).
5. The file is YAML for human edit-ability. Stages must round-trip
   unknown keys (do not drop fields they don't recognize).

## Why YAML, not JSON

Stages should be debuggable by hand. Operators will edit
`state.yaml` to retry, skip, or override stages. YAML keeps that
ergonomic.
