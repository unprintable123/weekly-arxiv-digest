import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadTopics, type TopicTaxonomy } from './topics.js';

const timezoneSchema = z
  .string()
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return value === 'UTC';
      }
    },
    { message: 'invalid IANA timezone' },
  );

// strictObject keeps legacy fields (threshold, interest, output.language,
// pi_agent, llm.instructions, topic) from being silently ignored.
const schema = z.strictObject({
  categories: z.array(z.string()).optional(),
  source: z
    .strictObject({
      provider: z.enum(['papers.cool', 'arxiv']).default('papers.cool'),
      base_url: z.string().url().default('https://papers.cool'),
      arxiv_base_url: z.string().url().default('https://export.arxiv.org'),
      categories: z.array(z.string()).optional(),
      request_delay_ms: z.number().int().nonnegative().default(400),
      timeout_ms: z.number().int().positive().default(20000),
      user_agent: z.string().default('weekly-digest/0.1'),
      max_papers: z.number().int().positive().optional(),
      concurrency: z.number().int().positive().default(4),
    })
    .default({
      provider: 'papers.cool',
      base_url: 'https://papers.cool',
      arxiv_base_url: 'https://export.arxiv.org',
      request_delay_ms: 400,
      timeout_ms: 20000,
      user_agent: 'weekly-digest/0.1',
      concurrency: 4,
    }),
  window: z
    .strictObject({
      timezone: timezoneSchema.default('UTC'),
      default: z.enum(['last-complete-week', 'current-week']).default('last-complete-week'),
    })
    .default({
      timezone: 'UTC',
      default: 'last-complete-week',
    }),
  output: z
    .strictObject({
      directory: z.string().default('digests'),
      filename: z.string().default('weekly-{week}-{category}.md'),
    })
    .default({
      directory: 'digests',
      filename: 'weekly-{week}-{category}.md',
    }),
  llm: z
    .strictObject({
      base_url: z.string().url().optional(),
      model: z.string().min(1).default('configured-model-id'),
      timeout_ms: z.number().int().positive().default(120000),
      max_retries: z.number().int().nonnegative().default(2),
    })
    .default({
      model: 'configured-model-id',
      timeout_ms: 120000,
      max_retries: 2,
    }),
});

export type Config = z.infer<typeof schema> & {
  resolvedCategories: string[];
  topics: TopicTaxonomy;
};

const categoryMap: Record<string, string> = {
  'Artificial Intelligence': 'cs.AI',
  'Computation and Language': 'cs.CL',
  'Machine Learning': 'cs.LG',
  'Computer Science': 'cs',
};

/**
 * Load and validate the YAML config plus the sibling TOPICS.yaml taxonomy.
 * Both must parse before anything else happens; there is no interest,
 * threshold, translation, custom-instructions, or pi-agent surface anymore.
 */
export async function loadConfig(
  path: string,
  topicsPath: string = join(dirname(path), 'TOPICS.yaml'),
): Promise<Config> {
  const [configText, topics] = await Promise.all([
    readFile(path, 'utf8').catch((error: unknown) => {
      throw new Error(
        `Failed to read config ${path}: ${error instanceof Error ? error.message : error}`,
      );
    }),
    loadTopics(topicsPath),
  ]);
  const raw = schema.parse(parse(configText));

  const cats = raw.source.categories ?? raw.categories ?? [];
  if (!cats.length) throw new Error('At least one category is required');
  const resolvedCategories = [
    ...new Set(cats.map((category) => (categoryMap[category] ?? category).trim()).filter(Boolean)),
  ];
  if (!resolvedCategories.length) throw new Error('At least one non-empty category is required');

  if (!raw.output.filename.includes('{week}') || !raw.output.filename.includes('{category}')) {
    throw new Error('output.filename must contain both {week} and {category} placeholders');
  }

  return { ...raw, resolvedCategories, topics };
}
