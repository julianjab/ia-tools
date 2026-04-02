---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/tests/**"
  - "**/test/**"
---

# Testing Standards

## Philosophy

- Tests exist to catch regressions, not to prove correctness.
- Test behavior (what), not implementation (how).
- A failing test should tell you exactly what broke without reading the test code.

## Structure

- One test file per source file: `foo.ts` → `foo.test.ts`, `bar.py` → `test_bar.py`
- Group related tests with `describe` (TS) or test classes (Python)
- Name tests clearly: `test_create_user_returns_201_when_valid_data` not `test_create_user`
- Follow Arrange → Act → Assert pattern

## What to Test

- Happy path: normal inputs produce expected outputs
- Edge cases: empty inputs, boundary values, null/undefined
- Error paths: invalid inputs produce correct errors
- Integration points: API endpoints, database queries, external service calls

## What NOT to Test

- Private/internal functions directly — test through public API
- Third-party library behavior
- Trivial getters/setters with no logic
- Framework internals

## Mocking

- Mock external dependencies (HTTP calls, databases, file system)
- Never mock the code under test
- Prefer fakes/stubs over mocks when possible
- Reset mocks between tests to prevent state leakage

## Coverage

- Aim for meaningful coverage, not a number
- 100% coverage is not a goal — focus on critical paths
- New code should include tests for its primary behaviors
