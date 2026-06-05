#!/usr/bin/env bash
# D3 — repeated user prompts (candidates for skills).
#
# Bucket:      lib (detector — invoked by /insights and /forge list)
# Listens to:  n/a — invoked manually or by skill bash blocks
# Blocking:    no (always exit 0)
# Input:       CLI flags
# Output:      table (default) or JSON array on stdout
#
# Usage:
#   D3_repeated_prompts.sh [--days N] [--min N] [--limit N] [--json]
#
# Defaults: --days 30, --min 3, --limit 20, table output.
#
# Normalisation: lowercase + trim leading/trailing whitespace. Prompts with
# identical normalised text are grouped. Skips rows whose inner JSON was
# truncated (payload >4KB) since the prompt may be cut mid-content.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../_lib/common.sh"

days=30
min=3
limit=20
format="table"

while [ $# -gt 0 ]; do
  case "$1" in
    --days)  days="$2"; shift 2 ;;
    --min)   min="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --json)  format="json"; shift ;;
    --table) format="table"; shift ;;
    *) sf_log_err "D3: unknown arg $1"; shift ;;
  esac
done

case "$days"  in ''|*[!0-9]*) days=30 ;; esac
case "$min"   in ''|*[!0-9]*) min=3 ;; esac
case "$limit" in ''|*[!0-9]*) limit=20 ;; esac

if ! sf_have sqlite3 || [ ! -f "$SF_DB" ]; then
  [ "$format" = "json" ] && printf '[]\n' || printf 'no data yet\n'
  exit 0
fi

cutoff_ms_expr="(strftime('%s','now') - ${days}*86400) * 1000"

sql="
WITH prompts AS (
  SELECT
    trim(lower(json_extract(json_extract(payload_json, '\$'), '\$.prompt'))) AS p,
    ts
  FROM events
  WHERE event_type='user_prompt'
    AND ts >= ${cutoff_ms_expr}
    AND json_valid(json_extract(payload_json, '\$'))
)
SELECT
  substr(p, 1, 200)                                 AS prompt,
  COUNT(*)                                          AS n,
  datetime(MIN(ts)/1000,'unixepoch','localtime')    AS first_seen,
  datetime(MAX(ts)/1000,'unixepoch','localtime')    AS last_seen
FROM prompts
WHERE p IS NOT NULL
  -- Filter out noise that pollutes skill candidates:
  --   length<5 catches acknowledgements like 'si', 'ok', 'no'
  --   prefix '/' catches invocations of skills that already exist
  AND length(p) >= 5
  AND p NOT LIKE '/%'
GROUP BY p
HAVING n >= ${min}
ORDER BY n DESC, last_seen DESC
LIMIT ${limit};
"

if [ "$format" = "json" ]; then
  sqlite3 -json "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
else
  sqlite3 -box "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
fi

exit 0
