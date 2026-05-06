/**
 * Typed accessor for ~/.sinain/memory/web.db.
 *
 * One module owns all SQL — keeps query strings out of HTTP handlers and
 * lets us swap out better-sqlite3 later if needed.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { log } from "../log.js";

const TAG = "web-db";

export type BookmarkStatus = "favorite" | "archive" | "recent";

export interface Bookmark {
  entity_id: string;
  status: BookmarkStatus;
  note: string | null;
  created_at: number;
  last_visited: number;
}

export interface PageCacheRow {
  entity_id: string;
  tx_watermark: number;
  page_json: string;
  generated_at: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
}

export interface RetractionUndoRow {
  token: string;
  fact_id: string;
  snapshot_json: string;
  retracted_tx: number;
  reason: string | null;
  actor: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface ConceptImportRow {
  id?: number;
  imported_at: number;
  root_entity: string;
  source_tool: string | null;
  source_version: string | null;
  envelope_format: string;
  bundle_sha256: string;
  conflict_mode: string;
  triples_count: number | null;
  redactions_seen: string | null;
  notes: string | null;
}

const PAGE_CACHE_LRU_CAP = 500;

export class WebDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.db
      .prepare(
        "INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(SCHEMA_VERSION));
    log(TAG, `web.db ready at ${dbPath} (schema v${SCHEMA_VERSION})`);
  }

  close(): void {
    this.db.close();
  }

  // ── Bookmarks ───────────────────────────────────────────

  listBookmarks(status?: BookmarkStatus, limit = 100): Bookmark[] {
    const sql = status
      ? "SELECT * FROM user_bookmarks WHERE status = ? ORDER BY last_visited DESC LIMIT ?"
      : "SELECT * FROM user_bookmarks ORDER BY last_visited DESC LIMIT ?";
    const args = status ? [status, limit] : [limit];
    return this.db.prepare(sql).all(...args) as Bookmark[];
  }

  upsertBookmark(entity_id: string, status: BookmarkStatus, note?: string): Bookmark {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO user_bookmarks(entity_id, status, note, created_at, last_visited)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           status = excluded.status,
           note = COALESCE(excluded.note, user_bookmarks.note),
           last_visited = excluded.last_visited`,
      )
      .run(entity_id, status, note ?? null, now, now);
    return this.db
      .prepare("SELECT * FROM user_bookmarks WHERE entity_id = ?")
      .get(entity_id) as Bookmark;
  }

  deleteBookmark(entity_id: string): boolean {
    const r = this.db.prepare("DELETE FROM user_bookmarks WHERE entity_id = ?").run(entity_id);
    return r.changes > 0;
  }

  /** Bump last_visited for a bookmark; if absent, insert as 'recent'. */
  touchVisit(entity_id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO user_bookmarks(entity_id, status, note, created_at, last_visited)
         VALUES(?, 'recent', NULL, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET last_visited = excluded.last_visited`,
      )
      .run(entity_id, now, now);
  }

  // ── Page cache ──────────────────────────────────────────

  getPageCache(entity_id: string, tx_watermark: number): PageCacheRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM page_cache WHERE entity_id = ? AND tx_watermark = ?",
      )
      .get(entity_id, tx_watermark) as PageCacheRow | undefined;
    return row ?? null;
  }

  putPageCache(row: Omit<PageCacheRow, "generated_at"> & { generated_at?: number }): void {
    const generated_at = row.generated_at ?? Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO page_cache
         (entity_id, tx_watermark, page_json, generated_at, tokens_in, tokens_out, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.entity_id,
        row.tx_watermark,
        row.page_json,
        generated_at,
        row.tokens_in ?? null,
        row.tokens_out ?? null,
        row.cost_usd ?? null,
      );
    this.pruneCache();
  }

  /** LRU prune: keep newest PAGE_CACHE_LRU_CAP entries by generated_at. */
  private pruneCache(): void {
    const count = (this.db.prepare("SELECT COUNT(*) as n FROM page_cache").get() as { n: number }).n;
    if (count <= PAGE_CACHE_LRU_CAP) return;
    const overflow = count - PAGE_CACHE_LRU_CAP;
    this.db
      .prepare(
        `DELETE FROM page_cache WHERE rowid IN (
           SELECT rowid FROM page_cache ORDER BY generated_at ASC LIMIT ?
         )`,
      )
      .run(overflow);
  }

  // ── Retraction undo ─────────────────────────────────────

  putRetractionUndo(row: Omit<RetractionUndoRow, "consumed_at">): void {
    this.db
      .prepare(
        `INSERT INTO retraction_undo
         (token, fact_id, snapshot_json, retracted_tx, reason, actor, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.token,
        row.fact_id,
        row.snapshot_json,
        row.retracted_tx,
        row.reason,
        row.actor,
        row.created_at,
        row.expires_at,
      );
  }

  getRetractionUndo(token: string): RetractionUndoRow | null {
    const row = this.db
      .prepare("SELECT * FROM retraction_undo WHERE token = ?")
      .get(token) as RetractionUndoRow | undefined;
    return row ?? null;
  }

  consumeRetractionUndo(token: string): void {
    this.db
      .prepare("UPDATE retraction_undo SET consumed_at = ? WHERE token = ?")
      .run(Date.now(), token);
  }

  pruneExpiredUndos(): number {
    const r = this.db
      .prepare("DELETE FROM retraction_undo WHERE expires_at < ? AND consumed_at IS NULL")
      .run(Date.now());
    return r.changes;
  }

  logRetraction(fact_id: string, reason: string | null, actor: string | null, source_entity: string | null): void {
    this.db
      .prepare(
        `INSERT INTO retraction_log(ts, fact_id, reason, actor, source_entity)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), fact_id, reason, actor, source_entity);
  }

  markRetractionUndone(fact_id: string): void {
    this.db
      .prepare(
        `UPDATE retraction_log SET undone_at = ?
         WHERE rowid = (
           SELECT rowid FROM retraction_log
           WHERE fact_id = ? AND undone_at IS NULL
           ORDER BY ts DESC LIMIT 1
         )`,
      )
      .run(Date.now(), fact_id);
  }

  // ── Concept imports ─────────────────────────────────────

  recordConceptImport(row: ConceptImportRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO concept_imports
         (imported_at, root_entity, source_tool, source_version, envelope_format,
          bundle_sha256, conflict_mode, triples_count, redactions_seen, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.imported_at,
        row.root_entity,
        row.source_tool,
        row.source_version,
        row.envelope_format,
        row.bundle_sha256,
        row.conflict_mode,
        row.triples_count,
        row.redactions_seen,
        row.notes,
      );
    return Number(r.lastInsertRowid);
  }

  findImportBySha(bundle_sha256: string): ConceptImportRow | null {
    const row = this.db
      .prepare("SELECT * FROM concept_imports WHERE bundle_sha256 = ? ORDER BY imported_at DESC LIMIT 1")
      .get(bundle_sha256) as ConceptImportRow | undefined;
    return row ?? null;
  }

  // ── Search log ──────────────────────────────────────────

  logSearch(query: string, resolved_to: string | null, result_count: number): void {
    this.db
      .prepare(
        "INSERT INTO search_log(ts, query, resolved_to, result_count) VALUES (?, ?, ?, ?)",
      )
      .run(Date.now(), query, resolved_to, result_count);
  }
}
