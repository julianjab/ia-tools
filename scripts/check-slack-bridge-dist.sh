#!/usr/bin/env bash
# Fails if plugins/slack-bridge/dist is stale vs src/.
# The slack-bridge plugin ships its compiled dist/ to the marketplace so
# consumers don't need a build step. This script rebuilds into a temp dir
# and compares .js/.d.ts output against the committed dist/. Source maps
# (*.map) and declaration maps are ignored because they embed absolute
# paths that differ between environments.
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

# Build into a sibling dist-check/ directory to avoid touching the committed one.
(
  cd "$plugin_dir"
  pnpm exec tsc --outDir "$tmp_dir"
)

# Compare only the stable artefacts.
if ! diff -r \
      --exclude='*.map' \
      "$committed_dist" "$tmp_dir" >/dev/null; then
  echo "error: plugins/slack-bridge/dist is stale relative to src/." >&2
  echo "       Run: pnpm --filter @ia-tools/slack-bridge build && git add plugins/slack-bridge/dist" >&2
  diff -r --exclude='*.map' "$committed_dist" "$tmp_dir" || true
  exit 1
fi

echo "plugins/slack-bridge/dist is in sync with src/."
