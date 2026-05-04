---
name: new-agent
description: Use when the user asks to create a new Claude Code agent. Gathers a brief, delegates design to the agent-author subagent, writes the agents/<name>.md file, then runs /audit-agent on it. Interactive — asks clarifying questions before writing.
when_to_use: |
  Trigger phrases: "create an agent", "new subagent", "generate a teammate",
  "scaffold an agent", "add agents/X.md", "make a new Claude Code agent",
  "build a security agent", "author an agent definition", "design a main-session agent".
argument-hint: <name> [--mode subagent|teammate|main] [--dest <path>]
arguments: [name]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git rev-parse *), Bash(ls *), Bash(mkdir -p *), Bash(test *)
---
<!--
arguments: declares ONE positional slot (name). Flags (--mode, --dest) are parsed from
$ARGUMENTS by the body — they are not positional slots per references/skill-frontmatter.md.
-->


# /new-agent — create a new Claude Code agent

Scaffolds a single `agents/<name>.md` file by delegating the design to the `agent-author` subagent and validating the result with `/audit-agent`.

## Arguments

| First token | Action |
|-------------|--------|
| `<kebab-name>` | Use as agent name; ask for remaining fields |
| `<kebab-name> --mode <m>` | Use `<m>` as execution_mode; skip that prompt |
| `<kebab-name> --dest <path>` | Use `<path>` as output directory; skip that prompt |
| `<kebab-name> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /new-agent <name> [--mode <m>] [--dest <path>]" |

Parse `$ARGUMENTS` as a string: first token is `$name`; scan remaining tokens for `--mode <value>` and `--dest <value>` pairs.

## Preconditions

| Condition | Action |
|-----------|--------|
| Name is not kebab-case (`^[a-z][a-z0-9-]*$`) | STOP — "name must be kebab-case" |
| Target file already exists at resolved dest | STOP — "Use /audit-agent to review, or delete the existing file first" |
| Not in a git repo | Warn but proceed — `git rev-parse --show-toplevel` fallback to cwd |
| Required reference files missing | STOP — "Scaffold plugin references missing. Reinstall the plugin." |

## Steps

### 1. Collect the brief

If any of `purpose`, `mode`, `dest` are missing, ask the user with AskUserQuestion. Use these exact questions:

| Field | Question | Choices |
|-------|----------|---------|
| `purpose` | "What does this agent do? One sentence, describing when to invoke it." | (free text) |
| `mode` | "How should this agent run?" | `subagent` (one-shot, returns artifact), `teammate` (persistent in agent team), `main` (top-level role listening to users) |
| `dest` | "Where should the file be written?" | `plugins/scaffold/agents/`, `agents/` (repo root), `.claude/agents/` (consumer), custom |
| `stack_hints` | "Any stack / domain hints? (optional — Python, React, mobile, etc.)" | (free text, empty ok) |

Do NOT ask if the flag provided the value.

### 2. Resolve output path

```
REPO_ROOT=$(git rev-parse --show-toplevel)
case "$dest" in
  plugins/scaffold/*) OUT="$REPO_ROOT/plugins/scaffold/agents/$name.md" ;;
  agents/*)           OUT="$REPO_ROOT/agents/$name.md" ;;
  .claude/agents/*)   OUT="$REPO_ROOT/.claude/agents/$name.md" ;;
  *)                  OUT="$dest/$name.md" ;;
esac
```

Verify the parent directory exists (create if missing with `mkdir -p`). Verify `$OUT` does not exist.

### 3. Delegate to agent-author

Compute the absolute path to the references dir so the agent doesn't rely on its own CWD:

```bash
REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"
```

Invoke the `agent-author` subagent with this brief:

```json
{
  "name": "<name>",
  "purpose": "<purpose>",
  "execution_mode": "<mode>",
  "stack_hints": "<stack_hints or empty>",
  "output_path": "<OUT>",
  "refs_dir": "<REFS_ABS_PATH>"
}
```

The subagent reads the references from `refs_dir` (absolute path), designs the agent, and writes the file. It returns a report block.

### 4. Audit the result

Invoke: `/audit-agent <OUT>`

### 5. Emit output block

## Output

```
/new-agent complete
  Name:         <name>
  Path:         <OUT>
  Mode:         <subagent|teammate|main>
  Model:        <from agent-author report>
  Tools:        <count>

Agent-author decisions:
  <paste 'Decisions:' section from agent-author report>

Audit result:
  Verdict:      <PASS|FAIL>
  HIGH:         <count>
  MEDIUM:       <count>
  LOW:          <count>

<If audit FAILED:>
  ⚠️ Audit flagged HIGH findings. Review and fix before using:
    <list findings>

<If audit PASSED:>
  ✓ Agent is ready to use.

Next:
  - Review the file at <OUT>
  - If mode=main: set IA_TOOLS_ROLE or equivalent in your session config
  - If mode=teammate: register in the relevant team roster
```

## Error handling

| Condition | Action |
|-----------|--------|
| `agent-author` subagent fails | STOP — report subagent error; do NOT leave a partial file |
| Audit cannot run (references missing) | Warn but continue — emit output without audit section |
| Audit returns FAIL with HIGH findings | Emit output with audit details; DO NOT delete the file — user decides |
| Output path conflicts with existing file | STOP before delegating |

## Never

- Auto-fix audit findings. User must review.
- Write to a path outside the chosen `dest`.
- Invoke `agent-author` more than once per skill call.
- Accept empty `purpose` — skill is useless without it.
