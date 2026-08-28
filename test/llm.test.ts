import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildClassificationPrompt,
    ChatCompletionClient,
    classifyPapers,
    CLASSIFICATION_BATCH_SIZE,
    CLASSIFICATION_PROMPT_VERSION,
    LLM_CLIENT_VERSION,
    normalizeBatchClassification,
    normalizeClassification,
    TLDR_MAX_CHARS,
} from '../src/llm.js';
import type { Paper } from '../src/types.js';
import { fixtureTaxonomy } from './helpers.js';

const taxonomy = fixtureTaxonomy();

const paper = (overrides: Partial<Paper> = {}): Paper => ({
    arxivId: '2401.01234',
    title: 'A Study of Scalable Attention',
    authors: ['Alice Example'],
    categories: ['cs.LG'],
    abstractEn: 'We study attention mechanisms and report scaling behavior.',
    publishedAt: '2024-01-02T00:00:00.000Z',
    detailUrl: 'https://arxiv.org/abs/2401.01234',
    contentHash: 'hash-1',
    ...overrides,
});

const agent = { model: 'test-model', timeout_ms: 1000, max_retries: 2 };

describe('buildClassificationPrompt', () => {
    it('embeds titles, abstracts and the taxonomy catalog only, with papers last', () => {
        const papers = [paper(), paper({ arxivId: '2401.01235', title: 'Mixture of Experts Revisited' })];
        const prompt = buildClassificationPrompt(papers, taxonomy);
        expect(prompt).toContain(papers[0].title);
        expect(prompt).toContain(papers[1].title);
        expect(prompt).toContain(papers[0].abstractEn);
        expect(prompt).toContain('- test-architecture: ');
        expect(prompt).toContain('test-reasoning');
        expect(prompt).toContain('Use "other" only when no other topic fits.');
        expect(prompt).toContain('JSON array');
        expect(prompt).toContain('"tldr"');
        expect(prompt).toContain('Simplified Chinese');
        expect(prompt).toContain('id: 2401.01234');
        expect(prompt).toContain('id: 2401.01235');
        // Instructions and catalog come before the paper list.
        expect(prompt.indexOf('Controlled topic catalog:')).toBeLessThan(prompt.indexOf('Papers to classify:'));
        expect(prompt.indexOf('Papers to classify:')).toBeLessThan(prompt.indexOf('id: 2401.01234'));
    });

    it('never contains interest, instructions, score or translation machinery', () => {
        const prompt = buildClassificationPrompt([paper()], taxonomy);
        // Legacy prompt-template constructs must be gone. (Topic tags such as
        // "score-based-model" or "machine-translation" may legitimately appear
        // inside the taxonomy catalog, so we match template markers exactly.)
        expect(prompt).not.toContain('Interest:');
        expect(prompt).not.toContain('Instructions:');
        expect(prompt).not.toContain('Use keys score');
        expect(prompt).not.toContain('Score relevance');
        expect(prompt).not.toContain('Translate the following');
        // The version is a fixed constant, not configurable.
        expect(CLASSIFICATION_PROMPT_VERSION).toBe('v3');
        expect(CLASSIFICATION_BATCH_SIZE).toBeGreaterThan(1);
    });
});

