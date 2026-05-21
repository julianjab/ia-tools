---
name: new-script
description: Use when the user asks to create a new bash hook, repo script, or skill bash block following ia-tools structured-bash style. Gathers a brief, delegates design to the script-author subagent, writes the file, then runs /audit-script on it.
when_to_use: |
  Trigger phrases: "create a hook", "new bash script", "scaffold a hook",
  "add a PreToolUse hook", "generate a repo script", "author a hook",
  "new TaskCompleted hook", "build a structured-bash script",
  "add scripts/X.sh", "write a skill bash block".
argument-hint: <name> [--context hook|repo-script|skill-block] [--plugin <name>] [--bucket enforcement|bookkeeping|intelligence] [--listens-to <event>[,<event>]] [--dest <path>]
arguments: [name]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(chmod *), Bash(test *), Bash(mkdir -p *), Bash(ls *), Bash(git rev-parse *)
---
<!--
arguments: declares ONE positional slot (name). Flags (--context, --plugin, --bucket,
--listens-to, --dest) are parsed from $ARGUMENTS by the body — they are not positional
slots per references/skill-frontmatter.md.

Bash is scoped to a small set of read-only / side-effect-free matchers plus chmod and
mkdir -p, the only mutating shell operations this skill performs directly.
-->


# /new-script — create a new structured bash script

Scaffolds one bash artifact — a plugin hook, a repo script, or a skill bash block — by delegating the design to the `script-author` subagent and validating with `/audit-script`. Style rules live in `references/script-style.md` (S1–S20) — this skill does not duplicate them.

## Arguments

| First token | Action |
|-------------|--------|
| `<kebab-name>` | Use as script base name; ask for remaining fields |
| `<name> --context <c>` | Use `<c>` as context (`hook`, `repo-script`, `skill-block`); skip that prompt |
| `<name> --plugin <p>` | Use `<p>` as target plugin (hook context only); skip that prompt |
| `<name> --bucket <b>` | Use `<b>` as hook bucket (`enforcement`, `bookkeeping`, `intelligence`) |
| `<name> --listens-to <ev>[,<ev>...]` | Comma-separated event list (hook context only) |
| `<name> --dest <path>` | Override destination directory |
| `<name> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /new-script <name> [--context ...] [--plugin ...] [--bucket ...] [--listens-to ...] [--dest ...]" |

Parse `$ARGUMENTS` as a string: first token is `$name`; scan remaining tokens for `--context`, `--plugin`, `--bucket`, `--listens-to`, `--dest` value pairs.

## Preconditions

| Condition | Action |
|-----------|--------|
| Name not kebab-case (`^[a-z][a-z0-9-]*$`) | STOP — "name must be kebab-case" |
| Resolved target path already exists | STOP — "Use /audit-script or /edit-script to modify; or pick a new name / --dest" |
| Context = `hook` but `plugins/<plugin>/` does not exist | STOP — list available plugins under `plugins/` (via `ls`), ask which |
| Bucket = `enforcement` but every `--listens-to` event is non-blocking (`SessionStart`, `SessionEnd`, `UserPromptSubmit`) | STOP — "enforcement bucket requires a blocking event (PreToolUse, TaskCompleted, TeammateIdle, PostToolUse). See script-style.md S5." |
| `references/script-style.md` missing | STOP — "Scaffold plugin references missing. Reinstall the plugin." |
| Not in a git repo (hook or repo-script context) | STOP — "hook and repo-script contexts require a git repo (paths anchor on repo root)" |

## Steps

### 1. Collect the brief

For any field not supplied via argv, ask the user with `AskUserQuestion`. Use these exact prompts:

| Field | Question | Choices |
|-------|----------|---------|
| `context` | "What kind of bash artifact?" | `hook` (plugin hook under `plugins/<p>/hooks/scripts/`), `repo-script` (under `scripts/` or `plugins/<p>/scripts/`), `skill-block` (fenced bash block inside a `SKILL.md`) |
| `purpose` | "What does this script do? One sentence, present tense." | (free text) |
| `plugin` *(hook or plugin repo-script)* | "Which plugin owns this script?" | (list directories under `plugins/`) |
| `bucket` *(hook only)* | "Which hook bucket?" | `enforcement` (may `exit 2` to block; `set -euo pipefail`), `bookkeeping` (writes state; non-blocking; `set -u` only), `intelligence` (LLM-assisted; non-blocking; `set -u` only) |
| `listens_to` *(hook only)* | "Which event(s)?" | `PreToolUse`, `PostToolUse`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptSubmit`, `SessionStart`, `SessionEnd` (multi-select; comma-separated) |
| `argv_pattern` *(repo-script only)* | "One-line usage string (e.g. `<feature> [--repo <path>]`)" | (free text) |
| `exit_codes` *(repo-script only)* | "Exit codes — what does each non-zero code mean?" | (free text, e.g. `2 = bad args, 3 = repo missing`) |
| `dest` *(if not provided)* | "Where should the file be written?" | suggest default per context (see Step 2) |

Do NOT ask if argv already supplied the value. Skip all hook-only / repo-script-only questions when the context does not apply.

### 2. Resolve output path

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

