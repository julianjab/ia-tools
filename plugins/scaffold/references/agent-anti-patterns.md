# Agent anti-patterns

Common mistakes detected by `/audit-agent`. Each entry: signal, why it breaks, fix.

## A1. Label-shaped description

- **Signal**: `description` is a pure noun phrase with no trigger verb ("Security agent.", "Backend helper."). A description that starts with an action verb ("Receives RED tests…", "Reviews code for…", "Stages changes and commits…") is acceptable.
- **Why**: `description` is the **trigger**. Claude matches user intent via this text. A label can't match a task, but a verb-led description can.
- **Fix**: Start with "Use when…" / "Invoke when…" OR lead with the action verb ("Implements…", "Reviews…", "Generates…"). Include keywords the user would actually type.

## A2. Dropped fields on plugin agents

- **Signal**: `hooks`, `mcpServers`, or `permissionMode` present in frontmatter of a file under `plugins/*/agents/` or `agents/` of a plugin.
- **Why**: Plugin loader silently drops these three. The agent ships with unenforced rules.
- **Fix**: Remove the fields. Move enforcement to (a) `settings.json` at consumer level, (b) `tools:` allowlist, or (c) body instructions.

## A3. Dropped fields on teammates

- **Signal**: `skills:` or `mcpServers:` set on an agent that is spawned as a teammate (TEAM roster).
- **Why**: Teammates ignore both. Skill preload never happens.
- **Fix**: Instruct the agent body to invoke the skill on boot (e.g., `Run /security-audit on boot.`). Move MCPs to settings.

## A4. Wrong model for the job

- **Signal**: `opus` on read-only explorer, `haiku` on security gate, no `model` on a simple lookup agent.
- **Why**: Opus on cheap tasks wastes budget; Haiku on gates loses judgment.
- **Fix**: See `model-selection.md`. Explorers → `haiku`. Implementers → `sonnet`. Gates/architecture/security → `opus`.

## A5. Unscoped Bash on leads / orchestrators

- **Signal**: Lead or orchestrator agent (no `Write`/`Edit`/`MultiEdit`, or body self-identifies as lead) has `Bash` in tools without a body instruction scoping it.
- **Why**: Leads should delegate, not shell out. Unscoped Bash on a lead invites the lead to do the work itself, defeating the team.
- **Scope**: Implementers (backend/frontend/mobile) with `Bash + Write + Edit` are NOT flagged — they legitimately run test/build commands.
- **Fix**: On leads, either remove `Bash`, restrict it in body ("use Bash only for `git status`, never for writes"), or promote the lead to have an allowlist of commands.

## A6. Circular teammate dependencies

- **Signal**: Agent body or plan implies `backend.blockedBy = qa` AND `qa.blockedBy = backend`.
- **Why**: Shared task list uses file locking; circular deps deadlock silently.
- **Fix**: Break cycles in the task graph. Typical shape: `qa:red → stack:impl → security:audit → pr:open`.

## A7. Team bloat

- **Signal**: Agent roster enumerates >5 teammates in the team spec.
- **Why**: Coordination overhead and token cost grow linearly. 3–5 is the sweet spot.
- **Fix**: Collapse overlapping roles. A single `stack-lead` beats separate `frontend-lead` + `backend-lead` + `api-lead`.

## A8. Lead implementing instead of delegating

- **Signal**: Orchestrator/lead body lacks an explicit "wait for teammates" instruction; has `Write`/`Edit` in `tools`.
- **Why**: Leads with write access tend to do the work themselves, defeating the team.
- **Fix**: Remove `Write`/`Edit`/`MultiEdit` from lead tools. Body: "You never edit files. Your job is to delegate, verify, and decide."

## A9. Same-file edits by multiple teammates

- **Signal**: Two teammate bodies claim overlapping file paths ("I own `src/api/`" and "I own `src/api/auth/`").
- **Why**: Concurrent edits overwrite each other.
- **Fix**: Partition by top-level module or feature, not by subtree overlap. Or declare one owner and the other as read-only contributor.

## A10. Missing output format

- **Signal**: Body has no "Output format" or "Return" section.
- **Why**: Caller has no contract to parse. Leads to free-form prose the orchestrator can't structure.
- **Fix**: Add a concrete schema — JSON object, markdown table, or fixed-field report block.

## A11. Subagent assuming parent context

- **Signal**: One-shot subagent body references project conventions without loading them ("follow the project conventions", "use our test framework").
- **Why**: Subagents receive ONLY their own system prompt. They don't see the parent's CLAUDE.md or skills.
- **Fix**: Add `skills: [stack-detection]` (works for subagents) or inject conventions in the body explicitly.

## A12. Vague maxTurns

- **Signal**: No `maxTurns` on an implementer (defaults high), or `maxTurns: 10` on a teammate that iterates.
- **Why**: Runaway budget on implementers; premature halt on iterators.
- **Fix**: Auditors/gates: 10–30. Implementers: 60–100. Orchestrators: 100–200.