describe('normalizeClassification', () => {
    it('accepts canonical categories and keeps primary-first order', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['test-architecture', 'test-reasoning'],
            tags: ['attention'],
            tldr: '一篇中文摘要。',
        });
        expect(result.categories).toEqual(['test-architecture', 'test-reasoning']);
        expect(result.tags).toEqual(['attention']);
        expect(result.tldr).toBe('一篇中文摘要。');
    });

    it('resolves aliases and drops unknown categories', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['arch', 'made-up-topic'],
            tags: [],
            tldr: '一篇中文摘要。',
        });
        expect(result.categories).toEqual(['test-architecture']);
    });

    it('applies precedence before capping at max_categories', () => {
        // fixture: test-architecture > test-training
        const result = normalizeClassification(taxonomy, {
            categories: ['test-training', 'test-architecture', 'test-reasoning'],
            tags: [],
            tldr: '一篇中文摘要。',
        });
        expect(result.categories).toEqual(['test-architecture', 'test-training']);
        expect(result.categories).toHaveLength(taxonomy.rules.maxCategories);
    });

    it('normalizes, deduplicates and caps tags, rejecting malformed ones', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['test-architecture'],
            tags: ['Attention', 'attention', 'not a tag!', 'a-b-c-d-e', 'state-space-model'],
            tldr: '一篇中文摘要。',
        });
        // 'Attention' lowercases into a duplicate; 'not a tag!' is invalid;
        // the cap of three tags is enforced.
        expect(result.tags).toEqual(['attention', 'a-b-c-d-e', 'state-space-model']);
    });

    it('rejects empty categories, wrong shapes and unknown-only categories', () => {
        expect(() => normalizeClassification(taxonomy, { categories: [], tags: [], tldr: 'x' })).toThrow();
        expect(() => normalizeClassification(taxonomy, { categories: ['ghost'], tags: [], tldr: 'x' })).toThrow(
            /no valid topic id/,
        );
        expect(() => normalizeClassification(taxonomy, { tags: [] })).toThrow();
        expect(() => normalizeClassification(taxonomy, 'not an object')).toThrow();
        expect(() => normalizeClassification(taxonomy, { categories: ['test-architecture'], tags: 'x', tldr: 'y' })).toThrow();
    });

    it('normalizes the tldr: trims, collapses whitespace and strips quotes', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['test-architecture'],
            tags: [],
            tldr: '  该论文\n\n  提出了  一种方法。  ',
        });
        expect(result.tldr).toBe('该论文 提出了 一种方法。');
        const quoted = normalizeClassification(taxonomy, {
            categories: ['test-architecture'],
            tags: [],
            tldr: '"一句话摘要。"',
        });
        expect(quoted.tldr).toBe('一句话摘要。');
    });

    it('rejects an empty, whitespace-only or overlong tldr', () => {
        expect(() =>
            normalizeClassification(taxonomy, { categories: ['test-architecture'], tags: [], tldr: '   ' }),
        ).toThrow(/empty tldr/);
        expect(() =>
            normalizeClassification(taxonomy, {
                categories: ['test-architecture'],
                tags: [],
                tldr: 'x'.repeat(TLDR_MAX_CHARS + 1),
            }),
        ).toThrow(/exceeds/);
    });

    it('rejects response keys outside the fixed agent contract', () => {
        expect(() =>
            normalizeClassification(taxonomy, {
                categories: ['test-architecture'],
            }),
        ).toThrow();
        expect(() =>
            normalizeClassification(taxonomy, {
                categories: ['test-architecture'],
                tags: [],
                score: 10,
                tldr: 'x',
            }),
        ).toThrow(/unrecognized key/i);
    });
});

