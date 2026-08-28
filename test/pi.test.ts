import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    buildClassificationPrompt,
    classifyPaper,
    CLASSIFICATION_PROMPT_VERSION,
    normalizeClassification,
} from '../src/pi.js';
import { parseTaxonomy } from '../src/topics.js';
import type { Paper } from '../src/types.js';
import { repoTopicsPath } from './helpers.js';

const taxonomy = parseTaxonomy(readFileSync(repoTopicsPath, 'utf8'));

const paper = (overrides: Partial<Paper> = {}): Paper => ({
    arxivId: '2401.01234',
    title: 'A Study of Scalable Attention',
    authors: ['Alice Example'],
    categories: ['cs.LG'],
    abstractEn: 'We study attention mechanisms and report scaling behavior.',
    publishedAt: '2024-01-02T00:00:00.000Z',
    detailUrl: 'https://arxiv.org/abs/2401.01234',
    sourceUrl: 'https://papers.cool/arxiv/2401.01234',
    contentHash: 'hash-1',
    ...overrides,
});

const agent = { provider: 'test', model: 'test-model', timeout_ms: 1000, max_retries: 2 };

describe('buildClassificationPrompt', () => {
    it('embeds title, abstract and taxonomy catalog only', () => {
        const prompt = buildClassificationPrompt(paper(), taxonomy);
        expect(prompt).toContain(paper().title);
        expect(prompt).toContain(paper().abstractEn);
        expect(prompt).toContain('- llm-architecture: ');
        expect(prompt).toContain('llm-physics');
        expect(prompt).toContain('Use "other" only when no other topic fits.');
    });

    it('never contains interest, instructions, score or translation machinery', () => {
        const prompt = buildClassificationPrompt(paper(), taxonomy);
        // Legacy prompt-template constructs must be gone. (Topic tags such as
        // "score-based-model" or "machine-translation" may legitimately appear
        // inside the taxonomy catalog, so we match template markers exactly.)
        expect(prompt).not.toContain('Interest:');
        expect(prompt).not.toContain('Instructions:');
        expect(prompt).not.toContain('Use keys score');
        expect(prompt).not.toContain('Score relevance');
        expect(prompt).not.toContain('Translate the following');
        // The version is a fixed constant, not configurable.
        expect(CLASSIFICATION_PROMPT_VERSION).toBe('v1');
    });
});

describe('normalizeClassification', () => {
    it('accepts canonical categories and keeps primary-first order', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['llm-architecture', 'llm-physics'],
            tags: ['attention'],
        });
        expect(result.categories).toEqual(['llm-architecture', 'llm-physics']);
        expect(result.tags).toEqual(['attention']);
    });

    it('resolves aliases and drops unknown categories', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['multimodal-gen', 'made-up-topic'],
            tags: [],
        });
        expect(result.categories).toEqual(['multimodal-generation']);
    });

    it('applies precedence before capping at max_categories', () => {
        // TOPICS.yaml: multimodal-generation > diffusion-lm
        const result = normalizeClassification(taxonomy, {
            categories: ['diffusion-lm', 'multimodal-generation', 'llm-architecture'],
            tags: [],
        });
        expect(result.categories).toEqual(['multimodal-generation', 'diffusion-lm']);
        expect(result.categories).toHaveLength(taxonomy.rules.maxCategories);
    });

    it('normalizes, deduplicates and caps tags, rejecting malformed ones', () => {
        const result = normalizeClassification(taxonomy, {
            categories: ['llm-architecture'],
            tags: ['Attention', 'attention', 'not a tag!', 'a-b-c-d-e', 'state-space-model'],
        });
        // 'Attention' lowercases into a duplicate; 'not a tag!' is invalid;
        // the cap of three tags is enforced.
        expect(result.tags).toEqual(['attention', 'a-b-c-d-e', 'state-space-model']);
    });

    it('rejects empty categories, wrong shapes and unknown-only categories', () => {
        expect(() => normalizeClassification(taxonomy, { categories: [], tags: [] })).toThrow();
        expect(() => normalizeClassification(taxonomy, { categories: ['ghost'], tags: [] })).toThrow(
            /no valid topic id/,
        );
        expect(() => normalizeClassification(taxonomy, { tags: [] })).toThrow();
        expect(() => normalizeClassification(taxonomy, 'not an object')).toThrow();
        expect(() => normalizeClassification(taxonomy, { categories: ['llm-architecture'], tags: 'x' })).toThrow();
    });

    it('rejects response keys outside the fixed agent contract', () => {
        expect(() =>
            normalizeClassification(taxonomy, {
                categories: ['llm-architecture'],
            }),
        ).toThrow();
        expect(() =>
            normalizeClassification(taxonomy, {
                categories: ['llm-architecture'],
                tags: [],
                score: 10,
            }),
        ).toThrow(/unrecognized key/i);
    });
});

describe('classifyPaper', () => {
    it('sends the fixed prompt and returns the validated classification with raw output', async () => {
        const invoker = {
            complete: vi.fn(async () => JSON.stringify({ categories: ['llm-architecture'], tags: ['attention'] })),
        };
        const result = await classifyPaper(paper(), taxonomy, agent, invoker);
        expect(result.categories).toEqual(['llm-architecture']);
        expect(result.tags).toEqual(['attention']);
        expect(result.raw).toContain('llm-architecture');
        expect(invoker.complete).toHaveBeenCalledTimes(1);
        const [prompt, options] = invoker.complete.mock.calls[0];
        expect(prompt).toContain(paper().title);
        expect(options).toEqual({ provider: 'test', model: 'test-model', timeoutMs: 1000 });
    });

    it('parses fenced JSON output', async () => {
        const invoker = {
            complete: vi.fn(async () => '```json\n{"categories": ["other"], "tags": []}\n```'),
        };
        const result = await classifyPaper(paper(), taxonomy, agent, invoker);
        expect(result.categories).toEqual(['other']);
    });

    it('retries on invalid responses and gives up after max_retries', async () => {
        const invoker = { complete: vi.fn(async () => 'garbage not json') };
        await expect(classifyPaper(paper(), taxonomy, agent, invoker)).rejects.toThrow();
        // Initial attempt + 2 retries.
        expect(invoker.complete).toHaveBeenCalledTimes(3);
    });

    it('retries once and succeeds when the second response is valid', async () => {
        let calls = 0;
        const invoker = {
            complete: vi.fn(async () => {
                calls += 1;
                if (calls === 1) return '{"categories": ["ghost"]}';
                return '{"categories": ["rag"], "tags": []}';
            }),
        };
        const result = await classifyPaper(paper(), taxonomy, agent, invoker);
        expect(result.categories).toEqual(['rag']);
        expect(invoker.complete).toHaveBeenCalledTimes(2);
    });
});
