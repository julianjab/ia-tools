#!/usr/bin/env bash
# D1 — top tools by frequency + success rate.
#
# Bucket:      lib (detector — invoked by /insights tools and /forge list)
# Listens to:  n/a — invoked manually or by skill bash blocks
# Blocking:    no (always exit 0)
# Input:       CLI flags
# Output:      table (default) or JSON array on stdout
#
# Usage:
#   D1_top_tools.sh [--days N] [--repo PATH] [--limit N] [--json]
#
# Defaults: --days 30, --limit 20, table output.
# --repo filters events.cwd LIKE '<path>%' (prefix match for repo subtrees).

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../_lib/common.sh"

days=30
limit=20
repo=""
format="table"

while [ $# -gt 0 ]; do
  case "$1" in
    --days)  days="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --repo)  repo="$2"; shift 2 ;;
    --json)  format="json"; shift ;;
    --table) format="table"; shift ;;
    *) sf_log_err "D1: unknown arg $1"; shift ;;
  esac
done

case "$days"  in ''|*[!0-9]*) days=30 ;; esac
case "$limit" in ''|*[!0-9]*) limit=20 ;; esac

if ! sf_have sqlite3 || [ ! -f "$SF_DB" ]; then
  [ "$format" = "json" ] && printf '[]\n' || printf 'no data yet\n'
  exit 0
fi

cutoff_ms_expr="(strftime('%s','now') - ${days}*86400) * 1000"
repo_filter=""
if [ -n "$repo" ]; then
  repo_q=$(printf '%s' "$repo" | sed "s/'/''/g")
  repo_filter="AND cwd LIKE '${repo_q}%'"
fi

sql="
WITH posts AS (
  SELECT tool_name, success, ts
  FROM events
  WHERE event_type='tool_post'
    AND tool_name IS NOT NULL
    AND ts >= ${cutoff_ms_expr}
    ${repo_filter}
)
SELECT
  tool_name                                                    AS tool,
  COUNT(*)                                                     AS calls,
  SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)                   AS ok,
  SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)                   AS fail,
  ROUND(100.0 * SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN success IS NOT NULL THEN 1 ELSE 0 END),0), 1) AS pct_ok,
  datetime(MAX(ts)/1000,'unixepoch','localtime')               AS last_used
FROM posts
GROUP BY tool_name
ORDER BY calls DESC
LIMIT ${limit};
"

if [ "$format" = "json" ]; then
  sqlite3 -json "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
else
  sqlite3 -header -column "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
fi

exit 0
