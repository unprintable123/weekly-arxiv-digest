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

const paper = (id: string, publishedAt = '2024-01-02T00:00:00.000Z'): Paper => ({
    arxivId: id,
    title: `Paper ${id}`,
    authors: ['Alice'],
    categories: ['cs.LG'],
    abstractEn: 'Abstract text.',
    publishedAt,
    detailUrl: `https://arxiv.org/abs/${id}`,
    contentHash: `hash-${id}`,
});

const model = 'test-model';

const result = (primary: string, secondary?: string): ClassificationResult => ({
    categories: secondary ? [primary, secondary] : [primary],
    tags: ['attention'],
});

describe('classification cache', () => {
    it('round-trips classification results by cache key', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            const key = 'k1';
            expect(store.getClassification(key)).toBeUndefined();

            store.saveClassification(key, paper('2401.01234'), model, result('llm-architecture'));
            const cached = store.getClassification(key);
            expect(cached?.categories).toEqual(['llm-architecture']);
            expect(cached?.tags).toEqual(['attention']);
            expect(cached).not.toHaveProperty('raw');
            expect(store.latestClassification('2401.01234')?.categories).toEqual(['llm-architecture']);
        } finally {
            cleanup();
        }
    });

    it('does not return entries stored under a different key (taxonomy/model change)', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('key-a', paper('2401.01234'), model, result('llm-architecture'));
            expect(store.getClassification('key-b')).toBeUndefined();
            // Rows no longer carry a taxonomy hash column; key isolation is the
            // only invalidation signal, and different keys stay independent.
            store.saveClassification('key-c', paper('2401.01234'), model, result('other'));
            expect(store.getClassification('key-c')?.categories).toEqual(['other']);
        } finally {
            cleanup();
        }
    });
});

describe('clearClassifications', () => {
    it('deletes everything without a cutoff, only stale rows with one', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('k1', paper('2401.01234'), model, result('other'));
            // Everything was just written, so nothing is older than 30 days.
            expect(store.clearClassifications(30)).toBe(0);
            expect(store.getClassification('k1')).toBeDefined();

            // age=0 removes all rows recorded before "now".
            expect(store.clearClassifications(0)).toBe(1);
            expect(store.getClassification('k1')).toBeUndefined();

            store.saveClassification('k2', paper('2401.01234'), model, result('physics-of-llm'));
            expect(store.clearClassifications()).toBe(1);
            expect(store.getClassification('k2')).toBeUndefined();
            expect(store.stats().classifications).toBe(0);
        } finally {
            cleanup();
        }
    });
});

describe('paper window queries', () => {
    it('returns papers inside the half-open [from, to) window', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234', '2024-01-01T00:00:00.000Z'));
            store.savePaper(paper('2401.01235', '2024-01-07T23:59:59.000Z'));
            store.savePaper(paper('2401.01236', '2024-01-08T00:00:00.000Z'));

            const papers = store.papersBetween('2024-01-01', '2024-01-08');
            expect(papers.map((entry) => entry.arxivId)).toEqual(['2401.01234', '2401.01235']);
        } finally {
            cleanup();
        }
    });
});

describe('meta table', () => {
    it('stores and overwrites byte-stable generation timestamps', () => {
        const { store, dir, cleanup } = makeStore();
        try {
            expect(store.getMeta('generated_at:2024-W01:abc')).toBeUndefined();
            store.setMeta('generated_at:2024-W01:abc', '2024-01-08T00:00:00.000Z');
            store.setMeta('generated_at:2024-W01:abc', '2024-01-09T00:00:00.000Z');
            expect(store.getMeta('generated_at:2024-W01:abc')).toBe('2024-01-09T00:00:00.000Z');

            store.close();
            const reopened = new Store(join(dir, 'cache.sqlite'));
            expect(reopened.getMeta('generated_at:2024-W01:abc')).toBe('2024-01-09T00:00:00.000Z');
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
            store.saveClassification('k1', paper('2401.01234'), model, result('other'));
            const stats = store.stats();
            expect(stats.papers).toBe(1);
            expect(stats.classifications).toBe(1);
            expect(stats.fetches).toBe(0);
            expect(stats).not.toHaveProperty('relevance');
            expect(stats).not.toHaveProperty('translations');

            store.saveFetch('https://example.com/list', [{ arxivId: '2401.01234' }], {
                expiresAt: '2024-02-01T00:00:00.000Z',
            });
            expect(store.getFetch('https://example.com/list')?.papers).toEqual([{ arxivId: '2401.01234' }]);
            // Nothing is older than the cutoff for a huge window.
            expect(store.prune(3650)).toBe(0);
            expect(store.getClassification('k1')).toBeDefined();

            // age=0 prunes everything recorded before "now".
            expect(store.prune(0)).toBeGreaterThanOrEqual(2);
            expect(store.getClassification('k1')).toBeUndefined();
            expect(store.getFetch('https://example.com/list')).toBeUndefined();
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

describe('fetch cache', () => {
    it('stores extracted paper lists, never a raw body', () => {
        const { store, cleanup } = makeStore();
        try {
            expect(store.getFetch('https://example.com/list')).toBeUndefined();
            const entries = [
                { arxivId: '2401.01234', title: 'One' },
                { arxivId: '2401.01235', title: 'Two' },
            ];
            store.saveFetch('https://example.com/list', entries, {
                etag: 'W/"e1"',
                lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
                expiresAt: '2024-02-01T00:00:00.000Z',
            });
            const cached = store.getFetch('https://example.com/list')!;
            expect(cached.papers).toEqual(entries);
            expect(cached.etag).toBe('W/"e1"');
            expect(cached.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
            expect(cached.expiresAt).toBe('2024-02-01T00:00:00.000Z');

            // Corrupt rows degrade to a miss instead of throwing.
            store.db.exec("UPDATE fetch_cache SET papers_json='{' WHERE url='https://example.com/list'");
            expect(store.getFetch('https://example.com/list')).toBeUndefined();
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
            // makeStore's Store constructor also passes through the mocked
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
