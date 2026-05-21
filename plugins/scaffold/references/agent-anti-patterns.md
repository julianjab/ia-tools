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

- **Signal**: Orchestrator/lead body has `Write`/`Edit`/`MultiEdit` in `tools` (or inherits them implicitly) AND lacks an explicit path-scope rule that limits where those tools may write.
- **Why**: Leads with unscoped write access tend to do the work themselves, defeating the team. Plugin leads, however, often need write access for legitimate state-keeping (state.md, agent-memory) and inline owner=lead fallback work (qa/sec inside the worktree) — denying write outright would block those flows.
- **Scope exception (PASS)**: a lead passes A8 when the body declares a concrete path scope for writes — typical phrasings: "Write/Edit only inside metadata.worktree_path", "state.md is the only file the lead edits outside a worktree", or an explicit allowlist of paths (`state.md`, `agent-memory/<name>/MEMORY.md`, `<worktree>/...`). The scope rule must be enforced by the agent body, not implicit. Plugin MCP servers that surface write-like tools (e.g. Slack `reply`) do not count toward A8 — only filesystem write tools do.
- **Fix when failing**: either remove `Write`/`Edit`/`MultiEdit` from the lead's tools allowlist, OR add a body section "Write scope" that names the exact path prefixes the lead may touch (and reiterates that everything else is delegated). The audit checks for both signals — tool surface AND scope rule — before flagging.

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

## A13. First- or second-person description

- **Signal**: `description` contains "I ", "I'll ", "I can", "you can", "you should", or "your".
- **Why**: `description` is consumed by the routing system, not the user. First/second-person prose reads as a chatbot greeting, defeats keyword-based intent matching, and is explicitly flagged in Anthropic's authoring guidelines. Claude routes agents on condition-shaped or verb-led descriptions, not conversational ones.
- **Fix**: Use third-person or condition-shape. Good: "Use when the orchestrator declares an api_contract change." Bad: "I can help you review API contracts."

## A14. Implementer has no escalation policy

- **Signal**: Agent body identifies as an implementer (has `Write`/`Edit`/`MultiEdit` in `tools` or body says "implement") but has no section describing when to stop and ask the user vs. when to decide autonomously.
- **Why**: Without an explicit escalation boundary, implementers tend to guess at ambiguous inputs, mutate files outside their declared scope, or silently skip unresolved conflicts — producing bugs that are hard to attribute. `agent-frontmatter.md § Body structure` item 7 ("Escalation — when to stop and ask the user vs. when to decide autonomously") lists this as a required section for all agent bodies.
- **Fix**: Add an "Escalation" or "When to stop" section: list the conditions (ambiguous merge conflict, spec drift, missing env var, security finding) that must pause the agent and ask the user. Document what it can resolve autonomously.

## A15. Prohibition prose about actions outside the agent's scope

- **Signal**: Agent body contains lines like `Do NOT <verb>`, `Never <verb>`, `Don't <verb>`, `Avoid <verb>ing`, `must not <verb>`, `you should not <verb>` where the prohibited action is something the agent no longer does (because its tools were removed, because the work moved to a hook, because another agent owns that path, etc.).
- **Why**: A prohibition forces the model to load the prohibited concept into its working context just to exclude it — every "Do NOT glob `.claude/agents/`" line is one more token of distraction from what the agent actually does. The standard for prompt prose is to **describe the positive action** ("The hook fills in `agents:` synchronously; read it back to dispatch") and **omit prohibitions about non-actions**. Legitimate hard constraints that ARE in-scope (e.g. "do not push to main without a PR" when the agent has `git push` access) are fine — those are real invariants the model must enforce.
- **Fix**: For each negation, ask: does the agent's `tools:` (or any inherited capability) actually let it do the prohibited thing? If no, **delete the line entirely** and rely on the positive description elsewhere in the body. If yes (a real constraint), rephrase the line to state what the agent DOES instead: "Push only via `/pr`" instead of "Do NOT push to main directly". Keep negations only when the alternative would be ambiguous about a real choice the agent could legitimately make.
- **Heuristic for `/audit-agent`**: scan the body for the case-insensitive ERE `(^|[^a-zA-Z])(Do NOT|Never|Don't|Avoid)[[:space:]]+[a-z]`. Flag each match as MEDIUM with the suggestion to rewrite positively or delete. Headings, fenced code blocks, and lines that contain `invariant`, `constraint`, or the literal uppercase word `MUST` are exempt (those are real declared invariants). The regex deliberately omits `cannot` / `must not` / `should not` — those forms are too often descriptive ("the lead cannot detect X", "task cannot complete without Y") and produce noisy false positives in practice.
