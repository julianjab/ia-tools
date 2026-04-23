---
name: audit-mcp
description: Use when the user asks to review or validate an MCP server plugin (plugins/<name>/) against best practices. Checks directory layout, .mcp.json format, plugin.json, tool descriptions, Zod schemas, stdio hygiene, dist-in-sync, and test coverage. Read-only.
when_to_use: |
  Trigger phrases: "review MCP server", "validate plugins/X", "check .mcp.json",
  "audit an MCP plugin", "does this MCP follow best practices", "lint MCP tools",
  "verify Zod schemas", "check stdio hygiene", "MCP anti-patterns",
  "run MCP-1 to MCP-8 rules", "is dist/ in sync", "mcp-author output review",
  "check tool descriptions", "verify CLAUDE_PLUGIN_ROOT usage", "console.log in server".
argument-hint: <path-to-mcp-plugin-dir> [--strict]
arguments: [path, flag]
allowed-tools: Read, Grep, Glob, Bash(cat *), Bash(head *), Bash(ls *), Bash(find *), Bash(git diff *), Bash(git status *)
---

# /audit-mcp — validate an MCP server plugin against best practices

Takes a path to a plugin directory (one containing `.mcp.json`), loads references, runs structural + code-level checks, emits a report.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>/` to a plugin dir | Audit the full structure |
| `<path>` without trailing slash | Same — treat as dir |
| _(empty)_ | STOP — "Usage: /audit-mcp <plugin-dir>" |
| `<path> --strict` | MEDIUM → HIGH; also fail on LOW `dist-out-of-sync` |

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP |
| `.mcp.json` absent at path root | STOP — "Not an MCP plugin: .mcp.json missing" |
| `package.json` absent | Report as HIGH M0; continue |
| `src/mcp-server.ts` absent | Report as HIGH M0; continue |

## Load references

From `${CLAUDE_SKILL_DIR}/../../references/`:

1. `mcp-tool-design.md`
2. `mcp-packaging.md`

## Checks

### 1. Directory layout

| Expected | Severity if missing |
|----------|---------------------|
| `.claude-plugin/plugin.json` | HIGH |
| `.mcp.json` | HIGH |
| `package.json` | HIGH |
| `tsconfig.json` | MEDIUM |
| `src/mcp-server.ts` | HIGH |
| `src/__tests__/` directory | MEDIUM |
| `dist/mcp-server.js` | MEDIUM (bundle missing — consumers can't run) |
| `README.md` | LOW |
| `scripts/bundle.mjs` | LOW |

### 2. `.mcp.json` content

| Rule | Check |
|------|-------|
| Uses `${CLAUDE_PLUGIN_ROOT}` in args | HIGH if hardcoded absolute path |
| Secrets in env, not args | HIGH if token in `args` |
| `command` is `node` or valid binary | MEDIUM if unusual |
| Server name matches plugin name | MEDIUM if mismatch |

### 3. `package.json` content

| Rule | Check |
|------|-------|
| `"type": "module"` | HIGH if missing |
| `@modelcontextprotocol/sdk` in dependencies | HIGH if missing |
| `zod` in dependencies (when tools declared) | MEDIUM if missing |
| `build`, `typecheck`, `test` scripts present | MEDIUM if any missing |
| `bin` entry for the server | LOW if missing |

### 4. Source code hygiene (scan `src/**/*.ts`)

| Pattern | Rule | Severity |
|---------|------|----------|
| `console.log` | MCP-1 (stdio breaks) | HIGH if stdio transport |
| `console.error` used | MCP-2 | LOW (prefer `process.stderr.write` or `ctx.log`) |
| `throw new Error` inside tool handler | MCP-3 | MEDIUM (prefer `isError: true`) |
| Missing `process.on('unhandledRejection', ...)` in entry file | MCP-4 | MEDIUM |
| Tool description < 40 chars | MCP-5 | MEDIUM (probably missing what-not/when-prefer) |
| Tool description missing "Does NOT" / "Prefer" / side-effect mention | MCP-5b | LOW |
| Zod field without `.describe()` | MCP-6 | MEDIUM |
| Hardcoded secret (matches `/token|secret|key\s*=\s*['"][A-Za-z0-9_-]{20,}/i`) | MCP-7 | HIGH |
| Tool name not `verb_noun` snake_case | MCP-8 | LOW |

### 5. Tests

| Rule | Check |
|------|-------|
| At least one test file per tool | MEDIUM if missing |
| Tests use SDK in-process transport | LOW if tests spin up real Claude |
| `vitest` or equivalent in devDeps | MEDIUM |

### 6. Dist in sync

Run `git diff --quiet dist/` in the plugin dir. If dirty → LOW (strict: HIGH).

### 7. Marketplace registration (best-effort)

Check `.claude-plugin/marketplace.json` at repo root mentions this plugin by name. If not → LOW (user may be local-only).

## Steps

1. Resolve plugin dir.
2. Load references.
3. Check layout (ls -la).
4. Read `.mcp.json`, `plugin.json`, `package.json`.
5. Grep src/ for patterns listed in section 4.
6. Check tests presence.
7. Run `git diff --quiet dist/` (tolerate non-zero exit — treat as "dirty").
8. Check marketplace.json.
9. Emit report.

## Output

```
/audit-mcp report
  Target:       <absolute path>
  Plugin name:  <from plugin.json>
  Server name:  <from .mcp.json>
  Transport:    <stdio | http>
  Tools:        <list of registered tool names>
  Tests:        <count test files>
  Rules run:    layout + .mcp.json + package.json + MCP-1..MCP-8 + tests + dist-sync

| Severity | Rule | Finding | Location |
|----------|------|---------|----------|
| HIGH     | MCP-1 | console.log found | src/mcp-server.ts:42 |
| MEDIUM   | MCP-6 | Zod field 'query' missing .describe() | src/tools/search.ts:12 |
| LOW      | dist-sync | dist/ is dirty vs src/ | dist/ |

Summary:
  HIGH:    <count>
  MEDIUM:  <count>
  LOW:     <count>

Verdict: <PASS | FAIL>

Next actions:
  - <one line per HIGH>
```

## Error handling

| Condition | Action |
|-----------|--------|
| Not inside a git repo (dist-sync check fails) | Skip dist-sync, note in report |
| Reference missing | STOP |
| `.mcp.json` malformed JSON | Report as HIGH; continue |
| `package.json` malformed | Report as HIGH; continue |

## Never

- Run `pnpm install` / `pnpm build` — auditing is read-only.
- Modify any file.
- Execute the MCP server to test it — only static analysis.
