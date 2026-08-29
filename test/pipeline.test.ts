import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/log.js';
import { previewDigest, runDigest, type RunResult } from '../src/pipeline.js';
import { weekWindow } from '../src/window.js';
import { fixture, fixtureTopicsPath, routeContains, stubFetch } from './helpers.js';

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

function loadRootConfig(root: string) {
    const file = join(root, 'config.yaml');
    writeFileSync(file, configYaml);
    copyFileSync(fixtureTopicsPath, join(root, 'TOPICS.yaml'));
    return loadConfig(file);
}

/** Classify the attention paper into two categories and the MoE paper into one. */
function setupInvoker(overrides: { attention?: string[]; moe?: string[] } = {}) {
    return {
        complete: vi.fn(async (prompt: string) => {
            const entries: { id: string; categories: string[]; tags: string[]; tldr: string }[] = [];
            if (prompt.includes('Attention Is All You Need')) {
                entries.push({
                    id: '2401.01234',
                    categories: overrides.attention ?? ['test-architecture', 'test-training'],
                    tags: ['attention', 'transformer'],
                    tldr: '提出可扩展的注意力机制。',
                });
            }
            if (prompt.includes('Mixture of Experts')) {
                entries.push({
                    id: '2401.01235',
                    categories: overrides.moe ?? ['test-architecture'],
                    tags: ['mixture-of-experts'],
                    tldr: '研究混合专家模型的可扩展性。',
                });
            }
            if (!entries.length) {
                entries.push({ id: 'unknown-paper', categories: ['other'], tags: [], tldr: '未知论文。' });
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
            // test-architecture gets both papers; test-training only the primary one.
            expect(result.documents.map((document) => document.categoryId)).toEqual([
                'test-architecture',
                'test-training',
            ]);
            // Markdown files + JSON twins (2 x 2), and the web-output
            // block below asserts the json pair + manifests in detail.
            expect(result.files).toHaveLength(4);
            expect(result.files.every((file) => file.endsWith('.md') || file.endsWith('.json'))).toBe(true);
            expect(result.files.filter((file) => file.endsWith('.md')).map((file) => file.split('\\').pop() ?? file)).toEqual([
                'weekly-2024-W01-test-architecture.md',
                'weekly-2024-W01-test-training.md',
            ]);
            // Two-level layout: each week's files live in a "YYYY-Www" subfolder —
            // markdown under output.directory, json under output.json_directory.
            expect(result.files.filter((file) => file.endsWith('.md')).every((file) => file.includes(join('digests', '2024-W01')))).toBe(true);
            expect(result.files.filter((file) => file.endsWith('.json')).every((file) => file.includes(join('digests-json', '2024-W01')))).toBe(true);
            expect(result.files.every((file) => existsSync(file))).toBe(true);

            const architecture = contentFor(result, 'test-architecture');
            expect(architecture).toContain('## Attention Is All You Need: A Study of Scalable Attention');
            expect(architecture).toContain('## Mixture of Experts Revisited');
            // Chinese topic names are a taxonomy concern; the digest only asserts ids.
            expect(architecture).toContain('- **Category:** test-architecture'.replace('test-architecture', 'Architecture'));
            expect(architecture).toContain('- **Tag:** `attention`, `transformer`');
            expect(architecture).toContain('- **TLDR:** 提出可扩展的注意力机制。');
            expect(architecture).toContain('- **TLDR:** 研究混合专家模型的可扩展性。');
            expect(architecture).toContain('- **Authors:** Alice Example, Bob Sample');
            expect(architecture).toContain('[2401.01234](https://arxiv.org/abs/2401.01234)');
            expect(architecture).toContain('- **papers.cool:** [2401.01234](https://papers.cool/arxiv/2401.01234)');
            expect(architecture).not.toContain('Source:');
            expect(architecture).not.toContain('Score');

            const training = contentFor(result, 'test-training');
            expect(training).toContain('## Attention Is All You Need: A Study of Scalable Attention');
            expect(training).not.toContain('Mixture of Experts');

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
            const invoker = setupInvoker({ attention: ['test-architecture'], moe: ['test-architecture'] });
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

    it('keeps cached classifications when only the taxonomy hash changes', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            const first = await runDigest(cfg, window(), { root, invoker });
            const callsAfterFirst = invoker.complete.mock.calls.length;
            expect(callsAfterFirst).toBeGreaterThan(0);

            // A TOPICS.yaml edit (here: hash only) must NOT invalidate the
            // classification cache; only an explicit cache clear re-classifies.
            cfg.topics = { ...cfg.topics, hash: `${cfg.topics.hash}-changed` };
            const second = await runDigest(cfg, window(), { root, invoker });
            expect(invoker.complete.mock.calls.length).toBe(callsAfterFirst);
            expect(second.errors).toBe(0);
            expect(second.documents.map((document) => document.categoryId)).toEqual(
                first.documents.map((document) => document.categoryId),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('reuses cache rows written under an older key format by content-hash fallback', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();

            await runDigest(cfg, window(), { root, invoker });
            const callsAfterFirst = invoker.complete.mock.calls.length;
            expect(callsAfterFirst).toBeGreaterThan(0);

            // Simulate cache rows written under an older key derivation (e.g.
            // taxonomy-bearing keys from before this format): rewrite every
            // classification row's key with a sentinel suffix so the exact-key
            // lookup misses and the content-hash fallback must recover them.
            const { Store } = await import('../src/db.js');
            const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
            try {
                const keys = (store.db
                    .prepare('SELECT cache_key FROM classification_cache')
                    .all() as any[]).map((row) => row.cache_key);
                expect(keys.length).toBeGreaterThan(0);
                for (const key of keys) {
                    store.db
                        .prepare('UPDATE classification_cache SET cache_key=? WHERE cache_key=?')
                        .run(`${key}-legacy`, key);
                }
            } finally {
                store.close();
            }

            const second = await runDigest(cfg, window(), { root, invoker });
            expect(invoker.complete.mock.calls.length).toBe(callsAfterFirst);
            expect(second.errors).toBe(0);
            expect(second.documents).toHaveLength(2);
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
                    const entries: { id: string; categories: string[]; tags: string[]; tldr: string }[] = [];
                    if (wantsAttention) {
                        entries.push({ id: '2401.01234', categories: ['test-architecture'], tags: ['attention'], tldr: '提出可扩展的注意力机制。' });
                    }
                    if (wantsMoe) {
                        entries.push({ id: '2401.01235', categories: ['test-architecture'], tags: [], tldr: '研究混合专家模型的可扩展性。' });
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
                        return '{"categories": ["test-architecture"], "tags": []}';
                    }
                    if (prompt.includes('Mixture of Experts')) {
                        return JSON.stringify([{ id: '2401.01235', categories: ['test-architecture'], tags: [], tldr: '研究混合专家模型的可扩展性。' }]);
                    }
                    return JSON.stringify([{ id: '2401.01234', categories: ['test-architecture'], tags: ['attention'], tldr: '提出可扩展的注意力机制。' }]);
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

    it('falls back to "other" with an empty tldr when a single paper hits a provider content-safety refusal', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    const wantsAttention = prompt.includes('Attention Is All You Need');
                    const wantsMoe = prompt.includes('Mixture of Experts');
                    // The batch prompt (both papers) and the MoE single-paper
                    // call keep returning the provider content-safety refusal.
                    if (wantsAttention && !wantsMoe) {
                        return JSON.stringify([{ id: '2401.01234', categories: ['test-architecture'], tags: ['attention'], tldr: '提出可扩展的注意力机制。' }]);
                    }
                    throw new Error(
                        'Chat completion failed: HTTP 400: {"error":{"message":"OpenAIException - 系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语。","type":null,"param":null,"code":"400"}}',
                    );
                }),
            };
            stubCrawl();

            const result = await runDigest(cfg, window(), { root, invoker });
            // The content-safety refusal is a graceful fallback, not an error.
            expect(result.errors).toBe(0);
            expect(result.status).toBe('ok');
            // Attention is classified normally; MoE lands under "other" with an
            // empty tldr instead of being dropped from the digest. Documents are
            // ordered by category id, so "other" sorts before "test-architecture".
            expect(result.documents.map((document) => document.categoryId)).toEqual([
                'other',
                'test-architecture',
            ]);
            const moe = result.documents.find((document) => document.categoryId === 'other')!;
            expect(moe.papers.map((paper) => paper.arxivId)).toEqual(['2401.01235']);
            expect(moe.papers[0].classification).toEqual({ categories: ['other'], tags: [], tldr: '' });

            // Markdown: the fallback paper renders without a TLDR line.
            const otherMd = contentFor(result, 'other');
            expect(otherMd).toContain('2401.01235');
            expect(otherMd).not.toContain('- **TLDR:**');
            const architectureMd = contentFor(result, 'test-architecture');
            expect(architectureMd).toContain('- **TLDR:** 提出可扩展的注意力机制。');

            // The fallback is not cached (empty tldr stays a cache miss), so a
            // later run retries the paper and can still recover.
            const { Store } = await import('../src/db.js');
            const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
            try {
                expect(store.stats().classifications).toBe(1);
            } finally {
                store.close();
            }
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
                    const entries: { id: string; categories: string[]; tags: string[]; tldr: string }[] = [];
                    if (prompt.includes('Attention Is All You Need')) {
                        entries.push({ id: '2401.01234', categories: ['test-architecture'], tags: ['attention'], tldr: '提出可扩展的注意力机制。' });
                    }
                    if (prompt.includes('Mixture of Experts')) {
                        entries.push({ id: '2401.01235', categories: ['test-architecture'], tags: [], tldr: '研究混合专家模型的可扩展性。' });
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
            // Preview reuses the run's stored generation stamp, so the rendered
            // markdown is byte-identical to the run output (no clock restamp).
            expect(all.markdown).toBe(
                contentFor(first, 'test-architecture') + contentFor(first, 'test-training'),
            );

            const one = previewDigest(root, cfg, '2024-W01', 'test-architecture');
            expect(one.documents).toHaveLength(1);
            expect(one.documents[0].categoryId).toBe('test-architecture');
            expect(one.markdown).toBe(contentFor(first, 'test-architecture'));

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
            const jsonDir = join(root, 'digests-json', '2024-W01');
            const jsonFiles = result.files.filter((file) => file.endsWith('.json'));
            expect(jsonFiles).toHaveLength(2);
            for (const file of jsonFiles) {
                expect(file.startsWith(jsonDir)).toBe(true);
                expect(existsSync(file)).toBe(true);
            }
            // Markdown lives in its own directory, JSON in the json_directory.
            expect(result.files.filter((file) => file.endsWith('.md')).every((file) => file.startsWith(join(root, 'digests', '2024-W01')))).toBe(true);
            expect(existsSync(join(jsonDir, 'index.json'))).toBe(true);
            expect(existsSync(join(root, 'digests-json', 'index.json'))).toBe(true);

            // Data twin carries the same paper content as the Markdown file.
            const json = JSON.parse(readFileSync(join(jsonDir, 'weekly-2024-W01-test-architecture.json'), 'utf8')) as {
                categoryId: string;
                papers: Array<{ arxivId: string; classification: { tags: string[]; tldr: string } }>;
            };
            expect(json.categoryId).toBe('test-architecture');
            expect(json.papers.map((paper) => paper.arxivId).sort()).toEqual(['2401.01234', '2401.01235']);
            expect(json.papers.some((paper) => paper.classification.tags.includes('attention'))).toBe(true);
            expect(json.papers.some((paper) => paper.classification.tldr.includes('注意力'))).toBe(true);

            // Week manifest: sorted ids with counts + taxonomy group metadata;
            // global index lists the week.
            const weekIndex = JSON.parse(readFileSync(join(jsonDir, 'index.json'), 'utf8')) as {
                categories: Array<{ id: string; name: string; count: number; groupId?: string; groupName?: string }>;
            };
            expect(weekIndex.categories).toEqual([
                { id: 'test-architecture', name: 'Architecture', count: 2, groupId: 'core', groupName: 'Core Models' },
                { id: 'test-training', name: 'Training', count: 1, groupId: 'core', groupName: 'Core Models' },
            ]);
            const siteIndex = JSON.parse(readFileSync(join(root, 'digests-json', 'index.json'), 'utf8')) as {
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
            expect(existsSync(join(root, 'digests-json'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shards a multi-week window into one digest per ISO week', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            // The fixture also carries 2401.01236 ("Out-of-Window Paper") on
            // 2024-01-09, which is inside the wider window and lands in W02.
            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    const entries: { id: string; categories: string[]; tags: string[]; tldr: string }[] = [];
                    if (prompt.includes('Attention Is All You Need')) {
                        entries.push({ id: '2401.01234', categories: ['test-architecture', 'test-training'], tags: ['attention'], tldr: '提出可扩展的注意力机制。' });
                    }
                    if (prompt.includes('Mixture of Experts')) {
                        entries.push({ id: '2401.01235', categories: ['test-architecture'], tags: ['mixture-of-experts'], tldr: '研究混合专家模型的可扩展性。' });
                    }
                    if (prompt.includes('Out-of-Window Paper')) {
                        entries.push({ id: '2401.01236', categories: ['test-architecture'], tags: ['out-of-window'], tldr: '第二周的一篇论文。' });
                    }
                    if (!entries.length) {
                        entries.push({ id: 'unknown-paper', categories: ['other'], tags: [], tldr: '未知论文。' });
                    }
                    return JSON.stringify(entries);
                }),
            };
            stubCrawl();

            // W01 + W02 window: two papers land in 2024-W01, one in 2024-W02.
            const result = await runDigest(cfg, weekWindow('2024-01-01', '2024-01-16'), { root, invoker });
            expect(result.errors).toBe(0);
            expect(result.status).toBe('ok');

            // Files are sharded into per-week subfolders.
            const mdFiles = result.files
                .filter((file) => file.endsWith('.md'))
                .map((file) => file.split('\\').pop() ?? file)
                .sort();
            expect(mdFiles).toEqual([
                'weekly-2024-W01-test-architecture.md',
                'weekly-2024-W01-test-training.md',
                'weekly-2024-W02-test-architecture.md',
            ]);

            // W02 digest contains only the second-week paper.
            const w02 = result.files.find(
                (file) => file.endsWith('.md') && file.includes(join('digests', '2024-W02')) && file.endsWith('-test-architecture.md'),
            )!;
            const w02Md = readFileSync(w02, 'utf8');
            // Titles are markdown-escaped (hyphens), so assert on arXiv ids.
            expect(w02Md).toContain('2401.01236');
            expect(w02Md).not.toContain('2401.01234');
            expect(w02Md).not.toContain('2401.01235');

            // W01 digest keeps the two original papers and no W02 paper.
            const w01 = result.files.find(
                (file) => file.endsWith('.md') && file.includes(join('digests', '2024-W01')) && file.endsWith('-test-architecture.md'),
            )!;
            const w01Md = readFileSync(w01, 'utf8');
            expect(w01Md).toContain('2401.01234');
            expect(w01Md).toContain('2401.01235');
            expect(w01Md).not.toContain('2401.01236');

            // Documents carry their own week; no stray week folder is created.
            expect(result.documents.map((document) => document.week).sort()).toEqual(['2024-W01', '2024-W01', '2024-W02']);
            expect(existsSync(join(root, 'digests', '2024-W03'))).toBe(false);
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
            expect(built.categories).toEqual(['test-architecture', 'test-training']);
            expect(built.files).toHaveLength(4); // 2 category json + 2 manifests
            expect(existsSync(join(root, 'digests-json', '2024-W01', 'weekly-2024-W01-test-training.json'))).toBe(true);
            expect(existsSync(join(root, 'digests-json', '2024-W01', 'index.json'))).toBe(true);
            expect(existsSync(join(root, 'digests-json', 'index.json'))).toBe(true);

            // Backfill shares the preview code path: no new agent/network work.
            expect(invoker.complete.mock.calls.length).toBe(agentCalls);

            // The backfilled json matches the run-written json exactly: both
            // reuse the stored generation stamp (no clock restamp).
            await runDigest(cfg, window(), { root, invoker });
            const direct = readFileSync(
                join(root, 'digests-json', '2024-W01', 'weekly-2024-W01-test-architecture.json'),
                'utf8',
            );
            const backfillFile = built.files.find((file) => file.endsWith('test-architecture.json'));
            expect(backfillFile).toBeTruthy();
            expect(readFileSync(backfillFile!, 'utf8')).toBe(direct);

            // Repeat backfill is byte-identical: stable ordering + the same
            // stamp keep every document and both manifests unchanged.
            const before = readFileSync(backfillFile!, 'utf8');
            const beforeWeekIndex = readFileSync(join(root, 'digests-json', '2024-W01', 'index.json'), 'utf8');
            const beforeSiteIndex = readFileSync(join(root, 'digests-json', 'index.json'), 'utf8');
            const { buildWebDigests: rebuild } = await import('../src/pipeline.js');
            await rebuild(root, cfg, '2024-W01');
            expect(readFileSync(backfillFile!, 'utf8')).toBe(before);
            expect(readFileSync(join(root, 'digests-json', '2024-W01', 'index.json'), 'utf8')).toBe(beforeWeekIndex);
            expect(readFileSync(join(root, 'digests-json', 'index.json'), 'utf8')).toBe(beforeSiteIndex);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('buildAllWebDigests backfills every cached week by default', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();
            await runDigest(cfg, window(), { root, invoker, dryRun: true });

            const { buildAllWebDigests } = await import('../src/pipeline.js');
            const all = await buildAllWebDigests(root, cfg);
            expect(all.weeks).toEqual(['2024-W01']);
            expect(all.skipped).toEqual([]);
            expect(all.categories).toEqual(['test-architecture', 'test-training']);
            expect(all.files).toHaveLength(4); // 2 category json + 2 manifests, deduped
            expect(existsSync(join(root, 'digests-json', '2024-W01', 'weekly-2024-W01-test-training.json'))).toBe(true);
            expect(existsSync(join(root, 'digests-json', '2024-W01', 'index.json'))).toBe(true);
            expect(existsSync(join(root, 'digests-json', 'index.json'))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('buildAllWebDigests skips weeks without cached classifications', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadRootConfig(root);
            const invoker = setupInvoker();
            stubCrawl();
            await runDigest(cfg, window(), { root, invoker, dryRun: true });

            const { Store } = await import('../src/db.js');
            const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
            store.clearClassifications();
            store.flush();
            store.close();

            const { buildAllWebDigests } = await import('../src/pipeline.js');
            const all = await buildAllWebDigests(root, cfg);
            expect(all.weeks).toEqual([]);
            expect(all.skipped).toEqual(['2024-W01']);
            expect(all.files).toHaveLength(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
