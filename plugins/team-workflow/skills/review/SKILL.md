---
name: review
description: >
  Code quality validation: formatting, tests, coverage, and coding standards.
  Run standalone to validate current work, or invoked automatically by `/pr` before push.
  Supports: `fmt` (format & lint), `test` (run tests), `coverage` (validate thresholds),
  `rules` (check coding standards), or no sub-command for the full review pipeline.
  Examples: `/review`, `/review test`, `/review coverage`, `/review rules`.
argument-hint: "[fmt|test|coverage|rules] [--fix] [--package core|app/<name>]"
disable-model-invocation: false
---

## Step 0 — Detect Stack

Before running any check, detect the project's tooling. Follow `shared/stack-detection.md`:

1. **Read CLAUDE.md** in the project root — if it defines `format`, `test`, `lint`, or `coverage` commands, use those (highest priority).
2. **Check for Makefile targets**: `fmt`/`format`, `test`, `test-coverage`/`coverage`, `lint`.
3. **Detect stack** from lockfiles/manifests: `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, etc.
4. **Resolve commands** using the priority chain and store as variables:

```
FMT_CMD=<resolved format command>
TEST_CMD=<resolved test command>
COV_CMD=<resolved coverage command>
LINT_CMD=<resolved lint command>
```

Also detect the **source file extension** for filtering diffs:

| Stack | Source extensions | Test file pattern |
|-------|-----------------|-------------------|
| Python | `.py` | `test_*.py` or `*_test.py` |
| Node/TS | `.ts`, `.tsx`, `.js`, `.jsx` | `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js` |
| Go | `.go` | `*_test.go` |
| Rust | `.rs` | Files containing `#[cfg(test)]` or in `tests/` |

Report which stack and commands were detected before proceeding.

---

## Review — Code Quality Gate

Parse `$ARGUMENTS` to determine which check to execute:

| First token in `$ARGUMENTS` | Action |
|-----------------------------|--------|
| `fmt` | Execute **only** the Format & Lint check |
| `test` | Execute **only** the Test Suite check |
| `coverage` | Execute **only** the Coverage Validation check |
| `rules` | Execute **only** the Coding Standards check |
| _(empty)_ | Execute **all checks** in order: fmt → test → coverage → rules |

**Flag `--fix`**: When present, automatically fix issues where possible (auto-format, delegate test fixes to a test-expert agent). Without `--fix`, report-only mode.

**Flag `--package`**: Limit checks to a specific package (e.g., `--package core`, `--package app/subscriptions`). Without it, auto-detect affected packages from the branch diff.

---

## Detect Affected Packages

Before running any check, determine which packages/directories were modified:

```bash
# Get affected top-level directories from branch diff
git diff --name-only origin/main...HEAD | grep -oP '^[^/]+(/[^/]+)?' | sort -u
```

For **monorepos**, each directory may have a different stack — run detection independently per package (see `shared/stack-detection.md` § Package Directory Detection).

If no diff is available (e.g., on `main`), use `--package` flag or check the whole project.

Store the result as `AFFECTED_PACKAGES` for use by all checks.

---

## Check: `fmt` — Format & Lint

**Purpose**: Ensure all code is properly formatted and lint-free.

### Steps

1. **Run the resolved format command** (from Step 0) on each affected package:
   ```bash
   $FMT_CMD   # e.g. make fmt, pnpm format, cargo fmt, gofmt -w .
   ```

2. **Run the resolved lint command** (if available):
   ```bash
   $LINT_CMD   # e.g. make lint, pnpm lint, cargo clippy, golangci-lint run
   ```

3. **Detect changes** produced by formatting:
   ```bash
   git diff --name-only
   ```

4. **Result handling**:

   | Result | `--fix` mode | Report-only mode |
   |--------|-------------|-----------------|
   | No changes | ✓ Pass | ✓ Pass |
   | Files changed by fmt | Auto-stage and commit: `chore: apply code formatting` | ✗ Fail — list files that need formatting |
   | Format/lint command fails | ✗ Fail — report errors | ✗ Fail — report errors |

