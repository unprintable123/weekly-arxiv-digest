import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { createCrawler, type PaperCrawler } from './crawler.js';
import { rowToPaper, Store } from './db.js';
import { Logger, elapsed } from './log.js';
import { agentVersion, scorePaper, translateAbstract, type PiInvoker } from './pi.js';
import { MarkdownRenderer } from './renderer.js';
import type { DigestDocument, DigestPaper, Paper, Window } from './types.js';
import { hash } from './util.js';

export interface RunOptions {
    root: string;
    force?: boolean;
    invoker?: PiInvoker;
    crawler?: PaperCrawler;
    logger?: Logger;
    /** run the whole pipeline but skip writing the digest file */
    dryRun?: boolean;
}

export interface RunResult {
    runId: string;
    file?: string;
    document: DigestDocument;
    errors: number;
    status: string;
}

export async function runDigest(
    cfg: Config,
    window: Window,
    opts: RunOptions,
): Promise<RunResult> {
    const store = new Store(join(opts.root, '.cache/weekly-digest.sqlite'));
    const runId = randomUUID();
    const configHash = hash(cfg);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const logger = opts.logger ?? new Logger({ runId });
    const invoker = opts.invoker;
    const version = agentVersion();

    store.startRun({
        runId,
        week: window.week,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        configHash,
        startedAt,
    });
    logger.info('run_start', {
        week: window.week,
        from: window.from.toISOString().slice(0, 10),
        to: window.to.toISOString().slice(0, 10),
        config_hash: configHash,
        force: !!opts.force,
        dry_run: !!opts.dryRun,
    });

    let crawlErrorCount = 0;
    let newFetches = false;
    let newScores = 0;
    let newTranslations = 0;
    let errors = 0;

    try {
        const crawler = opts.crawler ?? createCrawler(cfg.source.provider, store, {
            baseUrl: cfg.source.base_url,
            arxivBaseUrl: cfg.source.arxiv_base_url,
            delay: cfg.source.request_delay_ms,
            timeout: cfg.source.timeout_ms,
            userAgent: cfg.source.user_agent,
            force: opts.force,
            maxPapers: cfg.source.max_papers,
            concurrency: cfg.source.concurrency,
        });
        const papers = new Map<string, Paper>();
        for (const category of cfg.resolvedCategories) {
            const stageMs = Date.now();
            const result = await crawler.fetchCategory(category, window.from, window.to);
            for (const error of result.errors) store.addCrawlError(runId, error);
            for (const paper of result.papers) papers.set(paper.arxivId, paper);
            crawlErrorCount += result.errors.length;
            newFetches = newFetches || result.newFetches;
            logger.info('crawl', {
                category,
                count: result.papers.length,
                errors: result.errors.length,
                cache_hit: !result.newFetches,
                elapsed_ms: elapsed(stageMs),
            });
            for (const error of result.errors) {
                logger.warn('crawl_error', {
                    stage: error.stage,
                    category: error.category,
                    arxiv_id: error.arxivId,
                    url: error.url,
                    error: error.message,
                });
            }
        }

        // Never let a source outage silently produce a "successful" empty digest.
        if (papers.size === 0 && crawlErrorCount > 0) {
            throw new Error(`Source unavailable: all list fetches failed (${crawlErrorCount} error(s))`);
        }

        const categories = cfg.interestCategories.length
            ? cfg.interestCategories
            : [{ id: 'interest-general', name: 'General relevance', order: 1 }];

        const concurrency = Math.max(1, cfg.source.concurrency ?? 4);
        const limit = pLimit(concurrency);
        const tasks = [...papers.values()].map((paper) =>
            limit(async (): Promise<DigestPaper | undefined> => {
                store.savePaper(paper);
                let relevance: any;
                if (!cfg.interest.trim()) {
                    relevance = { score: 10, reason: 'No interest filter configured', categories: ['interest-general'], tags: [] };
                } else {
                    const key = hash({
                        id: paper.arxivId,
                        abstract: paper.contentHash,
                        interest: cfg.interest,
                        instructions: cfg.pi_agent.instructions,
                        promptVersion: 'v1',
                        agentVersion: version,
                        provider: cfg.pi_agent.provider,
                        model: cfg.pi_agent.model,
                    });
                    const scoreMs = Date.now();
                    relevance = opts.force ? undefined : store.getRelevance(key);
                    if (relevance) {
                        logger.debug('score', { arxiv_id: paper.arxivId, cache_hit: true, elapsed_ms: elapsed(scoreMs) });
                    } else {
                        if (!invoker) throw new Error('No PiInvoker configured');
                        try {
                            relevance = await scorePaper(paper, cfg.interest, cfg.interestCategories, cfg.pi_agent, invoker);
                            newScores += 1;
                            store.saveRelevance(
                                key,
                                paper,
                                hash(cfg.interest),
                                {
                                    promptVersion: 'v1',
                                    agentVersion: version,
                                    provider: cfg.pi_agent.provider,
                                    model: cfg.pi_agent.model,
                                },
                                relevance,
                            );
                            logger.debug('score', { arxiv_id: paper.arxivId, cache_hit: false, elapsed_ms: elapsed(scoreMs) });
                        } catch (error) {
                            errors += 1;
                            store.addLlmError(runId, 'score', paper.arxivId, error, cfg.pi_agent.max_retries);
                            store.addRunPaper(runId, paper.arxivId, false, 'llm-error', 0);
                            logger.warn('llm_error', {
                                arxiv_id: paper.arxivId,
                                stage: 'score',
                                error_type: error instanceof Error ? error.name : 'Error',
                                error: error instanceof Error ? error.message : String(error),
                            });
                            return undefined;
                        }
                    }
                }
                if (relevance.score < cfg.threshold) {
                    store.addRunPaper(runId, paper.arxivId, false, 'below-threshold', 0);
                    return undefined;
                }

                const translationKey = hash({
                    id: paper.arxivId,
                    abstract: paper.contentHash,
                    lang: cfg.output.language,
                    promptVersion: 'v1',
                });
                const translateMs = Date.now();
                let translation = opts.force ? undefined : store.getTranslation(translationKey);
                if (translation) {
                    logger.debug('translate', { arxiv_id: paper.arxivId, cache_hit: true, elapsed_ms: elapsed(translateMs) });
                } else {
                    if (!invoker) throw new Error('No PiInvoker configured for translation');
                    try {
                        translation = await translateAbstract(paper, cfg.pi_agent, invoker, cfg.output.language);
                        newTranslations += 1;
                        store.saveTranslation(translationKey, paper, cfg.output.language, translation);
                        logger.debug('translate', { arxiv_id: paper.arxivId, cache_hit: false, elapsed_ms: elapsed(translateMs) });
                    } catch (error) {
                        errors += 1;
                        store.addLlmError(runId, 'translate', paper.arxivId, error, cfg.pi_agent.max_retries);
                        store.addRunPaper(runId, paper.arxivId, false, 'translation-error', 0);
                        logger.warn('llm_error', {
                            arxiv_id: paper.arxivId,
                            stage: 'translate',
                            error_type: error instanceof Error ? error.name : 'Error',
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return undefined;
                    }
                }
                return { ...paper, relevance, translationZh: translation };
            }),
        );

        const included = (await Promise.all(tasks)).filter(
            (paper): paper is DigestPaper => paper !== undefined,
        );
        included.sort(
            (a, b) =>
                b.relevance.score - a.relevance.score ||
                b.publishedAt.localeCompare(a.publishedAt) ||
                a.arxivId.localeCompare(b.arxivId),
        );
        included.forEach((paper, index) => store.addRunPaper(runId, paper.arxivId, true, 'included', index));

        // Byte-identical output on replay: when this run made no new network or LLM
        // work, reuse the previous completed run's generation time so the digest
        // file is stable across identical repeat runs. generatedAt always equals the
        // run's ended_at so replays reproduce the exact same header.
        const didWork = newFetches || newScores > 0 || newTranslations > 0;
        let generatedAt: string;
        if (didWork) {
            generatedAt = new Date().toISOString();
        } else {
            const previous = store.latestRunForWeek(window.week, configHash);
            generatedAt = previous?.ended_at ?? new Date().toISOString();
        }

        const document: DigestDocument = {
            week: window.week,
            from: window.from.toISOString().slice(0, 10),
            to: window.to.toISOString().slice(0, 10),
            generatedAt,
            configHash,
            candidateCount: papers.size,
            includedCount: included.length,
            categories,
            papers: included,
        };

        const markdown = new MarkdownRenderer().render(document);
        let file: string | undefined;
        if (!opts.dryRun) {
            const outDir = join(opts.root, cfg.output.directory);
            await mkdir(outDir, { recursive: true });
            file = join(outDir, cfg.output.filename.replace('{week}', window.week));
            const temporary = `${file}.tmp-${runId}`;
            await writeFile(temporary, markdown, 'utf8');
            await rename(temporary, file);
        }
        store.saveRunDocument(runId, window.week, document, markdown, file ?? '');

        const status = errors > 0 || crawlErrorCount > 0 ? 'error' : 'ok';
        store.finishRun(runId, status, {
            candidates: papers.size,
            included: included.length,
            errors,
            crawl_errors: crawlErrorCount,
            new_fetches: newFetches,
            new_scores: newScores,
            new_translations: newTranslations,
            dry_run: !!opts.dryRun,
        }, generatedAt);
        logger.info('run_end', {
            status,
            candidates: papers.size,
            included: included.length,
            errors,
            crawl_errors: crawlErrorCount,
            elapsed_ms: elapsed(startedMs),
        });
        return { runId, file, document, errors: errors + crawlErrorCount, status };
    } catch (error) {
        store.finishRun(runId, 'error', {
            errors: 1,
            message: error instanceof Error ? error.message : String(error),
        });
        logger.error('run_error', {
            error: error instanceof Error ? error.message : String(error),
            elapsed_ms: elapsed(startedMs),
        });
        throw error;
    } finally {
        store.close();
    }
}

export type RetryStage = 'fetch' | 'score' | 'translate';

export interface RetryOptions {
    root: string;
    invoker?: PiInvoker;
    crawler?: PaperCrawler;
    logger?: Logger;
}

export interface RetryResult {
    runId: string;
    targetRunId: string;
    stage: RetryStage;
    retried: number;
    succeeded: number;
    failed: number;
    errors: number;
    status: string;
}

/**
 * Stage-scoped retry for a previously recorded run. Only the selected stage is
 * re-executed (for LLM stages, only the items that failed in that stage); a
 * later `digest run` regenerates the digest from the refreshed caches.
 */
export async function retryRun(
    cfg: Config,
    targetRunId: string,
    stage: RetryStage,
    opts: RetryOptions,
): Promise<RetryResult> {
    const store = new Store(join(opts.root, '.cache/weekly-digest.sqlite'));
    const target = store.getRun(targetRunId);
    if (!target) {
        store.close();
        throw new Error(`Unknown run: ${targetRunId}`);
    }
    const runId = randomUUID();
    const logger = opts.logger ?? new Logger({ runId });
    const startedMs = Date.now();
    store.startRun({
        runId,
        week: target.week,
        from: target.from_date,
        to: target.to_date,
        configHash: target.config_hash,
        startedAt: new Date().toISOString(),
    });
    logger.info('retry_start', { stage, target_run: targetRunId, week: target.week });

    try {
        if (stage === 'fetch') {
            const crawler = opts.crawler ?? createCrawler(cfg.source.provider, store, {
                baseUrl: cfg.source.base_url,
                arxivBaseUrl: cfg.source.arxiv_base_url,
                delay: cfg.source.request_delay_ms,
                timeout: cfg.source.timeout_ms,
                userAgent: cfg.source.user_agent,
                force: true,
                maxPapers: cfg.source.max_papers,
                concurrency: cfg.source.concurrency,
            });
            const window: Window = {
                from: new Date(target.from_date),
                to: new Date(target.to_date),
                week: target.week,
            };
            let papers = 0;
            let crawlErrors = 0;
            for (const category of cfg.resolvedCategories) {
                const result = await crawler.fetchCategory(category, window.from, window.to);
                for (const error of result.errors) store.addCrawlError(runId, error);
                for (const paper of result.papers) {
                    store.savePaper(paper);
                    papers += 1;
                }
                crawlErrors += result.errors.length;
            }
            const status = crawlErrors ? 'error' : 'ok';
            store.finishRun(runId, status, { stage: 'fetch', papers, errors: crawlErrors });
            logger.info('retry_end', {
                stage,
                retried: papers,
                succeeded: papers,
                failed: crawlErrors,
                status,
                elapsed_ms: elapsed(startedMs),
            });
            return { runId, targetRunId, stage, retried: papers, succeeded: papers, failed: crawlErrors, errors: crawlErrors, status };
        }

        const invoker = opts.invoker;
        if (!invoker) throw new Error(`No PiInvoker configured for retry --stage ${stage}`);

        if (stage === 'score') {
            const failed = new Set(
                store.llmErrorsForRun(targetRunId, 'score').map((entry) => entry.arxiv_id as string),
            );
            const targets = store
                .papersForRun(targetRunId)
                .map((row) => rowToPaper(row))
                .filter((paper) => failed.has(paper.arxivId));
            let succeeded = 0;
            let failedCount = 0;
            for (const paper of targets) {
                try {
                    const relevance = await scorePaper(paper, cfg.interest, cfg.interestCategories, cfg.pi_agent, invoker);
                    const key = hash({
                        id: paper.arxivId,
                        abstract: paper.contentHash,
                        interest: cfg.interest,
                        instructions: cfg.pi_agent.instructions,
                        promptVersion: 'v1',
                        agentVersion: agentVersion(),
                        provider: cfg.pi_agent.provider,
                        model: cfg.pi_agent.model,
                    });
                    store.saveRelevance(
                        key,
                        paper,
                        hash(cfg.interest),
                        {
                            promptVersion: 'v1',
                            agentVersion: agentVersion(),
                            provider: cfg.pi_agent.provider,
                            model: cfg.pi_agent.model,
                        },
                        relevance,
                    );
                    succeeded += 1;
                    logger.info('retry_item', { stage, arxiv_id: paper.arxivId, ok: true });
                } catch (error) {
                    failedCount += 1;
                    store.addLlmError(runId, 'score', paper.arxivId, error, cfg.pi_agent.max_retries);
                    logger.warn('retry_item', {
                        stage,
                        arxiv_id: paper.arxivId,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            const status = failedCount ? 'error' : 'ok';
            store.finishRun(runId, status, { stage: 'score', retried: targets.length, succeeded, failed: failedCount, errors: failedCount });
            logger.info('retry_end', {
                stage,
                retried: targets.length,
                succeeded,
                failed: failedCount,
                status,
                elapsed_ms: elapsed(startedMs),
            });
            return { runId, targetRunId, stage, retried: targets.length, succeeded, failed: failedCount, errors: failedCount, status };
        }

        if (stage === 'translate') {
            const failed = new Set(
                store.llmErrorsForRun(targetRunId, 'translate').map((entry) => entry.arxiv_id as string),
            );
            const targets = store
                .papersForRun(targetRunId)
                .map((row) => rowToPaper(row))
                .filter((paper) => failed.has(paper.arxivId));
            let succeeded = 0;
            let failedCount = 0;
            for (const paper of targets) {
                try {
                    const translation = await translateAbstract(paper, cfg.pi_agent, invoker, cfg.output.language);
                    const key = hash({
                        id: paper.arxivId,
                        abstract: paper.contentHash,
                        lang: cfg.output.language,
                        promptVersion: 'v1',
                    });
                    store.saveTranslation(key, paper, cfg.output.language, translation);
                    succeeded += 1;
                    logger.info('retry_item', { stage, arxiv_id: paper.arxivId, ok: true });
                } catch (error) {
                    failedCount += 1;
                    store.addLlmError(runId, 'translate', paper.arxivId, error, cfg.pi_agent.max_retries);
                    logger.warn('retry_item', {
                        stage,
                        arxiv_id: paper.arxivId,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            const status = failedCount ? 'error' : 'ok';
            store.finishRun(runId, status, { stage: 'translate', retried: targets.length, succeeded, failed: failedCount, errors: failedCount });
            logger.info('retry_end', {
                stage,
                retried: targets.length,
                succeeded,
                failed: failedCount,
                status,
                elapsed_ms: elapsed(startedMs),
            });
            return { runId, targetRunId, stage, retried: targets.length, succeeded, failed: failedCount, errors: failedCount, status };
        }

        throw new Error(`Unsupported retry stage: ${String(stage)}`);
    } catch (error) {
        store.finishRun(runId, 'error', {
            errors: 1,
            message: error instanceof Error ? error.message : String(error),
        });
        throw error;
    } finally {
        store.close();
    }
}
