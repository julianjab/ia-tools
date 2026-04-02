# Base Coding Standards

Universal rules for all projects consuming ia-tools.

## Code Quality

- Write clear, readable code. Favor explicitness over cleverness.
- Follow the Single Responsibility Principle — one function does one thing.
- Keep functions under 40 lines. If longer, extract helpers.
- Name variables and functions descriptively — avoid abbreviations except for well-known ones (id, url, api, db).
- Delete dead code. Do not comment it out "for later."

## Error Handling

- Handle errors at system boundaries (user input, external APIs, file I/O).
- Do NOT add defensive error handling for internal code that you control.
- Use typed errors / custom exceptions — not generic catch-all.
- Log errors with structured logging (not print/console.log).

## Security

- Never hardcode secrets, tokens, passwords, or API keys.
- Use environment variables for all sensitive configuration.
- Validate all external input (user data, API responses, file contents).
- Parameterize database queries — never concatenate user input into SQL.
- Sanitize output to prevent XSS in frontend code.

## Dependencies

- Prefer well-maintained, widely-used libraries over obscure alternatives.
- Pin dependency versions. Use lockfiles.
- Audit dependencies for known vulnerabilities before adding.

## Documentation

- Add comments only when the "why" is not obvious from the code.
- Do NOT add comments that restate what the code does.
- Public APIs must have docstrings/JSDoc with parameter descriptions.
- Keep README files up to date when changing project setup.
