import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseInterest } from '../src/config.js';

const baseYaml = `
threshold: 7
interest: ""
source:
  provider: papers.cool
  base_url: https://papers.cool
`;

function load(yaml: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    const dir = mkdtempSync(join(tmpdir(), 'weekly-digest-config-'));
    const file = join(dir, 'config.yaml');
    writeFileSync(file, yaml);
    return loadConfig(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('loadConfig', () => {
    it('rejects an invalid timezone', async () => {
        await expect(load(`${baseYaml}\nwindow:\n  timezone: Not/AZone\n`)).rejects.toThrow(/timezone/i);
    });

    it('rejects an unknown window default', async () => {
        await expect(load(`${baseYaml}\nwindow:\n  default: yesterday\n`)).rejects.toThrow();
    });

    it('maps natural-language categories to arXiv ids', async () => {
        const cfg = await load(`${baseYaml}\ncategories: ["Machine Learning", "Computation and Language"]\n`);
        expect(cfg.resolvedCategories).toEqual(['cs.LG', 'cs.CL']);
    });

    it('accepts raw arXiv ids directly', async () => {
        const cfg = await load(`${baseYaml}\ncategories: ["cs.LG", "cs.CL"]\n`);
        expect(cfg.resolvedCategories).toEqual(['cs.LG', 'cs.CL']);
    });

    it('rejects an empty category list', async () => {
        await expect(load(`${baseYaml}\ncategories: []\n`)).rejects.toThrow(/category/i);
    });

    it('rejects an out-of-range threshold', async () => {
        await expect(load(baseYaml.replace('threshold: 7', 'threshold: 11'))).rejects.toThrow();
    });
});

describe('parseInterest', () => {
    it('parses numbered entries into stable ids', () => {
        const cats = parseInterest('1. Novel Model Architectures & Components\n2. Physics & Theory of LLMs');
        expect(cats).toEqual([
            { id: 'interest-1-novel-model-architectures-components', name: 'Novel Model Architectures & Components', order: 1 },
            { id: 'interest-2-physics-theory-of-llms', name: 'Physics & Theory of LLMs', order: 2 },
        ]);
    });

    it('falls back to a general category when numbering cannot be parsed', () => {
        expect(parseInterest('some freeform interest')).toEqual([
            { id: 'interest-general', name: 'General relevance', order: 1 },
        ]);
    });

    it('returns an empty list for empty interest', () => {
        expect(parseInterest('')).toEqual([]);
    });
});
