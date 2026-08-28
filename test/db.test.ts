import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { replaceFileOver, Store } from '../src/db.js';
import type { ClassificationResult, Paper } from '../src/types.js';
import { makeStore } from './helpers.js';

/**
 * Node's fs ESM namespace cannot be spied on, so src/db.ts's `renameSync`
 * binding is swapped through a vi.mock indirection pointed at a mutable
 * implementation that each test installs and afterEach restores. The real
 * binding is captured via createRequire outside the mocked namespace so the
 * mock can delegate to it without recursing.
 */
const realRename = createRequire(import.meta.url)('node:fs').renameSync as (
    from: string,
    to: string,
) => void;
let renameImpl: (from: string, to: string) => void = realRename;
let renameCalls = 0;
vi.mock('node:fs', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs')>();
    return {
        ...real,
        renameSync: (from: string, to: string) => {
            renameCalls += 1;
            return renameImpl(from, to);
        },
    };
});

const failTimes = (code: string, times: number) => {
    renameImpl = (from, to) => {
        if (renameCalls <= times) {
            const error = new Error(`${code}: mocked fs failure`) as NodeJS.ErrnoException;
            error.code = code;
            throw error;
        }
        realRename(from, to);
    };
};

afterEach(() => {
    renameImpl = realRename;
    renameCalls = 0;
});

const paper = (id: string): Paper => ({
    arxivId: id,
    title: `Paper ${id}`,
    authors: ['Alice'],
    categories: ['cs.LG'],
    abstractEn: 'Abstract text.',
    publishedAt: '2024-01-02T00:00:00.000Z',
    detailUrl: `https://arxiv.org/abs/${id}`,
    sourceUrl: `https://papers.cool/arxiv/${id}`,
    contentHash: `hash-${id}`,
});

const meta = {
    taxonomyHash: 'tax-1',
    promptVersion: 'v1',
    agentVersion: '0.84.3',
    provider: 'test',
    model: 'test-model',
};

const result = (primary: string, secondary?: string): ClassificationResult => ({
    categories: secondary ? [primary, secondary] : [primary],
    tags: ['attention'],
    raw: '{"categories":["' + primary + '"]}',
});

describe('classification cache', () => {
    it('round-trips classification results by cache key', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            const key = 'k1';
            expect(store.getClassification(key)).toBeUndefined();

            store.saveClassification(key, paper('2401.01234'), meta, result('llm-architecture'));
            const cached = store.getClassification(key);
            expect(cached?.categories).toEqual(['llm-architecture']);
            expect(cached?.tags).toEqual(['attention']);
            expect(cached?.raw).toContain('llm-architecture');
            expect(store.latestClassification('2401.01234')?.categories).toEqual(['llm-architecture']);
        } finally {
            cleanup();
        }
    });

    it('does not return entries stored under a different key (taxonomy/model change)', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('key-a', paper('2401.01234'), meta, result('llm-architecture'));
            expect(store.getClassification('key-b')).toBeUndefined();
            // Changing the taxonomy hash must produce a miss.
            store.saveClassification(
                'key-c',
                paper('2401.01234'),
                { ...meta, taxonomyHash: 'tax-2' },
                result('other'),
            );
            expect(store.getClassification('key-c')?.categories).toEqual(['other']);
        } finally {
            cleanup();
        }
    });
});

