# Skill anti-patterns

Common mistakes detected by `/audit-skill`.

## S1. Single-file skill

- **Signal**: `skills/my-skill.md` at the root, not `skills/my-skill/SKILL.md`.
- **Why**: Loader expects a directory layout. Sibling files (`reference.md`, `scripts/`) can't coexist otherwise.
- **Fix**: Move to `skills/<name>/SKILL.md`. Flat single-files break when the skill grows.

## S2. Hardcoded absolute paths

- **Signal**: Body contains `/Users/…`, `/home/…`, or `/opt/…`.
- **Why**: Breaks for every other user of the plugin.
- **Fix**: Use `${CLAUDE_SKILL_DIR}` for bundled scripts, `$(git rev-parse --show-toplevel)` for repo root, or the skill-argument path. Never hardcode.

## S3. Label-shaped description

- **Signal**: Short noun phrase with no verb (`"Commit skill."`, `"PR helper."`). Verb-led descriptions ("Stage and commit…", "Generate tests for…", "Audit a skill…") are acceptable.
- **Why**: `description` drives Claude's autonomous invocation. A label doesn't match intent; an action verb does.
- **Fix**: Either condition-shape ("Use when the user asks to …") or verb-lead ("Stage and commit staged changes with conventional-commit formatting."). Avoid pure noun phrases.

## S4. Description over 1536 chars with `when_to_use`

- **Signal**: Combined length exceeds the listing cap.
- **Why**: Claude Code truncates — everything past 1536 is invisible for routing.
- **Fix**: Move phrases to the body. Keep `description + when_to_use` under 1000 chars for safety.

## S5. Missing `$ARGUMENTS` in body

- **Signal**: `argument-hint` declared, body never references `$ARGUMENTS` / `$0` / `$name`.
- **Why**: Runtime appends `ARGUMENTS: <value>` at end — the arg is divorced from its use point.
- **Fix**: Place `$ARGUMENTS` (or named args) where they're parsed — usually in a decision table up top.

## S6. No argument-parsing decision table (subcommand skills only)

- **Signal**: Skill uses **subcommand dispatch** (first positional token selects an action like `init|list|cleanup`) but has no decision table mapping tokens → actions.
- **Scope**: Flag-style skills (`/commit --type feat --scope x`) do NOT need a decision table. They validate flags during the relevant step.
- **Why**: Ambiguous first-token dispatch → model guesses. Empty-arg case often undefined.
- **Fix**: First section of body is a table: `init | list | cleanup | (empty) → default`.

## S7. Unscoped `allowed-tools`

- **Signal**: `allowed-tools: Bash` with no matcher.
- **Why**: Pre-approves ALL bash commands. Any side effect runs without prompt.
- **Fix**: Scope each binary: `Bash(git *), Bash(pnpm *), Bash(cat *)`. One entry per command family.

## S8. Fork skill with guideline-only body

- **Signal**: `context: fork` + body reads like "follow our conventions" without a concrete task.
- **Why**: Forked skill runs in a fresh subagent with no chat history. Guidelines are not a task.
- **Fix**: Body must contain the full prompt: task statement, inputs via `$ARGUMENTS`, output format, exit criteria.

## S9. Throws / exceptions in prose

- **Signal**: Body says "throw an error if …" or "raise exception".
- **Why**: Skills cannot throw. Control flow is linear prose.
- **Fix**: Replace with decision-table rows: `| Condition | STOP — message |`.

## S10. Imperative shell execution of another skill

- **Signal**: Body contains `bash -c /some-skill` or `$(/slash)`.
- **Why**: Slash paths are not executables. The runtime resolves them only when Claude invokes them directly.
- **Fix**: Instruct Claude to invoke the skill: `Invoke /other-skill with args <x>`.

## S11. Side-effect skill without `disable-model-invocation`

- **Signal**: Skill writes to remote (pushes, posts, sends, commits) but has no `disable-model-invocation: true`.
- **Why**: Claude can auto-invoke on vague intent. Side-effects happen without user confirmation.
- **Exception**: Skills deliberately documented as orchestrator-callable (body states "invoked by orchestrator" or similar) may keep auto-invocation enabled — the orchestrator is a gated caller. Audit downgrades from MEDIUM to LOW in this case.
- **Fix**: Add `disable-model-invocation: true` for `/push`, `/deploy`, `/publish`, `/send`. For `/commit`, the choice depends on whether the orchestrator is expected to call it autonomously.

## S12. No output format

- **Signal**: Body ends with free-form narrative ("Done!" "Finished.").
- **Why**: Caller (another skill / agent) can't parse state.
- **Fix**: Fixed-label block or table at the end. See `skill-frontmatter.md` § Output conventions.

## S13. Missing precondition checks

- **Signal**: Steps run immediately without validating state.
- **Why**: Runs against wrong branch, missing files, dirty tree — produces broken commits/PRs.
- **Accepts either shape**: (a) explicit "Preconditions" heading before Steps, OR (b) a clearly-labeled Step 0/1 that validates state ("Verify Branch", "Check that …") before any mutation.
- **Fix**: Add the precondition section or label the first step explicitly as a check. Each check maps to a decision-table row or STOP instruction.

## S14. Over-broad `paths`

- **Signal**: `paths: ["**/*"]` or no `paths` on a monorepo-specific skill.
- **Why**: Skill auto-activates everywhere, including sibling packages it wasn't written for.
- **Fix**: Scope: `paths: ["packages/mobile/**"]`. Or omit + rely on explicit user invocation.

## S15. First- or second-person description

- **Signal**: `description` contains "I ", "I'll ", "I can", "you can", "you should", or "your".
- **Why**: `description` is read by the routing system, not the user. First/second-person prose breaks the autocomplete trigger and reads as a chatbot greeting, not a task signal. Anthropic requires third-person or action-verb form.
- **Fix**: Use third person ("Stages and commits…", "Audits a skill…") or condition-shape ("Use when the user asks to commit staged changes."). Never "I can help you commit" or "You can use this to push."

## S16. Generic preamble buries the trigger

- **Signal**: `description` starts with "This skill", "This command", "A skill that", "This tool helps", or any noun phrase before the actual use-case.
- **Why**: Claude's skill router scores descriptions by keyword proximity. A preamble pushes the trigger phrase past the first 80 characters, reducing routing precision. Anthropic explicitly recommends front-loading the use case.
- **Fix**: Start directly with the trigger: "Use when the user asks to…" or an action verb ("Extracts text from PDF files…"). Drop all setup phrases.

## S17. Deep reference chain

- **Signal**: `SKILL.md` references a sibling file (e.g., `reference.md`) AND that sibling file itself contains references to further files (3+ levels of depth: SKILL.md → A.md → B.md).
- **Why**: When Claude encounters a nested reference, it may use partial-read commands (`head -100`) on intermediary files instead of reading them fully, losing information before reaching the actual content. Anthropic explicitly states: "Keep references one level deep from SKILL.md."
- **Fix**: All reference files should link directly from `SKILL.md`. Move the content from `B.md` into `A.md`, or link both directly from `SKILL.md`.

## S18. Long reference file without table of contents

- **Signal**: A sibling file (not `SKILL.md` itself) has more than 100 lines AND has no "## Contents", "## Table of contents", or similar TOC heading in the first 20 lines.
- **Why**: Claude sometimes previews large files with partial reads. Without a TOC at the top, it may not see what sections exist and skip relevant content entirely. Anthropic recommends a TOC for any reference file exceeding 100 lines so Claude can see the full scope even on a partial read.
- **Fix**: Add a short TOC section at the top of the file listing all major sections.