5. **Report** (include which command was used):
   ```
   fmt: ✓ passed (0 files changed) [ran: pnpm format]
   fmt: ✓ fixed (3 files auto-formatted, committed) [ran: cargo fmt]
   fmt: ✗ FAILED — syntax errors in 2 files [ran: make fmt]
   ```

---

## Check: `test` — Run Test Suite

**Purpose**: Ensure all tests pass in affected packages.

### Steps

1. **Run the resolved test command** (from Step 0) for each affected package:
   ```bash
   cd <package-dir>/ && $TEST_CMD   # e.g. make test, pnpm test, cargo test, go test ./...
   ```

2. **Capture results**: test count, failures, errors, and output.

3. **Result handling**:

   | Result | `--fix` mode | Report-only mode |
   |--------|-------------|-----------------|
   | All pass | ✓ Pass | ✓ Pass |
   | Tests fail — test code issue (import errors, outdated mocks, wrong assertions after refactor) | Delegate to test-expert agent to fix. Max 2 retry cycles | ✗ Fail — report failures |
   | Tests fail — implementation bug (assertion shows wrong behavior) | ✗ Fail — report as implementation bug | ✗ Fail — report as implementation bug |
   | Tests timeout | ✗ Fail — suggest running specific files | ✗ Fail — suggest running specific files |

4. **Agent delegation** (only in `--fix` mode):

   When tests fail due to test code issues, launch a subagent:
   ```
   Launch Agent (test-expert)
   Task: "Tests are failing during /review. Fix these test failures:
     - Failing tests: <test names and file paths>
     - Error output: <relevant error messages>
     - Changed files in this branch: <list from git diff>
     - Stack: <detected stack>
     Run tests from <package directory> using: $TEST_CMD
     Follow existing test patterns in the project.
     Ensure all tests pass before completing."
   ```

   The agent should adapt to the project's test framework (pytest, vitest, jest, Go testing, Rust #[test], etc.) — do NOT hardcode a specific framework.

   After agent completes, re-run tests. If still failing after 2 cycles, report and stop.

5. **Report** (include which command was used):
   ```
   test: ✓ passed (42 tests, 0 failures, 0 errors) [core] [ran: pnpm test]
   test: ✗ FAILED (3 failures) [src/services]
     - NotificationService.test.ts: expected 'sent' got 'failed'
     - CalendarService.test.ts: TimeoutError
   ```

---

## Check: `coverage` — Validate Test Coverage

**Purpose**: Ensure new code has adequate test coverage and existing coverage doesn't regress.

### Steps

1. **Run the resolved coverage command** (from Step 0) for each affected package:
   ```bash
   cd <package-dir>/ && $COV_CMD   # e.g. make test-coverage, pnpm test:coverage, go test -coverprofile=coverage.out ./...
   ```

2. **Identify new and modified source files** (exclude tests) using the detected source extension:
   ```bash
   # Use the detected SOURCE_EXT and TEST_PATTERN from Step 0
   git diff --name-only --diff-filter=A origin/main...HEAD | grep -E '\.(py|ts|tsx|js|go|rs)$' | grep -vE '(test_|\.test\.|\.spec\.|_test\.)'   # New files
   git diff --name-only --diff-filter=M origin/main...HEAD | grep -E '\.(py|ts|tsx|js|go|rs)$' | grep -vE '(test_|\.test\.|\.spec\.|_test\.)'   # Modified files
   ```

3. **Check test file existence** for each new source file. Test file location varies by stack:

   | Stack | Convention |
   |-------|-----------|
   | Python | `tests/**/test_<module>.py` or `<module>/test_<name>.py` |
   | Node/TS | `<module>.test.ts`, `<module>.spec.ts`, or `__tests__/<module>.ts` |
   | Go | `<module>_test.go` (same directory) |
   | Rust | `#[cfg(test)]` module in same file, or `tests/<module>.rs` |

   Look for existing patterns in the project to determine the convention used.

