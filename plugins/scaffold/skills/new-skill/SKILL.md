---
name: new-skill
description: Use when the user asks to create a new Claude Code skill (slash command). Gathers a brief, delegates design to the skill-author subagent, writes the skills/<name>/ directory, then runs /audit-skill. Interactive — asks clarifying questions before writing.
argument-hint: <name> [--invocation user-only|model-allowed] [--context inline|fork] [--dest <path>]
arguments: [name]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git rev-parse *), Bash(ls *), Bash(mkdir -p *), Bash(test *)
---
<!--
arguments: one positional slot (name). Flags parsed from $ARGUMENTS by the body.
Bash(chmod *) removed: skill-author holds that capability and marks its own scripts
executable during creation; new-skill does not chmod again.
-->


# /new-skill — create a new Claude Code skill

Scaffolds a `skills/<name>/` directory by delegating design to the `skill-author` subagent and validating with `/audit-skill`.

## Arguments

| First token | Action |
|-------------|--------|
| `<kebab-name>` | Use as skill name; ask remaining fields |
| `<name> --invocation <user-only\|model-allowed>` | Skip invocation prompt |
| `<name> --context <inline\|fork>` | Skip context-mode prompt |
| `<name> --dest <path>` | Skip destination prompt |
| `<name> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /new-skill <name> [flags]" |

## Preconditions

| Condition | Action |
|-----------|--------|
| Name not kebab-case | STOP |
| Target directory already exists | STOP — "Use /audit-skill to review, or delete first" |
| References missing | STOP |

## Steps

### 1. Collect brief

Ask only for missing fields:

| Field | Question | Choices |
|-------|----------|---------|
| `purpose` | "What does this skill do, in one sentence?" | (free text) |
| `invocation` | "Who can invoke this skill?" | `user-only` (disable-model-invocation=true — side effects or destructive), `model-allowed` (Claude can auto-invoke) |
| `side_effects` | "What side effects does it have?" | `none` (pure read), `reads` (read-only with no writes), `writes` (creates/edits files), `network` (external calls), `destructive` (deletes, force-pushes, etc.) |
| `arguments` | "What positional arguments does it take? (empty = none, else space-separated names)" | (free text) |
| `context_mode` | "How should it run?" | `inline` (in the current session), `fork` (isolated subagent — requires complete self-contained prompt) |
| `fork_agent` | (if context_mode=fork) "Which subagent type?" | `Explore`, `Plan`, `general-purpose`, custom |
| `dest` | "Where should the directory go?" | `plugins/scaffold/skills/`, `skills/` (repo root), `.claude/skills/` (consumer), custom |

If `side_effects in {writes, network, destructive}` but user picked `model-allowed`, warn and default to `user-only`.

### 2. Resolve output directory

```
REPO_ROOT=$(git rev-parse --show-toplevel)
case "$dest" in
  plugins/scaffold/*) OUT_DIR="$REPO_ROOT/plugins/scaffold/skills/$name" ;;
  skills/*)           OUT_DIR="$REPO_ROOT/skills/$name" ;;
  .claude/skills/*)   OUT_DIR="$REPO_ROOT/.claude/skills/$name" ;;
  *)                  OUT_DIR="$dest/$name" ;;
esac
```

Verify parent exists (`mkdir -p "$(dirname "$OUT_DIR")"`). Verify `$OUT_DIR` does not exist.

### 3. Delegate to skill-author

Invoke `skill-author` subagent with:

```json
{
  "name": "<name>",
  "purpose": "<purpose>",
  "invocation": "<user-only|model-allowed>",
  "side_effects": "<...>",
  "arguments": [<parsed list or empty>],
  "context_mode": "<inline|fork>",
  "fork_agent": "<agent or null>",
  "output_dir": "<OUT_DIR>",
  "stack_hints": "<optional>"
}
```

The subagent reads references, designs the skill, and writes `SKILL.md` + any `scripts/` or `templates/`. Returns a report block.

### 4. Audit

Invoke: `/audit-skill <OUT_DIR>/SKILL.md`

(The author agent has `Bash(chmod *)` in its own allowlist and marks any scripts it creates executable during generation — no post-processing step here.)

### 5. Emit output

## Output

```
/new-skill complete
  Name:         <name>
  Directory:    <OUT_DIR>
  Files:        <list>
  Invocation:   <user-only|model-allowed>
  Context:      <inline|fork:<agent>>
  Arguments:    <list or none>

Skill-author decisions:
  <paste 'Decisions:' section>

Audit result:
  Verdict:      <PASS|FAIL>
  HIGH:   <count>   MEDIUM: <count>   LOW: <count>

<If FAIL:>
  ⚠️ HIGH findings — review before using:
    <list>

<If PASS:>
  ✓ Skill is ready. Invoke with: /<name> <args>

Next:
  - Review the file at <OUT_DIR>/SKILL.md
  - If side_effects ≠ none: verify disable-model-invocation was set
```

## Error handling

| Condition | Action |
|-----------|--------|
| skill-author fails | STOP — do NOT leave partial directory; run `rm -rf $OUT_DIR` only after explicit user ack |
| Audit cannot run | Warn; emit output without audit section |
| Audit returns FAIL | Emit output with findings; do NOT auto-delete |
| User answered `model-allowed` for a write/destructive skill | Override to `user-only`, note in Decisions |

## Never

- Auto-fix audit findings.
- Create the skill as a flat `<name>.md` file — always a directory.
- Proceed without an explicit `purpose`.
- Invoke `skill-author` more than once per call.
