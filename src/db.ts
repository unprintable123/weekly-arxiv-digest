import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import type { Paper, RelevanceResult } from './types.js';

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
    sourceUrl: row.source_url,
    contentHash: row.content_hash,
  };
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
  private inTransaction = false;

  constructor(
    readonly database: SqliteDatabase,
    private readonly file: string,
  ) { }

  prepare(sql: string): Statement {
    // Every write is flushed to disk atomically so an interrupted process
    // never loses cache/run state and never leaves a corrupt database file.
    return new Statement(this.database, sql, () => this.persistIfIdle());
  }

  exec(sql: string): void {
    this.database.exec(sql);
    this.persistIfIdle();
  }

  pragma(_value: string): void { }

  transaction<T>(callback: () => T): () => T {
    return () => {
      this.inTransaction = true;
      this.database.exec('BEGIN');
      try {
        const result = callback();
        this.database.exec('COMMIT');
        this.persist();
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      } finally {
        this.inTransaction = false;
      }
    };
  }

  private persistIfIdle(): void {
    if (!this.inTransaction) this.persist();
  }

  /** Write a snapshot to a temp file then atomically rename over the target. */
  persist(): void {
    const buffer = Buffer.from(this.database.export());
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, buffer);
    renameSync(temporary, this.file);
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
  source_url TEXT,
  content_hash TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS fetch_cache (
  url TEXT PRIMARY KEY,
  status INTEGER,
  body TEXT,
  body_hash TEXT,
  etag TEXT,
  last_modified TEXT,
  expires_at TEXT,
  error TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS relevance_cache (
  cache_key TEXT PRIMARY KEY,
  arxiv_id TEXT,
  abstract_hash TEXT,
  interest_hash TEXT,
  prompt_version TEXT,
  agent_package_version TEXT,
  provider TEXT,
  model TEXT,
  score INTEGER,
  reason TEXT,
  categories_json TEXT,
  tags_json TEXT,
  raw TEXT,
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key TEXT PRIMARY KEY,
  arxiv_id TEXT,
  abstract_hash TEXT,
  target_language TEXT,
  prompt_version TEXT,
  translation TEXT,
  raw TEXT,
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  week TEXT,
  from_date TEXT,
  to_date TEXT,
  config_hash TEXT,
  started_at TEXT,
  ended_at TEXT,
  status TEXT,
  stats_json TEXT
);
CREATE TABLE IF NOT EXISTS run_papers (
  run_id TEXT,
  arxiv_id TEXT,
  included INTEGER,
  reason TEXT,
  sort_order INTEGER,
  PRIMARY KEY(run_id, arxiv_id)
);
CREATE TABLE IF NOT EXISTS llm_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  stage TEXT,
  arxiv_id TEXT,
  error_type TEXT,
  retries INTEGER,
  message TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS crawl_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  stage TEXT,
  category TEXT,
  arxiv_id TEXT,
  url TEXT,
  message TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS run_documents (
  run_id TEXT PRIMARY KEY,
  week TEXT,
  document_json TEXT,
  markdown TEXT,
  file TEXT,
  created_at TEXT
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

  getPaper(id: string): Paper | undefined {
    const row = this.db.prepare('SELECT * FROM papers WHERE arxiv_id=?').get(id) as any;
    return row && this.rowPaper(row);
  }

  savePaper(p: Paper): void {
    this.db
      .prepare(
        `INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(arxiv_id) DO UPDATE SET
           version=excluded.version,
           title=excluded.title,
           authors_json=excluded.authors_json,
           categories_json=excluded.categories_json,
           abstract_en=excluded.abstract_en,
           published_at=excluded.published_at,
           updated_at=excluded.updated_at,
           detail_url=excluded.detail_url,
           source_url=excluded.source_url,
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
        p.sourceUrl,
        p.contentHash,
        new Date().toISOString(),
      );
  }

  private rowPaper(row: any): Paper {
    return rowToPaper(row);
  }

  getFetch(url: string): any {
    return this.db.prepare('SELECT * FROM fetch_cache WHERE url=?').get(url) as any;
  }

  saveFetch(url: string, data: any): void {
    this.db
      .prepare('INSERT OR REPLACE INTO fetch_cache VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        url,
        data.status,
        data.body,
        data.bodyHash,
        data.etag || '',
        data.lastModified || '',
        data.expiresAt || '',
        data.error || '',
        new Date().toISOString(),
      );
  }

  getRelevance(key: string): RelevanceResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM relevance_cache WHERE cache_key=? AND status="ok"')
      .get(key) as any;
    return (
      row && {
        score: row.score,
        reason: row.reason,
        categories: JSON.parse(row.categories_json),
        tags: JSON.parse(row.tags_json),
        raw: row.raw,
      }
    );
  }

  latestRelevance(id: string): RelevanceResult | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM relevance_cache WHERE arxiv_id=? AND status="ok" ORDER BY created_at DESC LIMIT 1',
      )
      .get(id) as any;
    return (
      row && {
        score: row.score,
        reason: row.reason,
        categories: JSON.parse(row.categories_json),
        tags: JSON.parse(row.tags_json),
        raw: row.raw,
      }
    );
  }

  saveRelevance(key: string, p: Paper, interestHash: string, meta: any, r: RelevanceResult): void {
    this.db
      .prepare('INSERT OR REPLACE INTO relevance_cache VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        key,
        p.arxivId,
        p.contentHash,
        interestHash,
        meta.promptVersion,
        meta.agentVersion,
        meta.provider,
        meta.model,
        r.score,
        r.reason,
        JSON.stringify(r.categories),
        JSON.stringify(r.tags),
        r.raw || '',
        'ok',
        new Date().toISOString(),
      );
  }

  getTranslation(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT translation FROM translation_cache WHERE cache_key=? AND status="ok"')
      .get(key) as any;
    return row?.translation;
  }

  latestTranslation(id: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT translation FROM translation_cache WHERE arxiv_id=? AND status="ok" ORDER BY created_at DESC LIMIT 1',
      )
      .get(id) as any;
    return row?.translation;
  }

  saveTranslation(key: string, p: Paper, lang: string, translation: string, raw = ''): void {
    this.db
      .prepare('INSERT OR REPLACE INTO translation_cache VALUES (?,?,?,?,?,?,?,?,?)')
      .run(key, p.arxivId, p.contentHash, lang, 'v1', translation, raw, 'ok', new Date().toISOString());
  }

  addLlmError(runId: string, stage: string, arxivId: string, error: unknown, retries: number): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(
        'INSERT INTO llm_errors (run_id, stage, arxiv_id, error_type, retries, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        runId,
        stage,
        arxivId,
        error instanceof Error ? error.name : 'Error',
        retries,
        message,
        new Date().toISOString(),
      );
  }

  startRun(run: any): void {
    this.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)')
      .run(run.runId, run.week, run.from, run.to, run.configHash, run.startedAt, '', 'running', '{}');
  }

  finishRun(id: string, status: string, stats: any, endedAt = new Date().toISOString()): void {
    this.db
      .prepare('UPDATE runs SET ended_at=?,status=?,stats_json=? WHERE run_id=?')
      .run(endedAt, status, JSON.stringify(stats), id);
  }

  addRunPaper(runId: string, id: string, included: boolean, reason: string, order: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO run_papers VALUES (?,?,?,?,?)')
      .run(runId, id, included ? 1 : 0, reason, order);
  }

  listRunPapers(runId: string): any[] {
    return this.db
      .prepare(
        'SELECT p.*, rp.included, rp.reason FROM run_papers rp JOIN papers p ON p.arxiv_id=rp.arxiv_id WHERE rp.run_id=? ORDER BY rp.sort_order',
      )
      .all(runId) as any[];
  }

  latestRun(week: string): any {
    return this.db
      .prepare('SELECT * FROM runs WHERE week=? AND status="ok" ORDER BY ended_at DESC LIMIT 1')
      .get(week) as any;
  }

  stats(): any {
    return this.db
      .prepare(
        'SELECT (SELECT count(*) FROM papers) papers, ' +
        '(SELECT count(*) FROM fetch_cache) fetches, ' +
        '(SELECT count(*) FROM relevance_cache) relevance, ' +
        '(SELECT count(*) FROM translation_cache) translations',
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
      deleted += this.db.prepare('DELETE FROM relevance_cache WHERE created_at < ?').run(before).changes;
      deleted += this.db.prepare('DELETE FROM translation_cache WHERE created_at < ?').run(before).changes;
      return deleted;
    });
    return transaction();
  }

  addCrawlError(runId: string, error: { stage: string; category?: string; arxivId?: string; url: string; message: string }): void {
    this.db
      .prepare(
        'INSERT INTO crawl_errors (run_id, stage, category, arxiv_id, url, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        runId,
        error.stage,
        error.category ?? '',
        error.arxivId ?? '',
        error.url,
        error.message,
        new Date().toISOString(),
      );
  }

  crawlErrorsForRun(runId: string): any[] {
    return this.db
      .prepare('SELECT * FROM crawl_errors WHERE run_id=? ORDER BY id')
      .all(runId) as any[];
  }

  getRun(runId: string): any {
    return this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId) as any;
  }

  /** Latest run for a week/config-hash combination (any status). */
  latestRunForWeek(week: string, configHash: string): any {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE week=? AND config_hash=? ORDER BY ended_at DESC LIMIT 1',
      )
      .get(week, configHash) as any;
  }

  llmErrorsForRun(runId: string, stage?: string): any[] {
    const sql = stage
      ? 'SELECT * FROM llm_errors WHERE run_id=? AND stage=? ORDER BY id'
      : 'SELECT * FROM llm_errors WHERE run_id=? ORDER BY id';
    return this.db.prepare(sql).all(runId, stage) as any[];
  }

  papersForRun(runId: string): any[] {
    return this.db
      .prepare(
        'SELECT p.*, rp.included, rp.reason, rp.sort_order FROM run_papers rp JOIN papers p ON p.arxiv_id=rp.arxiv_id WHERE rp.run_id=? ORDER BY rp.sort_order',
      )
      .all(runId) as any[];
  }

  saveRunDocument(runId: string, week: string, document: unknown, markdown: string, file: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO run_documents VALUES (?,?,?,?,?,?)')
      .run(runId, week, JSON.stringify(document), markdown, file, new Date().toISOString());
  }

  getRunDocument(runId: string): any {
    return this.db.prepare('SELECT * FROM run_documents WHERE run_id=?').get(runId) as any;
  }
}
