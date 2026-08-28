import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, parseInterest } from '../src/config.js';
import { retryRun, runDigest } from '../src/pipeline.js';
import { weekWindow } from '../src/window.js';
import { fixture, routeContains, stubFetch } from './helpers.js';

const configYaml = `
threshold: 6
categories: ["cs.LG"]
interest: |
  1. Novel Model Architectures & Components
source:
  provider: papers.cool
  base_url: https://papers.cool
  arxiv_base_url: https://export.arxiv.org
  request_delay_ms: 0
  timeout_ms: 5000
  user_agent: weekly-digest-test/0.1
output:
  directory: digests
  filename: weekly-{week}.md
  language: zh-CN
pi_agent:
  provider: test
  model: test-model
  timeout_ms: 5000
  max_retries: 0
`;

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'weekly-digest-pipeline-'));
    writeFileSync(join(root, 'config.yaml'), configYaml);
    return root;
}

describe('runDigest', () => {
    it('produces byte-identical markdown on a fully cached repeat run with no new network/LLM calls', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadConfig(join(root, 'config.yaml'));
            const categoryId = parseInterest(cfg.interest)[0].id;
            const window = weekWindow('2024-01-01', '2024-01-08');

            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    if (prompt.startsWith('Return one JSON object')) {
                        return JSON.stringify({
                            score: 8,
                            reason: 'matches the architectural interest',
                            categories: [categoryId],
                            tags: ['attention'],
                        });
                    }
                    return '这是中文翻译。';
                }),
            };

            const { calls } = stubFetch([
                routeContains('/arxiv/cs.LG', fixture('papers-cool-list.html')),
                routeContains('/arxiv/2401.01234', fixture('papers-cool-detail.html')),
                routeContains('/arxiv/2401.01235', fixture('papers-cool-detail.html')),
            ]);

            const first = await runDigest(cfg, window, { root, invoker });
            expect(first.errors).toBe(0);
            expect(first.status).toBe('ok');
            expect(first.file && existsSync(first.file)).toBe(true);
            const firstMarkdown = first.file ? readFileSync(first.file, 'utf8') : '';
            expect(firstMarkdown).toContain('## Attention Is All You Need: A Study of Scalable Attention (Detailed)');

            const networkCalls = calls.length;
            const llmCalls = invoker.complete.mock.calls.length;
            expect(llmCalls).toBeGreaterThan(0);

            const second = await runDigest(cfg, window, { root, invoker });
            expect(second.errors).toBe(0);
            const secondMarkdown = second.file ? readFileSync(second.file, 'utf8') : '';

            // No additional network or LLM calls on the repeat run.
            expect(calls.length).toBe(networkCalls);
            expect(invoker.complete.mock.calls.length).toBe(llmCalls);
            // Byte-identical output, including the generatedAt header.
            expect(secondMarkdown).toBe(firstMarkdown);
            expect(second.document.generatedAt).toBe(first.document.generatedAt);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('skips writing the digest file in dry-run mode', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadConfig(join(root, 'config.yaml'));
            const window = weekWindow('2024-01-01', '2024-01-08');
            const invoker = {
                complete: vi.fn(async (prompt: string) =>
                    prompt.startsWith('Return one JSON object')
                        ? JSON.stringify({ score: 8, reason: 'r', categories: [parseInterest(cfg.interest)[0].id], tags: [] })
                        : '翻译',
                ),
            };
            stubFetch([
                routeContains('/arxiv/cs.LG', fixture('papers-cool-list.html')),
                routeContains('/arxiv/2401.01234', fixture('papers-cool-detail.html')),
                routeContains('/arxiv/2401.01235', fixture('papers-cool-detail.html')),
            ]);

            const result = await runDigest(cfg, window, { root, invoker, dryRun: true });

            expect(result.file).toBeUndefined();
            expect(result.document.candidateCount).toBe(2);
            expect(result.document.includedCount).toBe(2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('throws (run fails) when the source is unavailable instead of writing an empty digest', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadConfig(join(root, 'config.yaml'));
            const window = weekWindow('2024-01-01', '2024-01-08');
            const invoker = { complete: vi.fn(async () => '{}') };
            stubFetch([routeContains('/arxiv/cs.LG', '', 500)]);

            await expect(runDigest(cfg, window, { root, invoker })).rejects.toThrow(/Source unavailable/);
            // No digest file was produced.
            const digestDir = join(root, 'digests');
            expect(existsSync(join(digestDir, 'weekly-2024-W01.md'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('retries only the failed items of the selected LLM stage', async () => {
        const root = makeRoot();
        try {
            const cfg = await loadConfig(join(root, 'config.yaml'));
            const categoryId = parseInterest(cfg.interest)[0].id;
            const window = weekWindow('2024-01-01', '2024-01-08');

            // Scoring for "Mixture of Experts Revisited" fails only on the first run.
            let failNextScore = true;
            const invoker = {
                complete: vi.fn(async (prompt: string) => {
                    if (prompt.includes('Mixture of Experts') && failNextScore) {
                        failNextScore = false;
                        throw new Error('score boom');
                    }
                    if (prompt.startsWith('Return one JSON object')) {
                        return JSON.stringify({ score: 8, reason: 'r', categories: [categoryId], tags: [] });
                    }
                    return '翻译';
                }),
            };
            const moeDetail = `<!DOCTYPE html><html><body>
        <h1 class="title">Mixture of Experts Revisited</h1>
        <p class="summary">We revisit sparse mixture-of-experts layers and report routing stability improvements.</p>
        <span class="date-data">2024-01-02</span>
      </body></html>`;
            stubFetch([
                routeContains('/arxiv/cs.LG', fixture('papers-cool-list.html')),
                routeContains('/arxiv/2401.01234', fixture('papers-cool-detail.html')),
                { match: (url: string) => url.endsWith('/arxiv/2401.01235'), body: moeDetail },
            ]);

            const first = await runDigest(cfg, window, { root, invoker });
            expect(first.errors).toBeGreaterThan(0);
            expect(first.status).toBe('error');
            expect(first.document.papers.map((p) => p.arxivId)).toEqual(['2401.01234']);

            // The retry only re-scores the single paper that failed scoring.
            const callsBeforeRetry = invoker.complete.mock.calls.length;
            const retry = await retryRun(cfg, first.runId, 'score', { root, invoker });
            expect(retry.retried).toBe(1);
            expect(retry.succeeded).toBe(1);
            expect(retry.failed).toBe(0);
            expect(retry.status).toBe('ok');
            // Score calls: 1 failed attempt + the retry itself.
            expect(invoker.complete.mock.calls.length).toBe(callsBeforeRetry + 1);

            // A subsequent run now includes the previously failed paper from cache.
            const rerun = await runDigest(cfg, window, { root, invoker });
            expect(rerun.errors).toBe(0);
            expect(rerun.document.papers.map((p) => p.arxivId).sort()).toEqual([
                '2401.01234',
                '2401.01235',
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
