#!/usr/bin/env bash
# D2 — repeated bash commands (candidates for permission allowlist).
#
# Bucket:      lib (detector — invoked by /insights tools and /forge list)
# Listens to:  n/a — invoked manually or by skill bash blocks
# Blocking:    no (always exit 0)
# Input:       CLI flags
# Output:      table (default) or JSON array on stdout
#
# Usage:
#   D2_repeated_bash.sh [--days N] [--min N] [--limit N] [--json]
#
# Defaults: --days 30, --min 5, --limit 20, table output.
#
# Matches Bash tool_input.command exactly (no normalization in v1; identical
# repeats are the strongest signal). Skips rows whose inner JSON was
# truncated by append-event.sh (payload >4KB) since those can't be parsed.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../_lib/common.sh"

days=30
min=5
limit=20
format="table"

while [ $# -gt 0 ]; do
  case "$1" in
    --days)  days="$2"; shift 2 ;;
    --min)   min="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --json)  format="json"; shift ;;
    --table) format="table"; shift ;;
    *) sf_log_err "D2: unknown arg $1"; shift ;;
  esac
done

case "$days"  in ''|*[!0-9]*) days=30 ;; esac
case "$min"   in ''|*[!0-9]*) min=5 ;; esac
case "$limit" in ''|*[!0-9]*) limit=20 ;; esac

if ! sf_have sqlite3 || [ ! -f "$SF_DB" ]; then
  [ "$format" = "json" ] && printf '[]\n' || printf 'no data yet\n'
  exit 0
fi

cutoff_ms_expr="(strftime('%s','now') - ${days}*86400) * 1000"

sql="
WITH cmds AS (
  SELECT
    json_extract(json_extract(payload_json, '\$'), '\$.tool_input.command') AS cmd,
    ts
  FROM events
  WHERE tool_name='Bash' AND event_type='tool_pre'
    AND ts >= ${cutoff_ms_expr}
    AND json_valid(json_extract(payload_json, '\$'))
)
SELECT
  cmd,
  COUNT(*)                                          AS n,
  datetime(MIN(ts)/1000,'unixepoch','localtime')    AS first_seen,
  datetime(MAX(ts)/1000,'unixepoch','localtime')    AS last_seen
FROM cmds
WHERE cmd IS NOT NULL AND length(cmd) > 0
GROUP BY cmd
HAVING n >= ${min}
ORDER BY n DESC, last_seen DESC
LIMIT ${limit};
"

if [ "$format" = "json" ]; then
  sqlite3 -json "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
else
  # `box` mode wraps long columns (commands can be long); avoids the
  # noise of -column which truncates silently.
  sqlite3 -box "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
fi

exit 0
