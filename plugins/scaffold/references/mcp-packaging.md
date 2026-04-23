# MCP plugin packaging

How to package an MCP server as a Claude Code plugin inside this repo (and for external consumers).

## Directory layout

```
plugins/<name>/
├── .claude-plugin/
│   └── plugin.json           # plugin manifest — metadata only
├── .mcp.json                 # MCP server config (command + env)
├── package.json              # npm package
├── tsconfig.json             # extends ../../tsconfig.base.json
├── vitest.config.ts          # test runner
├── src/
│   ├── mcp-server.ts         # entry — stdio transport
│   ├── shared/               # types, helpers
│   └── __tests__/            # vitest suite
├── dist/                     # committed, built output
│   └── mcp-server.js
├── scripts/
│   └── bundle.mjs            # esbuild bundler
├── docs/                     # optional — api-contract.md, REQ-*.md
└── README.md
```

## `.claude-plugin/plugin.json`

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "description": "One-line description surfaced in the marketplace.",
  "author": { "name": "Julian Buitrago", "email": "julianbuitrago@lahaus.com" },
  "homepage": "https://github.com/julianjab/ia-tools",
  "repository": "https://github.com/julianjab/ia-tools",
  "license": "MIT"
}
```

**Do not** declare `agents`, `skills`, or `hooks` fields for an MCP-only plugin. The plugin loader uses `.mcp.json` for MCP servers.

## `.mcp.json`

```json
{
  "mcpServers": {
    "<name>": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"],
      "env": {
        "MY_TOKEN": "${MY_TOKEN}",
        "OPTIONAL_URL": "${OPTIONAL_URL:-http://localhost:3800}"
      }
    }
  }
}
```

Rules:

- **`${CLAUDE_PLUGIN_ROOT}`** — resolves to the plugin's install root at runtime. Never hardcode.
- **Secrets from env** — `"${TOKEN}"` reads from the consumer's env. Never embed secrets in args.
- **Default fallbacks** — `"${VAR:-default}"` supports optional config.
- **Prefer `node` over `pnpm exec`** — faster boot, fewer assumptions about the consumer toolchain.

## `package.json`

```json
{
  "name": "@ia-tools/<name>",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "<name>-mcp": "./dist/mcp-server.js"
  },
  "scripts": {
    "build": "node scripts/bundle.mjs",
    "dev": "node scripts/bundle.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.28.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- `"type": "module"` — ESM. Required for `import.meta` and modern MCP SDK usage.
- `"bin"` — lets consumers run the server directly via `npx`.
- `"build"` uses esbuild, not `tsc`, for a single bundled `dist/mcp-server.js`.

## `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["src/__tests__"]
}
```

## Bundling — `scripts/bundle.mjs`

```javascript
import { build } from 'esbuild';

await build({
  entryPoints: ['src/mcp-server.ts'],
  outfile: 'dist/mcp-server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [], // bundle everything
});
```

Committing `dist/`:

- **Always commit `dist/`** — marketplace consumers clone and expect a ready-to-run server.
- **Add a CI check** that `dist/` is in sync with `src/`. Reference: `scripts/check-slack-bridge-dist.sh` in this repo.
- **Gitignore `dist/` is wrong for plugin MCPs** — the opposite of typical npm packages.

## `src/mcp-server.ts` skeleton

```typescript
#!/usr/bin/env node
// SDK is currently unified (@modelcontextprotocol/sdk). A future split into
// @modelcontextprotocol/server, /client, and /node has been announced upstream;
// update import paths when that ships.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "<name>", version: "0.1.0" });

server.registerTool(
  "example_tool",
  {
    description: "One-line description. Does X. Does NOT do Y. Prefer over Z when ...",
    inputSchema: z.object({
      arg: z.string().describe("What this argument means"),
    }),
  },
  async ({ arg }) => {
    return { content: [{ type: "text", text: `received: ${arg}` }] };
  }
);

process.on('unhandledRejection', (err) => {
  process.stderr.write(`[unhandled] ${err}\n`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

Critical:

- **No `console.log` anywhere** — breaks stdio framing.
- **Errors → stderr** only.
- **Transport at end** — register tools first, connect last.

## Registering in marketplace

Add to `.claude-plugin/marketplace.json`:

```json
{
  "name": "<name>",
  "source": "./plugins/<name>",
  "description": "One-line description.",
  "category": "integration",
  "keywords": ["mcp", "<domain>"]
}
```

## Workspace integration

Add to `pnpm-workspace.yaml`:

```yaml
packages:
  - plugins/slack-bridge
  - plugins/<name>       # ← new
```

This enables `pnpm -r build`, `pnpm -r test`, and cross-package linking during development.

## Dist sync check

A CI-friendly check script pattern (mirrors `scripts/check-slack-bridge-dist.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../plugins/<name>"
pnpm build
if ! git diff --quiet dist/; then
  echo "dist/ is out of sync with src/. Run 'pnpm build' and commit."
  exit 1
fi
```

Wire into `.pre-commit-config.yaml` or CI.