case "$context" in
  hook)
    DEFAULT_DEST="$REPO_ROOT/plugins/$plugin/hooks/scripts"
    OUT="${dest:-$DEFAULT_DEST}/$name.sh"
    ;;
  repo-script)
    if [ -n "$plugin" ]; then
      DEFAULT_DEST="$REPO_ROOT/plugins/$plugin/scripts"
    else
      DEFAULT_DEST="$REPO_ROOT/scripts"
    fi
    OUT="${dest:-$DEFAULT_DEST}/$name.sh"
    ;;
  skill-block)
    # skill-block writes a snippet file the user pastes into SKILL.md
    OUT="${dest:-$REPO_ROOT/.scratch}/$name.skill-block.md"
    ;;
esac
```

Run `mkdir -p` on the parent directory. Verify `$OUT` does not exist (Preconditions row).

### 3. Delegate to script-author

Compute the absolute references path so the subagent does not depend on its own CWD:

```bash
REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"
```

Invoke the `script-author` subagent (via `Task` tool, `subagent_type=script-author`) with this JSON brief:

```json
{
  "name": "<name>",
  "purpose": "<purpose>",
  "context": "<hook|repo-script|skill-block>",
  "plugin": "<plugin or empty>",
  "bucket": "<enforcement|bookkeeping|intelligence or empty>",
  "listens_to": ["<ev1>", "<ev2>"],
  "argv_pattern": "<usage string or empty>",
  "exit_codes": "<free-form or empty>",
  "output_path": "<OUT>",
  "refs_dir": "<REFS_ABS_PATH>"
}
```

The subagent reads `${refs_dir}/script-style.md`, designs the script, writes the file, and returns a report block with `Verdict: PASS|FAIL` and a graded S1–S20 self-review.

### 4. Triage the author report

| Condition | Action |
|-----------|--------|
| Report `Verdict: FAIL` or any HIGH finding | STOP — surface the report to the user verbatim; do NOT proceed to audit; do NOT delete the file (user decides) |
| Report `Verdict: PASS` or only MEDIUM/LOW | Continue to Step 5 |

### 5. Audit

For `hook` and `repo-script`: invoke `/audit-script <OUT>`.

For `skill-block`: skip `/audit-script` (it scans `.sh` files); rely on the author's S1–S20 self-review.

### 6. Hook registration check (hook context only)

Read `plugins/<plugin>/hooks/hooks.json`. Grep for the new relative path (`hooks/scripts/<name>.sh`). If absent, do NOT auto-edit — print the exact JSON snippet the user must paste under each `--listens-to` event, including matcher placeholder where applicable.

### 7. Make the script executable (hook, repo-script)

```bash
chmod +x "$OUT"
```

Skip for `skill-block`.

### 8. Emit the output block

## Output

```
/new-script complete
  Name:         <name>
  Path:         <OUT>
  Context:      <hook|repo-script|skill-block>
  Plugin:       <plugin or n/a>
  Bucket:       <bucket or n/a>
  Listens to:   <comma-separated events or n/a>
  Executable:   <yes|no>

Author decisions:
  <paste 'Decisions:' section from script-author report>

Self-review (S1–S20):
  Verdict:      <PASS|FIX-APPLIED|FAIL>
  HIGH:         <count>   MEDIUM: <count>   LOW: <count>
  Open issues:  <list or none>

Audit result:
  Verdict:      <PASS|FAIL|skipped>
  Findings:     <inline list or 'clean'>

<If hook and not registered:>
  ⚠ Hook not yet registered. Add to plugins/<plugin>/hooks/hooks.json:

      <exact JSON snippet>

<If HIGH findings:>
  ⚠ HIGH findings present. Review and fix before relying on this script:
      <list>

<If clean:>
  ✓ Script is ready to use.

Next:
  - Review the file at <OUT>
  - <context-specific next step: register in hooks.json / wire into CI / paste into SKILL.md>
```

## Error handling

| Condition | Action |
|-----------|--------|
| `script-author` subagent fails | STOP — surface the subagent error verbatim; do NOT leave a partial file |
| Author reports `Verdict: FAIL` or HIGH findings | STOP — surface report; do NOT run `/audit-script`; let the user decide |
| `/audit-script` reports HIGH after a clean author report | STOP — surface findings; do NOT delete the file |
| `/audit-script` cannot run (skill missing) | Warn but continue — emit output with `Audit result: skipped` |
| `chmod +x` fails | Warn but continue — emit output with `Executable: no` and a `chmod +x <OUT>` reminder |
| Hook target plugin missing `hooks/hooks.json` | Warn — print the file the user must create plus the snippet to put in it |
| Context = `hook` and every listens-to event is non-blocking while bucket = `enforcement` | Caught in Preconditions; STOP earlier |

## Scope

Own: argument parsing, gathering the brief, resolving `OUT`, delegating once to `script-author`, running `/audit-script`, optional `chmod +x`, and emitting the output block.

Boundaries:
- Do NOT edit `plugins/<plugin>/hooks/hooks.json`; print the snippet and let the user commit the registration.
- Do NOT duplicate S1–S20 rules — `references/script-style.md` is the canonical source the author and `/audit-script` both read.
- Invoke `script-author` exactly once per call. Re-run the skill if the brief changes.
- Write only inside the resolved `dest`. Refuse to overwrite an existing file.
- Require a non-empty `purpose` before delegating; the artifact depends on it.
