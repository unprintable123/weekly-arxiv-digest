import { z } from 'zod';
import type { Logger } from './log.js';
import type { TopicTaxonomy } from './topics.js';
import { orderCategoriesByPrecedence, resolveCategoryId, topicCatalog } from './topics.js';
import type { ClassificationResult, Paper } from './types.js';
import { sleep } from './util.js';

/** Fixed prompt template version; part of the classification cache key. */
export const CLASSIFICATION_PROMPT_VERSION = 'v2';

/**
 * Fixed number of papers per classification LLM call. Batching only changes
 * prompt construction; per-paper cache keys and stored results are unchanged.
 */
export const CLASSIFICATION_BATCH_SIZE = 10;

/**
 * Version of the built-in chat-completion client. Part of the classification
 * cache key so client behavior changes invalidate old entries.
 */
export const LLM_CLIENT_VERSION = 'chat-completions-v1';

export interface LlmInvoker {
    complete(
        prompt: string,
        opts: { model: string; timeoutMs: number },
    ): Promise<string>;
}

export type LlmConfig = {
    model: string;
    timeout_ms: number;
    max_retries: number;
};

/**
 * Minimal OpenAI-compatible chat completion client. The endpoint and key come
 * from the environment (`BASE_URL`, `API_KEY`, loaded from `.env` by the CLI);
 * an optional config `llm.base_url` overrides the env endpoint. The key is
 * never accepted from YAML, config files, or logs.
 */
export class ChatCompletionClient implements LlmInvoker {
    constructor(
        private readonly overrides: { baseUrl?: string; apiKey?: string } = {},
    ) { }