describe('ChatCompletionClient', () => {
    const env = { ...process.env };

    afterEach(() => {
        process.env = { ...env };
        vi.restoreAllMocks();
    });

    const completion = (content: string): unknown => ({
        choices: [{ message: { role: 'assistant', content } }],
    });

    it('posts the prompt to the configured endpoint and returns the message content', async () => {
        process.env.BASE_URL = 'https://llm.example/v1/';
        process.env.API_KEY = 'secret-key';
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify(completion('{"categories": ["test-retrieval"]}')), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = new ChatCompletionClient();
        const raw = await client.complete('the prompt', { model: 'test-model', timeoutMs: 1000 });
        expect(raw).toBe('{"categories": ["test-retrieval"]}');

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://llm.example/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
        const body = JSON.parse(String(init.body)) as {
            model: string;
            messages: { role: string; content: string }[];
            temperature: number;
            reasoning_effort: string;
        };
        expect(body.model).toBe('test-model');
        expect(body.messages).toEqual([{ role: 'user', content: 'the prompt' }]);
        expect(body.temperature).toBe(0);
        expect(body.reasoning_effort).toBe('low');
    });

    it('prefers config base_url over the environment endpoint', async () => {
        process.env.BASE_URL = 'https://env.example/v1';
        process.env.API_KEY = 'secret-key';
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify(completion('ok')), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        await new ChatCompletionClient({ baseUrl: 'https://config.example/v1' }).complete('p', {
            model: 'm',
            timeoutMs: 1000,
        });
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://config.example/v1/chat/completions');
    });

    it('fails fast when the endpoint or key is missing', async () => {
        delete process.env.BASE_URL;
        delete process.env.API_KEY;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            new ChatCompletionClient().complete('p', { model: 'm', timeoutMs: 1000 }),
        ).rejects.toThrow(/BASE_URL/);
        await expect(
            new ChatCompletionClient({ baseUrl: 'https://config.example/v1' }).complete('p', {
                model: 'm',
                timeoutMs: 1000,
            }),
        ).rejects.toThrow(/API_KEY/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces HTTP errors without leaking the response body beyond a prefix', async () => {
        process.env.BASE_URL = 'https://llm.example/v1';
        process.env.API_KEY = 'secret-key';
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 401 })));

        await expect(
            new ChatCompletionClient().complete('p', { model: 'm', timeoutMs: 1000 }),
        ).rejects.toThrow(/HTTP 401/);
    });

    it('rejects malformed completion payloads', async () => {
        process.env.BASE_URL = 'https://llm.example/v1';
        process.env.API_KEY = 'secret-key';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));

        await expect(
            new ChatCompletionClient().complete('p', { model: 'm', timeoutMs: 1000 }),
        ).rejects.toThrow();
    });
});

describe('normalizeBatchClassification', () => {
    const batch = [paper(), paper({ arxivId: '2401.01235', title: 'Mixture of Experts Revisited' })];

    it('maps one response object per paper, keyed by arxiv id', () => {
        const results = normalizeBatchClassification(taxonomy, batch, [
            { id: '2401.01234', categories: ['test-architecture'], tags: ['attention'], tldr: '一篇中文摘要。' },
            { id: '2401.01235', categories: ['other'], tags: [], tldr: '另一篇中文摘要。' },
        ]);
        expect(results.get('2401.01234')?.categories).toEqual(['test-architecture']);
        expect(results.get('2401.01234')?.tldr).toBe('一篇中文摘要。');
        expect(results.get('2401.01235')?.categories).toEqual(['other']);
        expect(results.size).toBe(2);
    });

    it('rejects missing, duplicate, or unknown paper ids', () => {
        expect(() =>
            normalizeBatchClassification(taxonomy, batch, [
                { id: '2401.01234', categories: ['test-architecture'], tags: [], tldr: 'x' },
            ]),
        ).toThrow(/missing papers/);
        expect(() =>
            normalizeBatchClassification(taxonomy, batch, [
                { id: '2401.01234', categories: ['test-architecture'], tags: [], tldr: 'x' },
                { id: '2401.01234', categories: ['other'], tags: [], tldr: 'x' },
                { id: '2401.01235', categories: ['other'], tags: [], tldr: 'x' },
            ]),
        ).toThrow(/duplicate or unknown/);
        expect(() =>
            normalizeBatchClassification(taxonomy, batch, [
                { id: 'ghost', categories: ['other'], tags: [], tldr: 'x' },
                { id: '2401.01235', categories: ['other'], tags: [], tldr: 'x' },
            ]),
        ).toThrow(/duplicate or unknown/);
        expect(() => normalizeBatchClassification(taxonomy, batch, { not: 'an array' })).toThrow(
            /not a JSON array/,
        );
    });

    it('still validates each entry against the taxonomy', () => {
        expect(() =>
            normalizeBatchClassification(taxonomy, batch, [
                { id: '2401.01234', categories: ['ghost'], tags: [], tldr: 'x' },
                { id: '2401.01235', categories: ['other'], tags: [], tldr: 'x' },
            ]),
        ).toThrow(/no valid topic id/);
        expect(() =>
            normalizeBatchClassification(taxonomy, batch, [
                { id: '2401.01234', categories: ['test-architecture'], tags: [], score: 5, tldr: 'x' },
                { id: '2401.01235', categories: ['other'], tags: [], tldr: 'x' },
            ]),
        ).toThrow(/unrecognized key/i);
    });
});

