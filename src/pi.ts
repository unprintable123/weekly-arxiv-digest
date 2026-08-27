import { z } from 'zod';
import type { InterestCategory, Paper, RelevanceResult } from './types.js';
import { sleep } from './util.js';

const resultSchema = z.object({
  score: z.number().int().min(1).max(10),
  reason: z.string(),
  categories: z.array(z.string()),
  tags: z.array(z.string()).max(3).default([]),
});

export interface PiInvoker {
  complete(
    prompt: string,
    opts: { provider: string; model: string; timeoutMs: number },
  ): Promise<string>;
}

export class PiAgentAdapter implements PiInvoker {
  async complete(
    prompt: string,
    opts: { provider: string; model: string; timeoutMs: number },
  ): Promise<string> {
    // The packages are intentionally loaded from local node_modules; no CLI or child process fallback.
    const { contentText } = await import('@earendil-works/pi-ai');
    const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');

    const models = builtinModels();
    const model = models.getModel(opts.provider, opts.model);
    if (!model) {
      throw new Error(`Model not found for provider "${opts.provider}" and model "${opts.model}"`);
    }

    const message = await Promise.race([
      models.completeSimple(model, {
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pi agent timeout')), opts.timeoutMs),
      ),
    ]);
    return contentText(message.content);
  }
}

const cleanTags = (tags: string[]): string[] =>
  tags.filter((tag) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)).slice(0, 3);

export async function scorePaper(
  paper: Paper,
  interest: string,
  cats: InterestCategory[],
  cfg: any,
  inv: PiInvoker,
): Promise<RelevanceResult> {
  const allowed = cats.map((category) => category.id);
  const prompt = `Return one JSON object only. Score relevance from 1 to 10 using only the title and English abstract.
Interest:
${interest}
Instructions:
${cfg.instructions || ''}
Allowed categories: ${allowed.join(', ') || '(none)'}
Paper title: ${paper.title}
English abstract: ${paper.abstractEn}
Use keys score, reason, categories, tags. Do not invent facts.`;
  let last: unknown;
  for (let attempt = 0; attempt <= cfg.max_retries; attempt += 1) {
    try {
      const raw = await inv.complete(prompt, {
        provider: cfg.provider,
        model: cfg.model,
        timeoutMs: cfg.timeout_ms,
      });
      const parsed = resultSchema.parse(JSON.parse(raw));
      const categories = parsed.categories.filter((category) => allowed.includes(category));
      if (allowed.length > 0 && categories.length === 0) {
        throw new Error('Agent returned no allowed interest category');
      }
      return { ...parsed, categories, tags: cleanTags(parsed.tags), raw };
    } catch (error) {
      last = error;
      if (attempt < cfg.max_retries) await sleep(250 * 2 ** attempt);
    }
  }
  throw last;
}

export async function translateAbstract(paper: Paper, cfg: any, inv: PiInvoker): Promise<string> {
  const prompt = `Translate the following English abstract to Simplified Chinese. Return only the translation, preserving technical meaning and without adding facts.
${paper.abstractEn}`;
  let last: unknown;
  for (let attempt = 0; attempt <= cfg.max_retries; attempt += 1) {
    try {
      return await inv.complete(prompt, {
        provider: cfg.provider,
        model: cfg.model,
        timeoutMs: cfg.timeout_ms,
      });
    } catch (error) {
      last = error;
      if (attempt < cfg.max_retries) await sleep(250 * 2 ** attempt);
    }
  }
  throw last;
}
