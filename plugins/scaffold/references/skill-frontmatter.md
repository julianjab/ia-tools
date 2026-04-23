# Skill frontmatter — complete field reference

Source of truth for `skills/<name>/SKILL.md` frontmatter.

## File layout

A skill is a **directory**, not a single file:

```
skills/my-skill/
├── SKILL.md              # required
├── reference.md          # optional — loaded on-demand
├── examples.md           # optional — loaded on-demand
├── scripts/              # optional — executed, not read
│   └── helper.sh
└── templates/            # optional — source material
    └── template.tmpl
```

Keep `SKILL.md` under 500 lines. Move reference material to sibling files and name-reference them from `SKILL.md` so Claude loads them only when needed.

## Field matrix

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `name` | no | string | Lowercase + hyphens, max 64 chars. Defaults to directory name. |
| `description` | **recommended** | string | **Trigger signal**. Shown in autocomplete and in-session. Front-load the use case. |
| `when_to_use` | no | string | Overflow for trigger phrases. Counts toward 1536-char cap with `description`. |
| `argument-hint` | no | string | Autocomplete display, e.g. `<name> [--template <kind>]`. |
| `arguments` | no | string array | Named positional args for `$name` substitution. |
| `disable-model-invocation` | no | boolean | `true` = only user can invoke. Use for side-effect skills (`/commit`, `/deploy`). |
| `user-invocable` | no | boolean | `false` = hidden from `/` menu; Claude can still load as background knowledge. |
| `allowed-tools` | no | string | Pre-approved tools scope. Use tight matchers: `Bash(git add *), Bash(git commit *)`, not just `Bash`. |
| `context` | no | `fork` | Runs skill in isolated subagent. Requires self-contained body. |
| `agent` | no | string | Subagent type when `context: fork` (`Explore`, `Plan`, custom). |
| `paths` | no | string array | Glob patterns restricting auto-activation. Monorepo per-package skills. |
| `model` / `effort` | no | string | Per-turn override; session resumes previous values. |

## Character budget

- `description` alone: front-load keywords
- `description + when_to_use` combined: hard cap **1536 chars** in the skill listing
- `SKILL.md` body: soft cap ~500 lines (stays in context once loaded)

## Argument syntaxes

Three, all supported:

| Syntax | Semantics |
|--------|-----------|
| `$ARGUMENTS` | Entire arg string verbatim |
| `$ARGUMENTS[0]`, `$1` | 0-based positional (multi-word = shell-quoted) |
| `$name` | Named positional when `arguments: [name, ...]` is declared |

If the body omits `$ARGUMENTS`, the runtime appends `ARGUMENTS: <value>` at the end — works, but awkward. Always place explicitly.

## Body structure

1. **Trigger header** (1 line) — what the skill does, who calls it
2. **Argument parsing** — decision table mapping first token to action; document empty-arg default
3. **Preconditions** — checks that STOP early (wrong branch, missing file, etc.)
4. **Steps** — numbered, each with the tool/command
5. **Output** — fixed-format structured report (tables or labelled blocks)
6. **Error table** — one row per known failure mode (skills have no throw)

## Error handling — decision tables only

Skills cannot throw. Use exhaustive tables:

```markdown
## Error handling

| Condition | Action |
|-----------|--------|
| On `main`/`master` | STOP — tell caller to run `/worktree init` |
| No changes to commit | Report "Nothing to commit" and exit |
| Format command fails | STOP — report errors verbatim |
| Ambiguous input | Ask the user, don't guess |
```

## Invoking other skills

Correct: `Invoke /review with --fix flag: /review --fix --package <pkg>`. The runtime resolves the slash-path.

Incorrect: shelling out (`bash -c /review`) — slash paths are not executables.

## `context: fork` rules

A forked skill runs as a subagent with **no conversation history**. The body must be a complete prompt with:

- The task statement
- Inputs (via `$ARGUMENTS`)
- Output format
- Exit criteria

A forked skill body of "use the project conventions" returns nothing useful — the subagent never saw the conversation.

## Output conventions

Preferred — fixed-label block:

```
Result:
  Path:     <path>
  Branch:   <branch>
  Status:   clean
```

Preferred — table for lists:

```
| Severity | Rule | Finding | File:Line |
|----------|------|---------|-----------|
| HIGH     | A1   | …       | foo.md:3  |
```

Avoided — free-form prose. Callers (other skills or agents) can't parse.

## See also

- `skill-anti-patterns.md`
