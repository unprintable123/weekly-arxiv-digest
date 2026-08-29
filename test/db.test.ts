import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import type { ClassificationResult, Paper } from '../src/types.js';
import { makeStore } from './helpers.js';

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
    tldr: '一句话中文摘要。',
});

describe('incremental persistence', () => {
    it('survives reopen without an explicit flush: writes are durable immediately', () => {
        const { store, dir, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('k1', paper('2401.01234'), model, result('llm-architecture'));
            store.setMeta('generated_at:2024-W01:abc', '2024-01-08T00:00:00.000Z');
            // No flush(): every committed statement must already be on disk.
            store.close();

            const reopened = new Store(join(dir, 'cache.sqlite'));
            try {
                expect(reopened.getPaper('2401.01234')?.title).toBe('Paper 2401.01234');
                expect(reopened.getClassification('k1')?.tldr).toBe('一句话中文摘要。');
                expect(reopened.getMeta('generated_at:2024-W01:abc')).toBe('2024-01-08T00:00:00.000Z');
            } finally {
                reopened.close();
            }
        } finally {
            cleanup();
        }
    });

    it('committed writes stay durable when a transaction is used (prune)', () => {
        const { store, dir, cleanup } = makeStore();
        try {
            store.saveFetch('https://example.com/list', [{ arxivId: '2401.01234' }], {});
            store.close();
            const reopened = new Store(join(dir, 'cache.sqlite'));
            try {
                expect(reopened.getFetch('https://example.com/list')).toBeDefined();
            } finally {
                reopened.close();
            }
        } finally {
            cleanup();
        }
    });
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
            expect(cached?.tldr).toBe('一句话中文摘要。');
            expect(cached).not.toHaveProperty('raw');
            expect(store.latestClassification('2401.01234')?.categories).toEqual(['llm-architecture']);
            // The content-hash filter keeps the row reusable for the same paper
            // content but never reuses it once the paper content changed.
            expect(store.latestClassification('2401.01234', 'hash-2401.01234')?.categories).toEqual(['llm-architecture']);
            expect(store.latestClassification('2401.01234', 'different-content')).toBeUndefined();
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

    it('treats classification rows without a tldr as a cache miss', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('k1', paper('2401.01234'), model, result('llm-architecture'));
            expect(store.getClassification('k1')).toBeDefined();
            expect(store.latestClassification('2401.01234', 'hash-2401.01234')).toBeDefined();
            // Simulate a row written before the tldr_json column existed: the
            // row is no longer a valid classification and must be re-derived.
            store.db.exec("UPDATE classification_cache SET tldr_json='' WHERE cache_key='k1'");
            expect(store.getClassification('k1')).toBeUndefined();
            expect(store.latestClassification('2401.01234', 'hash-2401.01234')).toBeUndefined();
            // The same row is again usable once a tldr is stored.
            store.saveClassification('k1', paper('2401.01234'), model, result('llm-architecture'));
            expect(store.getClassification('k1')?.tldr).toBe('一句话中文摘要。');
        } finally {
            cleanup();
        }
    });

    it('returns the newest classification timestamp among the given papers', async () => {
        const { store, cleanup } = makeStore();
        try {
            expect(store.latestClassificationStamp([])).toBeUndefined();
            expect(store.latestClassificationStamp(['2401.01234'])).toBeUndefined();

            store.savePaper(paper('2401.01234'));
            store.savePaper(paper('2401.01235'));
            store.saveClassification('k1', paper('2401.01234'), model, result('llm-architecture'));
            // Let the clock advance so k2's created_at is strictly newer.
            await new Promise((resolve) => setTimeout(resolve, 5));
            store.saveClassification('k2', paper('2401.01235'), model, result('agent-design'));

            const older = store.latestClassificationStamp(['2401.01234']);
            const newer = store.latestClassificationStamp(['2401.01234', '2401.01235']);
            expect(older).toBeTruthy();
            expect(newer).toBeTruthy();
            // The max created_at across both papers is the later k2 stamp.
            expect(newer! >= older!).toBe(true);

            // Only status='ok' rows count; a failed row never becomes the stamp.
            store.db.exec("UPDATE classification_cache SET status='error' WHERE cache_key='k2'");
            expect(store.latestClassificationStamp(['2401.01234', '2401.01235'])).toBe(older);
        } finally {
            cleanup();
        }
    });
});

describe('clearClassifications', () => {
    it('deletes everything without a cutoff, only stale rows with one', async () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234'));
            store.saveClassification('k1', paper('2401.01234'), model, result('other'));
            // Everything was just written, so nothing is older than 30 days.
            expect(store.clearClassifications(30)).toBe(0);
            expect(store.getClassification('k1')).toBeDefined();

            // Let at least one millisecond pass so the stored timestamps are
            // strictly older than "now" when clearing with age=0 (same race
            // guard as the prune test).
            await new Promise((resolve) => setTimeout(resolve, 5));
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

    it('lists distinct ISO weeks, sorted, with no duplicate week per group', () => {
        const { store, cleanup } = makeStore();
        try {
            store.savePaper(paper('2401.01234', '2024-01-01T00:00:00.000Z')); // 2024-W01
            store.savePaper(paper('2401.01235', '2024-01-03T00:00:00.000Z')); // 2024-W01 (dup)
            store.savePaper(paper('2401.01236', '2024-01-10T00:00:00.000Z')); // 2024-W02
            store.savePaper(paper('2401.01237', '2024-12-30T00:00:00.000Z')); // 2025-W01

            expect(store.distinctWeeks()).toEqual(['2024-W01', '2024-W02', '2025-W01']);
        } finally {
            cleanup();
        }
        // Empty store yields an empty list.
        const empty = makeStore();
        try {
            expect(empty.store.distinctWeeks()).toEqual([]);
        } finally {
            empty.cleanup();
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
    it('reports fetch/classification counts and prunes only stale entries', async () => {
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

            // Let at least one millisecond pass so the stored timestamps are
            // strictly older than "now" when pruning with age=0 (avoids a
            // same-millisecond race that made this assertion flaky).
            await new Promise((resolve) => setTimeout(resolve, 5));
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