    async complete(
        prompt: string,
        opts: { model: string; timeoutMs: number },
    ): Promise<string> {
        const baseUrl = (this.overrides.baseUrl ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
        const apiKey = this.overrides.apiKey ?? process.env.API_KEY ?? '';
        if (!baseUrl) {
            throw new Error('Missing chat completion endpoint: set BASE_URL (env/.env) or llm.base_url (config)');
        }
        if (!apiKey) {
            throw new Error('Missing API key: set API_KEY in the environment (.env)');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        try {
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: opts.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0,
                    reasoning_effort: "low"
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `Chat completion failed: HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
                );
            }
            const payload = chatCompletionResponse.parse(await response.json());
            const content = payload.choices[0]?.message?.content?.trim();
            if (!content) throw new Error('Chat completion returned an empty message');
            return content;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('chat completion timeout');
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

const chatCompletionResponse = z.object({
    choices: z
        .array(
            z.object({
                message: z.object({
                    content: z.string().nullable().optional(),
                }),
            }),
        )
        .min(1),
});

/**
 * Fixed, versioned classification prompt. It embeds only the paper titles, the
 * English abstracts, and the controlled taxonomy catalog — never interest
 * text, user instructions, scores, or translations. Instructions and the
 * catalog come first; the paper list is appended last so the model reads the
 * task definition before the data.
 */
export function buildClassificationPrompt(papers: readonly Paper[], taxonomy: TopicTaxonomy): string {
    return [
        'Classify the research papers listed at the end of this message using the controlled topic catalog below.',
        'Return one JSON array only. The array must contain exactly one JSON object per paper, in the same order as the papers are listed.',
        'Each object must have exactly two keys:',
        `- "id": the paper id given in the paper list, copied verbatim.`,
        `- "categories": array of 1-${taxonomy.rules.maxCategories} catalog topic ids, ordered primary first. Use "${taxonomy.rules.unknownTopic}" only when no other topic fits.`,
        `- "tags": array of 0-${taxonomy.rules.maxTags} lowercase kebab-case tags naming the concrete contribution. Prefer the topic's common tags; add a new tag only with clear evidence from the abstract.`,
        'Rules: every category must be an exact topic id from the catalog; base each decision only on that paper\'s title and English abstract; do not invent facts; classify every paper exactly once; output no extra keys, no markdown, and no commentary.',
        '',
        'Controlled topic catalog:',
        topicCatalog(taxonomy),
        '',
        'Papers to classify:',
        ...papers.map(
            (paper) =>
                [
                    `id: ${paper.arxivId}`,
                    `title: ${paper.title}`,
                    `abstract: ${paper.abstractEn}`,
                    ''
                ].join('\n'),
        ),
    ].join('\n');
}

const responseSchema = z.strictObject({
    categories: z.array(z.string()).min(1),
    tags: z.array(z.string()),
});

/** One entry of the batch JSON array: paper id + per-paper classification. */
const batchEntrySchema = z.strictObject({
    id: z.string().min(1),
    categories: z.array(z.string()).min(1),
    tags: z.array(z.string()),
});

/** Best-effort JSON extraction for models that wrap the object in code fences. */
function extractJson(raw: string): unknown {
    const text = raw.trim();
    try {
        return JSON.parse(text);
    } catch {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try {
                return JSON.parse(fenced[1].trim());
            } catch {
                /* fall through */
            }
        }
        const braces = text.match(/\{[\s\S]*\}/);
        if (braces) return JSON.parse(braces[0]);
        throw new Error('Agent response is not valid JSON');
    }
}

/**
 * Normalize the raw agent JSON against the taxonomy: categories are alias-
 * resolved, filtered to canonical ids, de-duplicated, precedence-ordered and
 * capped at `max_categories`; tags are lowercased, pattern-checked,
 * de-duplicated and capped at `max_tags`. Zero valid categories is an error so
 * it triggers the configured retry policy.
 */
export function normalizeClassification(
    taxonomy: TopicTaxonomy,
    value: unknown,
): ClassificationResult {
    const parsed = responseSchema.parse(value);
    const resolved: string[] = [];
    for (const candidate of parsed.categories) {
        const id = resolveCategoryId(taxonomy, candidate);
        if (id && !resolved.includes(id)) resolved.push(id);
    }
    if (!resolved.length) {
        throw new Error(
            `Classification returned no valid topic id (input: ${parsed.categories.join(', ') || 'empty'})`,
        );
    }
    const categories = orderCategoriesByPrecedence(taxonomy, resolved).slice(
        0,
        taxonomy.rules.maxCategories,
    );
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const tag of parsed.tags) {
        const clean = tag.trim().toLowerCase();
        if (!clean || seen.has(clean) || !taxonomy.rules.tagPattern.test(clean)) continue;
        seen.add(clean);
        tags.push(clean);
        if (tags.length >= taxonomy.rules.maxTags) break;
    }
    return { categories, tags };
}

/**
 * Normalize a batch response: a JSON array with exactly one object per paper,
 * each carrying the paper `id` plus the per-paper classification keys. The
 * returned map is keyed by arXiv id; a missing, duplicated, or unknown id is a
 * batch-level error so the whole batch is retried together.
 */
export function normalizeBatchClassification(
    taxonomy: TopicTaxonomy,
    papers: readonly Paper[],
    value: unknown,
): Map<string, ClassificationResult> {
    if (!Array.isArray(value)) {
        throw new Error('Agent response is not a JSON array');
    }
    const expected = new Set(papers.map((paper) => paper.arxivId));
    const results = new Map<string, ClassificationResult>();
    for (const entry of value) {
        const parsed = batchEntrySchema.parse(entry);
        if (!expected.has(parsed.id) || results.has(parsed.id)) {
            throw new Error(`Agent response has a duplicate or unknown paper id: ${parsed.id}`);
        }
        const { id: _id, ...classification } = parsed;
        void _id;
        results.set(parsed.id, normalizeClassification(taxonomy, classification));
    }
    const missing = idsMissing(results, papers);
    if (missing.length) {
        throw new Error(`Agent response is missing papers: ${missing.join(', ')}`);
    }
    return results;
}

const idsMissing = (results: Map<string, unknown>, papers: readonly Paper[]): string[] =>
    papers.filter((paper) => !results.has(paper.arxivId)).map((paper) => paper.arxivId);

/**
 * Classify a batch of papers through one chat completion call with the fixed
 * prompt and retries. The response must be a JSON array with one object per
 * paper; each object is normalized independently against the taxonomy.
 * Emits `classify_start` before each LLM call and `classify_retry` between
 * attempts; prompts and responses are never logged.
 */
export async function classifyPapers(
    papers: readonly Paper[],
    taxonomy: TopicTaxonomy,
    agent: LlmConfig,
    invoker: LlmInvoker,
    logger?: Logger,
): Promise<Map<string, ClassificationResult>> {
    if (!papers.length) return new Map();
    const prompt = buildClassificationPrompt(papers, taxonomy);
    const ids = papers.map((paper) => paper.arxivId);
    let last: unknown;
    for (let attempt = 0; attempt <= agent.max_retries; attempt += 1) {
        try {
            logger?.debug('classify_start', {
                arxiv_ids: ids,
                batch_size: papers.length,
                model: agent.model,
                attempt: attempt + 1,
                attempts: agent.max_retries + 1,
            });
            const raw = await invoker.complete(prompt, {
                model: agent.model,
                timeoutMs: agent.timeout_ms,
            });
            logger?.debug('classify_response', {
                batch_size: papers.length,
                model: agent.model,
                raw_length: raw.length,
                content: raw.slice(0, 200) + (raw.length > 200 ? '...' : ''),
            });
            const results = normalizeBatchClassification(taxonomy, papers, extractJson(raw));
            // Keep the raw batch response on every paper for the cache table.
            for (const classification of results.values()) classification.raw = raw;
            return results;
        } catch (error) {
            last = error;
            if (attempt < agent.max_retries) {
                const retryDelayMs = 250 * 2 ** attempt;
                logger?.debug('classify_retry', {
                    batch_size: papers.length,
                    attempt: attempt + 1,
                    next_attempt: attempt + 2,
                    retry_delay_ms: retryDelayMs,
                    error: error instanceof Error ? error.message : String(error),
                });
                await sleep(retryDelayMs);
            }
        }
    }
    throw last;
}
