# MCP tool design — patterns and anti-patterns

How to design tools, resources, schemas, and error handling for MCP servers.

## Tool naming

- `verb_noun` snake_case: `search_issues`, `create_pull_request`, `read_thread`.
- Verb first; noun is the primary object.
- Avoid ambiguous verbs: `handle_x`, `process_x`, `do_x`.
- Max 3 words; add scope if needed: `github_search_issues` vs `jira_search_issues` when both servers attach.

## Tool description

The description is the model's **only** guidance for when to call the tool. Required sections:

1. **What it does** — one line, action verb.
2. **What it does NOT do** — prevents wrong-tool picks.
3. **When to prefer this vs similar tools** — disambiguation.
4. **Side effects** — mutations, external calls, rate limits.

Example:

```
Search GitHub issues by keyword. Returns title, number, URL, and author.
Does NOT create, modify, or close issues — use create_issue or close_issue.
Prefer this over list_issues when you have a query; list_issues returns all.
Read-only; no rate-limit side effects beyond the 5k/hr GitHub limit.
```

## Input schemas — Zod pattern (TypeScript SDK)

```typescript
inputSchema: z.object({
  query: z.string().min(1).describe("Keyword query; GitHub search syntax supported"),
  repo: z.string().regex(/^[^/]+\/[^/]+$/).describe("Owner/repo, e.g. 'org/name'"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
})
```

Rules:

- **Every field has `.describe()`**. The model reads it to fill arguments.
- **Every field is explicitly optional or required**. Zod `.optional()` for optional.
- **Validate at the boundary**. Zod runs before your handler — reject malformed input there.
- **Bound numerics**. `.min()/.max()` on limits, counts, timeouts.
- **Regex constrain strings**. IDs, repo paths, URL formats.

## Resources vs tools

| Need | Use |
|------|-----|
| Read-only data the LLM may reference (file contents, rows, config) | Resource |
| Anything that mutates state (write, send, publish) | Tool |
| Pure lookup without side effects | Either — tool if it needs arguments, resource if addressable by URI |

If idempotent + read-only → resource. If it changes anything → tool. When in doubt, tool.

## Error handling — two layers

### Layer 1: protocol errors (JSON-RPC)

Standard codes only; these are framework-level, not business-level:

| Code | Meaning |
|------|---------|
| -32700 | parse error |
| -32600 | invalid request |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | internal error |
| -32800 | request cancelled (MCP) |
| -32801 | content too large (MCP) |
| -32802 | resource unavailable (MCP) |

Throwing protocol errors for business failures is wrong — the LLM can't see them.

### Layer 2: tool execution errors

Return `isError: true` content — the LLM sees the error and can recover:

```typescript
return {
  isError: true,
  content: [{ type: "text", text: "Error: repo 'foo/bar' not found. Check owner/repo spelling." }]
};
```

Include:

- What went wrong (observable)
- What the caller likely mis-did (actionable)
- Never: secrets, stack traces with file paths, internal IDs the caller can't use

## Stdio transport rules

| Rule | Rationale |
|------|-----------|
| **Nothing to stdout except JSON-RPC** | Stray stdout breaks message framing; client silently disconnects. |
| Logs via `ctx.log.info(...)` (MCP logging notification) or stderr | `console.log` in stdio mode = bug. |
| Wrap handlers in try/catch | Uncaught throws crash the process. |
| Global `process.on('unhandledRejection', ...)` | Catches async leaks. |
| No global mutable state for sessions | Tools may be called concurrently by multiple clients. |

## Common anti-patterns

| Anti-pattern | Fix |
|--------------|-----|
| Two tools that do similar things | Merge, or give one a clearly-disambiguated description. |
| Tool that does 5 unrelated things | Split. Each tool = one verb. |
| Missing `.describe()` | Add to every field — the model reads them. |
| `throw new Error(...)` in handlers | Return `{ isError: true, content: [...] }`. |
| Secrets in tool responses | Redact before returning. |
| Console.log in stdio server | Use stderr or `ctx.log`. |
| Shared credential for all users | Per-user auth; kills audit trails and revocation. |
| Unbounded numeric inputs | `.min()/.max()`; DoS via abusive `limit: 9999999`. |

## Performance

- Non-blocking: no CPU-heavy sync work in handlers. Offload.
- Long-running: return a task ID immediately, poll via `get_task_status` tool (or use progress notifications if the client supports them).
- Connection pooling: one pool per external service, not per request.
- Stateless: session state in external store (Redis, DB), not in-process.

## Testing

| Layer | How |
|-------|-----|
| Unit — business logic | Standard test runner (vitest, jest), no MCP involvement |
| Unit — schemas | Feed malformed + valid input through Zod, assert |
| Integration — tool call | Spin up server via SDK in-process transport; call tools end-to-end |
| Contract — JSON-RPC | Verify message shape with the MCP Inspector (`npx @modelcontextprotocol/inspector`) |

Never use a real Claude session as your test harness — too slow, too noisy.
