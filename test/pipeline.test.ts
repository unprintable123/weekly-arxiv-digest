import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Logger } from '../src/log.js';
import { previewDigest, runDigest, type RunResult } from '../src/pipeline.js';
import { weekWindow } from '../src/window.js';
import { fixture, repoTopicsPath, routeContains, stubFetch } from './helpers.js';

const configYaml = `
categories: ["cs.LG"]
source:
  provider: papers.cool
  base_url: https://papers.cool
  arxiv_base_url: https://export.arxiv.org
  request_delay_ms: 0
  timeout_ms: 5000
  user_agent: weekly-digest-test/0.1
output:
  directory: digests
  subdirectory: "{week}"
  filename: weekly-{week}-{category}.md
llm:
  model: test-model
  timeout_ms: 5000
  max_retries: 0
`;

/** List fixture publishes attention 2024-01-01 and MoE 2024-01-02, so publishedAt ordering is observable. */

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), 'weekly-digest-pipeline-'));
}

async function loadRootConfig(root: string): Promise<Config> {
    const file = join(root, 'config.yaml');
    writeFileSync(file, configYaml);
    copyFileSync(repoTopicsPath, join(root, 'TOPICS.yaml'));
    return loadConfig(file);
}

/** Classify the attention paper into two categories and the MoE paper into one. */
function setupInvoker(overrides: { attention?: string[]; moe?: string[] } = {}) {
    return {
        complete: vi.fn(async (prompt: string) => {
            const entries: { id: string; categories: string[]; tags: string[] }[] = [];
            if (prompt.includes('Attention Is All You Need')) {
                entries.push({
                    id: '2401.01234',
                    categories: overrides.attention ?? ['llm-architecture', 'physics-of-llm'],
                    tags: ['attention', 'linear-attention'],
                });
            }
            if (prompt.includes('Mixture of Experts')) {
                entries.push({
                    id: '2401.01235',
                    categories: overrides.moe ?? ['llm-architecture'],
                    tags: ['mixture-of-experts'],
                });
            }
            if (!entries.length) {
                entries.push({ id: 'unknown-paper', categories: ['other'], tags: [] });
            }
            return JSON.stringify(entries);
        }),
    };
}

const window = () => weekWindow('2024-01-01', '2024-01-08');

function stubCrawl(): ReturnType<typeof stubFetch> {
    // List items carry all metadata; no per-paper detail requests are made.
    return stubFetch([routeContains('/arxiv/cs.LG', fixture('papers-cool-list.html'))]);
}

function fileContents(result: RunResult): string[] {
    return result.files.map((file) => readFileSync(file, 'utf8'));
}

function contentFor(result: RunResult, categoryId: string): string {
    const file = result.files.find((entry) => entry.endsWith(`-${categoryId}.md`));
    return file ? readFileSync(file, 'utf8') : '';
}