4. **Apply thresholds**:

   | Metric | Threshold | Action if below |
   |--------|-----------|-----------------|
   | **New files** | ≥ 80% line coverage | ✗ Fail — in `--fix` mode, delegate to test-expert agent |
   | **Modified files** | Coverage must not decrease vs. base | ⚠ Warn — report which files lost coverage |
   | **Missing test files** | Every new source file needs a test file | ✗ Fail — in `--fix` mode, delegate to test-expert agent |
   | **Overall package** | Informational only | Report, no blocking |

5. **Agent delegation for missing tests** (only in `--fix` mode):

   ```
   Launch Agent (test-expert)
   Task: "Coverage review: the following new files have no corresponding tests:
     - <file paths>
     - Stack: <detected stack>
     - Test framework: <detected from project — e.g. pytest, vitest, jest, go test>
     Create comprehensive tests following existing patterns in <example test path>.
     Mock/stub dependencies as appropriate for the framework.
     Target: ≥ 80% line coverage on each new file.
     Run tests using: $TEST_CMD"
   ```

   After agent completes, re-run coverage to verify.

6. **Report**:
   ```
   coverage: ✓ passed [ran: pnpm test:coverage]
     New files:      87% avg (3 files, all ≥ 80%)
     Modified files:  no regression
     Overall:        74% (+2% vs main)

   coverage: ✗ FAILED
     New files missing tests:
       - src/services/notification.service.ts (0% — no test file)
       - src/adapters/firebase.adapter.ts (0% — no test file)
     Modified files with regression:
       - src/services/calendar.service.ts: 82% → 71% (-11%)
   ```

---

## Check: `rules` — Coding Standards Validation

**Purpose**: Verify code follows project conventions and architectural rules.

### Steps

1. **Read project conventions** from (in priority order):
   - Root `CLAUDE.md` and package-specific `CLAUDE.md` files
   - Files in `rules/` or `.claude/rules/` directory (if they exist)
   - The `prompts/code-review.md` template (if it exists)

   These files define the **project-specific** rules. The rules check is driven by what the project declares — not by a fixed list.

2. **Get changed source files** (using detected source extensions from Step 0):
   ```bash
   git diff --name-only origin/main...HEAD | grep -E '\.(py|ts|tsx|js|jsx|go|rs|vue)$'
   ```

3. **For each changed file**, read the code and check against two rule categories:

   #### Universal Rules (apply to ALL stacks)

   | Rule | How to check | Severity |
   |------|-------------|----------|
   | No hardcoded secrets | Scan for patterns: API keys, tokens, passwords, connection strings | ✗ Fail |
   | No debug/console output in production code | `print()` (Python), `console.log()` (JS/TS), `fmt.Println()` used for debugging (Go) | ✗ Fail |
   | No hardcoded environment access | `os.environ` (Python), `process.env` without wrapper (Node) | ⚠ Warn |
   | File naming follows project convention | Check against `rules/` or CLAUDE.md naming section | ⚠ Warn |
   | Line length within project limit | Check against configured max (default: lint should catch this) | ⚠ Warn (fmt should fix) |

   #### Project-Specific Rules (loaded from CLAUDE.md + rules/)

   Read the project's `CLAUDE.md` and `rules/` directory to discover additional rules. Common categories:

   - **Architecture rules**: Layer boundaries, import restrictions, dependency direction
   - **Code quality rules**: Type annotations, error handling patterns, logging conventions
   - **Naming rules**: Class/function/file naming conventions specific to the project
   - **Dependency injection rules**: Registration patterns, constructor injection

   For each rule found in the project's config, check the changed files and report violations with file path and line number.

   > **Important**: Do NOT assume any specific architecture (hexagonal, MVC, etc.) or framework. Read what the project defines and validate against that.