describe('run documents', () => {
    it('stores one snapshot per (run, category)', () => {
        const { store, cleanup } = makeStore();
        try {
            const doc = (categoryId: string) => ({
                week: '2024-W01',
                from: '2024-01-01',
                to: '2024-01-08',
                categoryId,
                categoryName: categoryId,
                generatedAt: '2024-01-08T00:00:00.000Z',
                configHash: 'abc',
                candidateCount: 2,
                papers: [],
            });
            store.saveRunDocument('run-1', '2024-W01', 'llm-architecture', doc('llm-architecture'), 'md-a', 'f-a.md');
            store.saveRunDocument('run-1', '2024-W01', 'agent-design', doc('agent-design'), 'md-b', 'f-b.md');
            // Overwrite is allowed for the same key.
            store.saveRunDocument('run-1', '2024-W01', 'llm-architecture', doc('llm-architecture'), 'md-a2', 'f-a.md');

            expect(store.getRunDocuments('run-1').map((row) => row.category_id)).toEqual([
                'agent-design',
                'llm-architecture',
            ]);
            expect(store.getRunDocument('run-1', 'llm-architecture').markdown).toBe('md-a2');
            expect(store.getRunDocument('run-1', 'missing')).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('migrates a legacy single-document run_documents table without data loss', () => {
        const { store, dir, cleanup } = makeStore();
        try {
            // Degrade the table to the legacy shape used by the previous schema.
            store.db.exec('DROP TABLE run_documents');
            store.db.exec(`CREATE TABLE run_documents (
                run_id TEXT PRIMARY KEY,
                week TEXT,
                document_json TEXT,
                markdown TEXT,
                file TEXT,
                created_at TEXT
            )`);
            store.db.exec(
                `INSERT INTO run_documents VALUES ('legacy-run', '2023-W50', '{}', 'legacy md', 'old.md', '2023-01-01')`,
            );
            // Also drop the newer run_papers column to exercise ensureColumn.
            store.db.exec('DROP TABLE run_papers');
            store.db.exec('CREATE TABLE run_papers (run_id TEXT, arxiv_id TEXT, included INTEGER, reason TEXT, sort_order INTEGER, PRIMARY KEY(run_id, arxiv_id))');
            store.close();

            const reopened = new Store(join(dir, 'cache.sqlite'));
            expect(existsSync(join(dir, 'cache.sqlite'))).toBe(true);
            const legacy = reopened.getRunDocument('legacy-run', '');
            expect(legacy?.markdown).toBe('legacy md');
            // New multi-category writes work after migration.
            reopened.saveRunDocument('new-run', '2024-W01', 'rag', {}, 'md', 'f.md');
            expect(reopened.getRunDocuments('new-run')).toHaveLength(1);
            reopened.close();
        } finally {
            cleanup();
        }
    });
});

describe('stats and prune', () => {
    it('reports fetch/classification counts and prunes only stale entries', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('k1', paper('2401.01234'), meta, result('other'));
            const stats = store.stats();
            expect(stats.papers).toBe(1);
            expect(stats.classifications).toBe(1);
            expect(stats.fetches).toBe(0);
            expect(stats).not.toHaveProperty('relevance');
            expect(stats).not.toHaveProperty('translations');

            store.saveFetch('https://example.com', { status: 200, body: 'x', bodyHash: 'h' });
            // Nothing is older than the cutoff for a huge window.
            expect(store.prune(3650)).toBe(0);
            expect(store.getClassification('k1')).toBeDefined();

            // age=0 prunes everything recorded before "now".
            expect(store.prune(0)).toBeGreaterThanOrEqual(2);
            expect(store.getClassification('k1')).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('rejects invalid prune windows', () => {
        const { store, cleanup } = makeStore();
        try {
            expect(() => store.prune(-1)).toThrow(/non-negative/);
        } finally {
            cleanup();
        }
    });
});

describe('agent errors', () => {
    it('records errors per run and stage', () => {
        const { store, cleanup } = makeStore();
        try {
            store.addAgentError('run-1', 'classify', '2401.01234', new Error('boom'), 2);
            const errors = store.agentErrorsForRun('run-1', 'classify');
            expect(errors).toHaveLength(1);
            expect(errors[0].stage).toBe('classify');
            expect(errors[0].message).toBe('boom');
            expect(store.agentErrorsForRun('run-1', 'fetch')).toHaveLength(0);
        } finally {
            cleanup();
        }
    });
});

describe('replaceFileOver', () => {
    it('replaces an existing target file', async () => {
        const { dir, cleanup } = makeStore();
        try {
            const source = join(dir, 'src.txt');
            const target = join(dir, 'target.txt');
            writeFileSync(source, 'new');
            writeFileSync(target, 'old');
            replaceFileOver(source, target);
            expect(readFileSync(target, 'utf8')).toBe('new');
            expect(existsSync(source)).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('retries transient destination locks (EPERM) before succeeding', () => {
        const { dir, cleanup } = makeStore();
        try {
            const source = join(dir, 'src.txt');
            const target = join(dir, 'target.txt');
            writeFileSync(source, 'new');
            writeFileSync(target, 'old');
            failTimes('EPERM', 1);
            replaceFileOver(source, target);
            expect(readFileSync(target, 'utf8')).toBe('new');
            expect(renameCalls).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('throws after exhausting retries for a persistent lock', () => {
        const { dir, cleanup } = makeStore();
        try {
            const source = join(dir, 'src.txt');
            const target = join(dir, 'target.txt');
            writeFileSync(source, 'new');
            failTimes('EBUSY', Number.MAX_SAFE_INTEGER);
            // makeStore's constructor migrations also pass through the mocked
            // renameSync; measure only the calls made by this helper.
            renameCalls = 0;
            expect(() => replaceFileOver(source, target)).toThrow(/EBUSY/);
            expect(renameCalls).toBe(5);
        } finally {
            cleanup();
        }
    });

    it('does not retry non-transient errors', () => {
        const { dir, cleanup } = makeStore();
        try {
            const source = join(dir, 'src.txt');
            const target = join(dir, 'no-such-dir', 'target.txt');
            writeFileSync(source, 'new');
            failTimes('ENOENT', Number.MAX_SAFE_INTEGER);
            renameCalls = 0;
            expect(() => replaceFileOver(source, target)).toThrow(/ENOENT/);
            expect(renameCalls).toBe(1);
        } finally {
            cleanup();
        }
    });
});
