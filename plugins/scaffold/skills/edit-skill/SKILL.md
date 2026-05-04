---
name: edit-skill
description: Use when the user asks to modify an existing Claude Code skill (skills/<name>/SKILL.md or sibling files). Audits the directory, delegates the change to the skill-author subagent in edit mode, then re-audits to confirm no regressions. Interactive — collects a change request before editing.
when_to_use: |
  Trigger phrases: "edit this skill", "update SKILL.md", "modify skills/X/",
  "add an argument to my skill", "tighten allowed-tools", "switch context to fork",
  "rewrite the preconditions", "fix audit findings on skills/X", "rename a skill argument",
  "adjust argument-hint", "add a new step to this skill".
argument-hint: <path-to-SKILL.md-or-skill-dir> [--change "<plain-language request>"] [--auto]
arguments: [path]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(git rev-parse *), Bash(ls *), Bash(test *), Bash(diff *)
---

# /edit-skill — apply a focused change to an existing skill

Updates a `skills/<name>/` directory by delegating to `skill-author` in `mode: edit` and bracketing the work with `/audit-skill` runs (before + after).

## Arguments

| First token | Action |
|-------------|--------|
| `<path>/SKILL.md` or `<path>/` | Edit that skill; ask for the change request |
| `<path> --change "<text>"` | Use `<text>` as the change request; skip the prompt |
| `<path> --change "<text>" --auto` | Run end-to-end without confirmation prompts |
| `<path> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /edit-skill <path> [--change \"...\"] [--auto]" |

Parse `$ARGUMENTS`: first token is `$path`; scan for `--change <quoted>` and `--auto`. If `$path` is a directory, append `/SKILL.md`.

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP — "Path not found: <path>" |
| `SKILL.md` missing inside the resolved directory | STOP — "No SKILL.md at <dir>" |
| Frontmatter missing | STOP — "Target lacks YAML frontmatter; use /new-skill instead" |
| References missing | STOP — "Scaffold plugin references missing. Reinstall the plugin." |

## Steps

### 1. Pre-audit (baseline)

Invoke: `/audit-skill <dir>/SKILL.md`

Capture findings as `BEFORE`. Continue regardless of severity.

### 2. Collect the change request

Skip when `--change` is supplied. Otherwise ask:

| Field | Question |
|-------|----------|
| `change_request` | "What change should be applied to this skill? Describe it as you would to a coworker — one sentence is fine." |

Be specific. "Add a `--dry-run` flag and document the empty-args row" beats "make it better".

### 3. Resolve absolute references path

```bash
REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"
```

### 4. Delegate to skill-author in edit mode

Invoke `skill-author` with:

```json
{
  "mode": "edit",
  "name": "<derived from directory name>",
  "existing_dir": "<absolute path to skill dir>",
  "change_request": "<change_request>",
  "refs_dir": "<REFS_ABS_PATH>"
}
```

The subagent reads the existing skill, applies the change with minimum viable diff, runs its own self-review against S1–S18, repairs HIGH violations it introduced, and returns a report block.

### 5. Post-audit (verification)

Invoke: `/audit-skill <dir>/SKILL.md`

Capture findings as `AFTER`.

### 6. Compare and verdict

| Condition | Verdict |
|-----------|---------|
| `INTRODUCED` contains any HIGH | FAIL — surface findings, recommend revert |
| `INTRODUCED` is non-empty but only MEDIUM/LOW | WARN — surface findings, let the user decide |
| `INTRODUCED` is empty | PASS |

`--auto` mode: FAIL exits non-zero; WARN and PASS continue.

### 7. Emit output

## Output

```
/edit-skill complete
  Directory:      <absolute path>
  Files touched:  <list from skill-author report>
  Change request: <verbatim>

Author decisions:
  <paste 'Decisions:' from skill-author report>

Author self-review:
  Verdict:  <PASS | FIX-APPLIED | OPEN>
  Repairs:  <rule → fix, or 'none'>

Audit delta:
  Before:   HIGH=<n> MEDIUM=<n> LOW=<n>
  After:    HIGH=<n> MEDIUM=<n> LOW=<n>
  Resolved:    <rule IDs no longer failing>
  Introduced:  <rule IDs newly failing, or 'none'>

Verdict: <PASS | WARN | FAIL>

<If FAIL:>
  ⚠️ Edit introduced HIGH regressions. Review the diff:
    git -C <repo> diff <dir>

<If WARN:>
  ⚠️ Edit introduced MEDIUM/LOW issues:
    <list>

<If PASS:>
  ✓ Edit applied with no regressions.

Next:
  - Review the diff: git -C <repo> diff <dir>
  - If `disable-model-invocation` flipped, confirm the side-effect class still matches.
```

## Error handling

| Condition | Action |
|-----------|--------|
| Pre-audit cannot run (references missing) | STOP |
| `skill-author` fails | STOP — leave files untouched; report the subagent error |
| Post-audit cannot run | Emit output without delta; mark verdict INCONCLUSIVE |
| HIGH regression and `--auto` | Exit non-zero; do not auto-revert |
| Empty `change_request` (interactive) | Re-prompt once; STOP on second empty answer |

## Scope

Own: argument parsing, baseline audit, delegation to `skill-author`, verification audit, delta comparison, and the output block.

Boundaries:
- Edit only inside the target skill directory via `skill-author`.
- Invoke `skill-author` exactly once per call.
- Report regressions; do not auto-revert. The user owns the decision.
- Stay inside the skill directory — refuse paths that resolve outside `skills/` or `plugins/*/skills/` unless the user passes an explicit absolute path.
