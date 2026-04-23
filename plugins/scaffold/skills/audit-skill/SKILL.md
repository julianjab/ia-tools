---
name: audit-skill
description: Use when the user asks to review or validate an existing Claude Code skill (skills/<name>/SKILL.md) against best practices. Reports hardcoded paths, label-shaped descriptions, missing argument tables, unscoped tool permissions, and the 14 skill anti-patterns. Read-only.
argument-hint: <path-to-SKILL.md-or-skill-dir> [--strict]
arguments: [path, flag]
allowed-tools: Read, Grep, Glob, Bash(cat *), Bash(head *), Bash(wc *), Bash(ls *)
---

# /audit-skill — validate a skill definition against best practices

Takes a path to a `SKILL.md` or its containing directory, loads references, emits a structured report. Read-only.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>/SKILL.md` | Audit that file + sibling layout |
| `<path>/` (directory) | Locate `SKILL.md` inside, then audit |
| _(empty)_ | STOP — "Usage: /audit-skill <path>" |
| `<path> --strict` | Upgrade MEDIUM findings to HIGH |

`$ARGUMENTS[0]` = path, `$ARGUMENTS[1]` = optional `--strict`.

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP |
| Path is a flat `<name>.md` not inside a `<name>/` directory | Report as HIGH S1; continue |
| `SKILL.md` missing inside directory | STOP — "No SKILL.md found in <path>" |
| No frontmatter | Report as HIGH S0; continue with body checks |

## Load references

From `${CLAUDE_SKILL_DIR}/../../references/`:

1. `skill-frontmatter.md`
2. `skill-anti-patterns.md`

## Checks — run in order

### 1. Layout check

| Check | Severity |
|-------|----------|
| Skill is a directory (`<name>/SKILL.md`) | HIGH S1 if flat |
| `scripts/` present but no references in body | LOW |
| `templates/` present but no references in body | LOW |

### 2. Frontmatter rules S2–S14

| Rule | Check |
|------|-------|
| S2 | Body contains `/Users/`, `/home/`, `/opt/` → HIGH |
| S3 | `description` must carry a trigger signal. PASS if starts with "Use when"/"Invoke when" OR the first sentence begins with an action verb ("Stage…", "Commit…", "Scaffold…", "Generate…", "Audit…", "Deploy…"). FAIL → HIGH only if description is ≤ 60 chars AND has no verb (pure label: "Commit skill.", "PR helper."). |
| S4 | `description` + `when_to_use` combined > 1000 chars → MEDIUM; > 1536 → HIGH |
| S5 | `argument-hint` set but body doesn't reference `$ARGUMENTS` / `$0` / `$name` → MEDIUM |
| S6 | Applies only to skills with **subcommand-style dispatch** (first positional token selects an action, e.g. `init\|list\|cleanup`). If such a skill has no decision table → MEDIUM. Flag-style skills (`--type feat --scope x`) are PASS without the table. |
| S7 | `allowed-tools: Bash` without scoping (no `(…)` matcher) → HIGH |
| S8 | `context: fork` AND body < 30 lines or lacks task statement → HIGH |
| S9 | Body contains "throw" / "raise" / "except" in prose → MEDIUM |
| S10 | Body contains `bash -c /` or `$(/ ...)` patterns → HIGH |
| S11 | Body mentions push/publish/send/deploy/commit AND `disable-model-invocation` is missing or `false` → MEDIUM. Exception (downgrade to LOW): skill is documented as orchestrator-callable (body says "invoked by orchestrator / agent-team lead") — intentional choice. |
| S12 | Body ends without a fixed-label output block → MEDIUM |
| S13 | No preconditions before Steps. PASS if either (a) explicit "Preconditions"/"Precondition" heading exists, OR (b) an early numbered step (Step 0 or Step 1) explicitly validates state ("Verify branch", "Check that …"). Missing both → MEDIUM. |
| S14 | `paths: ["**/*"]` or similar over-broad pattern → LOW |

### 3. Additional smoke checks

| Check | Severity |
|-------|----------|
| `name` matches directory name | HIGH if mismatch |
| Body references sibling files (`reference.md`, etc.) that don't exist | MEDIUM |
| Body uses hardcoded tool names not in Claude Code's catalog | HIGH |
| Skill invokes another skill via `/x` but that skill isn't installed (best-effort check) | LOW |
| SKILL.md exceeds 500 lines | LOW |

## Steps

1. Resolve `$ARGUMENTS[0]` — if directory, append `/SKILL.md`.
2. Read the file.
3. Load the two references.
4. List sibling files (`ls <dir>`).
5. Run all checks.
6. Emit report.

## Output

```
/audit-skill report
  Target:       <absolute path>
  Name:         <name>
  Layout:       <directory | flat>
  Sibling files: <count files in dir>
  Rules run:    S1–S14 + 5 smoke checks

| Severity | Rule | Finding | Location |
|----------|------|---------|----------|
| HIGH     | S7   | allowed-tools grants unscoped Bash | L6 |
| MEDIUM   | S13  | Missing Preconditions section | body |

Summary:
  HIGH:    <count>
  MEDIUM:  <count>
  LOW:     <count>

Verdict: <PASS | FAIL>

Next actions:
  - <one line per HIGH finding>
```

## Error handling

| Condition | Action |
|-----------|--------|
| Reference file missing | STOP — "references/skill-anti-patterns.md not found." |
| Malformed YAML | Report S0, continue |
| Permission denied | STOP |
| `--strict` flag typo | Warn and proceed without strict |

## Never

- Edit the target.
- Auto-fix findings.
- Audit something that isn't a Claude Code skill (reject `.md` files outside `skills/` unless user explicitly forces via the path).
