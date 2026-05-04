---
name: edit-agent
description: Use when the user asks to modify an existing Claude Code agent definition (agents/<name>.md). Audits the file, delegates the change to the agent-author subagent in edit mode, then re-audits to confirm no regressions. Interactive — collects a change request before editing.
when_to_use: |
  Trigger phrases: "edit this agent", "update agents/X.md", "change the agent's tools",
  "rename this agent", "add a section to my agent", "fix this agent's description",
  "tighten the maxTurns", "switch model on agent X", "apply audit fixes to agents/X.md",
  "modify a teammate", "rewrite an agent's escalation".
argument-hint: <path-to-agent.md> [--change "<plain-language request>"] [--auto]
arguments: [path]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(git rev-parse *), Bash(ls *), Bash(test *), Bash(diff *)
---
<!--
arguments: one positional slot (path). Flags (--change, --auto) parsed from $ARGUMENTS.
--auto turns the skill non-interactive: requires --change, accepts the agent-author
result without confirmation, still blocks on HIGH regression.
-->


# /edit-agent — apply a focused change to an existing agent

Updates a single `agents/<name>.md` by delegating the change to `agent-author` in `mode: edit` and bracketing it with `/audit-agent` runs (before + after) so the user sees whether the edit improved or regressed the file.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>.md` | Edit that file; ask for the change request |
| `<path> --change "<text>"` | Use `<text>` as the change request; skip the prompt |
| `<path> --change "<text>" --auto` | Run end-to-end without confirmation prompts |
| `<path> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /edit-agent <path-to-agent.md> [--change \"...\"] [--auto]" |

Parse `$ARGUMENTS` as a string: first token is `$path`; scan for `--change <quoted-or-rest>` and `--auto`.

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP — "File not found: <path>" |
| Path is not a `.md` file | STOP — "/edit-agent expects a .md file, got <ext>" |
| File has no frontmatter | STOP — "Target lacks YAML frontmatter; use /new-agent instead" |
| Required reference files missing | STOP — "Scaffold plugin references missing. Reinstall the plugin." |

## Steps

### 1. Pre-audit (baseline)

Invoke: `/audit-agent <path>`

Capture the findings table and verdict as `BEFORE`. Continue regardless of severity — the goal of the edit may be to fix the findings.

### 2. Collect the change request

Skip when `--change` is supplied. Otherwise ask the user with AskUserQuestion:

| Field | Question |
|-------|----------|
| `change_request` | "What change should be applied to this agent? Describe it as you would to a coworker — one sentence is fine." |

The change request flows verbatim to `agent-author`. Be specific; "tighten tools to read-only and bump maxTurns to 30" is better than "improve it".

### 3. Resolve absolute references path

```bash
REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"
```

### 4. Delegate to agent-author in edit mode

Invoke the `agent-author` subagent with this brief:

```json
{
  "mode": "edit",
  "name": "<derived from filename stem>",
  "existing_path": "<absolute path>",
  "change_request": "<change_request>",
  "refs_dir": "<REFS_ABS_PATH>"
}
```

The subagent reads the existing file, applies the change with minimum viable diff, runs its own self-review against A1–A14, repairs HIGH violations it introduced, and returns a report block.

### 5. Post-audit (verification)

Invoke: `/audit-agent <path>`

Capture findings as `AFTER`.

### 6. Compare and verdict

Compute the delta:

- `RESOLVED`: rules that were FAIL in `BEFORE` and PASS in `AFTER`.
- `INTRODUCED`: rules that were PASS in `BEFORE` and FAIL in `AFTER` (regression).
- `UNCHANGED`: everything else.

Verdict logic:

| Condition | Verdict |
|-----------|---------|
| `INTRODUCED` contains any HIGH | FAIL — surface findings, recommend revert |
| `INTRODUCED` is non-empty but only MEDIUM/LOW | WARN — surface findings, let the user decide |
| `INTRODUCED` is empty | PASS |

In `--auto` mode, FAIL exits non-zero without prompting; WARN and PASS continue.

### 7. Emit output

## Output

```
/edit-agent complete
  Path:           <absolute path>
  Change request: <verbatim>

Author decisions:
  <paste 'Decisions:' from agent-author report>

Author self-review:
  Verdict:  <PASS | FIX-APPLIED | OPEN>
  Repairs:  <rule → fix, or 'none'>

Audit delta:
  Before:   HIGH=<n> MEDIUM=<n> LOW=<n>
  After:    HIGH=<n> MEDIUM=<n> LOW=<n>
  Resolved:    <list of rule IDs no longer failing>
  Introduced:  <list of rule IDs newly failing, or 'none'>

Verdict: <PASS | WARN | FAIL>

<If FAIL:>
  ⚠️ Edit introduced HIGH regressions. Review the diff and consider reverting:
    git -C <repo> diff <path>

<If WARN:>
  ⚠️ Edit introduced MEDIUM/LOW issues:
    <list>

<If PASS:>
  ✓ Edit applied with no regressions.

Next:
  - Review the diff: git -C <repo> diff <path>
  - Run /audit-agent <path> again if you make further manual edits
```

## Error handling

| Condition | Action |
|-----------|--------|
| Pre-audit cannot run (references missing) | STOP — refuse to edit blindly |
| `agent-author` fails | STOP — leave the file untouched; report the subagent error |
| Post-audit cannot run | Emit output without delta; mark verdict as INCONCLUSIVE |
| HIGH regression and `--auto` | Exit non-zero; do not auto-revert (preserve user's option) |
| Empty `change_request` (interactive) | Re-prompt once; STOP on second empty answer |

## Scope

Own: argument parsing, baseline audit, delegation to `agent-author`, verification audit, delta comparison, and the output block.

Boundaries:
- Edit only the target file via `agent-author`. Do not touch siblings.
- Invoke `agent-author` exactly once per call.
- Report regressions; do not auto-revert. The user owns the decision.
- Stay inside the agent's directory — refuse paths that resolve outside `agents/` or `plugins/*/agents/` unless the user passes an explicit absolute path.
