# Harness Engineering — MCP Audit Rules (HE-M1…HE-M13)

Apply these checks to MCP server plugins (`plugins/<name>/` with
`.mcp.json` + `src/mcp-server.ts` or equivalent). MCP tools are the
*action interface* of the harness — each tool is a typed contract
the agent uses to perceive or change state. These rules complement
[`../mcp-tool-design.md`](../mcp-tool-design.md) and
[`../mcp-packaging.md`](../mcp-packaging.md).

## Contents

- HE-M1 Tool description teaches perception — perception
- HE-M2 Strict input schema — action
- HE-M3 Structured output envelope — observability
- HE-M4 Side-effects are gated — guardrails
- HE-M5 Permission surface documented — action
- HE-M6 Audit trail — observability
- HE-M7 Bounded blast radius — guardrails
- HE-M8 Idempotency declared — verification
- HE-M9 No silent partial success — verification
- HE-M10 Server reads `CLAUDE_PLUGIN_ROOT` — perception
- HE-M11 Risk annotations declared (readOnly/destructive/idempotent/openWorld) — action
- HE-M12 Credential isolation — guardrails
- HE-M13 Tool count discipline — action
- Report shape

## HE-M1 — Tool description teaches perception (pillar: perception)

Each tool's `description` explains WHEN to use the tool, not just
WHAT it does. Lopopolo: the agent only knows what the harness shows
it. A description that reads "Searches Slack" fails; "Use when the
operator asks about a Slack channel; returns messages with thread_ts"
passes.

- **Check**: each tool description contains a "Use when" / "Use for" /
  "Returns" phrase, or a trigger verb at the start.
- **Severity**: MEDIUM per tool missing trigger framing.

## HE-M2 — Strict input schema (pillar: action)

Every tool input is validated by a strict schema (Zod / JSON Schema).
No `z.any()`, no `additionalProperties: true`, no implicit defaults
for fields that change behavior. Mitigates probabilistic reliance.

- **Check**: grep server source for `z.any()` / `z.unknown()` /
  `passthrough()` / `additionalProperties: true`.
- **Severity**: HIGH per violation.

## HE-M3 — Structured output envelope (pillar: observability)

Tool returns a typed, parseable structure with a status field and an
error envelope. No raw strings for status, no mixing success / error
shapes. Silent failures (empty success on error) are an anti-pattern.

- **Check**: return type is an object with explicit `ok` / `status` /
  `error` discriminant OR the server framework guarantees this
  (e.g. CallToolResult with `isError`).
- **Severity**: MEDIUM if return type is `string` or `any`.

## HE-M4 — Side-effects are gated (pillar: guardrails)

Destructive tools (delete, drop, force, send, publish, deploy) accept
an explicit `confirm: true` parameter OR ship a `dryRun` mode.
Auto-applied destructive operations from a probabilistic caller are
the canonical harness failure.

- **Check**: tools whose names match `(delete|drop|remove|force|send|
  publish|deploy|merge|push)` accept `confirm` / `dry_run` /
  `dryRun` / `force` as a required-or-default-safe parameter.
- **Severity**: HIGH per ungated destructive tool.

## HE-M5 — Permission surface documented (pillar: action)

Tool description (or README) names the required scopes, env vars,
cost characteristics, and rate limits. Agents can't reason about
what they don't see.

- **Check**: README enumerates required env vars; each tool that
  needs an external scope (Slack, Linear, GitHub) names it.
- **Severity**: LOW if missing on tool; MEDIUM if missing on server.

## HE-M6 — Audit trail (pillar: observability)

Every tool invocation can be reconstructed: server logs to stderr
(never stdout — stdout is the protocol channel) with tool name,
argument hash, and outcome. Black-box MCPs fail.

- **Check**: server source contains `console.error` / structured
  logger; no `console.log` (which corrupts stdio).
- **Severity**: HIGH if `console.log` present; MEDIUM if no logging
  at all.

## HE-M7 — Bounded blast radius (pillar: guardrails)

