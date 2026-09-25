-- Session store schema — SQLite (MODE=LOCAL).
-- Two tables: sessions (durable records + live-session lookup) and messages
-- (append-only transcript). Timestamps are epoch seconds (REAL).

PRAGMA foreign_keys = ON;

-- One durable record per conversation. id is the sessionId used everywhere else.
-- mode + last_interaction_at are the small mutable hot state, updated per turn.
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    session_key         TEXT NOT NULL,
    source              TEXT NOT NULL,             -- InboundMessage as JSON
    mode                TEXT,                      -- consult|plan|execute|verify
    started_at          REAL NOT NULL,             -- daily-reset clock
    last_interaction_at REAL NOT NULL,             -- idle-reset clock
    ended_at            REAL,                      -- NULL while live
    end_reason          TEXT
);

-- Single source of truth for "who's live": at most one live session per key.
-- Also the index backing getLiveSession(session_key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_live_per_key
    ON sessions (session_key)
    WHERE ended_at IS NULL;

-- Append-only transcript. id AUTOINCREMENT is insertion order AND conversation
-- order — every ordinary append satisfies both at once. content is the
-- AgentMessage as JSON.
--
-- A compaction summary is the one row where the two disagree: it is written
-- *after* the tail it logically precedes, so it always carries the highest id.
-- It is therefore excluded from the ordered read and spliced back into position
-- by the compaction module, which reads its splice point from compacted_start_id.
-- Nothing in this table encodes the summary's position as a sort key.
--
-- compacted_start_id: summary rows only (NULL everywhere else) — the id the
-- replaced span started at. Splice the summary before the first live row whose
-- id >= this value; the row it names was archived by that same compaction, so it
-- is not in the live set to match on directly. Not paired with an end id on
-- purpose: this is a splice point, and compacted_by_id below is the exact record
-- of what was archived.
--
-- compacted_by_id encodes both liveness and compaction lineage in one column:
--   NULL     = live (in the context window)
--   <id>     = summarized away; points at the summary message that replaced it
-- Self-FK is safe: the transcript is append-only, so the target never disappears.
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    role            TEXT NOT NULL,                 -- user | assistant | toolResult
    content         TEXT NOT NULL,                 -- JSON-serialized AgentMessage
    is_summary      INTEGER NOT NULL DEFAULT 0,    -- 1 for a compaction summary
    compacted_start_id INTEGER,                    -- splice point; summary rows only
    created_at      REAL NOT NULL,
    compacted_by_id INTEGER REFERENCES messages(id)
);

-- Live-context reconstruction (the hot read): partial index over only live rows.
-- getMessages(session_id) WHERE compacted_by_id IS NULL ORDER BY id. Also serves
-- the live-summary lookup, which filters the same partial set on is_summary.
CREATE INDEX IF NOT EXISTS idx_messages_live
    ON messages (session_id, id)
    WHERE compacted_by_id IS NULL;

-- Reverse lookup: every message a given summary replaced.
CREATE INDEX IF NOT EXISTS idx_messages_compacted_by
    ON messages (compacted_by_id);