describe('classifyPapers', () => {
    const batch = [paper(), paper({ arxivId: '2401.01235', title: 'Mixture of Experts Revisited' })];

    it('sends one batch prompt and returns validated classifications', async () => {
        const invoker = {
            complete: vi.fn(async () =>
                JSON.stringify([
                    { id: '2401.01234', categories: ['test-architecture'], tags: ['attention'], tldr: '一篇中文摘要。' },
                    { id: '2401.01235', categories: ['test-reasoning'], tags: [], tldr: '另一篇中文摘要。' },
                ]),
            ),
        };
        const results = await classifyPapers(batch, taxonomy, agent, invoker);
        expect(results.get('2401.01234')?.categories).toEqual(['test-architecture']);
        expect(results.get('2401.01235')?.categories).toEqual(['test-reasoning']);
        expect(results.get('2401.01234')).not.toHaveProperty('raw');
        expect(invoker.complete).toHaveBeenCalledTimes(1);
        const [prompt, options] = invoker.complete.mock.calls[0] as unknown as [string, { model: string; timeoutMs: number }];
        expect(prompt).toContain(batch[0].title);
        expect(prompt).toContain(batch[1].title);
        expect(options).toEqual({ model: 'test-model', timeoutMs: 1000 });
    });

    it('returns an empty map for an empty batch without calling the agent', async () => {
        const invoker = { complete: vi.fn() };
        const results = await classifyPapers([], taxonomy, agent, invoker);
        expect(results.size).toBe(0);
        expect(invoker.complete).not.toHaveBeenCalled();
    });

    it('parses fenced JSON array output', async () => {
        const invoker = {
            complete: vi.fn(async () => '```json\n[{"id": "2401.01234", "categories": ["other"], "tags": [], "tldr": "一篇中文摘要。"}]\n```'),
        };
        const results = await classifyPapers([paper()], taxonomy, agent, invoker);
        expect(results.get('2401.01234')?.categories).toEqual(['other']);
    });

    it('retries on invalid responses and gives up after max_retries', async () => {
        const invoker = { complete: vi.fn(async () => 'garbage not json') };
        await expect(classifyPapers(batch, taxonomy, agent, invoker)).rejects.toThrow();
        // Initial attempt + 2 retries.
        expect(invoker.complete).toHaveBeenCalledTimes(3);
    });

    it('retries once and succeeds when the second response is valid', async () => {
        let calls = 0;
        const invoker = {
            complete: vi.fn(async () => {
                calls += 1;
                if (calls === 1) return '[{"id": "2401.01234", "categories": ["ghost"], "tags": [], "tldr": "x"}]';
                return '[{"id": "2401.01234", "categories": ["test-retrieval"], "tags": [], "tldr": "一篇中文摘要。"}]';
            }),
        };
        const results = await classifyPapers([paper()], taxonomy, agent, invoker);
        expect(results.get('2401.01234')?.categories).toEqual(['test-retrieval']);
        expect(invoker.complete).toHaveBeenCalledTimes(2);
    });

    it('uses a stable client version for cache invalidation', () => {
        expect(LLM_CLIENT_VERSION).toBe('chat-completions-v1');
    });
});
