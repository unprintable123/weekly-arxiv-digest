import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Static-site data layer. The web viewer reads flat JSON files that mirror
 * the Markdown outputs: one document per week+category, plus two small
 * manifest levels derived by scanning the output tree. Everything in this
 * module is pure file derivation — no network, no LLM, no database.
 */

/** One paper as serialized for the web viewer (no internal bookkeeping fields). */
export type WebPaper = {
    arxivId: string;
    title: string;
    authors: string[];
    abstractEn: string;
    publishedAt: string;
    categories: string[];
    classification: {
        categories: string[];
        tags: string[];
        /** Absent in legacy documents generated before the tldr feature. */
        tldr?: string;
    };
};

/** Per week+category JSON document: the web equivalent of a Markdown digest. */
export type WebDigestDocument = {
    version: 1;
    week: string;
    from: string;
    to: string;
    categoryId: string;
    categoryName: string;
    /** Optional taxonomy group metadata (absent in legacy documents). */
    groupId?: string;
    groupName?: string;
    generatedAt: string;
    configHash: string;
    candidateCount: number;
    papers: WebPaper[];
};

/** `digests-json/<week>/index.json` — drives the group/category picker. */
export type WeekIndex = {
    version: 1;
    week: string;
    from: string;
    to: string;
    /** Category entries sorted by id. */
    categories: Array<{
        id: string;
        name: string;
        count: number;
        /** Optional taxonomy group; omitted for legacy data without groups. */
        groupId?: string;
        groupName?: string;
    }>;
};

/** `digests/index.json` — drives the week picker, newest first. */
export type SiteIndex = {
    version: 1;
    updatedAt: string;
    weeks: Array<{ week: string; from: string; to: string }>;
};

// Generated files are the reader-facing output contract; generation does not
// re-validate them. This schema exists for the manifest rebuild path, and a
// parse failure is treated as a missing file.
const webPaperSchema = z.object({
    arxivId: z.string().min(1),
    title: z.string(),
    authors: z.array(z.string()),
    abstractEn: z.string(),
    publishedAt: z.string(),
    categories: z.array(z.string()),
    classification: z.object({
        categories: z.array(z.string()),
        tags: z.array(z.string()),
        // Optional so legacy documents (generated before tldr) still parse.
        tldr: z.string().optional(),
    }),
});

const webDocumentSchema = z
    .object({
        version: z.literal(1),
        week: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        categoryId: z.string().min(1),
        categoryName: z.string().min(1),
        groupId: z.string().min(1).optional(),
        groupName: z.string().min(1).optional(),
        generatedAt: z.string(),
        configHash: z.string(),
        candidateCount: z.number().int().nonnegative(),
        papers: z.array(webPaperSchema),
    });

const weekIndexSchema = z
    .object({
        version: z.literal(1),
        week: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        categories: z.array(
            z.object({
                id: z.string().min(1),
                name: z.string(),
                count: z.number().int(),
                groupId: z.string().min(1).optional(),
                groupName: z.string().min(1).optional(),
            }),
        ),
    });

const WEEK_INDEX = 'index.json';
const WEEK_PATTERN = /^\d{4}-W\d{2}$/;
const DOCUMENT_PATTERN = /^weekly-(\d{4}-W\d{2})-([a-z0-9-]+)\.json$/;

/** Deterministic JSON with sorted keys: repeat builds are byte-identical. */
export function stableJson(value: unknown): string {
    let out: string;
    if (value === null || typeof value !== 'object') {
        out = JSON.stringify(value);
    } else if (Array.isArray(value)) {
        out = `[${value.map(stableJson).join(',')}]`;
    } else {
        const record = value as Record<string, unknown>;
        out = `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
            .join(',')}}`;
    }
    return out;
}

/** Project a DigestDocument to the trimmed web shape (drops contentHash etc.). */
export function toWebDocument(document: {
    week: string;
    from: string;
    to: string;
    categoryId: string;
    categoryName: string;
    groupId?: string;
    groupName?: string;
    generatedAt: string;
    configHash: string;
    candidateCount: number;
    papers: Array<{
        arxivId: string;
        title: string;
        authors: string[];
        categories: string[];
        abstractEn: string;
        publishedAt: string;
        classification: { categories: string[]; tags: string[]; tldr: string };
    }>;
}): WebDigestDocument {
    return {
        version: 1,
        week: document.week,
        from: document.from,
        to: document.to,
        categoryId: document.categoryId,
        categoryName: document.categoryName,
        ...(document.groupId ? { groupId: document.groupId } : {}),
        ...(document.groupName ? { groupName: document.groupName } : {}),
        generatedAt: document.generatedAt,
        configHash: document.configHash,
        candidateCount: document.candidateCount,
        papers: document.papers.map((paper) => ({
            arxivId: paper.arxivId,
            title: paper.title,
            authors: paper.authors,
            abstractEn: paper.abstractEn,
            publishedAt: paper.publishedAt,
            categories: paper.categories,
            classification: {
                categories: paper.classification.categories,
                tags: paper.classification.tags,
                tldr: paper.classification.tldr,
            },
        })),
    };
}

