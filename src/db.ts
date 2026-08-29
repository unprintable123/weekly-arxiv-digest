import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ClassificationResult, Paper } from './types.js';
import { isoWeekOf } from './window.js';

/** Convert a `papers` table row into the domain `Paper` object. */
export function rowToPaper(row: any): Paper {
  return {
    arxivId: row.arxiv_id,
    version: row.version || undefined,
    title: row.title,
    authors: JSON.parse(row.authors_json || '[]'),
    categories: JSON.parse(row.categories_json || '[]'),
    abstractEn: row.abstract_en,
    publishedAt: row.published_at,
    updatedAt: row.updated_at || undefined,
    detailUrl: row.detail_url,
    contentHash: row.content_hash,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  arxiv_id TEXT PRIMARY KEY,
  version TEXT,
  title TEXT NOT NULL,
  authors_json TEXT,
  categories_json TEXT,
  abstract_en TEXT,
  published_at TEXT,
  updated_at TEXT,
  detail_url TEXT,
  content_hash TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS fetch_cache (
  url TEXT PRIMARY KEY,
  papers_json TEXT,
  etag TEXT,
  last_modified TEXT,
  expires_at TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS classification_cache (
  cache_key TEXT PRIMARY KEY,
  arxiv_id TEXT,
  content_hash TEXT,
  model TEXT,
  categories_json TEXT,
  tags_json TEXT,
  tldr_json TEXT,
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Composite lookup index: an arxiv_id + status prefix with a created_at DESC
-- tail so latestClassification returns the newest row without a sort; the
-- content_hash filter then scans only the few versions of the same paper.
CREATE INDEX IF NOT EXISTS idx_classification_cache_lookup
ON classification_cache (arxiv_id, status, created_at DESC, content_hash);
`;

export class Store {
  db: DatabaseSync;

  // Prepared statements are compiled once at construction and reused for the
  // store's lifetime; re-parsing SQL on every call was the per-paper overhead.
  private stmtGetPaper: StatementSync;
  private stmtSavePaper: StatementSync;
  private stmtPapersBetween: StatementSync;
  private stmtAllPapers: StatementSync;
  private stmtGetFetch: StatementSync;
  private stmtSaveFetch: StatementSync;
  private stmtGetClassification: StatementSync;
  private stmtLatestClassification: StatementSync;
  private stmtLatestClassificationByContent: StatementSync;
  private stmtSaveClassification: StatementSync;
  private stmtDeleteAllClassifications: StatementSync;
  private stmtDeleteStaleClassifications: StatementSync;
  private stmtGetMeta: StatementSync;
  private stmtSetMeta: StatementSync;
  private stmtStats: StatementSync;
  private stmtPruneFetches: StatementSync;
  private stmtPruneClassifications: StatementSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    // The database file is the persistent store: every committed statement is
    // already durable (WAL), so `flush()` below only checkpoints the WAL.
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.stmtGetPaper = this.db.prepare('SELECT * FROM papers WHERE arxiv_id=?');
    this.stmtSavePaper = this.db.prepare(
      `INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(arxiv_id) DO UPDATE SET
         version=excluded.version,
         title=excluded.title,
         authors_json=excluded.authors_json,
         categories_json=excluded.categories_json,
         abstract_en=excluded.abstract_en,
         published_at=excluded.published_at,
         updated_at=excluded.updated_at,
         detail_url=excluded.detail_url,
         content_hash=excluded.content_hash,
         fetched_at=excluded.fetched_at`,
    );
    this.stmtPapersBetween = this.db.prepare(
      'SELECT * FROM papers WHERE published_at >= ? AND published_at < ? ORDER BY arxiv_id',
    );
    this.stmtAllPapers = this.db.prepare('SELECT published_at FROM papers');
    this.stmtGetFetch = this.db.prepare('SELECT * FROM fetch_cache WHERE url=?');
    this.stmtSaveFetch = this.db.prepare('INSERT OR REPLACE INTO fetch_cache VALUES (?,?,?,?,?,?)');
    this.stmtGetClassification = this.db.prepare(
      "SELECT * FROM classification_cache WHERE cache_key=? AND status='ok'",
    );
    this.stmtLatestClassification = this.db.prepare(
      "SELECT * FROM classification_cache WHERE arxiv_id=? AND status='ok' ORDER BY created_at DESC LIMIT 1",
    );
    this.stmtLatestClassificationByContent = this.db.prepare(
      "SELECT * FROM classification_cache WHERE arxiv_id=? AND content_hash=? AND status='ok' ORDER BY created_at DESC LIMIT 1",
    );
    this.stmtSaveClassification = this.db.prepare(
      'INSERT OR REPLACE INTO classification_cache VALUES (?,?,?,?,?,?,?,?,?)',
    );
    this.stmtDeleteAllClassifications = this.db.prepare('DELETE FROM classification_cache');
    this.stmtDeleteStaleClassifications = this.db.prepare(
      'DELETE FROM classification_cache WHERE created_at < ?',
    );
    this.stmtGetMeta = this.db.prepare('SELECT value FROM meta WHERE key=?');
    this.stmtSetMeta = this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
    this.stmtStats = this.db.prepare(
      'SELECT (SELECT count(*) FROM papers) papers, ' +
      '(SELECT count(*) FROM fetch_cache) fetches, ' +
      '(SELECT count(*) FROM classification_cache) classifications',
    );
    this.stmtPruneFetches = this.db.prepare('DELETE FROM fetch_cache WHERE fetched_at < ?');
    this.stmtPruneClassifications = this.db.prepare(
      'DELETE FROM classification_cache WHERE created_at < ?',
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Merge the write-ahead log back into the main database file. Writes are
   * already durable when committed; this bounds WAL growth between stages.
   */
  flush(): void {
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN');
    try {
      return callback();
    } finally {
      this.db.exec('COMMIT');
    }
  }

  getPaper(id: string): Paper | undefined {
    const row = this.stmtGetPaper.get(id) as any;
    return row && this.rowPaper(row);
  }

  savePaper(p: Paper): void {
    this.stmtSavePaper.run(
      p.arxivId,
      p.version ?? '',
      p.title,
      JSON.stringify(p.authors),
      JSON.stringify(p.categories),
      p.abstractEn,
      p.publishedAt,
      p.updatedAt ?? '',
      p.detailUrl,
      p.contentHash,
      new Date().toISOString(),
    );
  }

  /** All stored papers published inside the half-open [from, to) window. */
  papersBetween(from: string, to: string): Paper[] {
    return (this.stmtPapersBetween.all(from, to) as any[]).map((row) => this.rowPaper(row));
  }

  /** Sorted ISO week ids (`YYYY-Www`) that have at least one cached paper. */
  distinctWeeks(): string[] {
    const rows = this.stmtAllPapers.all() as Array<{ published_at: string }>;
    const weeks = new Set<string>();
    for (const row of rows) {
      const week = isoWeekOf(row.published_at);
      if (week) weeks.add(week);
    }
    return [...weeks].sort();
  }

  private rowPaper(row: any): Paper {
    return rowToPaper(row);
  }

  /** Cached extraction result for one URL, plus conditional-request metadata. */
  getFetch(url: string): {
    papers: unknown;
    etag: string;
    lastModified: string;
    expiresAt: string;
  } | undefined {
    const row = this.stmtGetFetch.get(url) as any;
    if (!row || typeof row.papers_json !== 'string' || !row.papers_json) return undefined;
    try {
      return {
        papers: JSON.parse(row.papers_json),
        etag: String(row.etag || ''),
        lastModified: String(row.last_modified || ''),
        expiresAt: String(row.expires_at || ''),
      };
    } catch {
      return undefined;
    }
  }

  /** Store the extracted paper list for a URL (never the raw response body). */
  saveFetch(url: string, papers: unknown, meta: {
    etag?: string;
    lastModified?: string;
    expiresAt?: string;
  }): void {
    this.stmtSaveFetch.run(
      url,
      JSON.stringify(papers),
      meta.etag || '',
      meta.lastModified || '',
      meta.expiresAt || '',
      new Date().toISOString(),
    );
  }

  getClassification(key: string): ClassificationResult | undefined {
    const row = this.stmtGetClassification.get(key) as any;
    return this.rowClassification(row);
  }

  /**
   * Latest "ok" classification for a paper. When `contentHash` is given, only
   * rows whose stored content hash still matches are considered, so a paper
   * whose abstract changed is never silently re-labeled with a stale result.
   */
  latestClassification(id: string, contentHash?: string): ClassificationResult | undefined {
    const row = contentHash === undefined
      ? this.stmtLatestClassification.get(id)
      : this.stmtLatestClassificationByContent.get(id, contentHash);
    return this.rowClassification(row as any);
  }

  /**
   * Newest `created_at` among cached ok classifications for the given papers.
   * Used as a deterministic fallback generation stamp for preview/backfill
   * when the meta table has no entry for the week (e.g. a config change, or a
   * week classified before the stamp feature existed). Runs once per week, not
   * per paper, so the statement is built on demand instead of at construction.
   */
  latestClassificationStamp(paperIds: string[]): string | undefined {
    if (!paperIds.length) return undefined;
    const placeholders = paperIds.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS stamp FROM classification_cache
         WHERE arxiv_id IN (${placeholders}) AND status='ok'`,
      )
      .get(...paperIds) as any;
    return typeof row?.stamp === 'string' && row.stamp ? row.stamp : undefined;
  }

  /**
   * Convert a classification row to the domain result. Rows written before the
   * `tldr_json` column existed (or with an empty tldr) are treated as a cache
   * miss so stale entries never produce a paper card without a TLDR.
   */
  private rowClassification(row: any): ClassificationResult | undefined {
    if (!row || typeof row.tldr_json !== 'string') return undefined;
    let tldr: string;
    try {
      tldr = JSON.parse(row.tldr_json);
    } catch {
      return undefined;
    }
    if (typeof tldr !== 'string' || !tldr.trim()) return undefined;
    return {
      categories: JSON.parse(row.categories_json),
      tags: JSON.parse(row.tags_json),
      tldr,
    };
  }

  saveClassification(
    key: string,
    p: Paper,
    model: string,
    r: ClassificationResult,
  ): void {
    this.stmtSaveClassification.run(
      key,
      p.arxivId,
      p.contentHash,
      model,
      JSON.stringify(r.categories),
      JSON.stringify(r.tags),
      JSON.stringify(r.tldr),
      'ok',
      new Date().toISOString(),
    );
  }

  /**
   * Delete stored classification results. Without `olderThanDays` the whole
   * cache is cleared; with it only entries older than the cutoff disappear.
   * Returns the number of deleted rows.
   */
  clearClassifications(olderThanDays?: number): number {
    if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
      throw new Error('older-than must be a non-negative number');
    }
    const rows = olderThanDays === undefined
      ? this.stmtDeleteAllClassifications.run()
      : this.stmtDeleteStaleClassifications.run(
        new Date(Date.now() - olderThanDays * 86400000).toISOString(),
      );
    return Number(rows.changes);
  }

  getMeta(key: string): string | undefined {
    const row = this.stmtGetMeta.get(key) as any;
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }

  stats(): any {
    return this.stmtStats.get();
  }

  prune(days: number): number {
    if (!Number.isFinite(days) || days < 0) {
      throw new Error('older-than must be a non-negative number');
    }
    const before = new Date(Date.now() - days * 86400000).toISOString();
    return this.transaction(() => {
      let deleted = 0;
      deleted += Number(this.stmtPruneFetches.run(before).changes);
      deleted += Number(this.stmtPruneClassifications.run(before).changes);
      return deleted;
    });
  }
}
