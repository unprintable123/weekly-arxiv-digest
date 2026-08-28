import { createRequire } from 'node:module';
import { z } from 'zod';
import type { TopicTaxonomy } from './topics.js';
import { orderCategoriesByPrecedence, resolveCategoryId, topicCatalog } from './topics.js';
import type { ClassificationResult, Paper } from './types.js';
import { sleep } from './util.js';

const require = createRequire(import.meta.url);

/** Fixed prompt template version; part of the classification cache key. */
export const CLASSIFICATION_PROMPT_VERSION = 'v1';

export interface PiInvoker {
  complete(
    prompt: string,
    opts: { provider: string; model: string; timeoutMs: number },
  ): Promise<string>;
}

/** Version of the local pi agent packages, used for cache invalidation. */
export function agentVersion(): string {
  try {
    const pkg = require('@earendil-works/pi-coding-agent/package.json') as { version?: string };
    return pkg.version ?? 'local';
  } catch {
    return 'local';
  }
}

/**
 * Adapter that drives the local pi agent through its TypeScript API. It creates
 * a stateful `Agent` session via `@earendil-works/pi-agent-core`, sends the
 * prompt, and reads back the final assistant text. No global `pi` executable,
 * `npx` download, or child process is ever used.
 */
export class PiAgentAdapter implements PiInvoker {
  async complete(
    prompt: string,
    opts: { provider: string; model: string; timeoutMs: number },
  ): Promise<string> {
    // The packages are intentionally loaded from local node_modules; no CLI or child process fallback.
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { contentText } = await import('@earendil-works/pi-ai');

    // ModelRuntime includes built-ins plus custom providers from
    // ~/.pi/agent/models.json and resolves their environment-backed API keys.
    const models = await ModelRuntime.create();
    const model = models.getModel(opts.provider, opts.model);
    if (!model) {
      throw new Error(`Model not found for provider "${opts.provider}" and model "${opts.model}"`);
    }

    // Create an agent session: streamFn routes model requests to the local
    // pi-ai runtime, convertToLlm passes standard LLM messages through.
    const agent = new Agent({
      streamFn: (m, context, options) => models.streamSimple(m, context, options),
      convertToLlm: (messages) =>
        messages.filter(
          (message) =>
            message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
        ) as never,
      initialState: { model, thinkingLevel: 'off', systemPrompt: '' },
    });

    try {
      await Promise.race([
        agent.prompt(prompt).then(() => agent.waitForIdle()),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            agent.abort();
            reject(new Error('pi agent timeout'));
          }, opts.timeoutMs),
        ),
      ]);
    } finally {
      agent.abort();
    }

    const lastAssistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    return contentText(lastAssistant?.content ?? []);
  }
}

export type AgentConfig = {
  provider: string;
  model: string;
  timeout_ms: number;
  max_retries: number;
};

/**
 * Fixed, versioned classification prompt. It embeds only the paper title, the
 * English abstract, and the controlled taxonomy catalog — never interest text,
 * user instructions, scores, or translations.
 */
export function buildClassificationPrompt(paper: Paper, taxonomy: TopicTaxonomy): string {
  return [
    'Classify a research paper using the controlled topic catalog below.',
    'Return one JSON object only, with exactly two keys:',
    `- "categories": array of 1-${taxonomy.rules.maxCategories} catalog topic ids, ordered primary first. Use "${taxonomy.rules.unknownTopic}" only when no other topic fits.`,
    `- "tags": array of 0-${taxonomy.rules.maxTags} lowercase kebab-case tags naming the concrete contribution. Prefer the topic's common tags; add a new tag only with clear evidence from the abstract.`,
    'Rules: every category must be an exact topic id from the catalog; base the decision only on the title and English abstract; do not invent facts; output no extra keys and no markdown.',
    '',
    'Controlled topic catalog:',
    topicCatalog(taxonomy),
    '',
    `Paper title: ${paper.title}`,
    `English abstract: ${paper.abstractEn}`,
  ].join('\n');
}

const responseSchema = z.strictObject({
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

/** Classify one paper through the local pi agent with the fixed prompt and retries. */
export async function classifyPaper(
  paper: Paper,
  taxonomy: TopicTaxonomy,
  agent: AgentConfig,
  invoker: PiInvoker,
): Promise<ClassificationResult> {
  const prompt = buildClassificationPrompt(paper, taxonomy);
  let last: unknown;
  for (let attempt = 0; attempt <= agent.max_retries; attempt += 1) {
    try {
      const raw = await invoker.complete(prompt, {
        provider: agent.provider,
        model: agent.model,
        timeoutMs: agent.timeout_ms,
      });
      return { ...normalizeClassification(taxonomy, extractJson(raw)), raw };
    } catch (error) {
      last = error;
      if (attempt < agent.max_retries) await sleep(250 * 2 ** attempt);
    }
  }
  throw last;
}
