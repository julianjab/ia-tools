#!/usr/bin/env bash
# check-commit-cadence.sh — refuse to push a feature branch that touches
# more than one architectural layer but carries only one commit.
#
# Usage:
#   check-commit-cadence.sh [<base-ref>]
#
# Default <base-ref> = origin/main (falls back to origin/master if main
# does not exist). Pass an explicit upstream ref to override
# (e.g. "origin/develop").
#
# Behavior:
#   - exit 0  → cadence OK (one commit per layer, or a single layer touched)
#   - exit 2  → cadence violation (split required); prints the layers
#               detected and the rebase command to run
#   - exit 1  → could not evaluate (no git, no base ref, etc.)
#
# Override (escape hatch for legitimate single-commit changes that
# happen to span multiple matched paths — e.g. moving one file across
# directories without changing its contents):
#   IA_TW_ALLOW_SINGLE_COMMIT=1  in the environment skips the check
#   with a warning to stderr.
set -euo pipefail

base="${1:-}"
# Resolve a default base ref when the caller did not pass one.
if [ -z "$base" ]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    base="origin/main"
  elif git rev-parse --verify origin/master >/dev/null 2>&1; then
    base="origin/master"
  else
    echo "check-commit-cadence: no base ref (tried origin/main, origin/master); pass one explicitly" >&2
    exit 1
  fi
fi

if ! git rev-parse --verify "$base" >/dev/null 2>&1; then
  echo "check-commit-cadence: base ref '$base' does not exist locally; fetch first" >&2
  exit 1
fi

# Commits + changed files between the base and HEAD.
commit_count=$(git rev-list --count "$base"..HEAD)
if [ "$commit_count" -eq 0 ]; then
  echo "check-commit-cadence: no commits between $base and HEAD; nothing to check" >&2
  exit 0
fi

# Layer regexes — each line is "<layer-name>:<regex>". A file matches at
# most one layer (first match wins, in this order). Adjust to taste; the
# defaults cover backend / frontend / mobile / infra conventions.
layers_spec=$(cat <<'EOF'
migration:^([^/]+/)*(migrations?|schema|sql)/
test:(^|/)(tests?|__tests__|spec|specs)/
model:^([^/]+/)*(models?|entities|schemas)/
adapter:^([^/]+/)*(adapters?|repos?|repositories|gateways?|clients?)/
service:^([^/]+/)*(services?|usecases?|domain|business)/
endpoint:^([^/]+/)*(routers?|handlers?|controllers?|endpoints?|api)/
ui-component:^([^/]+/)*(components?|widgets?|screens?|pages?|views?)/
state-store:^([^/]+/)*(stores?|state|redux|vuex|pinia|providers?)/
infra:^([^/]+/)*(\.github|terraform|k8s|kubernetes|helm|docker|deploy)/
docs:^([^/]+/)*(docs?|README\.md|CHANGELOG\.md|CLAUDE\.md|AGENTS\.md)
config:^([^/]+/)*(\.env\.example|pyproject\.toml|package\.json|pnpm-lock\.yaml|Cargo\.toml|go\.mod|pubspec\.yaml|biome\.json|tsconfig.*\.json)$
EOF
)

changed_files=$(git diff --name-only "$base"..HEAD)
if [ -z "$changed_files" ]; then
  echo "check-commit-cadence: no file changes between $base and HEAD" >&2
  exit 0
fi

# Classify each changed file into at most one layer.
layers_hit=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  matched=""
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    layer="${spec%%:*}"
    pattern="${spec#*:}"
    if printf '%s\n' "$file" | grep -Eq "$pattern"; then
      matched="$layer"
      break
    fi
  done <<< "$layers_spec"
  if [ -n "$matched" ]; then
    layers_hit="$layers_hit $matched"
  fi
done <<< "$changed_files"

# Dedup.
unique_layers=$(printf '%s\n' $layers_hit | sort -u | grep -v '^$' || true)
layer_count=$(printf '%s\n' "$unique_layers" | grep -c . || true)

# One or zero layers → cadence is moot, any commit count is fine.
if [ "$layer_count" -le 1 ]; then
  exit 0
fi

# Multi-layer + multi-commit → OK.
if [ "$commit_count" -gt 1 ]; then
  exit 0
fi

# Multi-layer + single commit → violation, unless overridden.
if [ "${IA_TW_ALLOW_SINGLE_COMMIT:-}" = "1" ]; then
  echo "check-commit-cadence: WARN — IA_TW_ALLOW_SINGLE_COMMIT=1 skipping cadence check" >&2
  echo "check-commit-cadence: layers touched: $(echo $unique_layers | tr '\n' ' ')" >&2
  exit 0
fi

cat >&2 <<EOF
check-commit-cadence: VIOLATION

The branch carries 1 commit but touches $layer_count architectural layers:
$(printf '  - %s\n' $unique_layers)

Atomic commits per layer are required (see plugins/team-workflow/agents/
lead.md → "Commit cadence contract"). Split this branch into one commit
per layer before pushing:

  git rebase -i $base

…then mark commits as "edit" or use \`split\` to break them up. Or, if
this really should be one commit (e.g. a pure rename / move that spans
directories without behavior changes), re-run with:

  IA_TW_ALLOW_SINGLE_COMMIT=1 $0 $base

EOF
exit 2
