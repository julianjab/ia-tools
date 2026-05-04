# Stack Detection — Shared Reference for All Skills

Skills in this ecosystem are **stack-agnostic**. They detect the project's tooling automatically and adapt commands accordingly. This file documents the detection logic that every skill must follow.

## How to Detect the Stack

Run these checks at the start of any skill that needs to execute project commands:

```bash
# Check for project markers (in order of priority)
ls Makefile package.json pyproject.toml Cargo.toml go.mod pom.xml build.gradle 2>/dev/null
```

## Command Resolution Table

Each skill needs **format**, **test**, and **test-coverage** commands. Resolve them based on what's available:

### Priority 1: Makefile targets (any stack)

If a `Makefile` exists, check for targets:

```bash
grep -qE '^fmt:|^format:' Makefile && FMT_CMD="make fmt"
grep -qE '^test:' Makefile && TEST_CMD="make test"
grep -qE '^test-coverage:|^coverage:' Makefile && COV_CMD="make test-coverage"
grep -qE '^lint:' Makefile && LINT_CMD="make lint"
```

Makefile targets are always preferred — they represent the project's own convention.

### Priority 2: Stack-specific defaults

If Makefile doesn't have the needed target, fall back by stack:

| Stack | Detected by | Format | Test | Coverage | Lint |
|-------|------------|--------|------|----------|------|
| **Python (poetry)** | `pyproject.toml` + `poetry.lock` | `poetry run ruff format .` | `poetry run pytest` | `poetry run pytest --cov=. --cov-report=term-missing` | `poetry run ruff check .` |
| **Python (uv)** | `pyproject.toml` + `uv.lock` | `uv run ruff format .` | `uv run pytest` | `uv run pytest --cov=. --cov-report=term-missing` | `uv run ruff check .` |
| **Python (pip)** | `requirements.txt` | `ruff format .` | `pytest` | `pytest --cov=. --cov-report=term-missing` | `ruff check .` |
| **Node (npm)** | `package.json` + `package-lock.json` | `npm run format` or `npx prettier --write .` | `npm test` | `npm run test:coverage` or `npx vitest --coverage` | `npm run lint` or `npx eslint .` |
| **Node (pnpm)** | `package.json` + `pnpm-lock.yaml` | `pnpm format` or `pnpm exec prettier --write .` | `pnpm test` | `pnpm test:coverage` or `pnpm exec vitest --coverage` | `pnpm lint` or `pnpm exec eslint .` |
| **Node (bun)** | `package.json` + `bun.lockb` | `bun run format` | `bun test` | `bun run test:coverage` | `bun run lint` |
| **Go** | `go.mod` | `gofmt -w .` | `go test ./...` | `go test -coverprofile=coverage.out ./...` | `golangci-lint run` |
| **Rust** | `Cargo.toml` | `cargo fmt` | `cargo test` | `cargo tarpaulin` | `cargo clippy` |

### Priority 3: Verify command exists

Before running any resolved command, verify it's available:

```bash
# For Makefile targets:
make -n <target> 2>/dev/null  # dry-run to check if target exists

# For npm scripts:
node -e "const p=require('./package.json'); process.exit(p.scripts?.['test'] ? 0 : 1)"

# For binaries:
command -v ruff &>/dev/null
command -v pytest &>/dev/null
```

## How Skills Should Use This

Every skill that runs project commands must:

1. **Detect the stack** at the beginning of execution
2. **Resolve commands** using the priority chain above
3. **Report which commands were used** in the output (so the user knows what ran)
4. **Never hardcode** `make fmt`, `make test`, `poetry run pytest`, etc. — always resolve dynamically

### Example Usage in a Skill

Instead of:
```
Run `make fmt` to format code.
```

Write:
```
Run the project's format command:
- Check Makefile for `fmt` or `format` target → use it
- Else detect stack and use the appropriate formatter (see shared/stack-detection.md)
- Report: "Formatted with: <command used>"
```

## Package Directory Detection

For monorepos, detect which packages/directories were modified:

```bash
# Get modified directories from the branch diff
git diff --name-only origin/main...HEAD | grep -oP '^[^/]+(/[^/]+)?' | sort -u
```

For each package directory, run the detection independently — a monorepo might have Python in `core/` and Node in `frontend/`.

## CLAUDE.md Override

If the project's `CLAUDE.md` specifies commands explicitly, those take **highest priority** — even above Makefile:

```markdown
## Commands
- format: `ruff format . && ruff check --fix .`
- test: `pytest -x --tb=short`
- lint: `ruff check .`
```

Skills should read the target project's `CLAUDE.md` first and extract command definitions before falling back to auto-detection.