Read / list / search tools paginate and cap result size. Write tools
target a single entity per call. A "delete-all-matching" tool fails
this; "delete-by-id" passes.

- **Check**: list/search tools accept `limit` / `cursor` /
  `page_size`. Write tools take a single entity ID, not a filter.
- **Severity**: MEDIUM per unbounded list or bulk-write tool.

## HE-M8 — Idempotency declared (pillar: verification)

Each tool's description states whether retries are safe (idempotent)
or not. The agent can't decide its retry strategy without knowing.

- **Check**: tool description contains "idempotent" / "safe to retry"
  / "not idempotent" / "creates a new" for write tools.
- **Severity**: LOW.

## HE-M9 — No silent partial success (pillar: verification)

Tools that operate on multiple items return per-item status, not a
single boolean. A "labeled 5 of 7 messages, 2 failed" outcome must
be representable in the response.

- **Check**: batch tools return an array of per-item results with
  status, not a single `success: boolean`.
- **Severity**: MEDIUM per batch tool with boolean-only outcome.

## HE-M11 — Risk annotations declared (pillar: action)

MCP defines a risk vocabulary the harness uses for permission
decisions: `readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`. Tools that omit these hints force the harness to
guess. Read tools must declare `readOnlyHint: true`; destructive tools
must declare `destructiveHint: true`; safe-retry tools must declare
`idempotentHint: true`; tools that touch external state must declare
`openWorldHint: true`.

- **Check**: each tool registration in server source has at least one
  of the four hints set. Read tools without `readOnlyHint` → MEDIUM.
  Destructive tools without `destructiveHint` → HIGH.
- **Severity**: HIGH per ungated destructive tool missing the hint.

## HE-M12 — Credential isolation (pillar: guardrails)

Anthropic Managed Agents principle: *"Tokens are never reachable from
the sandbox where Claude's generated code runs."* MCP tools must not:
(a) echo secrets in their return value, (b) log secrets to stderr,
(c) accept raw tokens as a tool parameter (use env / vault references
instead), or (d) include secrets in error messages.

- **Check**: grep server source for return paths that interpolate
  `process.env.*_TOKEN` / `*_SECRET` / `*_KEY` / `apiKey` / `password`
  into output strings. Flag any match. Grep tool parameter schemas for
  `token` / `secret` / `apiKey` as required fields → MEDIUM.
- **Severity**: HIGH per credential leak path; MEDIUM per tool
  parameter that takes a raw secret.

## HE-M13 — Tool count discipline (pillar: action)

AddyOsmani: *"Limit to ~10 focused tools rather than 50 overlapping
ones."* A server with 30+ tools, or with multiple tools whose
descriptions only differ in one argument, fails this rule. Bash + code
execution as general-purpose fallback often beats N narrow tools.

- **Check**: count exported tools. > 25 → MEDIUM, > 40 → HIGH. Detect
  description near-duplicates (same verb + same object noun) → LOW per
  pair.
- **Severity**: see thresholds.

## HE-M10 — Server reads `CLAUDE_PLUGIN_ROOT` (pillar: perception)

Server resolves resources via `CLAUDE_PLUGIN_ROOT` (the documented
plugin-root env) rather than hardcoded paths. Hardcoded `/Users/…` or
`process.cwd()` paths break portability and are a perception failure
(the agent ships with a broken harness on the next machine).

- **Check**: grep server source for `process.env.CLAUDE_PLUGIN_ROOT`
  when filesystem resources are used; flag hardcoded absolute paths.
- **Severity**: HIGH per hardcoded path; MEDIUM if `process.cwd()`
  used for resource resolution.

## Report shape

```
| Severity | Rule   | Finding                                              | Location |
| HIGH     | HE-M4  | Tool `delete_label` accepts no confirm/dry_run flag  | tools/labels.ts:42 |
| MEDIUM   | HE-M1  | Tool `search` description lacks "Use when" framing   | tools/search.ts:8  |
```
