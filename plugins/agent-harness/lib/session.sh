#!/usr/bin/env bash
# lib/session.sh — single source of truth for session id / dir / state.yaml.

# Schema version this plugin understands. Stages reading state.yaml
# call `assert_state_version <state.yaml>` to refuse files written by
# a newer plugin version.
STATE_SCHEMA_VERSION=1

assert_state_version() {
  local state="$1" v
  [[ -f "$state" ]] || return 0  # fresh session — no version to check yet
  v="$(yq -r '.version // 1' "$state" 2>/dev/null)"
  if [[ "$v" =~ ^[0-9]+$ ]] && [[ "$v" -le "$STATE_SCHEMA_VERSION" ]]; then
    return 0
  fi
  echo "✗ state.yaml version=$v but this plugin understands up to $STATE_SCHEMA_VERSION." >&2
  echo "  run: bin/state-migrate.sh $state" >&2
  return 1
}
#
# Source this AFTER lib/config.sh:
#   source "$PLUGIN_ROOT/lib/config.sh"
#   source "$PLUGIN_ROOT/lib/session.sh"
#   sid="$(session_id_for "<request text>")"
#   sdir="$(session_dir_for "$sid")"
#   state="$sdir/state.yaml"
#
# All callers (orchestrator agent, /harness skill, future scripts)
# MUST go through these helpers so a session id derived in one place
# matches the same input derived elsewhere.

# Canonicalize free-form text into a kebab-slug, max 60 chars.
session_slug() {
  local text="$1"
  printf '%s' "$text" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c '[:alnum:]' '-' \
    | sed -E 's/-+/-/g; s/^-//; s/-$//' \
    | cut -c1-60
}

# Stable 8-char hash of the input — disambiguates slugs.
session_hash() {
  local text="$1"
  printf '%s' "$text" | shasum | cut -c1-8
}

# Compose a session id from a free-form request.
session_id_for() {
  local text="$1"
  echo "$(session_slug "$text")_$(session_hash "$text")"
}

# Resolve the on-disk session dir for a given id.
# Honors the env > repo > user > default config chain for session_root.
session_dir_for() {
  local id="$1"
  echo "$(config_get session_root)/$id"
}

# Resolve the state.yaml path for a given id.
state_file_for() {
  echo "$(session_dir_for "$1")/state.yaml"
}

# Print the most recently modified session dir, or empty.
latest_session_dir() {
  local root; root="$(config_get session_root)"
  [[ -d "$root" ]] || return 0
  ls -dt "$root"/*/ 2>/dev/null | head -1 | sed 's:/$::'
}

# Find a session dir by id-prefix match. Prints matches one per line.
find_session_dirs() {
  local prefix="$1" root
  root="$(config_get session_root)"
  [[ -d "$root" ]] || return 0
  for d in "$root"/*/; do
    base="$(basename "$d")"
    if [[ "$base" == "$prefix"* ]]; then
      echo "${d%/}"
    fi
  done
}
