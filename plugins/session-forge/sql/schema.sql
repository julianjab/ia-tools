-- session-forge schema v1
-- Applied idempotently by hooks/scripts/_lib/init-db.sh on every hook run.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  cwd         TEXT,
  git_branch  TEXT,
  git_dirty   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  tool_name    TEXT,
  success      INTEGER,
  duration_ms  INTEGER,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts);
CREATE INDEX IF NOT EXISTS idx_events_tool    ON events(tool_name);

-- FTS5 for prompt text. Held back from PR1 detectors but cheap to add now.
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
  prompt,
  session_id UNINDEXED,
  event_id   UNINDEXED
);
