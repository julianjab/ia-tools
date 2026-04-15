#!/usr/bin/env bash
# Fails if plugins/slack-bridge/dist is stale vs src/.
# The slack-bridge plugin ships a self-contained bundled dist/ to the
# marketplace so consumers installing the Claude plugin don't need a build
# step (no npm install, no node_modules resolution at runtime). This script
# rebuilds with the same esbuild config into a temp dir and compares the
# output against the committed dist/.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
plugin_dir="$repo_root/plugins/slack-bridge"
committed_dist="$plugin_dir/dist"

if [ ! -d "$committed_dist" ]; then
  echo "error: $committed_dist does not exist — run pnpm --filter @ia-tools/slack-bridge build and commit the output." >&2
  exit 1
fi

tmp_dir="$(mktemp -d -t slack-bridge-dist-check.XXXXXX)"
trap 'rm -rf "$tmp_dir"' EXIT

# Rebuild into tmp using the same bundler entrypoint as `pnpm build`.
SLACK_BRIDGE_OUTDIR="$tmp_dir" node "$plugin_dir/scripts/bundle.mjs" >/dev/null

if ! diff -r "$committed_dist" "$tmp_dir" >/dev/null; then
  echo "error: plugins/slack-bridge/dist is stale relative to src/." >&2
  echo "       Run: pnpm --filter @ia-tools/slack-bridge build && git add plugins/slack-bridge/dist" >&2
  diff -r "$committed_dist" "$tmp_dir" || true
  exit 1
fi

echo "plugins/slack-bridge/dist is in sync with src/."
