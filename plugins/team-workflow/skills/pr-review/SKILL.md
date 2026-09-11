---
name: pr-review
description: Review the current branch's changes against project standards. Loads the project's review checklist + stack-specific rules, reads the diff, and produces a fixed-format report with issues classified by severity and references to file:line.
allowed-tools: Bash, Read, Grep, Glob
---

Review the current branch's changes.

### Step 0 — Preconditions

Check `$IA_TW_STATE_DIR` first to determine the caller context — same
convention `/pr` uses for CI watching:

- **Agent-teams flow** — `$IA_TW_STATE_DIR` is set (this run was
  dispatched by `team-lead` / `/team-review`). A verdict is about to be
  parsed programmatically, so a failed precondition must be unambiguous:
  **STOP and report** with `VERDICT: BLOCKED`, no prompt.
- **Standalone (console)** — `$IA_TW_STATE_DIR` is unset (a human ran
  `/pr-review` directly). There's a human right here to ask, so don't
  hard-stop: **alert** which precondition failed and **ask the user**
  whether to continue anyway (e.g. review against a different base
  branch, or review uncommitted/staged changes instead of a diff vs
  `main`). If they say no, stop without a verdict block — this was never
  meant to be parsed. If they say yes, adapt the diff source accordingly
  and proceed to Step 1.

| Check | If false |
|---|---|
| `git rev-parse --is-inside-work-tree` succeeds | Not a git repo — nothing to adapt to, STOP in both contexts |
| `git diff main...HEAD --quiet` returns non-zero (i.e. there IS a diff) | Agent-teams: STOP. Standalone: alert "no changes against main" and ask whether to review against a different ref (e.g. `--base <branch>`) or the working tree diff instead |
| Current branch is not `main` / `master` | Agent-teams: STOP. Standalone: alert "you're on main/master" and ask whether to continue reviewing `HEAD` anyway (useful right after a merge) |

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
parse to decide whether to block. `VERDICT: BLOCKED` is only ever
emitted in the agent-teams flow (Step 0). In standalone/console runs,
a declined precondition ends the turn with a plain explanation instead
— there's no caller parsing it, so a fixed-format report would be
noise.
