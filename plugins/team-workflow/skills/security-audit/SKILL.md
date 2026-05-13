---
name: security-audit
description: Scan the codebase (or a worktree diff) for hardcoded secrets, exposed config, common injection patterns, and missing input validation. Produces a fixed-format report with severity-classified findings and file:line references. Invoked by `team-lead` when no repo-local security agent exists, or standalone by an operator.
allowed-tools: Bash, Read, Grep, Glob
---

Run a security audit on the current project.

### Step 0 — Preconditions

| Check | If false |
|---|---|
| `git rev-parse --is-inside-work-tree` succeeds | STOP — "not in a git repo" |
| On a feature branch (not `main`/`master`) OR `--scope repo` flag passed | STOP — "specify --scope repo to audit main" |
| For PR-style audit: `git diff --cached --quiet` returns NON-zero (i.e. something IS staged) | STOP — "stage the approved file set first via `git add <files>`, then re-invoke. Audit must run against the bytes that will be committed, not the working tree." |

Decide the scope:

- **PR-style (default, on feature branch)**: audit ONLY `git diff --cached`.
  This is the set of bytes that will be committed by the next `/pr` call.
  Files in the working tree that are NOT staged are out of scope —
  if they should be in the commit, the caller must stage them first.
- **Full sweep (`--scope repo`)**: audit the whole tree. Used when
  auditing `main` directly, or for ad-hoc inspections.

Report the chosen scope on the first line of the output, and on the
verdict line append `(staged-diff)` or `(full-repo)` so the caller can
confirm what was actually checked.

### Step 1 — Hardcoded secrets

```bash
grep -rn --include="*.py" --include="*.ts" --include="*.js" --include="*.vue" --include="*.env*" \
  -iE "(password|secret|api_key|token|credential|auth).*=.*['\"]" . || true
```

Filter out matches inside `tests/`, `*.spec.*`, and `*.fixture.*` —
test data with fake credentials is expected. Anything else → finding.

### Step 2 — Exposed `.env` files

```bash
git ls-files | grep -iE "\.env(\..+)?$" || echo "no .env files tracked"
```

Any `.env*` file tracked by git (except `.env.example` / `.env.sample`)
→ HIGH finding.

### Step 3 — Injection patterns

SQL string concatenation / f-string interpolation in queries:

```bash
grep -rn --include="*.py" -E "(execute|raw|text)\(.*\+|f['\"].*SELECT|f['\"].*INSERT|f['\"].*UPDATE|f['\"].*DELETE" . \
  || echo "no obvious SQL injection patterns"
```

Shell injection in subprocess / exec / system calls without parameterization:

```bash
grep -rn --include="*.py" --include="*.ts" --include="*.js" \
  -E "(subprocess\.|os\.system|exec\(|child_process\.)" . || true
```

### Step 4 — Missing input validation on API endpoints

For each handler under `**/api/**` or `**/handlers/**` (stack-dependent),
check that the payload type/schema is validated before use. Manual
sniff — flag endpoints that consume `request.body` / `req.body` /
unparsed args without a `pydantic` / `zod` / equivalent schema.

### Step 5 — Dependency vulnerabilities

Run whichever auditor exists in the project:

```bash
(pnpm audit --audit-level=high 2>/dev/null) \
  || (uv pip list --outdated 2>/dev/null) \
  || (pip list --format=columns 2>/dev/null) \
  || true
```

Note: dep audits are best-effort here; full coverage belongs to CI.

### Output format

End with this fixed-label block:

```
SECURITY AUDIT REPORT
=====================
Scope:            <diff vs main | whole repo>
Files scanned:    <count>
Checks run:       secrets, env-tracking, injection, input-validation, deps

HIGH (block PR; escalate to user)
  - <path>:<line> — <one-line description>

MEDIUM (block PR; mitigation required before merge)
  - <path>:<line> — <one-line description>

LOW (informational; can pass through as PR comment)
  - <path>:<line> — <one-line description>

VERDICT: APPROVED | REJECTED
  - APPROVED = 0 HIGH and 0 MEDIUM findings (LOW-only is acceptable).
  - REJECTED = 1+ HIGH or MEDIUM finding.

When invoked by team-lead, the worktree-prefix marker must be emitted
on the verdict line so the TaskCompleted hook can verify it:

  security: APPROVED for <wt_prefix>
```

The verdict line is what `team-lead` writes to `state.md` so the
`task-completed.sh` hook can gate the matching `:pr` task per
invariant 3.
