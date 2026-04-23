# Agent frontmatter — complete field reference

Source of truth for every `agents/*.md` field. Used by `/new-agent`, `/audit-agent`, and the `agent-author` subagent.

## Field matrix

| Field | Required | Type | Works in plugin? | Works for teammate? | Notes |
|-------|----------|------|------------------|---------------------|-------|
| `name` | yes | string | yes | yes | Lowercase, hyphens. Must match filename stem. |
| `description` | yes | string | yes | yes | **Trigger signal** — Claude matches tasks via this. Write as a condition, not a label. |
| `model` | no | `haiku`/`sonnet`/`opus`/`inherit` | yes | yes | See `model-selection.md`. Default `inherit`. |
| `tools` | no | string (comma list) | yes | yes | Allowlist. Omitting = inherit all. Use `Agent(x,y)` to restrict spawnable agents. |
| `disallowedTools` | no | string (comma list) | yes | yes | Denylist. Applied before `tools`. |
| `color` | no | string | yes | yes | UI only — pink/green/blue/red/yellow/purple/orange/cyan. |
| `maxTurns` | no | integer | yes | yes | Caps conversation turns. Low for auditors (10), high for implementers (100+). |
| `memory` | no | `user`/`project`/`local`/omit | yes | yes | Enables `.claude/agent-memory/<name>/`. See [memory docs]. |
| `background` | no | boolean | yes | yes | Run detached from parent context. |
| `effort` | no | `low`/`medium`/`high`/`xhigh`/`max` | yes | yes | Reasoning budget. Default `xhigh` on Opus 4.7. |
| `isolation` | no | `worktree` | yes | yes | Spawns agent in temp git worktree. |
| `initialPrompt` | no | string | yes | no (main session only) | First auto-submitted user turn when agent boots as main. |
| `skills` | no | string array | yes (subagent only) | **silently dropped** | Preloads skills. For teammates, invoke skill in body instead. |
| `mcpServers` | no | object | **silently dropped** | **silently dropped** | Set at settings.json level, not on plugin agents. |
| `hooks` | no | object | **silently dropped** | **silently dropped** | Set at settings.json level. |
| `permissionMode` | no | string | **silently dropped** | **silently dropped** | Set at settings.json level. |

## Execution modes — pick one

| Mode | When | Definition cues |
|------|------|-----------------|
| **One-shot subagent** | Produces a single artifact and exits. Orchestrator gets the result in-context. | Low `maxTurns` (10–30). Read-heavy `tools` allowlist. No `initialPrompt`. |
| **Teammate** | Iterative work alongside other teammates, shared task list. | Higher `maxTurns` (60–200). `memory: project` to persist patterns. Body instructs claim-complete cycle. |
| **Main session** | Persistent top-level role (router, orchestrator). | `initialPrompt` for boot action. Body is the full role definition. |

## Body structure

Effective body follows this order:

1. **Persona** — one sentence: role + specialty
2. **Core responsibility** — 2–4 bullets: what you own, what you never touch
3. **Inputs you expect** — from who, in what format
4. **Output format** — concrete schema or shape the caller parses
5. **Decision tables / rules** — error handling, edge cases (skills-style tables preferred over prose)
6. **Memory instructions** (if `memory:` set) — explicit read-before, update-after
7. **Escalation** — when to stop and ask the user vs. when to decide autonomously

## Trigger-description pattern

Good `description` examples (condition-shaped):

- `"Use when the user asks to review code for OWASP vulnerabilities, hardcoded secrets, or permission misconfig before a PR."`
- `"Invoke when the orchestrator declares api_contract: new or changed in the plan."`
- `"Use for implementing backend tasks after QA has confirmed RED tests in .sdlc/tasks.md."`

Bad `description` examples (label-shaped — Claude can't route):

- `"Security agent."`
- `"Backend developer."`
- `"Helps with tests."`

## Body references

The body is the system prompt. It is appended to the teammate's system prompt or replaces the subagent's. Do NOT assume the agent inherits the parent's project context — inject via `skills:` (subagent) or explicit body instructions (teammate).

## See also

- `agent-anti-patterns.md` — 10 common mistakes with fixes
- `model-selection.md` — haiku/sonnet/opus decision guide
