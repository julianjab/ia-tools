---
name: scope-check
description: >
  Analyse the scope of a user request to determine which consumer repos are
  touched, then return a structured verdict. Invokes the orchestrator as a
  one-shot inline subagent in scope-check mode. Does NOT create a worktree,
  does NOT open a tmux window, does NOT subscribe to Slack. Returns one of
  three verdicts: read-only, inline, or new-session.
  Used by session-manager before deciding whether to open a full sub-session
  via /session.
  Examples:
    `/scope-check --description "agrega tracking de pagos que se refleje en la app y el backend"`
    `/scope-check --description "implementa auth con Google" --task-label feat-google-auth`
argument-hint: "--description \"<raw user message>\" [--task-label <slug>]"
disable-model-invocation: false
---

## /scope-check — Inline Scope Analysis

`/scope-check` invokes the orchestrator as a **one-shot inline subagent** in
`scope-check` mode. It does NOT open a tmux window, does NOT create a worktree,
and does NOT subscribe to Slack. It produces three files in
`.sessions/<task-label>/` and returns a verdict JSON block.

`session-manager` calls this skill when it classifies a message as
`scope-check` (ambiguous multi-repo scope). The returned verdict tells
session-manager how to route the request.

## Contract

```
/scope-check --description "<raw user message>" [--task-label <slug>]
```

| Flag | Required? | Purpose |
|------|-----------|---------|
| `--description "<text>"` | ✅ | The raw user message being classified. Passed verbatim to the orchestrator. |
| `--task-label <slug>` | ❌ | Explicit kebab-case slug override for the task label. Defaults to a slug derived from the description using the same rules as session-manager branch naming. |

## What /scope-check does, in order

1. **Derive task label** from `--task-label` if provided, otherwise slugify
   `--description` (lowercase, kebab-case, max 5 words, strip accents).

2. **Resolve `sessions_dir`** = `<consumer-repo-root>/.sessions/<task-label>/`.
   Consumer repo root = `git rev-parse --show-toplevel` from the current CWD.

3. **Create `<sessions_dir>`** via `Bash`:
   ```bash
   mkdir -p "<sessions_dir>"
   ```

4. **Invoke orchestrator as one-shot subagent**:
   ```
   Agent(
     subagent_type: "orchestrator",
     prompt: "mode: scope-check

sessions_dir: <absolute path to sessions_dir>
task_label: <task_label>

Raw message:
<description>"
   )
   ```
   The orchestrator writes `scope.md`, `plan-draft.md`, and `verdict.json`
   to `<sessions_dir>` and returns the verdict JSON block.

5. **Verify output** — assert the following files exist before returning:
   - `<sessions_dir>/verdict.json`
   - `<sessions_dir>/scope.md` (required when `verdict == "new-session"`)
   - `<sessions_dir>/plan-draft.md` (required when `verdict == "new-session"`)

   If any required file is missing, reply with an error and stop. Do NOT
   silently return a malformed verdict.

6. **Print / reply** the verdict JSON block from the orchestrator's response.
   session-manager parses the `json` fenced block. Format:

   ```json
   {
     "verdict": "read-only" | "inline" | "new-session",
     "reason": "<one sentence, max 200 chars>",
     "scope_path": "<absolute path>",
     "plan_draft_path": "<absolute path>",
     "sessions_dir": "<absolute path>",
     "task_label": "<slug>",
     "touched_repos": [
       { "path": "<absolute>", "stack": "backend|frontend|mobile", "reason": "<one sentence>" }
     ],
     "downgrade_to": "small-change|trivial-config",
     "authorised_session": true|false,
     "authorising_ts": "<slack-ts or null>"
   }
   ```

   See `api-contract.md §2` for the full field-by-field schema.

## Verdict routing (for session-manager)

| `verdict` | session-manager action |
|-----------|------------------------|
| `"read-only"` | Reply inline with `reason`. No `/session` call. |
| `"inline"` | Hand off to the `downgrade_to` path (`small-change` or `trivial-config`). No new sub-session. |
| `"new-session"` | Apply confirmation gate (unless `authorised_session: true`). Then: `/session <task_label> --resume-from <sessions_dir>`. |

## Error handling

| Error | Action |
|-------|--------|
| `verdict.json` missing or malformed | Report error, stop. Do NOT return a partial verdict. |
| `scope.md` or `plan-draft.md` missing when `verdict == "new-session"` | Report error, stop. Orchestrator-scope-check is responsible for writing these. |
| `Agent(orchestrator)` fails | Report error in the thread. Do NOT fall back to a guessed verdict. |

## What /scope-check does NOT do

- **Does NOT create a worktree.** No `/worktree init`.
- **Does NOT open a tmux window.** No `start-session.sh`.
- **Does NOT subscribe to Slack.** No `subscribe_slack`.
- **Does NOT run the approval gate.** Approval runs later, inside the full sub-session.
- **Does NOT run `/task`.** session-manager calls `/task` after reading the verdict.

## Shared directory layout produced

After `/scope-check` runs, the following files exist:

```
<consumer-repo-root>/
└── .sessions/
    └── <task-label>/
        ├── scope.md          ← scope-check's prose findings
        ├── plan-draft.md     ← skeleton plan seed (orchestrator expands it)
        └── verdict.json      ← machine-readable routing verdict
```

These files are gitignored (`.sessions/` must be in the consumer repo's
`.gitignore`). They are cleaned up by `/worktree cleanup` or manually.
