import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { makeConfigDir } from './helpers.js';

const baseYaml = `
source:
  provider: papers.cool
  base_url: https://papers.cool
`;

async function load(yaml: string, options: { withTopics?: boolean } = {}) {
    const { file, dir, cleanup } = makeConfigDir(yaml);
    if (options.withTopics === false) {
        // Simulate a missing TOPICS.yaml by removing the copy.
        const { rmSync } = await import('node:fs');
        rmSync(`${dir}/TOPICS.yaml`);
    }
    return loadConfig(file).finally(cleanup);
}

describe('loadConfig', () => {
    it('applies defaults and loads the sibling TOPICS.yaml taxonomy', async () => {
        const cfg = await load(`${baseYaml}\ncategories: [cs.LG]\n`);
        expect(cfg.resolvedCategories).toEqual(['cs.LG']);
        expect(cfg.output.filename).toBe('weekly-{week}-{category}.md');
        expect(cfg.output.directory).toBe('digests');
        expect(cfg.pi_agent.max_retries).toBe(2);
        expect(cfg.window.timezone).toBe('UTC');
        expect(cfg.topics.topics.other).toBeDefined();
        expect(Object.keys(cfg.topics.topics).length).toBeGreaterThan(0);
        expect(cfg).not.toHaveProperty('threshold');
        expect(cfg).not.toHaveProperty('interest');
    });

    it('rejects legacy fields via strict parsing', async () => {
        await expect(load(`${baseYaml}\nthreshold: 7\n`)).rejects.toThrow(/threshold/);
        await expect(load(`${baseYaml}\ninterest: llm papers\n`)).rejects.toThrow(/interest/);
        await expect(load(`${baseYaml}\noutput:\n  language: zh-CN\n`)).rejects.toThrow(/language/);
        await expect(load(`${baseYaml}\npi_agent:\n  instructions: do X\n`)).rejects.toThrow(/instructions/);
        await expect(load(`${baseYaml}\ntopic: Computer Science\n`)).rejects.toThrow(/topic/);
    });

    it('rejects an invalid timezone or unknown window default', async () => {
        await expect(load(`${baseYaml}\nwindow:\n  timezone: Not/AZone\n`)).rejects.toThrow(/timezone/i);
        await expect(load(`${baseYaml}\nwindow:\n  default: yesterday\n`)).rejects.toThrow();
    });

    it('maps natural-language categories to arXiv ids and accepts raw ids', async () => {
        const mapped = await load(`${baseYaml}\ncategories: ["Machine Learning", "Computation and Language"]\n`);
        expect(mapped.resolvedCategories).toEqual(['cs.LG', 'cs.CL']);

        const raw = await load(`${baseYaml}\ncategories: ["cs.LG", "cs.CL"]\n`);
        expect(raw.resolvedCategories).toEqual(['cs.LG', 'cs.CL']);

        const sourceLevel = await load('source:\n  categories: [cs.AI]\n');
        expect(sourceLevel.resolvedCategories).toEqual(['cs.AI']);
    });

    it('rejects an empty or missing category list', async () => {
        await expect(load(`${baseYaml}\ncategories: []\n`)).rejects.toThrow(/category/i);
        await expect(load('source:\n  provider: papers.cool\n')).rejects.toThrow(/category/i);
    });

    it('fails before anything else when TOPICS.yaml is missing or invalid', async () => {
        await expect(load(baseYaml, { withTopics: false })).rejects.toThrow(/topic taxonomy/i);
        await expect(load(`${baseYaml}\ncategories: [cs.LG]\n`)).resolves.toBeTruthy();
    });

    it('requires {week} and {category} in the output filename', async () => {
        const cats = 'categories: [cs.LG]\n';
        await expect(load(`${baseYaml}${cats}output:\n  filename: weekly-{week}.md\n`)).rejects.toThrow(/\{category\}/);
        await expect(load(`${baseYaml}${cats}output:\n  filename: digest.md\n`)).rejects.toThrow(/filename/);
    });
});
