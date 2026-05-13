---
name: pr-review
description: Review the current branch's changes against project standards. Loads the project's review checklist + stack-specific rules, reads the diff, and produces a fixed-format report with issues classified by severity and references to file:line.
allowed-tools: Bash, Read, Grep, Glob
---

Review the current branch's changes.

### Step 0 — Preconditions

Stop and report if any of the following:

| Check | If false |
|---|---|
| `git rev-parse --is-inside-work-tree` succeeds | STOP — "not in a git repo" |
| `git diff main...HEAD --quiet` returns non-zero (i.e. there IS a diff) | STOP — "no changes against main; nothing to review" |
| Current branch is not `main` / `master` | STOP — "switch to a feature branch first" |

### Step 1 — Get the diff

```bash
git diff main...HEAD --stat
git diff main...HEAD
```

### Step 2 — Detect stack

Read `shared/stack-detection.md` to identify the project's language,
framework, and tooling.

### Step 3 — Load checklists

1. **Project review checklist**: read `rules/review.md` if it exists.
2. **Stack-specific rules**: list `rules/*.md` and load only the ones
   that match the diff (e.g. for `*.py` changes load `rules/python.md`
   when present).

### Step 4 — Review each changed file

Evaluate every changed file against these categories:

- **Correctness**: logic errors, edge cases, error handling.
- **Security**: secrets, input validation, injection risks.
- **Performance**: N+1 queries, unnecessary work, async issues.
- **Readability**: naming, complexity, dead code.
- **Standards**: adherence to the loaded `rules/` files.

### Output format

End the review with this fixed-label block. Use `—` if a section is empty:

```
PR REVIEW REPORT
================
Branch:           <current branch>
Files changed:    <count>  (+<additions> -<deletions>)
Stack:            <detected stack(s)>
Rules loaded:     <list, or "none">

CRITICAL (must fix before merge)
  - <path>:<line> — <one-line description>

WARNING (should fix; non-blocking)
  - <path>:<line> — <one-line description>

SUGGESTION (consider improving)
  - <path>:<line> — <one-line description>

GOOD (acknowledge)
  - <path>:<line> — <what was done well>

VERDICT: APPROVED | NEEDS-FIX | BLOCKED
  - APPROVED   = 0 CRITICAL findings.
  - NEEDS-FIX  = 1+ CRITICAL findings.
  - BLOCKED    = preconditions failed; review didn't run.
```

The verdict line is what callers (e.g. `team-lead`, `/team-review`)
parse to decide whether to block.
