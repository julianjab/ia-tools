---
name: pr-review
description: Review the current branch's changes against project standards using the review checklist
allowed-tools: Bash, Read, Grep, Glob
---

Review the current branch's changes:

1. **Get the diff**: Identify all changed files
   ```bash
   git diff main...HEAD --stat
   git diff main...HEAD
   ```

2. **Load review checklist**: Read `rules/review.md` for the full checklist

3. **Load language rules**: Based on changed file types, read relevant rules:
   - Python files → `rules/python.md`
   - TypeScript/Vue files → `rules/typescript.md`
   - Test files → `rules/testing.md`

4. **Review each changed file** against:
   - Correctness: logic errors, edge cases, error handling
   - Security: secrets, input validation, injection risks
   - Performance: N+1 queries, unnecessary work, async issues
   - Readability: naming, complexity, dead code
   - Standards: adherence to rules/ files

5. **Output a structured review** with:
   - Summary of changes
   - Issues found (critical → warning → suggestion)
   - Each issue with file path, line number, and fix suggestion
   - Acknowledgment of good practices observed
