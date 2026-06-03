#!/usr/bin/env bash
# D4 — user corrections following a tool call (candidates for CLAUDE.md / memory).
#
# Bucket:      lib (detector — invoked by /insights corrections and /forge list)
# Listens to:  n/a — invoked manually or by skill bash blocks
# Blocking:    no (always exit 0)
# Input:       CLI flags
# Output:      table (default) or JSON array on stdout
#
# Usage:
#   D4_corrections.sh [--days N] [--limit N] [--json]
#
# Defaults: --days 30, --limit 20, table output.
#
# Heuristic: a user_prompt counts as a "correction" when:
#   1. It immediately follows a tool_post in the same session (no other
#      user_prompt between them), AND
#   2. Its normalised text starts with a known correction marker
#      (ES + EN: no, así no, en realidad, mejor, undo, revert, equivocaste,
#      incorrecto, deshazlo, stop, wait, actually, that's wrong).
#
# Pure SQL via regexp-style LIKE patterns (SQLite has no REGEXP function
# loaded by default). Each marker becomes a LIKE branch; cheap and explicit.

set -u
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../_lib/common.sh"

days=30
limit=20
format="table"

while [ $# -gt 0 ]; do
  case "$1" in
    --days)  days="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --json)  format="json"; shift ;;
    --table) format="table"; shift ;;
    *) sf_log_err "D4: unknown arg $1"; shift ;;
  esac
done

case "$days"  in ''|*[!0-9]*) days=30 ;; esac
case "$limit" in ''|*[!0-9]*) limit=20 ;; esac

if ! sf_have sqlite3 || [ ! -f "$SF_DB" ]; then
  [ "$format" = "json" ] && printf '[]\n' || printf 'no data yet\n'
  exit 0
fi

cutoff_ms_expr="(strftime('%s','now') - ${days}*86400) * 1000"

# Correction markers as a list of LIKE patterns. Lowercased + trimmed prompt
# must START with one of these. Add new markers here as patterns emerge.
sql="
WITH timeline AS (
  SELECT
    id, session_id, ts, event_type, tool_name,
    CASE WHEN event_type='user_prompt'
         THEN trim(lower(json_extract(json_extract(payload_json, '\$'), '\$.prompt')))
         ELSE NULL END                                 AS prompt
  FROM events
  WHERE ts >= ${cutoff_ms_expr}
    AND json_valid(json_extract(payload_json, '\$'))
),
with_prev AS (
  SELECT
    t.id, t.session_id, t.ts, t.event_type, t.prompt,
    (SELECT event_type FROM timeline p
      WHERE p.session_id = t.session_id AND p.ts < t.ts
      ORDER BY p.ts DESC LIMIT 1)                      AS prev_event,
    (SELECT tool_name  FROM timeline p
      WHERE p.session_id = t.session_id AND p.ts < t.ts
      ORDER BY p.ts DESC LIMIT 1)                      AS prev_tool
  FROM timeline t
  WHERE t.event_type='user_prompt'
)
SELECT
  substr(prompt, 1, 160)                              AS prompt,
  prev_tool                                           AS after_tool,
  datetime(ts/1000,'unixepoch','localtime')           AS at,
  substr(session_id, 1, 8)                            AS sid
FROM with_prev
WHERE prev_event = 'tool_post'
  AND (
       prompt LIKE 'no,%'          OR prompt LIKE 'no %'
    OR prompt LIKE 'así no%'       OR prompt LIKE 'asi no%'
    OR prompt LIKE 'en realidad%'
    OR prompt LIKE 'mejor %'
    OR prompt LIKE 'undo%'         OR prompt LIKE 'revert%'
    OR prompt LIKE 'equivocaste%'  OR prompt LIKE 'te equivocaste%'
    OR prompt LIKE 'incorrecto%'
    OR prompt LIKE 'deshazlo%'     OR prompt LIKE 'deshaz%'
    OR prompt LIKE 'stop%'         OR prompt LIKE 'espera%' OR prompt LIKE 'wait%'
    OR prompt LIKE 'actually%'
    OR prompt LIKE 'that''s wrong%' OR prompt LIKE 'that is wrong%'
    OR prompt LIKE 'eso esta mal%' OR prompt LIKE 'está mal%'
    OR prompt LIKE 'corrige%'      OR prompt LIKE 'fix that%'
  )
ORDER BY ts DESC
LIMIT ${limit};
"

if [ "$format" = "json" ]; then
  sqlite3 -json "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
else
  sqlite3 -box "$SF_DB" "$sql" 2>>"$SF_ERRORS_LOG"
fi

exit 0
