---
name: audit-script
description: Use when the user asks to review or validate a bash hook, repo script, or skill bash block against ia-tools structured-bash style rules. Reports missing doc headers, unquoted expansions, mixed-bucket responsibilities, unsafe piping, and the 20 script-style rules (S1-S20). Read-only; never edits the target.
when_to_use: |
  Trigger phrases: "review this script", "validate hooks/X.sh", "check bash style",
  "lint a hook", "does this script follow conventions", "audit hook script",
  "find issues in scripts/X.sh", "run S1-S20 rules", "verify hook bucket",
  "script-style audit", "structured-bash check", "check enforcement hook",
  "audit bash block in SKILL.md", "suggest hook migration", "split enforcement and bookkeeping",
  "is this hook mixing responsibilities", "script-author output review".
argument-hint: <path> [--strict] [--suggest-migration]
arguments: [path, flag1, flag2]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(test *), Bash(ls *)
---

# /audit-script — validate a bash script against structured-bash style rules

Takes a path to a `.sh` script, a directory of scripts, or a `SKILL.md` with embedded bash blocks. Loads `references/script-style.md`, runs rules S1-S20, emits a structured report. Read-only.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>` ending in `.sh` | Audit that script |
| `<path>` ending in `.md` | Audit fenced ```bash blocks inside (skill bash blocks) |
| `<path>` that is a directory | Audit every `.sh` recursively (`--recursive` implied) |
| `<path> --strict` | Upgrade MEDIUM findings to HIGH (CI use) |
| `<path> --suggest-migration` | Also run bucket decision tree; emit migration plan when responsibilities are mixed |
| _(empty)_ | STOP — "Usage: /audit-script <path>" |

`$ARGUMENTS[0]` = path, `$ARGUMENTS[1..]` = optional flags. `--strict` and `--suggest-migration` may both appear.

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP — "File not found: <path>" |
| Path is not `.sh`, not `.md`, and not a directory | STOP — "/audit-script expects .sh, .md, or a directory" |
| Path not readable | STOP — permission error |
| `references/script-style.md` missing | STOP — "references/script-style.md not found. Is the scaffold plugin installed?" |
| Directory has no `.sh` files | Warn "no scripts to audit"; emit empty report |
| `.md` target has no ```bash regions | Warn "no bash blocks to audit"; emit empty report |

## Load references

Read `${CLAUDE_SKILL_DIR}/../../references/script-style.md` and parse:

1. The 20 numbered rules (S1-S20) with their severity and check method.
2. The bucket decision tree (used by `--suggest-migration`).

## Detect context

Classify each target file by path before running rules:

| Path pattern | Context | Bucket |
|--------------|---------|--------|
| `plugins/<plugin>/hooks/scripts/enforcement/*.sh` | hook | enforcement |
| `plugins/<plugin>/hooks/scripts/bookkeeping/*.sh` | hook | bookkeeping |
| `plugins/<plugin>/hooks/scripts/intelligence/*.sh` | hook | intelligence |
| `plugins/<plugin>/hooks/scripts/*.sh` (unbucketed) | hook | unknown — may trigger migration suggestion |
| `scripts/*.sh` or `plugins/<plugin>/scripts/*.sh` | repo-script | n/a |
| `*.md` | skill-block (extract fenced ```bash) | n/a |

## Checks — run in order

### 1. Rules S1-S20

For each rule defined in `references/script-style.md`:

- Read the rule's check method from the reference (line patterns, header
  fields, quoting checks, exit-code expectations, etc.).
- Apply it to the file content.
- Record a finding with: severity (from rule), rule id (`S1`, `S2`, ...),
  best-effort `file:line` (the matching line, or `L1-L8` for header
  rules), short message, and `auto-fix: yes|no` (mapping mirrors
  `/edit-script`'s repair table).

### 2. Bucket suggestion (`--suggest-migration` only)

Walk the decision tree from the reference:

```
Does the script ever `exit 2`?                    → enforcement
Does it call `claude -p` / Anthropic API?         → intelligence
Does it modify state.md or hook-audit.log?        → bookkeeping
None of the above                                 → consider promoting to repo script
```

If the script triggers more than one branch (e.g., has both `exit 2` AND
state.md writes), record a `mixed-bucket` finding and emit a `migrate:`
section in the report:

- Suggested split: which line ranges go to which bucket file.
- Required `hooks.json` changes (register both, enforcement first).

### 3. Smoke checks

| Check | Severity |
|-------|----------|
| Shebang missing or not `#!/usr/bin/env bash` | HIGH |
| `set -euo pipefail` missing | HIGH |
| File not executable (`.sh` only) | MEDIUM |
| File > 200 lines | LOW (split candidate) |
| Filename does not match `[a-z0-9-]+\.sh` | LOW |

## Steps

1. Resolve `$ARGUMENTS[0]`. If directory, glob `**/*.sh` recursively. If `.md`, extract fenced ```bash regions and treat each as a virtual file with `file:line` offsets preserved.
2. Read `references/script-style.md` and parse the rule table.
3. For each target file:
   a. Detect context and bucket.
   b. Apply rules S1-S20.
   c. Run smoke checks.
   d. If `--suggest-migration`, run the bucket decision tree.
