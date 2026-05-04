---
name: audit-agent
description: Use when the user asks to review or validate an existing Claude Code agent file (agents/<name>.md) against best practices. Reports frontmatter drops, description quality, tool-allowlist issues, model mismatches, and the 12 anti-patterns. Read-only; never edits the agent.
when_to_use: |
  Trigger phrases: "review this agent", "validate agents/X.md", "check agent frontmatter",
  "lint an agent", "does this agent follow best practices", "audit agent definition",
  "find issues in agents/X.md", "is my agent well-formed", "check description shape",
  "verify agent tools", "review my subagent", "teammate frontmatter check",
  "agent anti-patterns", "run A1-A12 rules", "agent-author output review".
argument-hint: <path-to-agent.md> [--strict]
arguments: [path, flag]
allowed-tools: Read, Grep, Glob, Bash(cat *), Bash(head *), Bash(wc *)
---

# /audit-agent — validate an agent definition against best practices

Takes a path to an `agents/<name>.md` file, loads the canonical references, and emits a structured report with severity levels. Read-only — never modifies the target.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>` ending in `.md` | Audit that file |
| `<path>` that's a directory | STOP — ask user to point at the specific `.md` file |
| _(empty)_ | STOP — report "Usage: /audit-agent <path-to-agent.md>" |
| `<path> --strict` | Upgrade all MEDIUM findings to HIGH (for CI use) |

`$ARGUMENTS[0]` = path, `$ARGUMENTS[1]` = optional `--strict`.

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP — "File not found: <path>" |
| Path is not a `.md` file | STOP — "/audit-agent expects a .md file, got <ext>" |
| File has no frontmatter (no `---` at top) | Report as HIGH finding A0; continue with body checks |
| Plugin context cannot be detected | Warn but continue — assume standalone rules |

## Load references

Read these files from the plugin root (`${CLAUDE_SKILL_DIR}/../../references/`):

1. `agent-frontmatter.md` — field matrix
2. `agent-anti-patterns.md` — the 12 rules A1–A12
3. `model-selection.md` — model decisions

## Checks — run in order

### 1. Parse frontmatter

Extract every field. If the file is under a `plugins/*/` directory, set `context = plugin`. If the file contains a comment or description indicating teammate use, set `teammate = true`.

### 2. Apply rules A1–A12

For each rule in `agent-anti-patterns.md`, evaluate:

| Rule | Check |
|------|-------|
| A1 | `description` must carry a trigger signal. PASS if it starts with "Use when"/"Invoke when"/"Call when" OR contains an action verb in the first sentence that implies delegation ("Receives…", "Implements…", "Produces…", "Reviews…", "Stages…", "Gathers…"). FAIL → HIGH if description is ≤ 80 chars AND lacks any such verb (pure noun phrase: "Security agent.", "Backend helper."). |
| A2 | If `context = plugin`: `hooks`, `mcpServers`, `permissionMode` absent. Present → HIGH (silently dropped). |
| A3 | If `teammate = true`: `skills`, `mcpServers` absent. Present → HIGH. |
| A4 | Cross-check `model` against body hints (gate/security → opus; implementer → sonnet; explorer → haiku). Mismatch → MEDIUM. |
| A5 | Applies only to **leads/orchestrators** (agent body self-identifies as lead OR lacks `Write`/`Edit`/`MultiEdit`). If lead has `Bash` unscoped in body → MEDIUM. Implementers with `Bash + Write` are PASS — they legitimately run test commands. |
| A6 | Body mentions "blockedBy" and creates a cycle → HIGH. (Static check — look for obvious circular references.) |
| A7 | Body enumerates >5 teammates → MEDIUM. |
| A8 | Body identifies as lead/orchestrator AND `tools` includes write tools → HIGH. |
| A9 | Body claims ownership of paths that overlap other agents in the same directory → MEDIUM. (Grep other agent files.) |
| A10 | Body has no "Output" / "Return" / "Output format" heading → MEDIUM. |
| A11 | Body references "project conventions" / "our framework" without declaring `skills:` preload (for subagents) → MEDIUM. |
| A12 | `maxTurns` missing → LOW. Implementer with `maxTurns < 40` → MEDIUM. Auditor with `maxTurns > 50` → LOW. |

### 3. Additional smoke checks

| Check | Severity |
|-------|----------|
| `name` matches filename stem | HIGH if mismatch |
| `description` length > 500 chars | MEDIUM |
| `color` is not a recognized value | LOW |
| `memory` set to `user` (global) without explicit reason in body | LOW (possibly mistake — most project agents should use `project`) |
| Body has no "Persona" / intro line | MEDIUM |
| `tools` contains tools not in Claude Code's tool catalog | HIGH (typo) |

## Steps

1. Read `$ARGUMENTS[0]`.
2. Parse YAML frontmatter using `head -n 50` + Bash `sed` for the `---` block, OR Read the whole file and locate the delimiters.
3. Load references listed above.
4. Apply rules A1–A12 + smoke checks.
5. Emit the output block.

## Output

```
/audit-agent report
  Target:       <absolute path>
  Name:         <name from frontmatter>
  Mode:         <plugin-subagent | plugin-teammate | plugin-main | standalone>
  Model:        <model>
  Rules run:    A1–A12 + 6 smoke checks

| Severity | Rule | Finding | Location |
|----------|------|---------|----------|
| HIGH     | A1   | description is label-shaped ("Security agent") | L3 |
| MEDIUM   | A10  | No output format section | body |
| LOW      | A12  | maxTurns not declared | L7 |

Summary:
  HIGH:    <count>
  MEDIUM:  <count>
  LOW:     <count>

Verdict: <PASS | FAIL>
  - PASS if 0 HIGH and (strict: 0 MEDIUM, else MEDIUM ≤ 3)
  - FAIL otherwise

Next actions:
  - <one line per HIGH finding, referencing the fix in agent-anti-patterns.md>
```

## Error handling

| Condition | Action |
|-----------|--------|
| Reference file missing | STOP — "references/agent-anti-patterns.md not found. Is the scaffold plugin installed?" |
| YAML parse fails | Report as HIGH A0 "Malformed frontmatter"; continue with body checks |
| Target file not readable | STOP — report permission error |
| `--strict` unrecognized flag | Warn and proceed without strict mode |

## Never

- Edit the target file. Auditing is read-only.
- Apply fixes automatically — only report. The caller decides.
- Exit 1 on findings — emit report and let the caller interpret.
