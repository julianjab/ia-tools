#!/usr/bin/env bash
# bin/state-migrate.sh — migrate a state.yaml across schema versions.
#
# Usage: state-migrate.sh <state.yaml>
#
# Currently v1 is the only schema version, so this script verifies the
# file is at v1 (or unset) and exits 0. When a v2 ships, add a
# migrate_1_to_2() function and call it from the dispatch table below.
#
# The general shape for a new migration:
#
#   migrate_N_to_NP1() {
#     local f="$1"
#     # ... yq -i mutations
#     yq -i '.version = (N+1)' "$f"
#   }

set -euo pipefail

STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$STAGE_DIR/.." && pwd)"

# shellcheck source=../lib/session.sh
source "$PLUGIN_ROOT/lib/session.sh"

state_file="${1:?usage: state-migrate.sh <state.yaml>}"
[[ -f "$state_file" ]] || { echo "✗ state-migrate: $state_file missing" >&2; exit 1; }

current="$(yq -r '.version // 1' "$state_file")"
target="$STATE_SCHEMA_VERSION"

if [[ "$current" -gt "$target" ]]; then
  echo "✗ state-migrate: file is at v$current; this plugin only knows up to v$target." >&2
  echo "  Upgrade the plugin before opening this session." >&2
  exit 1
fi

while [[ "$current" -lt "$target" ]]; do
  case "$current" in
    # Add `0|1) migrate_1_to_2 "$state_file" ;;` here when v2 ships.
    *) echo "✗ state-migrate: no migration registered for v$current → v$((current+1))" >&2
       exit 1
       ;;
  esac
  current="$(yq -r '.version' "$state_file")"
done

echo "✓ state-migrate: $state_file is at v$current (target v$target)"
