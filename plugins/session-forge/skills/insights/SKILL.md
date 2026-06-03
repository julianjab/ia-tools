---
name: insights
description: >
  Inspect captured Claude Code session data from the session-forge SQLite store.
  Subcommands: `sessions` (list recent sessions), `tools` (top tools with
  success rate), `corrections` (user prompts that look like corrections),
  `weekly` (markdown report saved under reports/).
argument-hint: "sessions [<N>] | tools [--days N] [--repo PATH] | corrections [--days N] | weekly"
disable-model-invocation: false
---

# /insights — explore captured session data

Reader surface over the session-forge SQLite store. Read-only; never writes
to the DB. Each subcommand wraps an underlying detector in
`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detectors/`.

## Arguments

| First token            | Meaning |
|------------------------|---------|
| `sessions`             | List recent sessions (default 20). |
| `sessions N`           | List the last N sessions (clamped 1..200). |
| `tools [args]`         | Top tools by frequency + success rate. Accepts `--days N`, `--repo PATH`, `--limit N`. |
| `corrections [args]`   | User prompts following a tool call that match a correction marker. Accepts `--days N`. |
| `weekly`               | Write a markdown summary to `~/.claude/session-forge/reports/YYYY-WNN.md` and print the path. |
| _(empty)_              | Print usage and stop. |
| anything else          | Print "unknown subcommand <x>" and stop. |

## Preconditions

| Condition | Action |
|-----------|--------|
| `sqlite3` not on PATH | Print "sqlite3 not installed — capture is disabled" and stop. |
| `~/.claude/session-forge/db.sqlite` missing | Print "no session data yet — start a Claude Code session with session-forge installed" and stop. |

## Implementation

Dispatch on the first token. Each branch delegates to the matching detector
under `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detectors/`.

```bash
SF_DB="${HOME}/.claude/session-forge/db.sqlite"
DET_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/cache/ia-tools/session-forge/$(ls -1 $HOME/.claude/plugins/cache/ia-tools/session-forge/ 2>/dev/null | tail -1)}/hooks/scripts/detectors"

command -v sqlite3 >/dev/null 2>&1 || {
  printf 'sqlite3 not installed — session-forge capture is disabled.\n'
  exit 0
}
[ -f "$SF_DB" ] || {
  printf 'No session data yet at %s. Start a Claude Code session with session-forge installed.\n' "$SF_DB"
  exit 0
}

sub="${1:-}"; shift 2>/dev/null || true

case "$sub" in
  sessions)
    LIMIT="${1:-20}"
    case "$LIMIT" in ''|*[!0-9]*) LIMIT=20 ;; esac
    if [ "$LIMIT" -lt 1 ];   then LIMIT=1;   fi
    if [ "$LIMIT" -gt 200 ]; then LIMIT=200; fi
    sqlite3 -box "$SF_DB" "
      SELECT
        substr(s.id, 1, 8)                                       AS sid,
        datetime(s.started_at/1000, 'unixepoch','localtime')     AS started,
        COALESCE(s.git_branch, '-')                              AS branch,
        COALESCE(s.cwd, '-')                                     AS cwd,
        CASE WHEN s.ended_at IS NULL THEN '(live)'
             ELSE printf('%ds', (s.ended_at - s.started_at)/1000)
        END                                                      AS duration,
        (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS events
      FROM sessions s
      ORDER BY s.started_at DESC
      LIMIT ${LIMIT};
    "
    ;;

  tools)
    bash "${DET_DIR}/D1_top_tools.sh" "$@"
    ;;

  corrections)
    bash "${DET_DIR}/D4_corrections.sh" "$@"
    ;;

  weekly)
    REPORT_DIR="$HOME/.claude/session-forge/reports"
    mkdir -p "$REPORT_DIR"
    WEEK="$(date +%G-W%V)"
    OUT="$REPORT_DIR/${WEEK}.md"
    {
      printf '# session-forge weekly — %s\n\n' "$WEEK"
      printf '## Totals\n\n'
      sqlite3 -box "$SF_DB" "
        SELECT
          COUNT(DISTINCT session_id)                              AS sessions,
          COUNT(*) FILTER (WHERE event_type='user_prompt')        AS prompts,
          COUNT(*) FILTER (WHERE event_type='tool_post')          AS tool_calls
        FROM events
        WHERE ts >= (strftime('%s','now','-7 days') * 1000);
      "
      printf '\n## Top tools (last 7 days)\n\n'
      bash "${DET_DIR}/D1_top_tools.sh" --days 7 --limit 15
      printf '\n## Repeated bash commands (last 7 days, min 3)\n\n'
      bash "${DET_DIR}/D2_repeated_bash.sh" --days 7 --min 3 --limit 15
      printf '\n## Corrections (last 7 days)\n\n'
      bash "${DET_DIR}/D4_corrections.sh" --days 7 --limit 15
    } > "$OUT"
    printf 'Weekly report written to %s\n' "$OUT"
    ;;

  '')
    printf 'Usage: /insights <sessions|tools|corrections|weekly> [args]\n'
    ;;

  *)
    printf 'unknown subcommand: %s\n' "$sub"
    printf 'Usage: /insights <sessions|tools|corrections|weekly> [args]\n'
    ;;
esac
```

## Notes

- Read-only; never writes to the DB.
- `weekly` writes a markdown report and prints the path.
- For raw exploration: `sqlite3 ~/.claude/session-forge/db.sqlite`.
