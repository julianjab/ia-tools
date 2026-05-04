---
name: edit-mcp
description: Use when the user asks to modify an existing MCP server plugin (plugins/<name>/). Audits the plugin, delegates source-level changes to the mcp-author subagent in edit mode, then re-audits to confirm no regressions. Reads-only against manifests; the calling user owns plugin.json / .mcp.json / package.json edits.
when_to_use: |
  Trigger phrases: "edit this MCP", "update plugins/X/", "add a tool to my MCP server",
  "remove a tool", "tighten Zod schemas", "fix MCP audit findings", "rename an MCP tool",
  "split mcp-server.ts into src/tools/", "add a test to plugins/X", "refactor MCP source".
argument-hint: <path-to-mcp-plugin-dir> [--change "<plain-language request>"] [--auto]
arguments: [path]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(git rev-parse *), Bash(ls *), Bash(test *), Bash(cat *), Bash(find *), Bash(diff *), Bash(git -C * diff *)
---

# /edit-mcp — apply a focused change to an existing MCP plugin

Updates the source under `plugins/<name>/src/` by delegating to `mcp-author` in `mode: edit` and bracketing the work with `/audit-mcp` runs (before + after). The calling user keeps ownership of manifests, configs, and dependency lists — this skill prints the deltas it observes but does not modify them.

## Arguments

| First token | Action |
|-------------|--------|
| `<path>/` to a plugin dir | Edit that plugin's source; ask for the change request |
| `<path> --change "<text>"` | Use `<text>` as the change request; skip the prompt |
| `<path> --change "<text>" --auto` | Run end-to-end without confirmation prompts |
| `<path> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /edit-mcp <plugin-dir> [--change \"...\"] [--auto]" |

## Preconditions

| Condition | Action |
|-----------|--------|
| Path does not exist | STOP |
| `.mcp.json` absent at path root | STOP — "Not an MCP plugin: .mcp.json missing" |
| `src/mcp-server.ts` absent | STOP — "MCP plugin missing entry; use /new-mcp instead" |
| References missing | STOP |

## Steps

### 1. Pre-audit (baseline)

Invoke: `/audit-mcp <path>`

Capture findings (layout + manifests + MCP-1..MCP-8 + tests + dist-sync) as `BEFORE`. Continue regardless of severity.

### 2. Collect the change request

Skip when `--change` is supplied. Otherwise ask:

| Field | Question |
|-------|----------|
| `change_request` | "What change should be applied to the MCP source? Be specific — name tools, files, or behaviors." |
| `external_deps` | "Will the change require new npm packages? (comma-separated, empty ok)" |

### 3. Resolve absolute references path

```bash
REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"
```

### 4. Delegate to mcp-author in edit mode

Invoke `mcp-author` with:

```json
{
  "mode": "edit",
  "name": "<derived from plugin.json>",
  "existing_dir": "<absolute path to plugin>",
  "change_request": "<change_request>",
  "external_deps": [<list or empty>],
  "refs_dir": "<REFS_ABS_PATH>"
}
```

The subagent reads the existing source, applies the change with minimum viable diff, runs its own self-review against MCP-1..MCP-8, repairs HIGH violations it introduced, and returns a report block.

### 5. Post-audit (verification)

Invoke: `/audit-mcp <path>`

Capture findings as `AFTER`.

### 6. Compare and verdict

| Condition | Verdict |
|-----------|---------|
| `INTRODUCED` contains any HIGH | FAIL — surface findings, recommend revert |
| `INTRODUCED` is non-empty but only MEDIUM/LOW | WARN — surface findings, let the user decide |
| `INTRODUCED` is empty | PASS |

`--auto` mode: FAIL exits non-zero; WARN and PASS continue.

### 7. Emit output

## Output

```
/edit-mcp complete
  Directory:      <absolute path>
  Files touched:  <list from mcp-author report>
  Change request: <verbatim>
  New deps:       <list or 'none'>

Author decisions:
  <paste 'Decisions:' from mcp-author report>

Author self-review:
  Verdict:  <PASS | FIX-APPLIED | OPEN>
  Repairs:  <rule → fix, or 'none'>

Audit delta:
  Before:   HIGH=<n> MEDIUM=<n> LOW=<n>
  After:    HIGH=<n> MEDIUM=<n> LOW=<n>
  Resolved:    <rule IDs no longer failing>
  Introduced:  <rule IDs newly failing, or 'none'>

Verdict: <PASS | WARN | FAIL>

Next steps (run manually):
  cd <path>
  <if new deps:>
    pnpm add <space-separated deps>
  pnpm install
  pnpm build
  pnpm test
  # Commit dist/ once build passes

<If FAIL:>
  ⚠️ Edit introduced HIGH regressions. Review the diff:
    git -C <repo> diff <path>/src/

<If PASS:>
  ✓ Edit applied with no regressions.
```

## Error handling

| Condition | Action |
|-----------|--------|
| Pre-audit cannot run (references missing) | STOP |
| `mcp-author` fails | STOP — leave sources untouched; report the subagent error |
| Post-audit cannot run | Emit output without delta; mark verdict INCONCLUSIVE |
| HIGH regression and `--auto` | Exit non-zero; do not auto-revert |
| Empty `change_request` (interactive) | Re-prompt once; STOP on second empty answer |
| `dist/` becomes stale after edit | Note in output; let the user run `pnpm build` and commit |

## Scope

Own: argument parsing, baseline audit, delegation to `mcp-author`, verification audit, delta comparison, and the output block.

Boundaries:
- Edit only the source under `plugins/<name>/src/` via `mcp-author`.
- Print, do not modify, changes to `package.json`, `.mcp.json`, `plugin.json`, `marketplace.json`, `pnpm-workspace.yaml`. The user commits those.
- Skip `pnpm install` and `pnpm build`; print the commands and let the user run them.
- Invoke `mcp-author` exactly once per call.
- Report regressions; do not auto-revert.
