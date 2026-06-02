---
name: audit-harness
description: Use when the user asks to audit an AI tool (agent, skill, or MCP server) against harness engineering best practices — the 2026 fourth-paradigm discipline of designing perception, action, verification, guardrail, and observability controls around AI agents. Detects victory-declaration bias, ungated side-effects, silent failures, unbounded tool surfaces, model lock-in, and missing self-verification. Read-only.
when_to_use: |
  Trigger phrases: "harness audit", "audit harness engineering",
  "review against harness best practices", "is this agent production-safe",
  "check for victory declaration bias", "audit AI tool", "harness review",
  "run HE rules", "check perception/action/verification/guardrails/observability",
  "is this MCP harness-safe", "review agent harness", "fourth paradigm audit".
argument-hint: <path-to-artifact> [--strict] [--type agent|skill|mcp]
arguments: [path, ...flags]
allowed-tools: Read, Grep, Glob, Bash(ls *), Bash(wc *), Bash(head *), Bash(find *), Bash(test *)
---

# /audit-harness — audit an AI tool against harness engineering rules

Takes a path to an agent, skill, or MCP plugin and reports findings
against the harness engineering rubric (rules HE-A*, HE-S*, HE-M*).
Read-only. Complements `/audit-agent`, `/audit-skill`, `/audit-mcp` —
those check *structural* correctness; this one checks *harness
behavior*.

## Arguments

| Token | Action |
|-------|--------|
| `<path>/agents/<name>.md` | Audit as agent (HE-A rules) |
| `<path>/skills/<name>/SKILL.md` or `<path>/skills/<name>/` | Audit as skill (HE-S rules) |
| `<path>/<name>/` (plugin dir with `.mcp.json`) | Audit as MCP (HE-M rules) |
| `--type agent\|skill\|mcp` | Force artifact type when auto-detect is ambiguous |
| `--strict` | Upgrade MEDIUM findings to HIGH |
| _(empty)_ | STOP — "Usage: /audit-harness <path> [--type agent|skill|mcp] [--strict]" |

`$ARGUMENTS[0]` = path; remaining tokens are flags in any order.

## Preconditions

| Condition | Action |
|-----------|--------|
| `$ARGUMENTS[0]` empty | STOP with usage |
| Path does not exist | STOP — "Path not found: <path>" |
| Auto-detect fails AND `--type` not provided | STOP — "Cannot detect artifact type; pass --type" |
| Referenced rubric file missing | STOP — name the missing file |

## Auto-detect artifact type

| Signal | Type |
|--------|------|
| Path ends in `SKILL.md` or directory contains `SKILL.md` | skill |
| Path is a `.md` file under `agents/` or matches `*/agents/*.md` | agent |
| Path is a directory containing `.mcp.json` OR `plugin.json` + `src/mcp-server.*` | mcp |
| Directory contains both `agents/` and `skills/` | STOP — ask user which artifact |

## Load the matching rubric

References live under `${CLAUDE_SKILL_DIR}/../../references/harness-engineering/`:

| Type | Rubric |
|------|--------|
| agent | `agents.md` (HE-A1…HE-A11) |
| skill | `skills.md` (HE-S1…HE-S10) |
| mcp   | `mcps.md` (HE-M1…HE-M13) |

Also load `README.md` once for the five-pillar mapping (perception,
action, verification, guardrails, observability) used in the report.

## Steps

1. Parse `$ARGUMENTS`; on missing path → STOP with usage.
2. Resolve absolute path; on missing → STOP.
3. Detect artifact type (or honor `--type`); on ambiguous → STOP.
4. Load the matching rubric + `README.md`.
5. For agents: read the `.md` file, parse frontmatter + body, run HE-A1…HE-A10.
6. For skills: read `SKILL.md`, list sibling files, run HE-S1…HE-S10.
7. For MCPs: list plugin layout (`.mcp.json`, `src/`, `tools/`), grep
   for the patterns named in HE-M2 / HE-M6 / HE-M10, run HE-M1…HE-M10.
8. Apply `--strict` if present (MEDIUM → HIGH).
9. Verify each finding cites a concrete location (file:line or "body");
   findings without a location are dropped (mitigates victory bias).
10. Emit report.

## Output

```
/audit-harness report
  Target:       <absolute path>
  Type:         <agent | skill | mcp>
  Rubric:       HE-<A|S|M>1..10 ({n} rules)
  Strict mode:  <on | off>

| Severity | Rule   | Pillar         | Finding                          | Location |
|----------|--------|----------------|----------------------------------|----------|
| HIGH     | HE-S5  | guardrails     | `git push` without a gate        | L88      |
| MEDIUM   | HE-A5  | verification   | No self-verification step        | body     |
| LOW      | HE-A9  | meta           | 312 lines — review for shims     | file     |

Summary:
  HIGH:    <count>
  MEDIUM:  <count>
  LOW:     <count>

Pillar coverage:
  perception:    <pass | fail>
  action:        <pass | fail>
  verification:  <pass | fail>
  guardrails:    <pass | fail>
  observability: <pass | fail>

Verdict: <PASS | FAIL>   (FAIL when any HIGH present)

Next actions:
  - <one line per HIGH finding>
```

## Error handling

| Condition | Action |
|-----------|--------|
| Rubric file missing | STOP — "references/harness-engineering/<file> not found" |
| Malformed frontmatter | Report as HIGH (HE-A1 / HE-S0) and continue |
| Permission denied on file | STOP — "Cannot read <path>" |
| `--type` value unknown | STOP — list valid values |
| `--strict` typo (e.g. `--Strict`) | Warn, proceed without strict |

## Scope

Own: reading the target artifact, loading the matching harness rubric,
running rules HE-A*/HE-S*/HE-M*, mapping each finding to one of the
five pillars, and emitting the structured report.

Boundaries (read-only invariants):
- Skill is read-only by `allowed-tools` (Read/Grep/Glob/Bash list-only).
  Apply fixes via `/edit-agent`, `/edit-skill`, `/edit-mcp`.
- Harness rules complement, not replace, the structural rules in
  `/audit-agent`, `/audit-skill`, `/audit-mcp`. Run both for full coverage.
- Audits Claude Code artifacts only. Refuses paths outside an
  `agents/`, `skills/`, or plugin directory unless `--type` is explicit.