4. If `--strict`, upgrade every MEDIUM finding to HIGH before tallying.
5. Emit the report (one block per target when auditing a directory).

## Output

```
/audit-script report
  Target:       <abs path>
  Context:      hook | repo-script | skill-block
  Bucket:       <enforcement | bookkeeping | intelligence | unknown | n/a>
  Mode:         strict | normal
  Migration:    on | off
  Rules run:    S1-S20 + 5 smoke checks

| Severity | Rule | Finding                                          | Location | Auto-fix |
|----------|------|--------------------------------------------------|----------|----------|
| HIGH     | S3   | echo "$payload" | jq (unquoted pipe input)       | L19      | yes      |
| MEDIUM   | S2   | header doc-comment missing fields: Bucket, Blocking | L1-L8 | no       |
| LOW      | S16  | helper function lacks doc block                  | L45      | no       |

migrate:                           # only when --suggest-migration triggers
  Reason: script mixes enforcement (exit 2 at L52) and bookkeeping (state.md write at L78).
  Suggested split:
    enforcement/<name>.sh: L1-L60
    bookkeeping/<name>.sh: L1-L20 (helpers) + L61-L100
  hooks.json: register both; enforcement first.

Summary:
  HIGH:    <count>
  MEDIUM:  <count>
  LOW:     <count>
  Auto-fixable: <count>

Verdict: <PASS | FAIL>
  PASS if 0 HIGH and (strict: 0 MEDIUM, else MEDIUM <= 3)
  FAIL otherwise

Next actions:
  - <one line per HIGH finding>
  - Run /edit-script <path> --fix to auto-repair <N> findings.
```

When auditing a directory, emit one report block per file followed by a
final aggregate summary line: `Aggregate: HIGH=<n> MEDIUM=<n> LOW=<n>
across <k> files`.

## Error handling

| Condition | Action |
|-----------|--------|
| Path not readable | STOP — permission error |
| Reference file missing | STOP — "references/script-style.md not found." |
| Unrecognized rule version in reference header | Warn; run rules that parsed successfully |
| `--strict` and `--suggest-migration` both set | Apply both |
| Unknown flag | Warn and ignore |
| Directory has no `.sh` files | Warn "no scripts to audit"; verdict PASS |
| `.md` target has no ```bash regions | Warn "no bash blocks to audit"; verdict PASS |

## Scope

Own: reading the target file(s), loading `references/script-style.md`,
applying rules S1-S20 plus smoke checks, optionally running the bucket
decision tree, and emitting the structured report.

Boundaries:
- Stay read-only. Never edits the target. Mechanical repairs are
  `/edit-script`'s responsibility.
- Always emit the report block, even when the verdict is FAIL.
- Bucket migration output is a SUGGESTION only — never split files here.
- Refuse to audit `.md` files outside a `skills/` directory unless the
  user passes an explicit path (avoid scanning random docs).
