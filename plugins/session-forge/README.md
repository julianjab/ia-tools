# session-forge

Captures Claude Code session events to a local SQLite store so future
versions can detect patterns (repeated prompts, repeated tool calls,
user corrections) and auto-generate skills, agents, hooks, or memory
entries.

PR1 (current) is **capture-only**: hooks write events; the `/insights`
skill is a smoke-test reader. Pattern detection and tool generation
land in PR2+.

## What it captures

| Hook | Event type | What is recorded |
|---|---|---|
| `SessionStart` | `session_start` | session_id, cwd, git branch + dirty flag, ts |
| `SessionEnd` | `session_end` | session_id, ts (→ duration derived from started_at) |
| `UserPromptSubmit` | `user_prompt` | session_id, prompt text (FTS indexed), ts |
| `PreToolUse` | `tool_pre` | session_id, tool name, raw payload (truncated), ts |
| `PostToolUse` | `tool_post` | session_id, tool name, success flag (best-effort), ts |

All event payloads are also appended raw to a daily JSONL file as
backup.

## Where data lives

Nothing is written inside any repo. All data is local to your machine:

```
~/.claude/session-forge/
├── db.sqlite                  # SQLite + WAL + FTS5, source of truth
├── events/YYYY-MM-DD.jsonl    # raw event log, append-only
├── forge_registry.json        # index of forged artefacts (empty in PR1)
├── config.json                # plugin settings (max_payload_bytes, ...)
└── errors.log                 # any hook errors (never surfaced to user)
```

## Install

1. The plugin lives at `ia-tools/plugins/session-forge/`. Register it
   in your Claude Code plugin marketplace or symlink it into
   `~/.claude/plugins/`, then enable it via `/plugins`.
2. Open a new Claude Code session. The schema is created on the first
   hook fire.

Dependencies: `sqlite3` and `jq` on PATH. Both ship by default on
macOS. If either is missing, capture is silently disabled and a line
goes to `errors.log` — your session is never interrupted.

## Inspect the data

The `/insights` skill prints a friendly list:

```
/insights sessions
/insights sessions 50
```

For raw access, open the DB directly:

```bash
sqlite3 ~/.claude/session-forge/db.sqlite

# How many events per type?
SELECT event_type, COUNT(*) FROM events GROUP BY event_type;

# Top 10 tools used today
SELECT tool_name, COUNT(*) FROM events
WHERE event_type = 'tool_post' AND ts > strftime('%s','now','start of day') * 1000
GROUP BY tool_name ORDER BY 2 DESC LIMIT 10;

# Last 20 prompts
SELECT datetime(ts/1000, 'unixepoch','localtime') AS at, substr(payload_json, 1, 80)
FROM events WHERE event_type = 'user_prompt' ORDER BY ts DESC LIMIT 20;
```

## Reset

Capture is purely additive. To start fresh:

```bash
rm -rf ~/.claude/session-forge
```

The next Claude Code session recreates everything.

## Roadmap (out of scope for PR1)

- PR2: detectors for repeated prompts, repeated tool calls, repeated
  Bash approvals, and user corrections.
- PR3: `/forge propose` skill that turns detected patterns into
  skills/agents/hooks/permissions via the `scaffold:*` agents.
- PR4: `/insights tools`, `/insights corrections`, `/insights weekly`.
- PR5: feedback loop — track which forged artefacts get used and which
  decay.
