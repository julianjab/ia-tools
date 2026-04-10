---
name: deliver
description: >
  Full delivery pipeline — detects state and orchestrates /worktree, /commit,
  /review, /pr, and /sync-docs in the right order. Use when you want the
  complete flow from current state to PR in a single command.
  For individual steps, use the dedicated skills directly.
  Examples: `/deliver`, `/deliver feat/notification-service`.
argument-hint: "[branch-name] [--base main]"
disable-model-invocation: false
---

## Deliver — Smart Orchestrator

`/deliver` is a convenience wrapper that detects the current git state and invokes the right skills in sequence. It does NOT contain logic of its own — it delegates everything.

**For individual steps, use the dedicated skills directly:**

| Need | Skill | Example |
|------|-------|---------|
| Create branch/worktree | `/worktree` | `/worktree init feat/notification` |
| Stage + commit | `/commit` | `/commit --type feat --scope notification` |
| Validate quality | `/review` | `/review` or `/review test` |
| Push + create PR | `/pr` | `/pr` |
| Sync documentation | `/sync-docs` | `/sync-docs` |
| Notify team | `/ship` | `/ship` |

---

## How /deliver Works

### Step 0 — Detect State

Run these commands to understand the current situation:

```bash
git branch --show-current
git status --porcelain
git fetch origin
git log origin/main..HEAD --oneline 2>/dev/null
gh pr view --json url,state,number 2>/dev/null
git rev-parse --git-common-dir
```

From the output, determine these flags:

| Flag | How to detect |
|------|--------------|
| `ON_BASE` | Current branch is `main` or `master` |
| `HAS_UNCOMMITTED` | `git status --porcelain` has output |
| `HAS_COMMITS` | `git log origin/main..HEAD` has output |
| `HAS_UNPUSHED` | `git log origin/<branch>..HEAD` has output (or remote branch doesn't exist) |
| `PR_EXISTS` | `gh pr view` returned a PR |
| `IN_WORKTREE` | `git rev-parse --git-common-dir` differs from `.git` |

### Step 1 — Execute Only Needed Skills

| State | Skills to invoke (in order) | Skills to SKIP |
|-------|---------------------------|----------------|
| `ON_BASE` + branch name in args | `/worktree init` → `/commit` (if changes) → `/sync-docs` → `/review --fix` → `/pr` | — |
| `ON_BASE` + no branch name | Ask for branch name, then `/worktree init` | everything else (until branch exists) |
| `HAS_UNCOMMITTED` + no commits yet | `/commit` → `/sync-docs` → `/review --fix` → `/pr` | `/worktree init` (already on branch) |
| `HAS_UNCOMMITTED` + has commits | `/commit` → `/sync-docs` → `/review --fix` → `/pr` | `/worktree init` |
| `!HAS_UNCOMMITTED` + `HAS_UNPUSHED` | `/sync-docs` → `/review --fix` → `/pr` | `/worktree init`, `/commit` |
| `!HAS_UNCOMMITTED` + `PR_EXISTS` + no unpushed | Report: "Nothing to do — PR already up to date" | ALL |
| `!HAS_UNCOMMITTED` + `!HAS_COMMITS` | Report: "No changes found on this branch" | ALL |

### Step 2 — Report What Happened

```
/deliver complete:
  /worktree init: skipped (already on feature branch)
  /commit:        executed (2 files committed)
  /sync-docs:     skipped (no CLAUDE.md drift)
  /review:        passed (fmt ✓ | test ✓ 42 passed | coverage ✓ 87% | rules ✓)
  /pr:            executed (PR created: <url>)
```

---

## Skill Invocation Details

When `/deliver` delegates to each skill, it passes relevant context:

### → `/worktree init`
```
/worktree init <branch-name> --base <base>
```
Branch name is taken from `$ARGUMENTS` or inferred from the task context.

### → `/commit`
```
/commit
```
No extra args — `/commit` auto-infers type, scope, and message from the diff.

### → `/sync-docs`
```
/sync-docs
```
Checks and auto-fixes CLAUDE.md drift.

### → `/review --fix`
```
/review --fix
```
Runs the full quality gate (fmt, tests, coverage, rules) with auto-fix enabled. If BLOCKED, `/deliver` stops here and reports — does NOT proceed to `/pr`.

### → `/pr`
```
/pr --base <base>
```
Only invoked if `/review` passed. Pushes, creates PR with diagrams, monitors CI.

---

## Error Handling

| Error | Action |
|-------|--------|
| `ON_BASE` with no branch name | Ask user for a branch name |
| `/review` reports BLOCKED | STOP — report failures, do NOT invoke `/pr` |
| Any skill fails | STOP — report which skill failed, suggest running it individually for more detail |
| No changes to deliver | Report "Nothing to do" and exit |

## Important Rules

- **`/deliver` is a convenience — not a requirement**. Every skill it calls can be invoked directly
- **`/review` must pass before `/pr`** — this invariant is enforced by both `/deliver` and `/pr`
- **Worktree-aware**: Detects worktree context and reports it. All delegated skills work in worktrees
- **No duplicate logic**: `/deliver` never reimplements what the individual skills do
