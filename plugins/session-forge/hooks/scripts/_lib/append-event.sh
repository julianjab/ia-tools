#!/usr/bin/env bash
# Write one session-forge event to JSONL + SQLite.
#
# Bucket:      lib (invoked by bookkeeping hooks; bucket = bookkeeping rules)
# Listens to:  n/a — invoked via `bash "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/_lib/append-event.sh"`
# Blocking:    no (always exit 0)
# Input (stdin JSON):
#   { "session_id": "...", "ts": <ms>, "event_type": "...",
#     "tool_name": "..."|null, "success": 0|1|null,
#     "duration_ms": <int>|null, "payload": <object>,
#     "cwd": "..."|null, "git_branch": "..."|null,
#     "git_dirty": 0|1|null, "prompt_text": "..."|null }
# Output:      none on stdout; appends one JSONL line + one row to events
#              (plus upsert into sessions / insert into prompts_fts when relevant).
#
# Best-effort: any failure is logged to ERRORS_LOG; always exit 0.

set -u
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"
bash "${SCRIPT_DIR}/init-db.sh"

if ! sf_have jq; then
  sf_log_err "append-event: jq not found; cannot extract fields"
  exit 0
fi

payload="$(cat)"
[ -n "$payload" ] || exit 0

# 1. Raw JSONL append (atomic single-line append).
day_file="${SF_EVENTS_DIR}/$(date +%F).jsonl"
printf '%s\n' "$payload" >> "$day_file" 2>/dev/null || \
  sf_log_err "append-event: JSONL append failed ($day_file)"

if ! sf_have sqlite3; then
  exit 0
fi

# 2. Extract fields with jq. Empty-string defaults so SQL bind is well-formed.
sid=$(printf '%s' "$payload"        | jq -r '.session_id  // empty')
ts=$(printf '%s' "$payload"         | jq -r '.ts          // empty')
etype=$(printf '%s' "$payload"      | jq -r '.event_type  // empty')
tool=$(printf '%s' "$payload"       | jq -r '.tool_name   // empty')
success=$(printf '%s' "$payload"    | jq -r '.success     // empty')
duration=$(printf '%s' "$payload"   | jq -r '.duration_ms // empty')
cwd=$(printf '%s' "$payload"        | jq -r '.cwd         // empty')
branch=$(printf '%s' "$payload"     | jq -r '.git_branch  // empty')
dirty=$(printf '%s' "$payload"      | jq -r '.git_dirty   // empty')
prompt_text=$(printf '%s' "$payload"| jq -r '.prompt_text // empty')

# Truncated payload as JSON string (capped).
max_bytes=$(jq -r '.max_payload_bytes // 4096' "$SF_CONFIG" 2>/dev/null)
[ -n "$max_bytes" ] || max_bytes=4096
payload_truncated=$(printf '%s' "$payload" | jq -c --argjson n "$max_bytes" '
  .payload // {} | tostring | if (length > $n) then .[0:$n] + "…[truncated]" else . end
' 2>/dev/null)
[ -n "$payload_truncated" ] || payload_truncated='""'

# Guard required fields.
[ -n "$sid" ] || { sf_log_err "append-event: missing session_id ($etype)"; exit 0; }
[ -n "$ts" ] || ts="$(sf_now_ms)"
[ -n "$etype" ] || { sf_log_err "append-event: missing event_type"; exit 0; }

# Escape single quotes for SQL single-quoted literals (sqlite3 stdin mode).
sf_sqlq() { printf '%s' "$1" | sed "s/'/''/g"; }

sid_q=$(sf_sqlq "$sid")
tool_q=$(sf_sqlq "$tool")
cwd_q=$(sf_sqlq "$cwd")
branch_q=$(sf_sqlq "$branch")
payload_q=$(sf_sqlq "$payload_truncated")

# 3. Build SQL. Use a heredoc; bind values inline (no params in sqlite3 CLI).
sql_body=""

case "$etype" in
  session_start)
    sql_body+="
INSERT INTO sessions (id, started_at, cwd, git_branch, git_dirty)
VALUES ('${sid_q}', ${ts}, NULLIF('${cwd_q}',''), NULLIF('${branch_q}',''), ${dirty:-NULL})
ON CONFLICT(id) DO UPDATE SET
  started_at = COALESCE(sessions.started_at, excluded.started_at),
  cwd        = COALESCE(sessions.cwd,        excluded.cwd),
  git_branch = COALESCE(sessions.git_branch, excluded.git_branch),
  git_dirty  = COALESCE(sessions.git_dirty,  excluded.git_dirty);
"
    ;;
  session_end)
    sql_body+="
INSERT INTO sessions (id, started_at, ended_at)
VALUES ('${sid_q}', ${ts}, ${ts})
ON CONFLICT(id) DO UPDATE SET ended_at = ${ts};
"
    ;;
esac

# Always insert the event row.
tool_val="NULL"; [ -n "$tool" ] && tool_val="'${tool_q}'"
success_val="NULL"; [ -n "$success" ] && success_val="$success"
duration_val="NULL"; [ -n "$duration" ] && duration_val="$duration"

sql_body+="
INSERT INTO events (session_id, ts, event_type, tool_name, success, duration_ms, payload_json)
VALUES ('${sid_q}', ${ts}, '${etype}', ${tool_val}, ${success_val}, ${duration_val}, '${payload_q}');
"

# Prompt FTS: only on user_prompt events, only if text is present.
if [ "$etype" = "user_prompt" ] && [ -n "$prompt_text" ]; then
  prompt_q=$(sf_sqlq "$prompt_text")
  sql_body+="
INSERT INTO prompts_fts (rowid, prompt, session_id, event_id)
SELECT last_insert_rowid(), '${prompt_q}', '${sid_q}', last_insert_rowid();
"
fi

printf '%s\n' "$sql_body" | sqlite3 "$SF_DB" >/dev/null 2>>"$SF_ERRORS_LOG" || \
  sf_log_err "append-event: insert failed (event_type=$etype session=$sid)"

exit 0
