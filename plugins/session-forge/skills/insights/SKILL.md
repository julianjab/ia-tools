---
name: insights
description: >
  Inspect captured Claude Code session data from the session-forge SQLite store.
  PR1 supports the `sessions` subcommand: list the last N sessions with cwd,
  branch, duration, and event count. Example: `/insights sessions`,
  `/insights sessions 50`.
argument-hint: "sessions [<limit>]"
disable-model-invocation: false
---

# /insights — explore captured session data

This skill is the smoke-test surface for the session-forge capture pipeline.
PR1 ships one subcommand; PR2+ will add `tools`, `corrections`, and others.

## Arguments

| First token   | Meaning |
|---------------|---------|
| `sessions`    | List recent sessions (default limit 20). |
| `sessions N`  | List the last N sessions (N must be a positive integer ≤ 200). |
| _(empty)_     | Print usage and stop. |
| anything else | Print "subcommand <x> not implemented in PR1" and stop. |

## Preconditions

| Condition | Action |
|-----------|--------|
| `sqlite3` not on PATH | Print "sqlite3 not installed — capture is disabled" and stop. |
| `~/.claude/session-forge/db.sqlite` missing | Print "no session data yet — start a Claude Code session with session-forge installed" and stop. |

## Implementation

Resolve the limit (default 20, clamp 1..200 if a numeric token is given),
then run a single SQLite query and pretty-print the result.

```bash
SF_DB="${HOME}/.claude/session-forge/db.sqlite"
LIMIT="${1:-20}"
case "$LIMIT" in
  ''|*[!0-9]*) LIMIT=20 ;;
esac
if [ "$LIMIT" -lt 1 ]; then LIMIT=1; fi
if [ "$LIMIT" -gt 200 ]; then LIMIT=200; fi

command -v sqlite3 >/dev/null 2>&1 || {
  printf 'sqlite3 not installed — session-forge capture is disabled.\n'
  exit 0
}
[ -f "$SF_DB" ] || {
  printf 'No session data yet at %s. Start a Claude Code session with session-forge installed.\n' "$SF_DB"
  exit 0
}

sqlite3 -header -column "$SF_DB" "
  SELECT
    substr(s.id, 1, 8)                              AS sid,
    datetime(s.started_at/1000, 'unixepoch','localtime') AS started,
    COALESCE(s.git_branch, '-')                     AS branch,
    COALESCE(s.cwd, '-')                            AS cwd,
    CASE
      WHEN s.ended_at IS NULL THEN '(live)'
      ELSE printf('%ds', (s.ended_at - s.started_at)/1000)
    END                                             AS duration,
    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS events
  FROM sessions s
  ORDER BY s.started_at DESC
  LIMIT ${LIMIT};
"
```

## Notes

- Output goes to the user; no transformation step.
- This skill is read-only; it never writes to the DB.
- For raw inspection, the user can run `sqlite3 ~/.claude/session-forge/db.sqlite`
  directly. See the plugin README.
