/**
 * Schema for ~/.sinain/memory/web.db — UI metadata storage.
 *
 * Kept separate from triplestore (knowledge-graph.db) because triples are
 * claims about the world (with confidence, retraction, bi-temporal validity),
 * whereas this DB stores UI state, page caches, and undo tokens — metadata
 * that should not be visible to the curator/distiller.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- Schema version tracking (for future migrations)
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- User bookmarks (favorite / archive / recent)
CREATE TABLE IF NOT EXISTS user_bookmarks (
  entity_id     TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('favorite','archive','recent')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  last_visited  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_status_visited
  ON user_bookmarks(status, last_visited DESC);

-- LLM-rendered page cache. Key: (entity, max tx_id of facts that fed the render)
-- Implicit invalidation: new facts → tx advances → cache miss → regenerate.
-- Old entries kept for bi-temporal "view as of" support.
CREATE TABLE IF NOT EXISTS page_cache (
  entity_id     TEXT NOT NULL,
  tx_watermark  INTEGER NOT NULL,
  page_json     TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  PRIMARY KEY (entity_id, tx_watermark)
);
CREATE INDEX IF NOT EXISTS idx_page_cache_entity
  ON page_cache(entity_id, generated_at DESC);

-- Undo snapshots for fact retraction. 10-minute server-side window.
-- Single-use: consumed_at set when restored; row not deleted (audit trail).
CREATE TABLE IF NOT EXISTS retraction_undo (
  token         TEXT PRIMARY KEY,
  fact_id       TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  retracted_tx  INTEGER NOT NULL,
  reason        TEXT,
  actor         TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_retraction_undo_expires
  ON retraction_undo(expires_at);

-- Audit log of every retraction (kept forever, feeds eval reports).
CREATE TABLE IF NOT EXISTS retraction_log (
  ts            INTEGER NOT NULL,
  fact_id       TEXT NOT NULL,
  reason        TEXT,
  actor         TEXT,
  undone_at     INTEGER,
  source_entity TEXT
);
CREATE INDEX IF NOT EXISTS idx_retraction_log_ts ON retraction_log(ts DESC);

-- Imported concepts — provenance + idempotency check via bundle_sha256.
CREATE TABLE IF NOT EXISTS concept_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at     INTEGER NOT NULL,
  root_entity     TEXT NOT NULL,
  source_tool     TEXT,
  source_version  TEXT,
  envelope_format TEXT NOT NULL,
  bundle_sha256   TEXT NOT NULL,
  conflict_mode   TEXT NOT NULL,
  triples_count   INTEGER,
  redactions_seen TEXT,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_concept_imports_root
  ON concept_imports(root_entity, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_concept_imports_sha
  ON concept_imports(bundle_sha256);

-- Search log for telemetry / "what did the user search for that didn't resolve."
CREATE TABLE IF NOT EXISTS search_log (
  ts            INTEGER NOT NULL,
  query         TEXT NOT NULL,
  resolved_to   TEXT,
  result_count  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_search_log_ts ON search_log(ts DESC);
`;
