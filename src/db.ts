import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import type { ClassificationResult, Paper } from './types.js';

const require = createRequire(import.meta.url);
const sqlJs: any = await initSqlJs({
  locateFile: (file) => join(dirname(require.resolve('sql.js')), file),
});

type SqliteDatabase = any;

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

/**
 * Atomically replace the target file with the source file. On Windows the
 * destination is commonly locked for milliseconds by antivirus scanners,
 * file-indexing, or sync tools, so a plain rename fails with EPERM; retry a
 * few times with a short backoff before giving up.
 */
export function replaceFileOver(source: string, target: string): void {
  const attempts = 5;
  let delayMs = 50;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      // Retry only transient sharing violations on the destination file.
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      // Synchronous sleep: this helper must stay usable from sync callers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      delayMs *= 2;
    }
  }
  throw lastError;
}

class Statement {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly sql: string,
    private readonly onWrite?: () => void,
  ) { }

  private bind(statement: any, params: unknown[]): void {
    statement.bind(
      params.length === 1 && params[0] && typeof params[0] === 'object'
        ? (params[0] as Record<string, unknown>)
        : params,
    );
  }

  get(...params: unknown[]): any {
    const statement = this.database.prepare(this.sql);
    this.bind(statement, params);
    const row = statement.step() ? statement.getAsObject() : undefined;
    statement.free();
    return row;
  }

  all(...params: unknown[]): any[] {
    const statement = this.database.prepare(this.sql);
    this.bind(statement, params);
    const rows: any[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    statement.free();
    return rows;
  }

  run(...params: unknown[]): { changes: number } {
    const statement = this.database.prepare(this.sql);
    this.bind(statement, params);
    statement.step();
    statement.free();
    this.onWrite?.();
    return { changes: this.database.getRowsModified() };
  }
}

class SqliteStore {
  constructor(
    readonly database: SqliteDatabase,
    private readonly file: string,
  ) { }

  prepare(sql: string): Statement {
    return new Statement(this.database, sql);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(_value: string): void { }

  transaction<T>(callback: () => T): () => T {
    return () => {
      this.database.exec('BEGIN');
      try {
        return callback();
      } finally {
        this.database.exec('COMMIT');
      }
    };
  }

  /** Write a snapshot to a temp file then atomically rename over the target. */
  persist(): void {
    const buffer = Buffer.from(this.database.export());
    const temporary = `${this.file}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, buffer);
      replaceFileOver(temporary, this.file);
    } catch (error) {
      // Never leave orphaned temp snapshots behind.
      try {
        unlinkSync(temporary);
      } catch {
        /* best effort */
      }
      throw error;
    }
  }

  close(): void {
    this.persist();
    this.database.close();
  }
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
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export class Store {
  db: SqliteStore;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const bytes = existsSync(file) ? readFileSync(file) : undefined;
    const database = new sqlJs.Database(bytes && bytes.length ? bytes : undefined);
    this.db = new SqliteStore(database, file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Persist the in-memory database snapshot to disk (atomic temp+rename). */
  flush(): void {
    this.db.persist();
  }

  getPaper(id: string): Paper | undefined {
    const row = this.db.prepare('SELECT * FROM papers WHERE arxiv_id=?').get(id) as any;
    return row && this.rowPaper(row);
  }

  savePaper(p: Paper): void {
    this.db
      .prepare(
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
      )
      .run(
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
    return (this.db
      .prepare('SELECT * FROM papers WHERE published_at >= ? AND published_at < ? ORDER BY arxiv_id')
      .all(from, to) as any[]).map((row) => this.rowPaper(row));
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
    const row = this.db.prepare('SELECT * FROM fetch_cache WHERE url=?').get(url) as any;
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
    this.db
      .prepare('INSERT OR REPLACE INTO fetch_cache VALUES (?,?,?,?,?,?)')
      .run(
        url,
        JSON.stringify(papers),
        meta.etag || '',
        meta.lastModified || '',
        meta.expiresAt || '',
        new Date().toISOString(),
      );
  }

  getClassification(key: string): ClassificationResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM classification_cache WHERE cache_key=? AND status="ok"')
      .get(key) as any;
    return (
      row && {
        categories: JSON.parse(row.categories_json),
        tags: JSON.parse(row.tags_json),
      }
    );
  }

  /**
   * Latest "ok" classification for a paper. When `contentHash` is given, only
   * rows whose stored content hash still matches are considered, so a paper
   * whose abstract changed is never silently re-labeled with a stale result.
   */
  latestClassification(id: string, contentHash?: string): ClassificationResult | undefined {
    const row = contentHash === undefined
      ? this.db
        .prepare('SELECT * FROM classification_cache WHERE arxiv_id=? AND status="ok" ORDER BY created_at DESC LIMIT 1')
        .get(id)
      : this.db
        .prepare('SELECT * FROM classification_cache WHERE arxiv_id=? AND content_hash=? AND status="ok" ORDER BY created_at DESC LIMIT 1')
        .get(id, contentHash);
    return (
      row && {
        categories: JSON.parse(row.categories_json),
        tags: JSON.parse(row.tags_json),
      }
    );
  }

  saveClassification(
    key: string,
    p: Paper,
    model: string,
    r: ClassificationResult,
  ): void {
    this.db
      .prepare('INSERT OR REPLACE INTO classification_cache VALUES (?,?,?,?,?,?,?,?)')
      .run(
        key,
        p.arxivId,
        p.contentHash,
        model,
        JSON.stringify(r.categories),
        JSON.stringify(r.tags),
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
      ? this.db.prepare('DELETE FROM classification_cache').run()
      : this.db
        .prepare('DELETE FROM classification_cache WHERE created_at < ?')
        .run(new Date(Date.now() - olderThanDays * 86400000).toISOString());
    return rows.changes;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any;
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta VALUES (?,?)')
      .run(key, value);
  }

  stats(): any {
    return this.db
      .prepare(
        'SELECT (SELECT count(*) FROM papers) papers, ' +
        '(SELECT count(*) FROM fetch_cache) fetches, ' +
        '(SELECT count(*) FROM classification_cache) classifications',
      )
      .get();
  }

  prune(days: number): number {
    if (!Number.isFinite(days) || days < 0) {
      throw new Error('older-than must be a non-negative number');
    }
    const before = new Date(Date.now() - days * 86400000).toISOString();
    const transaction = this.db.transaction(() => {
      let deleted = 0;
      deleted += this.db.prepare('DELETE FROM fetch_cache WHERE fetched_at < ?').run(before).changes;
      deleted += this.db.prepare('DELETE FROM classification_cache WHERE created_at < ?').run(before).changes;
      return deleted;
    });
    return transaction();
  }
}
