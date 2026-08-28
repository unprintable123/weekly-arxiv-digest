import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    parseWebDocument,
    rebuildSiteIndex,
    rebuildWeekIndex,
    readWeekDocuments,
    stableJson,
    toWebDocument,
    writeJsonAtomic,
    writeSiteIndex,
    writeWeekIndex,
} from '../src/site.js';

const sampleDocument = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    week: '2024-W01',
    from: '2024-01-01',
    to: '2024-01-08',
    categoryId: 'llm-architecture',
    categoryName: '大模型架构',
    generatedAt: '2024-01-08T00:00:00.000Z',
    configHash: 'abc123',
    candidateCount: 5,
    papers: [
        {
            arxivId: '2401.01234',
            title: 'A Study of Scalable Attention',
            authors: ['Alice Example'],
            abstractEn: 'We study attention.',
            publishedAt: '2024-01-02T00:00:00.000Z',
            categories: ['cs.LG'],
            classification: { categories: ['llm-architecture'], tags: ['attention'] },
        },
    ],
    ...overrides,
});

const docFile = (categoryId: string) => `weekly-2024-W01-${categoryId}.json`;

function makeWeekDir(categoryIds: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'weekly-digest-site-'));
    const weekDir = join(root, 'digests', '2024-W01');
    mkdirSync(weekDir, { recursive: true });
    for (const categoryId of categoryIds) {
        writeFileSync(
            join(weekDir, docFile(categoryId)),
            `${stableJson(sampleDocument({
                categoryId, papers: Array.from({ length: categoryId === 'a-category' ? 2 : 1 }, (_, index) => ({
                    arxivId: `2401.0100${index}`,
                    title: `Paper ${categoryId} ${index}`,
                    authors: [],
                    abstractEn: 'text',
                    publishedAt: '2024-01-02T00:00:00.000Z',
                    categories: [],
                    classification: { categories: [categoryId], tags: [] },
                }))
            }))}\n`,
            'utf8',
        );
    }
    return root;
}

describe('stableJson + atomic write', () => {
    it('produces sorted-key deterministic JSON', () => {
        expect(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    });

    it('writes via a temporary file and leaves no .tmp behind', () => {
        const dir = mkdtempSync(join(tmpdir(), 'weekly-digest-site-'));
        try {
            const file = join(dir, 'index.json');
            writeJsonAtomic(file, { z: 1, a: 2 });
            expect(readFileSync(file, 'utf8')).toBe('{"a":2,"z":1}\n');
            expect(existsSync(`${file}.tmp`)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('toWebDocument / parseWebDocument', () => {
    it('projects the digest document without internal bookkeeping fields', () => {
        const web = toWebDocument(sampleDocument());
        expect(Object.keys(web).sort()).toEqual([
            'candidateCount',
            'categoryId',
            'categoryName',
            'configHash',
            'from',
            'generatedAt',
            'papers',
            'to',
            'version',
            'week',
        ]);
        expect(web.papers[0]).not.toHaveProperty('contentHash');
        expect(web.papers[0]).not.toHaveProperty('detailUrl');
        expect(parseWebDocument(`${stableJson(web)}\n`)).toEqual(web);
    });

    it('rejects malformed documents', () => {
        expect(parseWebDocument('{nope')).toBeUndefined();
        expect(parseWebDocument('{"version":2}')).toBeUndefined();
    });
});

describe('week index derivation', () => {
    afterEach(() => {
        // temp dirs are cleaned per test; nothing global to restore
    });

    it('lists categories sorted by id with counts', () => {
        const root = makeWeekDir(['llm-safety', 'a-category', 'llm-architecture']);
        const weekDir = join(root, 'digests', '2024-W01');
        try {
            const index = rebuildWeekIndex(weekDir, '2024-W01');
            expect(index.categories.map((category) => category.id)).toEqual([
                'a-category',
                'llm-architecture',
                'llm-safety',
            ]);
            expect(index.categories[0].count).toBe(2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('ignores malformed documents and manifest files', () => {
        const root = makeWeekDir(['llm-architecture']);
        const weekDir = join(root, 'digests', '2024-W01');
        try {
            writeFileSync(join(weekDir, 'weekly-2024-W01-broken.json'), '{nope', 'utf8');
            writeFileSync(join(weekDir, 'index.json'), 'placeholder', 'utf8');
            const documents = readWeekDocuments(weekDir);
            expect(documents).toHaveLength(1);
            expect(documents[0].categoryId).toBe('llm-architecture');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('writeWeekIndex writes the manifest and skips missing directories', () => {
        const root = makeWeekDir(['llm-architecture']);
        const weekDir = join(root, 'digests', '2024-W01');
        try {
            const index = writeWeekIndex(weekDir, '2024-W01');
            expect(index?.categories).toHaveLength(1);
            expect(readFileSync(join(weekDir, 'index.json'), 'utf8')).toContain('llm-architecture');
            expect(writeWeekIndex(join(root, 'digests', '1999-W01'), '1999-W01')).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('global site index derivation', () => {
    it('collects weeks newest first and skips weeks without a valid index', () => {
        const root = mkdtempSync(join(tmpdir(), 'weekly-digest-site-'));
        const digestsDir = join(root, 'digests');
        try {
            mkdirSync(join(digestsDir, '2024-W02'), { recursive: true });
            writeJsonAtomic(join(digestsDir, '2024-W02', 'index.json'), {
                version: 1,
                week: '2024-W02',
                from: '2024-01-08',
                to: '2024-01-15',
                categories: [],
            });
            makeWeekDirIn(digestsDir, '2024-W01');
            mkdirSync(join(digestsDir, 'not-a-week'), { recursive: true });
            mkdirSync(join(digestsDir, '2023-W10'), { recursive: true }); // no index.json

            const index = rebuildSiteIndex(digestsDir, '2024-01-16T00:00:00.000Z');
            expect(index.updatedAt).toBe('2024-01-16T00:00:00.000Z');
            expect(index.weeks.map((week) => week.week)).toEqual(['2024-W02', '2024-W01']);
            expect(writeSiteIndex(digestsDir, '2024-01-17T00:00:00.000Z').updatedAt).toBe(
                '2024-01-17T00:00:00.000Z',
            );
            expect(existsSync(join(digestsDir, 'index.json'))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/** Helper mirroring makeWeekDir but with an explicit week directory name. */
function makeWeekDirIn(digestsDir: string, week: string): void {
    const weekDir = join(digestsDir, week);
    mkdirSync(weekDir, { recursive: true });
    writeJsonAtomic(join(weekDir, 'index.json'), {
        version: 1,
        week,
        from: '2024-01-01',
        to: '2024-01-08',
        categories: [{ id: 'llm-architecture', name: '大模型架构', count: 1 }],
    });
}
