---
name: new-mcp
description: Use when the user asks to create a new MCP server plugin. Runs the deterministic scaffold.sh with templates to produce plugins/<name>/ — plugin.json, .mcp.json, package.json, tsconfig, src/mcp-server.ts, tests. Then runs /audit-mcp. Optionally delegates custom tool design to the mcp-author subagent.
when_to_use: |
  Trigger phrases: "create an MCP server", "new MCP plugin", "scaffold an MCP",
  "generate a Model Context Protocol server", "add plugins/X with .mcp.json",
  "build a custom MCP", "author MCP tools", "start an MCP from templates",
  "wire a stdio MCP server", "new integration MCP".
argument-hint: <name> [--custom] [--dest <path>]
arguments: [name]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Bash(git rev-parse *), Bash(ls *), Bash(mkdir -p *), Bash(test *), Bash(chmod *), Bash(${CLAUDE_SKILL_DIR}/scripts/scaffold.sh *), Bash(cat *), Bash(find *)
---
<!--
arguments: one positional slot. Flags (--custom, --dest) parsed from $ARGUMENTS.
Bash(bash *) was replaced with a scoped matcher to the scaffold.sh path — no other
shell scripts can be executed through this skill.
-->


# /new-mcp — create a new MCP server plugin

Scaffolds `plugins/<name>/` with the full TypeScript + MCP SDK skeleton, then runs `/audit-mcp`. Two modes:

- **Default (template-based)**: runs `scripts/scaffold.sh` which copies templates and substitutes `{{NAME}}`. Fast, deterministic, produces a working starter.
- **`--custom`**: delegates to the `mcp-author` subagent to design tools/resources from a user brief. Slower, produces tailored code.

## Arguments

| First token | Action |
|-------------|--------|
| `<kebab-name>` | Template mode; ask only for destination if missing |
| `<name> --custom` | Custom mode; gather full brief and invoke mcp-author |
| `<name> --dest <path>` | Skip destination prompt |
| `<name> --help` | Print usage; exit |
| _(empty)_ | STOP — "Usage: /new-mcp <name> [--custom] [--dest <path>]" |

## Preconditions

| Condition | Action |
|-----------|--------|
| Name not kebab-case | STOP |
| `plugins/<name>/` already exists | STOP — "Pick a different name or delete existing" |
| Not inside a git repo | STOP — "MCP plugins live at plugins/<name>/ under a repo root" |
| `scaffold.sh` not executable | Run `chmod +x` and continue |

## Steps

### 1. Resolve paths

```
REPO_ROOT=$(git rev-parse --show-toplevel)
DEST_ROOT="${dest_value:-$REPO_ROOT}"
PLUGIN_DIR="$DEST_ROOT/plugins/$name"
SCAFFOLD="${CLAUDE_SKILL_DIR}/scripts/scaffold.sh"
```

Verify `$PLUGIN_DIR` does not exist.

### 2. Template mode (default)

Run:

```bash
"$SCAFFOLD" "$name" "$DEST_ROOT"
```

The script creates the directory tree, substitutes `{{NAME}}`, and prints next-step instructions. Exit on non-zero.

### 3. Custom mode (`--custom`)

Ask the user:

| Field | Question |
|-------|----------|
| `purpose` | "What should this MCP server let Claude do? One sentence." |
| `tools` | "List tools as `verb_noun` names with a one-liner each. One per line." |
| `auth` | "Auth model?" → `none`, `api_key` (env var), `oauth`, `env` |
| `transport` | "Transport?" → `stdio` (local, default), `http` (remote) |
| `external_deps` | "Any npm packages needed? (e.g. @slack/bolt, octokit — comma-separated, empty ok)" |

Then:

1. Run `scaffold.sh` first to create the base structure (writes all manifests, tsconfig, package.json, bundle script, README, and a generic `src/` stub).
2. Compute `REFS_ABS_PATH="$(cd "${CLAUDE_SKILL_DIR}/../../references" && pwd)"` and pass it to the subagent. Invoke `mcp-author` with the brief + `output_dir: $PLUGIN_DIR` + `refs_dir: $REFS_ABS_PATH`. The subagent OVERWRITES **only** `src/mcp-server.ts`, `src/shared/types.ts`, `src/__tests__/server.test.ts` (and optionally adds `src/tools/*.ts` if >3 tools). It does NOT touch manifests, package.json, tsconfig, vitest.config, bundle.mjs, or README.
3. Do NOT edit `package.json` from this skill. Instead, read the `external_deps` list back from `mcp-author`'s "Next steps" report and include them verbatim in this skill's output so the user adds them with `pnpm add` as a conscious step.

### 4. Audit

Invoke: `/audit-mcp <PLUGIN_DIR>`

### 5. Registration hints (not automatic)

Do NOT modify `.claude-plugin/marketplace.json` or `pnpm-workspace.yaml` automatically. Print the exact lines to add, let the user commit the registration as a conscious step.

## Output

```
/new-mcp complete
  Name:         <name>
  Directory:    <PLUGIN_DIR>
  Mode:         <template | custom>
  Files:        <count>
  Tools:        <list from mcp-author or ['example_tool'] in template mode>

<If custom:>
  Decisions:
    <paste mcp-author 'Decisions:' section>

Audit result:
  Verdict:      <PASS|FAIL>
  HIGH:   <count>   MEDIUM: <count>   LOW: <count>

Next steps (run manually):
  cd <PLUGIN_DIR>
  <if custom and external_deps non-empty:>
    pnpm add <space-separated deps from mcp-author report>
  pnpm install
  pnpm build
  pnpm test

Then register (manual — required):
  1. Add to .claude-plugin/marketplace.json:
       {
         "name": "<name>",
         "source": "./plugins/<name>",
         "description": "<one-line>",
         "category": "integration",
         "keywords": ["mcp", "..."]
       }
  2. Add to pnpm-workspace.yaml under `packages:`:
       - plugins/<name>
  3. Commit dist/ once pnpm build passes.

<If FAIL:>
  ⚠️ Audit flagged HIGH findings. Fix before committing:
    <list>
```

## Error handling

| Condition | Action |
|-----------|--------|
| `scaffold.sh` missing | STOP — "Scaffold plugin install incomplete" |
| `scaffold.sh` exits non-zero | STOP — print script output verbatim |
| `mcp-author` fails (custom mode) | Report error; leave scaffolded base intact (user can salvage) |
| Audit fails to run | Warn; emit output without audit section |
| Audit reports HIGH findings | Emit output; do NOT delete the plugin dir |

## Never

- Auto-register in marketplace.json or pnpm-workspace.yaml — these require explicit user commit.
- Run `pnpm install` or `pnpm build` — leave for the user.
- Overwrite an existing `plugins/<name>/` directory.
- Invoke `mcp-author` without first running `scaffold.sh` (the subagent assumes the base structure exists).
