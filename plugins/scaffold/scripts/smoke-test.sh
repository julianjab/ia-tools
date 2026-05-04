#!/usr/bin/env bash
# E2E smoke test for /new-mcp's scaffold.sh.
#
# Verifies that the deterministic scaffold flow produces a valid MCP plugin
# structure: all expected files, no leftover {{NAME}} placeholders, valid JSON
# manifests, and correct behavior on invalid inputs.
#
# Does NOT test Claude-invoked flows (/new-agent, /audit-*) — those require a
# live session. This script covers the portion that ships as pure bash +
# templates and can be run in CI.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd "$script_dir/.." && pwd)"
scaffold="$plugin_dir/skills/new-mcp/scripts/scaffold.sh"

if [ ! -x "$scaffold" ]; then
  echo "FAIL: scaffold.sh not found or not executable at $scaffold" >&2
  exit 1
fi

test_root="$(mktemp -d -t scaffold-smoke.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

pass=0
fail=0

report() {
  local result="$1"
  local label="$2"
  if [ "$result" = "pass" ]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$label"
  else
    fail=$((fail + 1))
    printf '  ✗ %s\n' "$label" >&2
  fi
}

echo "Smoke test — scaffold.sh"
echo "Test root: $test_root"
echo ""

# ----------------------------------------------------------------------------
# Case 1: happy path — valid name, clean destination
# ----------------------------------------------------------------------------
echo "Case 1: happy path"
plugin_name="smoke-demo"
dest_root="$test_root/case1"
mkdir -p "$dest_root"

if "$scaffold" "$plugin_name" "$dest_root" "Smoke Test" "smoke@example.com" > "$test_root/case1.log" 2>&1; then
  report pass "scaffold.sh exits 0"
else
  report fail "scaffold.sh exits 0 (exit code $?; see $test_root/case1.log)"
  cat "$test_root/case1.log" >&2
fi

generated="$dest_root/plugins/$plugin_name"

# Expected files
expected=(
  ".claude-plugin/plugin.json"
  ".mcp.json"
  ".gitignore"
  "package.json"
  "tsconfig.json"
  "vitest.config.ts"
  "README.md"
  "src/mcp-server.ts"
  "src/shared/types.ts"
  "src/__tests__/server.test.ts"
  "scripts/bundle.mjs"
)

for f in "${expected[@]}"; do
  if [ -f "$generated/$f" ]; then
    report pass "file exists: $f"
  else
    report fail "file missing: $f"
  fi
done

# Placeholder substitution — no {{NAME}} / {{AUTHOR_*}} should leak
if grep -rn '{{NAME}}\|{{AUTHOR_NAME}}\|{{AUTHOR_EMAIL}}' "$generated" > "$test_root/case1.placeholders" 2>&1; then
  report fail "placeholder substitution (leftovers found)"
  cat "$test_root/case1.placeholders" >&2
else
  report pass "placeholder substitution (no leftovers)"
fi

# JSON validity
for f in ".claude-plugin/plugin.json" ".mcp.json" "package.json" "tsconfig.json"; do
  if python3 -c "import json,sys; json.load(open('$generated/$f'))" 2>/dev/null; then
    report pass "valid JSON: $f"
  else
    report fail "invalid JSON: $f"
  fi
done

# NAME substituted correctly in package.json
if grep -q "\"@ia-tools/$plugin_name\"" "$generated/package.json"; then
  report pass "package.json name = @ia-tools/$plugin_name"
else
  report fail "package.json name mismatch"
fi

# Author substituted from CLI args
if grep -q '"Smoke Test"' "$generated/.claude-plugin/plugin.json" \
   && grep -q '"smoke@example.com"' "$generated/.claude-plugin/plugin.json"; then
  report pass "author substituted from CLI args"
else
  report fail "author substitution (expected 'Smoke Test' / 'smoke@example.com')"
fi

# bundle.mjs targets node22 and ESM
if grep -q 'target: "node22"' "$generated/scripts/bundle.mjs" \
   && grep -q 'format: "esm"' "$generated/scripts/bundle.mjs"; then
  report pass "bundle.mjs targets node22 + esm"
else
  report fail "bundle.mjs config (expected node22 + esm)"
fi

# mcp-server.ts uses zod/v4 and z.object (per current SDK docs)
if grep -q 'from "zod/v4"' "$generated/src/mcp-server.ts" \
   && grep -q 'z\.object(' "$generated/src/mcp-server.ts"; then
  report pass "mcp-server.ts uses zod/v4 + z.object()"
else
  report fail "mcp-server.ts imports or inputSchema shape"
fi

# .mcp.json uses CLAUDE_PLUGIN_ROOT
if grep -q '\${CLAUDE_PLUGIN_ROOT}' "$generated/.mcp.json"; then
  report pass ".mcp.json uses \${CLAUDE_PLUGIN_ROOT}"
else
  report fail ".mcp.json should reference \${CLAUDE_PLUGIN_ROOT}"
fi

echo ""

# ----------------------------------------------------------------------------
# Case 2: refuse existing destination
# ----------------------------------------------------------------------------
echo "Case 2: refuse to overwrite existing dest"
if "$scaffold" "$plugin_name" "$dest_root" > "$test_root/case2.log" 2>&1; then
  report fail "scaffold.sh should have refused existing dest"
else
  if grep -q "already exists" "$test_root/case2.log"; then
    report pass "refused existing dest with clear message"
  else
    report fail "refused existing dest but error message unclear"
  fi
fi

echo ""

# ----------------------------------------------------------------------------
# Case 3: reject invalid name (uppercase)
# ----------------------------------------------------------------------------
echo "Case 3: reject invalid name"
if "$scaffold" "BadName" "$test_root/case3" > "$test_root/case3.log" 2>&1; then
  report fail "scaffold.sh should have rejected 'BadName' (non-kebab-case)"
else
  if grep -q "kebab-case" "$test_root/case3.log"; then
    report pass "rejected 'BadName' with kebab-case message"
  else
    report fail "rejected 'BadName' but message missing 'kebab-case'"
  fi
fi

echo ""

# ----------------------------------------------------------------------------
# Case 4: fallback to git config when author not provided
# ----------------------------------------------------------------------------
echo "Case 4: git config fallback for author"
dest4="$test_root/case4"
mkdir -p "$dest4"
if "$scaffold" "fallback-demo" "$dest4" > "$test_root/case4.log" 2>&1; then
  # git config user.name / user.email should be populated in CI and local dev
  if grep -q '"name":' "$dest4/plugins/fallback-demo/.claude-plugin/plugin.json"; then
    report pass "git config fallback produced author entry"
  else
    report fail "author field missing after git config fallback"
  fi
else
  report fail "scaffold.sh failed with only name+dest (exit $?)"
fi

echo ""

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
total=$((pass + fail))
echo "Summary: $pass/$total passed"
if [ "$fail" -gt 0 ]; then
  echo "FAIL: $fail assertion(s) failed"
  exit 1
fi
echo "PASS"