describe('runDigest', () => {
    it('writes one file per category and lists a two-category paper in both', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            const result = await runDigest(cfg, window(), { root, invoker });
            expect(result.errors).toBe(0);
            expect(result.status).toBe('ok');
            // llm-architecture gets both papers; physics-of-llm only the primary one.
            expect(result.documents.map((document) => document.categoryId)).toEqual([
                'llm-architecture',
                'physics-of-llm',
            ]);
            // Markdown + JSON twin per category (2脳2), and the web-output
            // block below asserts the json pair + manifests in detail.
            expect(result.files).toHaveLength(4);
            expect(result.files.every((file) => file.endsWith('.md') || file.endsWith('.json'))).toBe(true);
            expect(result.files.filter((file) => file.endsWith('.md')).map((file) => file.split('\\').pop() ?? file)).toEqual([
                'weekly-2024-W01-llm-architecture.md',
                'weekly-2024-W01-physics-of-llm.md',
            ]);
            // Two-level layout: each week's files live in a "YYYY-Www" subfolder.
            expect(result.files.every((file) => file.includes(join('digests', '2024-W01')))).toBe(true);
            expect(result.files.every((file) => existsSync(file))).toBe(true);

            const architecture = contentFor(result, 'llm-architecture');
            expect(architecture).toContain('## Attention Is All You Need: A Study of Scalable Attention');
            expect(architecture).toContain('## Mixture of Experts Revisited');
            expect(architecture).toContain('- **Category:** 大模型架构');
            expect(architecture).toContain('- **Tag:** `attention`, `linear-attention`');
            expect(architecture).toContain('- **Authors:** Alice Example, Bob Sample');
            expect(architecture).toContain('[2401.01234](https://arxiv.org/abs/2401.01234)');
            expect(architecture).toContain('- **papers.cool:** [2401.01234](https://papers.cool/arxiv/2401.01234)');
            expect(architecture).not.toContain('Source:');
            expect(architecture).not.toContain('Score');
            expect(architecture).not.toContain('中文');

            const physics = contentFor(result, 'physics-of-llm');
            expect(physics).toContain('# Weekly arXiv Digest: 2024-W01 — 大模型训练物理与涌现规律');
            expect(physics).toContain('## Attention Is All You Need: A Study of Scalable Attention');
            expect(physics).not.toContain('Mixture of Experts');

            // Papers and classifications are cached for repeat runs and preview.
            const { Store } = await import('../src/db.js');
            const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
            try {
                expect(store.stats().papers).toBe(2);
                expect(store.stats().classifications).toBe(2);
                expect(store.stats().fetches).toBeGreaterThan(0);
            } finally {
                store.close();
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('sorts each category by publishedAt desc then arxivId asc', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker({ attention: ['llm-architecture'], moe: ['llm-architecture'] });
            stubCrawl();

            const result = await runDigest(cfg, window(), { root, invoker });
            expect(result.documents).toHaveLength(1);
            // MoE was published 2024-01-02, attention 2024-01-01.
            expect(result.documents[0].papers.map((paper) => paper.arxivId)).toEqual([
                '2401.01235',
                '2401.01234',
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('produces byte-identical markdown on a fully cached repeat run with no new network/agent calls', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            const { calls } = stubCrawl();

            const first = await runDigest(cfg, window(), { root, invoker });
            expect(first.status).toBe('ok');
            const firstContent = fileContents(first);
            expect(firstContent.every((content) => content.length > 0)).toBe(true);

            const networkCalls = calls.length;
            const agentCalls = invoker.complete.mock.calls.length;
            expect(agentCalls).toBeGreaterThan(0);

            const second = await runDigest(cfg, window(), { root, invoker });
            expect(second.errors).toBe(0);
            // No additional network or agent calls on the repeat run.
            expect(calls.length).toBe(networkCalls);
            expect(invoker.complete.mock.calls.length).toBe(agentCalls);
            // Byte-identical files, including the generatedAt header.
            expect(fileContents(second)).toEqual(firstContent);
            expect(second.documents.map((document) => document.generatedAt)).toEqual(
                first.documents.map((document) => document.generatedAt),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('invalidates classification cache when the taxonomy hash changes', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            await runDigest(cfg, window(), { root, invoker });
            const callsAfterFirst = invoker.complete.mock.calls.length;

            // Any taxonomy change (here: hash only, as produced by a TOPICS.yaml
            // edit) must produce fresh classification cache keys.
            cfg.topics = { ...cfg.topics, hash: `${cfg.topics.hash}-changed` };
            await runDigest(cfg, window(), { root, invoker });
            expect(invoker.complete.mock.calls.length).toBe(callsAfterFirst * 2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('skips writing files in dry-run mode without touching digests', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            const result = await runDigest(cfg, window(), { root, invoker, dryRun: true });
            expect(result.files).toEqual([]);
            expect(existsSync(join(root, 'digests'))).toBe(false);
            expect(result.documents).toHaveLength(2);
            expect(result.documents[0].papers).toHaveLength(2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('throws when the source is unavailable instead of writing an empty digest', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = { complete: vi.fn(async () => '{}') };
            stubFetch([routeContains('/arxiv/cs.LG', '', 500)]);

            await expect(runDigest(cfg, window(), { root, invoker })).rejects.toThrow(/Source unavailable/);
            expect(existsSync(join(root, 'digests'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('logs classify_start before each LLM call without leaking prompts', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();
            let output = '';
            const logger = new Logger({
                debug: true,
                stream: { write: (chunk: string) => { output += chunk; return true; } } as NodeJS.WritableStream,
            });

            await runDigest(cfg, window(), { root, invoker, logger });

            const events = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
            const starts = events.filter((entry) => entry.event === 'classify_start');
            // One classify_start per agent call, emitted before the call.
            expect(starts).toHaveLength(invoker.complete.mock.calls.length);
            expect(starts.length).toBeGreaterThan(0);
            for (const start of starts) {
                expect(start.batch_size).toBeGreaterThan(0);
                expect(start.attempt).toBe(1);
                expect(start.model).toBe('test-model');
            }
            // Prompts and abstracts never appear in the log.
            expect(output).not.toContain('Attention Is All You Need');
            expect(output).not.toContain('Controlled topic catalog');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps successful papers when classification fails, and classify-retry repairs the run', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            let failMoe = true;
            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    const wantsAttention = prompt.includes('Attention Is All You Need');
                    const wantsMoe = prompt.includes('Mixture of Experts');
                    if (wantsMoe && failMoe) {
                        failMoe = false;
                        throw new Error('classify boom');
                    }
                    const entries: { id: string; categories: string[]; tags: string[] }[] = [];
                    if (wantsAttention) {
                        entries.push({ id: '2401.01234', categories: ['llm-architecture'], tags: ['attention'] });
                    }
                    if (wantsMoe) {
                        entries.push({ id: '2401.01235', categories: ['llm-architecture'], tags: [] });
                    }
                    return JSON.stringify(entries);
                }),
            };
            stubCrawl();

            const first = await runDigest(cfg, window(), { root, invoker });
            // Both papers share one batch; the batch failure falls back to
            // per-paper classification, so both papers still succeed and the
            // run reports no error.
            expect(first.errors).toBe(0);
            expect(first.status).toBe('ok');
            expect(first.documents[0].papers.map((paper) => paper.arxivId)).toEqual([
                '2401.01235',
                '2401.01234',
            ]);

            // A forced rerun re-classifies both papers; the batch call now
            // succeeds, so no per-paper fallback is needed.
            const callsBefore = invoker.complete.mock.calls.length;
            const rerun = await runDigest(cfg, window(), { root, invoker, force: true });
            expect(rerun.errors).toBe(0);
            expect(rerun.status).toBe('ok');
            expect(rerun.documents[0].papers.map((paper) => paper.arxivId)).toEqual([
                '2401.01235',
                '2401.01234',
            ]);
            expect(invoker.complete.mock.calls.length).toBe(callsBefore + 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('falls back to per-paper classification when a batch response is malformed', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            let failBatch = true;
            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    if (failBatch) {
                        failBatch = false;
                        // Valid JSON but wrong shape: not a per-paper array.
                        return '{"categories": ["llm-architecture"], "tags": []}';
                    }
                    if (prompt.includes('Mixture of Experts')) {
                        return JSON.stringify([{ id: '2401.01235', categories: ['llm-architecture'], tags: [] }]);
                    }
                    return JSON.stringify([{ id: '2401.01234', categories: ['llm-architecture'], tags: ['attention'] }]);
                }),
            };
            stubCrawl();

            const result = await runDigest(cfg, window(), { root, invoker });
            expect(result.errors).toBe(0);
            expect(result.status).toBe('ok');
            expect(result.documents[0].papers.map((paper) => paper.arxivId)).toEqual([
                '2401.01235',
                '2401.01234',
            ]);
            // One failed batch call + one per-paper call per paper.
            expect(invoker.complete.mock.calls.length).toBe(3);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('re-classifies failed papers on a re-run instead of recording errors', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            let failMoe = true;
            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    if (prompt.includes('Mixture of Experts') && failMoe) {
                        // Keep failing until the retry run below flips the flag.
                        if (invoker.complete.mock.calls.length >= 2) failMoe = false;
                        throw new Error('moe classify boom');
                    }
                    const entries: { id: string; categories: string[]; tags: string[] }[] = [];
                    if (prompt.includes('Attention Is All You Need')) {
                        entries.push({ id: '2401.01234', categories: ['llm-architecture'], tags: ['attention'] });
                    }
                    if (prompt.includes('Mixture of Experts')) {
                        entries.push({ id: '2401.01235', categories: ['llm-architecture'], tags: [] });
                    }
                    return JSON.stringify(entries);
                }),
            };
            stubCrawl();

            const first = await runDigest(cfg, window(), { root, invoker });
            expect(first.errors).toBe(1);
            expect(first.status).toBe('error');
            // The other paper is still classified and written.
            expect(first.documents[0].papers.map((paper) => paper.arxivId)).toEqual(['2401.01234']);

            // Errors are not stored; re-running the digest naturally retries
            // only the paper without a cached classification (cache miss).
            const rerun = await runDigest(cfg, window(), { root, invoker });
            expect(rerun.errors).toBe(0);
            expect(rerun.status).toBe('ok');
            expect(rerun.documents[0].papers.map((paper) => paper.arxivId)).toEqual([
                '2401.01235',
                '2401.01234',
            ]);
            // Only the failed paper was re-classified.
            expect(invoker.complete.mock.calls.length).toBe(4);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('previewDigest', () => {
    it('rebuilds one or all categories from the caches without new agent work', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();
            const first = await runDigest(cfg, window(), { root, invoker });
            const agentCalls = invoker.complete.mock.calls.length;

            const all = previewDigest(root, cfg, '2024-W01');
            expect(all.documents).toHaveLength(2);
            // Preview output matches the run's rendered files modulo the
            // fresh "Generated" timestamp.
            const stripGenerated = (text: string): string =>
                text.replace(/- Generated: .*/g, '- Generated: X');
            expect(stripGenerated(all.markdown)).toBe(
                stripGenerated(contentFor(first, 'llm-architecture') + contentFor(first, 'physics-of-llm')),
            );

            const one = previewDigest(root, cfg, '2024-W01', 'llm-architecture');
            expect(one.documents).toHaveLength(1);
            expect(one.documents[0].categoryId).toBe('llm-architecture');
            expect(stripGenerated(one.markdown)).toBe(stripGenerated(contentFor(first, 'llm-architecture')));

            // Preview never calls the agent or the network.
            expect(invoker.complete.mock.calls.length).toBe(agentCalls);

            expect(() => previewDigest(root, cfg, '2024-W01', 'missing-category')).toThrow(/No snapshot/);
            expect(() => previewDigest(root, cfg, '1999-W01')).toThrow(/No cached papers/);
            expect(() => previewDigest(root, cfg, 'not-a-week')).toThrow(/Invalid week/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('web output', () => {
    it('writes a .json twin next to every .md plus week and global manifests', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            const result = await runDigest(cfg, window(), { root, invoker });
            const weekDir = join(root, 'digests', '2024-W01');
            const jsonFiles = result.files.filter((file) => file.endsWith('.json'));
            expect(jsonFiles).toHaveLength(2);
            for (const file of jsonFiles) {
                expect(file.startsWith(weekDir)).toBe(true);
                expect(existsSync(file)).toBe(true);
            }
            expect(existsSync(join(weekDir, 'index.json'))).toBe(true);
            expect(existsSync(join(root, 'digests', 'index.json'))).toBe(true);

            // Data twin carries the same paper content as the Markdown file.
            const json = JSON.parse(readFileSync(join(weekDir, 'weekly-2024-W01-llm-architecture.json'), 'utf8')) as {
                categoryId: string;
                papers: Array<{ arxivId: string; classification: { tags: string[] } }>;
            };
            expect(json.categoryId).toBe('llm-architecture');
            expect(json.papers.map((paper) => paper.arxivId).sort()).toEqual(['2401.01234', '2401.01235']);
            expect(json.papers.some((paper) => paper.classification.tags.includes('attention'))).toBe(true);

            // Week manifest: sorted ids with counts; global index lists the week.
            const weekIndex = JSON.parse(readFileSync(join(weekDir, 'index.json'), 'utf8')) as {
                categories: Array<{ id: string; count: number }>;
            };
            expect(weekIndex.categories).toEqual([
                { id: 'llm-architecture', name: '大模型架构', count: 2 },
                { id: 'physics-of-llm', name: '大模型训练物理与涌现规律', count: 1 },
            ]);
            const siteIndex = JSON.parse(readFileSync(join(root, 'digests', 'index.json'), 'utf8')) as {
                weeks: Array<{ week: string }>;
            };
            expect(siteIndex.weeks.map((entry) => entry.week)).toEqual(['2024-W01']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps json twins byte-identical on cached replay (same generatedAt)', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            const first = await runDigest(cfg, window(), { root, invoker });
            const readJson = (files: string[]): string[] =>
                files.filter((file) => file.endsWith('.json')).map((file) => readFileSync(file, 'utf8'));
            const firstJson = readJson(first.files);

            const second = await runDigest(cfg, window(), { root, invoker });
            expect(readJson(second.files)).toEqual(firstJson);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('dry-run writes no json or manifest files', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            await runDigest(cfg, window(), { root, invoker, dryRun: true });
            expect(existsSync(join(root, 'digests'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('buildWebDigests backfills the site data offline from caches', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            const run = await runDigest(cfg, window(), { root, invoker, dryRun: true });
            expect(run.files).toEqual([]);
            // No json files were written by the dry run; backfill produces them.
            const agentCalls = invoker.complete.mock.calls.length;

            const { buildWebDigests } = await import('../src/pipeline.js');
            const built = await buildWebDigests(root, cfg, '2024-W01');
            expect(built.categories).toEqual(['llm-architecture', 'physics-of-llm']);
            expect(built.files).toHaveLength(4); // 2 category json + 2 manifests
            expect(existsSync(join(root, 'digests', '2024-W01', 'weekly-2024-W01-physics-of-llm.json'))).toBe(true);
            expect(existsSync(join(root, 'digests', '2024-W01', 'index.json'))).toBe(true);
            expect(existsSync(join(root, 'digests', 'index.json'))).toBe(true);

            // Backfill shares the preview code path: no new agent/network work.
            expect(invoker.complete.mock.calls.length).toBe(agentCalls);

            // The regenerated json matches the run-written json (modulo the
            // generatedAt stamp) once the run has also written the twins.
            await runDigest(cfg, window(), { root, invoker });
            const direct = readFileSync(
                join(root, 'digests', '2024-W01', 'weekly-2024-W01-llm-architecture.json'),
                'utf8',
            );
            const backfillFile = built.files.find((file) => file.endsWith('llm-architecture.json'));
            expect(backfillFile).toBeTruthy();
            // generatedAt may differ between preview and run; compare content.
            const normalize = (text: string): string => text.replace(/"generatedAt":"[^"]*"/g, '');
            expect(normalize(direct)).toBe(normalize(readFileSync(backfillFile!, 'utf8')));

            // Repeat backfill is byte-identical (stable ordering, same stamp
            // within the same second is not guaranteed, so only the document
            // shape minus generatedAt is compared).
            const before = normalize(readFileSync(backfillFile!, 'utf8'));
            const { buildWebDigests: rebuild } = await import('../src/pipeline.js');
            await rebuild(root, cfg, '2024-W01');
            expect(normalize(readFileSync(backfillFile!, 'utf8'))).toBe(before);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
