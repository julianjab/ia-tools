-- session-forge schema v2
-- Applied idempotently by hooks/scripts/_lib/init-db.sh on every hook run.
-- v2: add events.cwd (per-event working directory) to enable repo-scoped
--     analytics and git_branch backfill on sessions started outside a repo.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (2);

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
  cwd          TEXT,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts);
CREATE INDEX IF NOT EXISTS idx_events_tool    ON events(tool_name);
-- idx_events_cwd is created by init-db.sh after the v1→v2 migration so v1
-- DBs don't error on "no such column: cwd" before the ALTER TABLE runs.

-- FTS5 for prompt text. Held back from PR1 detectors but cheap to add now.
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
  prompt,
  session_id UNINDEXED,
  event_id   UNINDEXED
);
