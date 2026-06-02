#!/usr/bin/env bash
# Idempotent SQLite schema bootstrap for session-forge.
#
# Bucket:      lib (invoked by bookkeeping hooks; bucket = bookkeeping rules)
# Listens to:  n/a — invoked via `bash "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/_lib/init-db.sh"`
# Blocking:    no (always exit 0)
# Input:       none
# Output:      ensures ~/.claude/session-forge/ exists with db.sqlite, registry, config.
#
# Applies sql/schema.sql every call. All CREATE statements are IF NOT EXISTS,
# so this is safe to run on every hook fire. Any failure is logged to
# ERRORS_LOG; the user's session is never interrupted.

set -u
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

if ! sf_have sqlite3; then
  sf_log_err "init-db: sqlite3 not found in PATH; capture disabled"
  exit 0
fi

if [ ! -f "$SF_SCHEMA" ]; then
  sf_log_err "init-db: schema not found at $SF_SCHEMA"
  exit 0
fi

# Apply schema. `CREATE … IF NOT EXISTS` makes this safe to run every hook.
# Discard stdout (PRAGMA echoes its result string); only capture stderr.
sqlite3 "$SF_DB" < "$SF_SCHEMA" >/dev/null 2>>"$SF_ERRORS_LOG" || \
  sf_log_err "init-db: sqlite3 apply failed (db=$SF_DB)"

# Seed empty registry + config if missing.
[ -f "$SF_REGISTRY" ] || printf '{}\n' > "$SF_REGISTRY" 2>/dev/null
[ -f "$SF_CONFIG" ]   || printf '{"max_payload_bytes":4096}\n' > "$SF_CONFIG" 2>/dev/null

exit 0