4. **Result handling**:

   | Violations found | Action |
   |-----------------|--------|
   | Only warnings | ✓ Pass with warnings — report them but don't block |
   | Any failures | ✗ Fail — report violations with file, line, and rule |
   | No violations | ✓ Pass |
   | No rules found (no CLAUDE.md, no rules/) | ✓ Pass — apply universal rules only, skip project-specific |

5. **Report**:
   ```
   rules: ✓ passed (2 warnings)
     ⚠ src/services/notification.service.ts:45 — console.log in production code
     ⚠ src/adapters/firebase.adapter.ts:12 — line length 107 chars

   rules: ✗ FAILED (1 failure, 1 warning)
     ✗ src/domain/notification.model.ts:3 — framework import in domain layer (per rules/architecture.md)
     ⚠ src/services/notification.service.ts:45 — missing type annotation
   ```

---

## Full Review Pipeline (no sub-command)

When `/review` is called without arguments, run all checks in order:

### Execution Order

```
1. fmt    → must pass to continue
2. test   → must pass to continue
3. coverage → can warn, blocks only on missing tests for new files
4. rules  → can warn, blocks only on failures (not warnings)
```

Each check depends on the previous one passing. If a check fails:
- In `--fix` mode: attempt to fix, retry, continue if fixed
- In report-only mode: stop and report all findings

### Full Report

```
/review complete:
  fmt:      ✓ passed (0 files changed)
  test:     ✓ passed (60 tests, 0 failures) [core, app/subscriptions]
  coverage: ✓ passed (new: 87% | modified: no regression)
  rules:    ✓ passed (1 warning)
    ⚠ core/service/notification_service.py:45 — missing @trace

Result: PASSED — ready for /pr
```

```
/review complete:
  fmt:      ✓ passed
  test:     ✗ FAILED (2 failures in core)
  coverage: — skipped (tests must pass first)
  rules:    — skipped (tests must pass first)

Result: BLOCKED — fix 2 test failures before proceeding
```

---

## Integration with Other Skills

`/review` is designed to be invoked by `/pr` and by the `senior-developer` agent:

| Caller | When | Mode |
|--------|------|------|
| `/pr` (before push) | Mandatory — runs automatically as pre-push gate | `--fix` (auto-fix what's possible) |
| Developer agent (during implementation) | Optional — run after completing a phase | Report-only (no `--fix`) |
| User directly | Anytime — validate current branch quality | User chooses `--fix` or not |
| Code reviewer agent | During PR review | Report-only |

### How `/pr` invokes `/review`

When `/pr` reaches the quality gate step, it internally runs:
```
/review --fix --package <affected-packages>
```

If `/review` reports PASSED → proceed to push.
If `/review` reports BLOCKED → stop, report to user, do not push.

---

## Error Handling

| Error | Action |
|-------|--------|
| No format command detected | Warn and skip fmt check — suggest configuring in CLAUDE.md or Makefile |
| No test command detected | Warn and skip test check — suggest configuring in CLAUDE.md or Makefile |
| No coverage command detected | Warn and skip coverage check — report as "not configured" |
| No `rules/` directory and no CLAUDE.md | Apply universal rules only, skip project-specific |
| No test files found for package | Warn, but don't fail (package might be config-only) |
| Agent delegation fails after 2 retries | Stop and report — manual intervention needed |
| Inside a worktree | Works normally — all git commands are branch-scoped |
| No diff vs main (new repo or first branch) | Skip diff-based checks, run fmt + test only |
| Unknown stack (no recognized manifests) | Ask user to define commands in CLAUDE.md |

## Important Rules

- **`/review` never pushes code** — it only validates. Pushing is `/pr`'s responsibility
- **`/review` never commits code** unless `--fix` is set and formatting changes are needed
- **Failures block push** but warnings don't — warnings are reported in the PR body
- **Coverage thresholds are per-file**, not per-package — a single file below 80% fails the gate
- **Rules checks read actual code** — they don't guess. Every violation includes file path and line number
- **Agent delegation is bounded** — max 2 retry cycles for test fixes, then stop and report
