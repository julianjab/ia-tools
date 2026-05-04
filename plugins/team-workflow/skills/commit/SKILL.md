---
name: commit
description: >
  Stage and commit changes with conventional commit format.
  Runs formatting, quick test validation, and creates atomic conventional commits.
  Examples: `/commit`, `/commit --type feat --scope notification --message "add port"`,
  `/commit --type fix --scope calendar`.
argument-hint: "[--type feat|fix|refactor|test|docs|chore|perf|bump] [--scope <scope>] [--message \"<description>\"]"
disable-model-invocation: false
---

## Commit — Conventional Commit with Quality Checks

**Purpose**: Stage and commit changes with conventional commit format. Runs formatting and a quick test validation before committing.

---

### Step 0 — Detect Stack

Before running any command, detect the project's tooling. Follow `shared/stack-detection.md`:

1. **Read CLAUDE.md** — if it defines `format`, `test`, or `lint` commands, use those (highest priority).
2. **Check Makefile targets**: `fmt`/`format`, `test`.
3. **Detect stack** from lockfiles/manifests and resolve commands:

```
FMT_CMD=<resolved format command>
TEST_CMD=<resolved test command>
SOURCE_EXT=<detected source file extensions — e.g. .py, .ts, .go>
TEST_PATTERN=<test file pattern — e.g. test_*.py, *.test.ts, *_test.go>
```

### Steps

#### 1 — Verify Branch

```bash
git branch --show-current
```

- MUST NOT be `main`/`master`.
- If on `main`/`master`, **STOP** and tell the caller to run `/worktree init` first.
- If inside a worktree, the branch is already set — proceed normally.

#### 2 — Format Code (MANDATORY)

Run the resolved format command (from Step 0):

```bash
$FMT_CMD   # e.g. make fmt, pnpm format, cargo fmt, gofmt -w .
```

- After formatting, check if any files changed:
  ```bash
  git diff --name-only
  ```
- If formatting modified files, those changes will be included in the staged files below.
- If the format command **fails** (syntax error, invalid code): **STOP** and report the error. Do not commit broken code.
- If no format command was detected, **warn** and skip this step (suggest configuring in CLAUDE.md or Makefile).

#### 3 — Quick Test Validation (soft gate)

Run tests for files affected by the current changes:

```bash
# Identify source files changed (not yet committed) — use detected extensions
git diff --name-only HEAD | grep -E "$SOURCE_EXT" | grep -vE "$TEST_PATTERN"
```

For each changed source file, find and run its corresponding test file using the resolved test command:
```bash
cd <package-dir>/ && $TEST_CMD   # e.g. make test, pnpm test, pytest, go test ./...
```

If no test command was detected, skip this step with a warning.

**Result handling:**

| Result | Action |
|--------|--------|
| Tests pass | Continue to step 4 |
| Tests fail | **WARN** the user but allow the commit. Checkpoint commits can have in-progress work. Add `[tests-pending]` to commit message body |
| No test files exist | Note this in the report — `/review` will enforce test creation before push |

This is a **soft gate** — warn, don't block. The hard gate is in `/review` before push.

#### 4 — Analyze Changes

```bash
git status
git diff
git diff --cached
```

#### 5 — Determine Commit Metadata

- If `--type`, `--scope`, `--message` are provided, use them directly.
- Otherwise, **infer** from the changed files:
  - **Type**: `feat` for new files, `fix` for bug-related changes, `refactor` for restructuring, `test` for test-only, etc.
  - **Scope**: Most affected domain (e.g., `calendar`, `lead`, `widget`, `auth`)
  - **Description**: Concise summary of what changed

#### 6 — Stage Specific Files

```bash
git add <file1> <file2> ...
```

- **NEVER** use `git add -A` or `git add .`
- **NEVER stage** `.env`, credentials, build artifacts (`__pycache__`, `.pyc`, `node_modules/`, `target/`, `dist/`), or sensitive files

#### 7 — Create Commit(s)

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <description>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

- If there are multiple logical changes, create **separate commits** (one per concern).
- If tests were pending (step 3), append to the commit body:
  ```
  [tests-pending] — quick validation showed N failures, will be resolved before PR
  ```

#### 8 — Report

```
Committed: <type>(<scope>): <description>
Files: <count> files staged
Branch: <branch-name>
Tests: ✓ passed | ⚠ pending (N failures) | — skipped (no test files)
```

---

## Conventional Commit Reference

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `test` | Adding or modifying tests only |
| `docs` | Documentation changes |
| `chore` | Build, CI, tooling changes |
| `perf` | Performance improvement |
| `bump` | Version bump |

---

## When to Use /commit (Checkpoint Triggers)

Execute a commit checkpoint when ANY of these conditions are met:

1. **Layer completed**: Finished all changes in one architectural layer (e.g., domain ports done, moving to service)
2. **Working state reached**: Code runs and tests pass, even if the feature is incomplete
3. **Before risky changes**: About to modify shared code or refactor existing logic
4. **Significant progress**: Created/modified 3+ files since the last commit
5. **Before sub-agent delegation**: Before delegating tests to a test-expert agent, commit implementation first
6. **Context switch**: Switching between packages (e.g., `core/` → `app/subscriptions/`)

---

## Error Handling

| Error | Action |
|-------|--------|
| On `main`/`master` | STOP — tell caller to run `/worktree init` first |
| No changes to commit | Report "Nothing to commit" and exit |
| Format command fails | STOP — report syntax/lint errors |
| Sensitive files detected in diff | Exclude from staging, warn user |
| Inside a worktree | Works normally — branch is implicit from worktree |

## Important Rules

- **NEVER commit to `main` or `master`** — this is non-negotiable
- **ALWAYS run the project's format command** before staging (see `shared/stack-detection.md`)
- **ALWAYS use specific file paths** with `git add` (never `git add -A` or `git add .`)
- **NEVER stage** `.env`, credentials, build artifacts (`__pycache__`, `.pyc`, `node_modules/`, `target/`, `dist/`), or sensitive files
- **Each commit must be atomic**: valid codebase state (no broken imports, no half-implemented interfaces)
- **Conventional commit format** is mandatory for every commit
- **Worktree-safe**: Works identically from main repo or any worktree
