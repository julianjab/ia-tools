---
name: test-generation
description: Generate unit tests for recently modified or specified files
allowed-tools: Read, Write, Bash, Grep, Glob
---

Generate tests for $ARGUMENTS (or recently modified files if not specified):

1. **Detect stack**: Read `shared/stack-detection.md` to resolve:
   - `$TEST_CMD` — project test runner
   - `$SOURCE_EXT` — source file extensions
   - `$TEST_PATTERN` — test file naming convention
   - `$TEST_DIR` — where tests live

2. **Identify target files**: If no arguments given, find recently modified source files:
   ```bash
   git diff --name-only HEAD~1 | grep -vE "$TEST_PATTERN"
   ```

3. **Read target files** and understand their public API (exported functions, classes, endpoints)

4. **Check testing standards**: Read `rules/testing.md` if it exists in the project

5. **Create test file** following the project's convention (`$TEST_PATTERN` from stack-detection):
   - Place alongside the source or in `$TEST_DIR` — follow whatever pattern already exists in the project
   - Structure: happy path, edge cases, error cases
   - Use parameterized/data-driven tests for multiple inputs
   - Mock external dependencies only

6. **Run the tests** to verify they pass:
   ```bash
   $TEST_CMD {test_file}
   ```

7. **Report** test count, pass/fail status, and coverage if available
