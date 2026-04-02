# Code Review Checklist

Use this checklist when reviewing code or PRs.

## Correctness

- [ ] Does the code do what the PR description claims?
- [ ] Are edge cases handled (empty inputs, nulls, errors)?
- [ ] Are there any off-by-one errors, race conditions, or deadlocks?
- [ ] Does error handling cover all failure modes?

## Security

- [ ] No hardcoded secrets or credentials
- [ ] User input is validated and sanitized
- [ ] SQL queries are parameterized
- [ ] API endpoints check authorization
- [ ] No sensitive data logged or exposed in responses

## Performance

- [ ] No N+1 queries in database access
- [ ] No unnecessary computations in loops
- [ ] Large datasets are paginated
- [ ] Async operations are properly awaited

## Readability

- [ ] Names are descriptive and consistent with codebase conventions
- [ ] Functions are focused (single responsibility)
- [ ] No commented-out code or debug statements
- [ ] Complex logic has comments explaining "why"

## Testing

- [ ] New code has corresponding tests
- [ ] Tests cover happy path and error cases
- [ ] Tests are deterministic (no flaky dependencies)
- [ ] Mocks are appropriate (external deps only)

## Standards

- [ ] Follows rules in `rules/` (Python, TypeScript, etc.)
- [ ] Consistent with existing patterns in the codebase
- [ ] No new dependencies without justification
- [ ] PR is appropriately sized (< 400 lines)
