import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { InterestCategory } from './types.js';
import { slug } from './util.js';

const schema = z.object({
  topic: z.string().optional(),
  categories: z.array(z.string()).optional(),
  threshold: z.number().int().min(1).max(10),
  interest: z.string().default(''),
  source: z
    .object({
      provider: z.enum(['papers.cool', 'arxiv']).default('papers.cool'),
      base_url: z.string().url().default('https://papers.cool'),
      arxiv_base_url: z.string().url().default('https://export.arxiv.org'),
      categories: z.array(z.string()).optional(),
      request_delay_ms: z.number().int().nonnegative().default(400),
      timeout_ms: z.number().int().positive().default(20000),
      user_agent: z.string().default('weekly-digest/0.1'),
    })
    .default({
      provider: 'papers.cool',
      base_url: 'https://papers.cool',
      arxiv_base_url: 'https://export.arxiv.org',
      request_delay_ms: 400,
      timeout_ms: 20000,
      user_agent: 'weekly-digest/0.1',
    }),
  window: z
    .object({
      timezone: z.string().default('UTC'),
      default: z.string().default('last-complete-week'),
    })
    .default({
      timezone: 'UTC',
      default: 'last-complete-week',
    }),
  output: z
    .object({
      directory: z.string().default('digests'),
      filename: z.string().default('weekly-{week}.md'),
      language: z.string().default('zh-CN'),
    })
    .default({
      directory: 'digests',
      filename: 'weekly-{week}.md',
      language: 'zh-CN',
    }),
  pi_agent: z
    .object({
      provider: z.string().default('anthropic'),
      model: z.string().default('configured-model-id'),
      timeout_ms: z.number().int().positive().default(120000),
      max_retries: z.number().int().nonnegative().default(2),
      instructions: z.string().default(''),
    })
    .default({
      provider: 'anthropic',
      model: 'configured-model-id',
      timeout_ms: 120000,
      max_retries: 2,
      instructions: '',
    }),
});

export type Config = z.infer<typeof schema> & {
  resolvedCategories: string[];
  interestCategories: InterestCategory[];
};

const categoryMap: Record<string, string> = {
  'Artificial Intelligence': 'cs.AI',
  'Computation and Language': 'cs.CL',
  'Machine Learning': 'cs.LG',
  'Computer Science': 'cs',
};

export function parseInterest(text: string): InterestCategory[] {
  const rows = text.split(/\n/);
  const out: InterestCategory[] = [];
  for (const line of rows) {
    const match = line.match(/^\s*(\d+)\.\s*([^:]+?)(?::|$)/);
    if (match) {
      out.push({
        id: `interest-${match[1]}-${slug(match[2])}`,
        name: match[2].trim(),
        order: Number(match[1]),
      });
    }
  }
  if (out.length) return out.sort((a, b) => a.order - b.order);
  return text.trim()
    ? [{ id: 'interest-general', name: 'General relevance', order: 1 }]
    : [];
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = schema.parse(parse(await readFile(path, 'utf8')));
  const cats = raw.source.categories ?? raw.categories ?? [];
  if (!cats.length) throw new Error('At least one category is required');
  const resolvedCategories = [
    ...new Set(cats.map((category) => (categoryMap[category] ?? category).trim()).filter(Boolean)),
  ];
  if (!resolvedCategories.length) throw new Error('At least one non-empty category is required');
  return { ...raw, resolvedCategories, interestCategories: parseInterest(raw.interest) };
}
