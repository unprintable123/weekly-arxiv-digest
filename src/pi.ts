import { createRequire } from 'node:module';
import { z } from 'zod';
import type { InterestCategory, Paper, RelevanceResult } from './types.js';
import { sleep } from './util.js';

const require = createRequire(import.meta.url);

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
    const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
    const { contentText } = await import('@earendil-works/pi-ai');

    const models = builtinModels();
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

export async function translateAbstract(
  paper: Paper,
  cfg: any,
  inv: PiInvoker,
  language = 'zh-CN',
): Promise<string> {
  const prompt = `Translate the following English abstract into ${language}. Return only the translation, preserving technical meaning and without adding facts.
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
