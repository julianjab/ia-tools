#!/usr/bin/env bash
# /new-mcp scaffold script — creates a plugins/<name>/ MCP server from templates.
#
# Usage:
#   scaffold.sh <plugin-name> <destination-root> [author-name] [author-email]
#
# Substitutes {{NAME}}, {{AUTHOR_NAME}}, {{AUTHOR_EMAIL}} in template files.
# Idempotent check: refuses to overwrite if destination already exists.

set -euo pipefail

name="${1:?Usage: scaffold.sh <name> <dest-root> [author-name] [author-email]}"
dest_root="${2:?destination root required}"
author_name="${3:-$(git config user.name 2>/dev/null || echo 'Unknown')}"
author_email="${4:-$(git config user.email 2>/dev/null || echo 'unknown@example.com')}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$script_dir/../templates" ]; then
  echo "ERROR: templates directory not found at $script_dir/../templates — scaffold plugin install is incomplete." >&2
  exit 1
fi

templates_dir="$(cd "$script_dir/../templates" && pwd)"
dest="$dest_root/plugins/$name"

if [ -e "$dest" ]; then
  echo "ERROR: $dest already exists. Remove it first or pick a different name." >&2
  exit 1
fi

if [[ ! "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: plugin name must be kebab-case (lowercase letters, digits, hyphens): $name" >&2
  exit 1
fi

echo "Scaffolding MCP plugin '$name' at $dest"

mkdir -p "$dest/.claude-plugin"
mkdir -p "$dest/src/shared"
mkdir -p "$dest/src/__tests__"
mkdir -p "$dest/scripts"

substitute() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|{{NAME}}|$name|g" \
    -e "s|{{AUTHOR_NAME}}|$author_name|g" \
    -e "s|{{AUTHOR_EMAIL}}|$author_email|g" \
    "$src" > "$dst"
}

substitute "$templates_dir/plugin.json.tmpl"           "$dest/.claude-plugin/plugin.json"
substitute "$templates_dir/mcp.json.tmpl"              "$dest/.mcp.json"
substitute "$templates_dir/package.json.tmpl"          "$dest/package.json"
substitute "$templates_dir/tsconfig.json.tmpl"         "$dest/tsconfig.json"
substitute "$templates_dir/vitest.config.ts.tmpl"      "$dest/vitest.config.ts"
substitute "$templates_dir/README.md.tmpl"             "$dest/README.md"
substitute "$templates_dir/gitignore.tmpl"             "$dest/.gitignore"
substitute "$templates_dir/src/mcp-server.ts.tmpl"     "$dest/src/mcp-server.ts"
substitute "$templates_dir/src/shared/types.ts.tmpl"   "$dest/src/shared/types.ts"
substitute "$templates_dir/src/__tests__/server.test.ts.tmpl" "$dest/src/__tests__/server.test.ts"
substitute "$templates_dir/scripts/bundle.mjs.tmpl"    "$dest/scripts/bundle.mjs"

echo "Done. Files written:"
find "$dest" -type f | sort | sed "s|$dest/|  |"

echo ""
echo "Next steps:"
echo "  cd $dest"
echo "  pnpm install"
echo "  pnpm build"
echo "  pnpm test"
echo ""
echo "Then register:"
echo "  1. Add { \"name\": \"$name\", \"source\": \"./plugins/$name\", ... } to .claude-plugin/marketplace.json"
echo "  2. Add 'plugins/$name' to pnpm-workspace.yaml"
echo "  3. Commit dist/ once build passes"
