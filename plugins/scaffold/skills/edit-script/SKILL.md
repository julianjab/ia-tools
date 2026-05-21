---
name: edit-script
description: Use when the user asks to modify an existing bash script (hook under hooks/scripts/, repo helper script, or a skill's bash block), or to auto-fix /audit-script findings against script-style.md. Bracketed by /audit-script runs before and after so regressions surface explicitly.
when_to_use: |
  Trigger phrases: "edit this hook", "fix this script", "auto-fix /audit-script findings",
  "apply audit fixes to hooks/scripts/X.sh", "update enforce-worktree.sh", "rewrite this
  bash block", "swap echo for printf in this script", "wrap cd && tool in a subshell",
  "split this hook into the right bucket", "migrate this hook to the correct bucket",
  "tighten set -u in scripts/X.sh".
argument-hint: <path> [--fix] [--change "<description>"] [--migrate-bucket] [--auto]
arguments: [path]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(chmod *), Bash(test *), Bash(mkdir -p *), Bash(ls *), Bash(git rev-parse *), Bash(diff *)
---

# /edit-script — apply a focused change to an existing bash script

Updates a single bash script (`hooks/scripts/*.sh`, a repo helper, or a fenced bash block inside a `SKILL.md`) by delegating structural changes to the `script-author` subagent in `mode: edit`, or — for mechanical violations — applying scoped `Edit` substitutions directly. Bracketed by `/audit-script` runs (before + after) so the user sees whether the edit improved or regressed the file against `script-style.md` rules S1–S19.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>` (no flags) | Ask the user for a change description; treat answer as `--change` |
| `<path> --fix` | Run `/audit-script`, apply mechanical fixes for HIGH+MEDIUM findings; delegate structural ones to `script-author` |
| `<path> --change "<text>"` | Apply `<text>` via `script-author` in edit mode |
| `<path> --change "<text>" --auto` | Same; skip confirmation prompts |
| `<path> --migrate-bucket` | Hook-only: split mixed-responsibility hook into the correct bucket file and update `hooks.json` |
| `<path> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /edit-script <path> [--fix] [--change \"...\"] [--migrate-bucket] [--auto]" |

Parse `$ARGUMENTS` as a string: first token is `$path`; scan for `--fix`, `--change <quoted-or-rest>`, `--migrate-bucket`, `--auto`. Flags `--fix`, `--change`, and `--migrate-bucket` are mutually exclusive; passing more than one is an error.

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP — "File not found: <path>" |
| Path is neither `*.sh` nor a `.md` containing a fenced ```bash block | STOP — "Not a script: <path>. Pass a .sh file or a SKILL.md with a bash block." |
| References missing (`scaffold/references/script-style.md`) | STOP — "Scaffold plugin references missing. Reinstall the plugin." |
| `--migrate-bucket` but path is not under `hooks/scripts/` | STOP — "--migrate-bucket only applies to hook scripts under hooks/scripts/" |
| `--fix` AND `--change` AND/OR `--migrate-bucket` together | STOP — "Pick one of --fix, --change, --migrate-bucket" |

## Steps

### 1. Pre-audit (baseline)

Invoke: `/audit-script <path>`

Capture the findings table and severity counts as `BEFORE`. Continue regardless of severity — the goal of the edit may be to fix the findings.

### 2. Resolve the change request

| Mode | Source of `change_request` |
|------|----------------------------|
| `--change "<text>"` | Use `<text>` verbatim |
| `--fix` | Synthesize: "Resolve /audit-script findings: <comma-separated rule IDs from BEFORE>" |
| `--migrate-bucket` | Synthesize: "Split this hook by responsibility into the correct hooks.json bucket; update hooks.json accordingly" |
| _(no flag)_ | Ask the user with AskUserQuestion: "What change should be applied to this script? Be specific — name the function, behavior, or audit rule." |

Re-prompt once on an empty interactive answer; STOP on the second empty answer.

### 3. Apply mechanical fixes (`--fix` only)

For each finding in `BEFORE` whose rule appears in the table below, apply the listed `Edit` directly to `<path>`. Skip rules not in the table and forward them to the `script-author` invocation in Step 4.

| Rule | Violation pattern | Mechanical fix via `Edit` |
|------|-------------------|---------------------------|
| S1 | `set -e` or `set -eo pipefail` without `-u` | Insert `set -euo pipefail` as the first non-comment line; remove the weaker form |
| S3 | `echo "$payload" \| jq ...` | Replace `echo "$payload"` with `printf '%s' "$payload"` |
| S6 | `echo` in stdout output positions | Replace `echo "<x>"` with `printf '%s\n' "<x>"` |
| S7 | `cd "<dir>" && <tool> ...` | Wrap as `( cd "<dir>" && <tool> ... )` |
| S17 | Hardcoded absolute prefix in `hooks.json` `command` | Replace prefix with `${CLAUDE_PLUGIN_ROOT}` |

Everything else (S2 missing header, S4 dispatch on `hook_event_name`, S5 stdin parsing, S8 idempotency, S9 portability, S10 quoting, S11 awk vs sed, S12 trap/cleanup, S13 logging, S14 JSON output, S15 function extraction, S16 exit codes, S18 unit tests, S19 skill-block global state) requires `script-author`.

After each mechanical fix, re-`Read` the affected region once to confirm the substitution applied as intended.

### 4. Delegate structural changes to `script-author`

Skip when `--fix` produced no residual structural findings AND no `--change` / `--migrate-bucket` is in effect.

```bash
REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"
```

Invoke the `script-author` subagent with this brief:

```json
{
  "mode": "edit",
  "existing_path": "<absolute path>",
  "change_request": "<change_request from Step 2>",
  "preserve_rules": ["S1", "S2", "S4", "S7", "S10", "S14", "S17"],
  "auto_fix_already_applied": ["<rule IDs handled in Step 3, or []>"],
  "migrate_bucket": <true | false>,
  "refs_dir": "<REFS_ABS_PATH>"
}
```

`preserve_rules` lists rules that must remain PASS in unchanged portions. The author returns a report block listing files touched and decisions made.

### 5. Bucket migration follow-up (`--migrate-bucket` only)

Confirm with the user before destructive moves unless `--auto` is set:

| Sub-step | Action |
|----------|--------|
| New file path | The author reports the new file under the correct bucket dir; verify it exists with `test -f` |
| `hooks.json` update | The author edits `hooks.json` to register both files; verify with `Read` |
| Original file disposition | If the original is now empty/stub, ask the user whether to delete (skip in `--auto`; default: keep stub) |
| `chmod +x` on new file | Run `chmod +x <new path>` |

### 6. Post-audit (verification)

Invoke: `/audit-script <path>` (and the migrated bucket file, if any).

Capture findings as `AFTER`.

### 7. Compare and verdict

Compute the delta:

- `RESOLVED`: rules FAIL in `BEFORE` → PASS in `AFTER`.
- `INTRODUCED`: rules PASS in `BEFORE` → FAIL in `AFTER`.
- `UNCHANGED`: everything else.

| Condition | Verdict | Behavior |
|-----------|---------|----------|
| `AFTER` still contains any HIGH finding from `BEFORE` | FAIL | Roll back the edit via the inverse `Edit` calls (or `git checkout -- <path>` if cleaner); report rollback in output |
| `INTRODUCED` contains any HIGH | FAIL | Roll back as above |
| `INTRODUCED` only MEDIUM/LOW | WARN | Surface findings; let the user decide |
| `INTRODUCED` empty AND no residual HIGH | PASS | Continue |

In `--auto` mode, FAIL still rolls back; WARN and PASS continue without prompts.

## Output

```
/edit-script complete
  Path:           <absolute path>
  Mode:           <fix | change | migrate-bucket>
  Change request: <verbatim or synthesized>

Mechanical fixes (in-skill Edits):
  <rule → one-line description, or 'none'>

Author decisions:
  <paste 'Decisions:' from script-author report, or 'n/a'>

Author self-review:
  Verdict:  <PASS | FIX-APPLIED | OPEN | n/a>
  Repairs:  <rule → fix, or 'none'>

Audit delta:
  Before:   HIGH=<n> MEDIUM=<n> LOW=<n>
  After:    HIGH=<n> MEDIUM=<n> LOW=<n>
  Resolved:    <rule IDs no longer failing>
  Introduced:  <rule IDs newly failing, or 'none'>

Verdict: <PASS | WARN | FAIL>

<If --migrate-bucket:>
  Migrated:
    From:   <original path>
    To:     <new bucket path>
    hooks.json: updated (entries: <list>)

<If FAIL:>
  Edit rolled back. Review the audit findings:
    Invoke /audit-script <path>

<If WARN:>
  Edit applied with MEDIUM/LOW regressions:
    <list>

<If PASS:>
  Edit applied with no regressions.

Next:
  - Review the diff: git -C <repo> diff <path>
  - Re-run /audit-script <path> after further manual edits
```

## Error handling

| Condition | Action |
|-----------|--------|
| Pre-audit cannot run (references missing) | STOP — refuse to edit blindly |
| `script-author` returns an error | STOP — leave the file untouched; surface the subagent error |
| `--fix` and `BEFORE` reports no violations | Report "audit clean — nothing to fix"; exit without invoking author |
| `--migrate-bucket` but the hook has only one responsibility | Report "no split needed — hook already single-purpose"; exit |
| Post-audit cannot run | Emit output without delta; mark verdict INCONCLUSIVE |
| HIGH regression detected | Roll back via inverse `Edit` calls or `git checkout -- <path>`; mark FAIL |
| `chmod +x` fails on migrated file | Report failure; leave migration in place; user fixes perms manually |
| Path resolves outside the plugin/repo tree | STOP — refuse paths outside `$(git rev-parse --show-toplevel)` unless absolute and explicit |

## Scope

Own: argument parsing, baseline audit, mechanical `Edit`-based fixes for the S1/S3/S6/S7/S17 table, delegation to `script-author` for structural changes, bucket-migration follow-up, verification audit, delta comparison, rollback on HIGH regression, and the output block.

Boundaries:
- Edit only the target script (and, for `--migrate-bucket`, the new bucket file + `hooks.json`). Do not touch unrelated siblings.
- Invoke `script-author` at most once per call.
- Never modify `script-style.md` or other reference files.
- Mechanical fixes are limited to the S1/S3/S6/S7/S17 table. Anything else routes through the author.
- Roll back on HIGH regression; never overwrite the user's working tree without surfacing it in the output block.
