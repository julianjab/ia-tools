#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const outdir = process.env.SLACK_BRIDGE_OUTDIR
  ? resolve(process.env.SLACK_BRIDGE_OUTDIR)
  : resolve(pluginRoot, "dist");
const watch = process.argv.includes("--watch");

await rm(outdir, { recursive: true, force: true });

const options = {
  absWorkingDir: pluginRoot,
  entryPoints: ["src/mcp-server.ts", "src/daemon/index.ts"],
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[bundle] watching…");
} else {
  await esbuild.build(options);
  console.log("[bundle] built dist/mcp-server.js + dist/daemon/index.js");
}
