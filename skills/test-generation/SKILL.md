---
name: test-generation
description: Generate unit tests for recently modified or specified files
allowed-tools: Read, Write, Bash, Grep, Glob
---

Generate tests for $ARGUMENTS (or recently modified files if not specified):

1. **Identify target files**: If no arguments given, find recently modified source files:
   ```bash
   git diff --name-only HEAD~1 | grep -E "\.(py|ts|vue)$" | grep -v "test" | grep -v "spec"
   ```

2. **Read target files** and understand their public API (exported functions, classes, endpoints)

3. **Check testing standards**: Read `rules/testing.md`

4. **For Python files**:
   - Create test file at `tests/test_{module}.py` or alongside as `{module}_test.py`
   - Use pytest with fixtures in conftest.py
   - Include: happy path, edge cases, error cases
   - Use `pytest.mark.parametrize` for data variations
   - Mock external dependencies only

5. **For TypeScript/Vue files**:
   - Create test file at `{file}.test.ts` alongside the source
   - Use vitest with describe/it structure
   - For Vue components: use @vue/test-utils mount/shallowMount
   - Test props, emits, slots, and user interactions

6. **Run the tests** to verify they pass:
   - Python: `uv run pytest {test_file} -v`
   - TypeScript: `pnpm vitest run {test_file}`

7. **Report** test count, pass/fail status, and coverage if available
