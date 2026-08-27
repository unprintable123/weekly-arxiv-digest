import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config.js';
import { createCrawler } from './crawler.js';
import { Store } from './db.js';
import { scorePaper, translateAbstract, type PiInvoker } from './pi.js';
import { MarkdownRenderer } from './renderer.js';
import type { DigestDocument, DigestPaper, Window } from './types.js';
import { hash } from './util.js';

export async function runDigest(
    cfg: Config,
    window: Window,
    opts: { root: string; force?: boolean; invoker?: PiInvoker },
): Promise<{ runId: string; file: string; document: DigestDocument; errors: number }> {
    const store = new Store(join(opts.root, '.cache/weekly-digest.sqlite'));
    const runId = randomUUID();
    const configHash = hash(cfg);
    store.startRun({
        runId,
        week: window.week,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        configHash,
        startedAt: new Date().toISOString(),
    });

    try {
        const crawler = createCrawler(cfg.source.provider, store, {
            baseUrl: cfg.source.base_url,
            arxivBaseUrl: cfg.source.arxiv_base_url,
            delay: cfg.source.request_delay_ms,
            timeout: cfg.source.timeout_ms,
            userAgent: cfg.source.user_agent,
            force: opts.force,
        });
        const papers = new Map<string, any>();
        for (const category of cfg.resolvedCategories) {
            for (const paper of await crawler.fetchCategory(category, window.from, window.to)) {
                papers.set(paper.arxivId, paper);
            }
        }

        const invoker = opts.invoker;
        const included: DigestPaper[] = [];
        let errors = 0;
        const categories = cfg.interestCategories.length
            ? cfg.interestCategories
            : [{ id: 'interest-general', name: 'General relevance', order: 1 }];

        for (const paper of papers.values()) {
            store.savePaper(paper);
            let relevance: any;
            if (!cfg.interest.trim()) {
                relevance = { score: 10, reason: 'No interest filter configured', categories: ['interest-general'], tags: [] };
            } else {
                const key = hash({
                    id: paper.arxivId,
                    abstract: paper.contentHash,
                    interest: cfg.interest,
                    promptVersion: 'v1',
                    provider: cfg.pi_agent.provider,
                    model: cfg.pi_agent.model,
                });
                relevance = opts.force ? undefined : store.getRelevance(key);
                if (!relevance) {
                    if (!invoker) throw new Error('No PiInvoker configured');
                    try {
                        relevance = await scorePaper(paper, cfg.interest, cfg.interestCategories, cfg.pi_agent, invoker);
                        store.saveRelevance(
                            key,
                            paper,
                            hash(cfg.interest),
                            {
                                promptVersion: 'v1',
                                agentVersion: 'local',
                                provider: cfg.pi_agent.provider,
                                model: cfg.pi_agent.model,
                            },
                            relevance,
                        );
                    } catch (error) {
                        errors++;
                        store.addLlmError(runId, 'score', paper.arxivId, error, cfg.pi_agent.max_retries);
                        store.addRunPaper(runId, paper.arxivId, false, 'llm-error', 0);
                        continue;
                    }
                }
            }
            if (relevance.score < cfg.threshold) {
                store.addRunPaper(runId, paper.arxivId, false, 'below-threshold', 0);
                continue;
            }

            const translationKey = hash({
                id: paper.arxivId,
                abstract: paper.contentHash,
                lang: cfg.output.language,
                promptVersion: 'v1',
            });
            let translation = opts.force ? undefined : store.getTranslation(translationKey);
            if (!translation) {
                if (!invoker) throw new Error('No PiInvoker configured for translation');
                try {
                    translation = await translateAbstract(paper, cfg.pi_agent, invoker);
                    store.saveTranslation(translationKey, paper, cfg.output.language, translation);
                } catch (error) {
                    errors++;
                    store.addLlmError(runId, 'translate', paper.arxivId, error, cfg.pi_agent.max_retries);
                    store.addRunPaper(runId, paper.arxivId, false, 'translation-error', 0);
                    continue;
                }
            }
            included.push({ ...paper, relevance, translationZh: translation });
        }

        included.sort(
            (a, b) =>
                b.relevance.score - a.relevance.score ||
                b.publishedAt.localeCompare(a.publishedAt) ||
                a.arxivId.localeCompare(b.arxivId),
        );
        included.forEach((paper, index) => store.addRunPaper(runId, paper.arxivId, true, 'included', index));

        const document: DigestDocument = {
            week: window.week,
            from: window.from.toISOString().slice(0, 10),
            to: window.to.toISOString().slice(0, 10),
            generatedAt: new Date().toISOString(),
            configHash,
            candidateCount: papers.size,
            includedCount: included.length,
            categories,
            papers: included,
        };

        const outDir = join(opts.root, cfg.output.directory);
        await mkdir(outDir, { recursive: true });
        const file = join(outDir, cfg.output.filename.replace('{week}', window.week));
        const temporary = `${file}.tmp-${runId}`;
        await writeFile(temporary, new MarkdownRenderer().render(document), 'utf8');
        await rename(temporary, file);
        store.finishRun(runId, errors ? 'error' : 'ok', { candidates: papers.size, included: included.length, errors });
        return { runId, file, document, errors };
    } catch (error) {
        store.finishRun(runId, 'error', { errors: 1, message: error instanceof Error ? error.message : String(error) });
        throw error;
    } finally {
        store.close();
    }
}
