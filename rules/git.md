# Git Conventions

## Branches

- `main` — production-ready, protected
- `develop` — integration branch (if used)
- Feature branches: `feat/short-description`
- Bug fix branches: `fix/short-description`
- Chore branches: `chore/short-description`

## Commits

Follow Conventional Commits format:

```
type(scope): short description

Optional longer description explaining why (not what).
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`

- Keep the first line under 72 characters
- Use imperative mood: "add feature" not "added feature"
- Reference issue numbers when applicable: `feat(auth): add JWT validation (#123)`
- One logical change per commit — do not mix unrelated changes

## Pull Requests

- PR title follows same format as commits: `feat(scope): description`
- PR description must include:
  - **Summary**: 1-3 bullet points of what changed
  - **Why**: Motivation for the change
  - **Test plan**: How the change was verified
- Keep PRs small (< 400 lines changed). Split large features into incremental PRs.
- Request review from at least one team member
- Address all review comments before merging
- Squash merge to main for clean history

## Rules

- Never force-push to `main` or `develop`
- Never commit secrets, credentials, or .env files
- Always pull latest before creating a branch
- Delete branches after merging
