#!/usr/bin/env bash
# Shared env + helpers for session-forge hooks (sourced, never registered).
#
# Bucket:      lib (sourced by bookkeeping hooks)
# Listens to:  n/a — sourced via `source "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/_lib/common.sh"`
# Blocking:    no (helpers must not exit non-zero; callers control flow)
# Input:       none
# Output:      exports SF_* env vars; defines sf_log_err, sf_now_ms, sf_have.
#
# Defines per-machine data paths (DB, JSONL dir, errors log) and a few
# best-effort helpers. Deliberately does NOT call `set -e/-u` because the
# file is sourced into hook scripts that own their own flag state.

# Resolve plugin root: prefer Claude Code's env var, fall back to script path.
if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  # _lib/common.sh -> _lib -> scripts -> hooks -> plugin root
  CLAUDE_PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fi

SF_DATA_DIR="${SF_DATA_DIR:-${HOME}/.claude/session-forge}"
SF_DB="${SF_DATA_DIR}/db.sqlite"
SF_EVENTS_DIR="${SF_DATA_DIR}/events"
SF_ERRORS_LOG="${SF_DATA_DIR}/errors.log"
SF_REGISTRY="${SF_DATA_DIR}/forge_registry.json"
SF_CONFIG="${SF_DATA_DIR}/config.json"
SF_SCHEMA="${CLAUDE_PLUGIN_ROOT}/sql/schema.sql"

mkdir -p "$SF_DATA_DIR" "$SF_EVENTS_DIR" 2>/dev/null || true

sf_log_err() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "$SF_ERRORS_LOG" 2>/dev/null || true
}

sf_now_ms() {
  # Milliseconds since epoch. macOS `date` lacks %N; use python or perl fallback.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
  elif command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

sf_have() { command -v "$1" >/dev/null 2>&1; }
