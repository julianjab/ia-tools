#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const outdir = process.env.SLACK_BRIDGE_OUTDIR
  ? resolve(process.env.SLACK_BRIDGE_OUTDIR)
  : resolve(pluginRoot, 'dist');
const watch = process.argv.includes('--watch');

await rm(outdir, { recursive: true, force: true });

const options = {
  absWorkingDir: pluginRoot,
  // bin.ts is the executable entry; it imports main() from mcp-server.ts.
  // We pin the output name to `mcp-server.js` so .mcp.json and consumers
  // don't need to change. The class + main() are still importable from
  // source for tests, but the dist artifact is the bin-wrapped bundle.
  entryPoints: [
    { in: 'src/bin.ts', out: 'mcp-server' },
    { in: 'src/daemon/index.ts', out: 'daemon/index' },
  ],
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[bundle] watching…');
} else {
  await esbuild.build(options);
  console.log('[bundle] built dist/mcp-server.js + dist/daemon/index.js');
}