/**
 * Atomic JSON write: temp file + rename so site readers (and git) never see a
 * partial file. Stable key ordering keeps repeat builds byte-identical.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
    const payload = `${stableJson(value)}\n`;
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, payload, 'utf8');
    renameSync(temporary, file);
}

/** Parse one serialized web document; returns undefined when invalid. */
export function parseWebDocument(text: string): WebDigestDocument | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    const parsed = webDocumentSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/**
 * Read every valid per-category JSON document of one week directory. Files
 * that fail validation are ignored so a broken write cannot break the site.
 */
export function readWeekDocuments(weekDir: string): WebDigestDocument[] {
    const documents: WebDigestDocument[] = [];
    let entries: string[];
    try {
        entries = readdirSync(weekDir);
    } catch {
        return documents;
    }
    for (const entry of entries.sort()) {
        if (!DOCUMENT_PATTERN.test(entry) || entry === WEEK_INDEX) continue;
        try {
            const document = parseWebDocument(readFileSync(join(weekDir, entry), 'utf8'));
            if (document) documents.push(document);
        } catch {
            // Malformed JSON is skipped; the manifest simply omits it.
        }
    }
    return documents;
}

/**
 * Rebuild `digests/<week>/index.json` from the per-category documents found on
 * disk. The window dates repeat on every document; the first valid one wins.
 */
export function rebuildWeekIndex(weekDir: string, week: string): WeekIndex {
    const documents = readWeekDocuments(weekDir);
    const first = documents[0];
    const categories = documents.map((document) => ({
        id: document.categoryId,
        name: document.categoryName,
        count: document.papers.length,
        ...(document.groupId ? { groupId: document.groupId } : {}),
        ...(document.groupName ? { groupName: document.groupName } : {}),
    }));
    categories.sort((a, b) => a.id.localeCompare(b.id));
    return {
        version: 1,
        week,
        from: first?.from ?? '',
        to: first?.to ?? '',
        categories,
    };
}

/** Write the week index (no-op when the week directory does not exist). */
export function writeWeekIndex(weekDir: string, week: string): WeekIndex | undefined {
    if (!readdirSafe(weekDir).ok) return undefined;
    const index = rebuildWeekIndex(weekDir, week);
    writeJsonAtomic(join(weekDir, WEEK_INDEX), index);
    return index;
}

/**
 * Rebuild the global `digests/index.json`: one entry per `YYYY-Www` directory
 * that contains a valid week index, newest week first.
 */
export function rebuildSiteIndex(digestsDir: string, updatedAt: string): SiteIndex {
    const weeks: SiteIndex['weeks'] = [];
    for (const entry of readdirSafe(digestsDir).entries.sort()) {
        if (!WEEK_PATTERN.test(entry)) continue;
        const indexPath = join(digestsDir, entry, WEEK_INDEX);
        try {
            const parsed = weekIndexSchema.safeParse(JSON.parse(readFileSync(indexPath, 'utf8')));
            if (!parsed.success) continue;
            weeks.push({ week: parsed.data.week, from: parsed.data.from, to: parsed.data.to });
        } catch {
            // Missing or unreadable week index: skip that week.
        }
    }
    weeks.sort((a, b) => b.week.localeCompare(a.week)); // newest first
    return { version: 1, updatedAt, weeks };
}

/** Rebuild and write the global index after one or more weeks changed. */
export function writeSiteIndex(digestsDir: string, updatedAt: string): SiteIndex {
    const index = rebuildSiteIndex(digestsDir, updatedAt);
    writeJsonAtomic(join(digestsDir, WEEK_INDEX), index);
    return index;
}

/** Refresh both manifest levels for one week in one call. */
export function refreshManifests(digestsDir: string, week: string, updatedAt: string): {
    weekIndex: WeekIndex;
    siteIndex: SiteIndex;
} {
    writeWeekIndex(join(digestsDir, week), week);
    return {
        weekIndex: rebuildWeekIndex(join(digestsDir, week), week),
        siteIndex: writeSiteIndex(digestsDir, updatedAt),
    };
}

function readdirSafe(dir: string): { ok: boolean; entries: string[] } {
    try {
        return { ok: true, entries: readdirSync(dir) };
    } catch {
        return { ok: false, entries: [] };
    }
}
