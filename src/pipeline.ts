import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { createCrawler, type PaperCrawler } from './crawler.js';
import { rowToPaper, Store } from './db.js';
import { Logger, elapsed } from './log.js';
import {
    classifyPapers,
    CLASSIFICATION_BATCH_SIZE,
    CLASSIFICATION_PROMPT_VERSION,
    LLM_CLIENT_VERSION,
    type LlmInvoker,
} from './llm.js';
import { MarkdownRenderer } from './renderer.js';
import type {
    ClassifiedPaper,
    ClassificationResult,
    DigestDocument,
    Paper,
    Window,
} from './types.js';
import { chunk, hash } from './util.js';

export interface RunOptions {
    root: string;
    force?: boolean;
    invoker?: LlmInvoker;
    crawler?: PaperCrawler;
    logger?: Logger;
    /** run the whole pipeline but skip writing the digest files */
    dryRun?: boolean;
}

export interface RunResult {
    runId: string;
    /** written digest files, one per category (empty in dry-run mode) */
    files: string[];
    /** one document per non-empty category, ordered by category id */
    documents: DigestDocument[];
    errors: number;
    status: string;
}

export function configHash(cfg: Config): string {
    return hash({
        source: cfg.source,
        window: cfg.window,
        output: cfg.output,
        llm: cfg.llm,
        categories: cfg.resolvedCategories,
    });
}

/**
 * Classification cache key: any change to paper content, taxonomy, prompt
 * version, LLM client, model, or endpoint invalidates the old entries.
 */
export function classificationCacheKey(
    paper: Paper,
    cfg: Config,
    taxonomyHash: string,
): string {
    return hash({
        id: paper.arxivId,
        content: paper.contentHash,
        taxonomy: taxonomyHash,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        clientVersion: LLM_CLIENT_VERSION,
        model: cfg.llm.model,
        baseUrl: cfg.llm.base_url ?? '',
    });
}

function sortPapers(papers: ClassifiedPaper[]): ClassifiedPaper[] {
    return papers.sort(
        (a, b) =>
            b.publishedAt.localeCompare(a.publishedAt) || a.arxivId.localeCompare(b.arxivId),
    );
}

export async function runDigest(
    cfg: Config,
    window: Window,
    opts: RunOptions,
): Promise<RunResult> {
    const store = new Store(join(opts.root, '.cache/weekly-digest.sqlite'));
    const runId = randomUUID();
    const configHashValue = configHash(cfg);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const logger = opts.logger ?? new Logger({ runId });
    const invoker = opts.invoker;
    const taxonomy = cfg.topics;

    store.startRun({
        runId,
        week: window.week,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        configHash: configHashValue,
        startedAt,
    });
    logger.info('run_start', {
        week: window.week,
        from: window.from.toISOString().slice(0, 10),
        to: window.to.toISOString().slice(0, 10),
        config_hash: configHashValue,
        taxonomy_hash: taxonomy.hash.slice(0, 12),
        force: !!opts.force,
        dry_run: !!opts.dryRun,
    });

    let crawlErrorCount = 0;
    let newFetches = false;
    let newClassifications = 0;
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
            logger,
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

        // Classify every paper; cache hits never invoke the agent. Uncached
        // papers are grouped into fixed-size batches so one LLM call labels
        // several papers at once; a failed batch is retried per paper so one
        // bad response does not lose the whole batch.
        const classificationKeys = new Map<string, string>();
        const limit = pLimit(Math.max(1, cfg.source.concurrency ?? 4));
        const pending: Paper[] = [];
        for (const paper of papers.values()) {
            store.savePaper(paper);
            classificationKeys.set(paper.arxivId, classificationCacheKey(paper, cfg, taxonomy.hash));
            if (!opts.force && store.getClassification(classificationKeys.get(paper.arxivId)!)) {
                logger.debug('classify', {
                    arxiv_id: paper.arxivId,
                    category: store.getClassification(classificationKeys.get(paper.arxivId)!)!.categories[0],
                    cache_hit: true,
                });
            } else {
                pending.push(paper);
            }
        }

        const results = new Map<string, ClassificationResult>();
        for (const paper of papers.values()) {
            const cached = opts.force ? undefined : store.getClassification(classificationKeys.get(paper.arxivId)!);
            if (cached) results.set(paper.arxivId, cached);
        }

        const classifyMs = Date.now();
        const batches = chunk(pending, CLASSIFICATION_BATCH_SIZE);
        // Coarse progress for long runs: one info log roughly every 100 papers
        // (newClassifications is shared, and single-threaded increments cannot
        // skip a boundary).
        const PROGRESS_INTERVAL = 100;
        const logClassifyProgress = () => {
            if (newClassifications > 0 && newClassifications % PROGRESS_INTERVAL === 0) {
                logger.info('classify_progress', {
                    classified: newClassifications,
                    total: pending.length,
                });
            }
        };
        const batchTasks = batches.map((batch) =>
            limit(async (): Promise<void> => {
                if (!invoker) throw new Error('No LlmInvoker configured');
                try {
                    const batchResults = await classifyPapers(batch, taxonomy, cfg.llm, invoker, logger);
                    for (const [arxivId, classification] of batchResults) {
                        results.set(arxivId, classification);
                        newClassifications += 1;
                        logClassifyProgress();
                        const paper = batch.find((entry) => entry.arxivId === arxivId)!;
                        store.saveClassification(
                            classificationKeys.get(arxivId)!,
                            paper,
                            {
                                taxonomyHash: taxonomy.hash,
                                promptVersion: CLASSIFICATION_PROMPT_VERSION,
                                agentVersion: LLM_CLIENT_VERSION,
                                provider: cfg.llm.base_url ?? '',
                                model: cfg.llm.model,
                            },
                            classification,
                        );
                        logger.debug('classify', {
                            arxiv_id: arxivId,
                            category: classification.categories[0],
                            cache_hit: false,
                        });
                    }
                } catch (error) {
                    // The whole batch failed; retry each paper individually so
                    // one malformed response does not lose the entire batch.
                    logger.warn('batch_error', {
                        batch_size: batch.length,
                        error_type: error instanceof Error ? error.name : 'Error',
                        error: error instanceof Error ? error.message : String(error),
                    });
                    for (const paper of batch) {
                        try {
                            const classification = await classifyPapers(
                                [paper],
                                taxonomy,
                                cfg.llm,
                                invoker,
                                logger,
                            );
                            const classificationResult = classification.get(paper.arxivId)!;
                            results.set(paper.arxivId, classificationResult);
                            newClassifications += 1;
                            logClassifyProgress();
                            store.saveClassification(
                                classificationKeys.get(paper.arxivId)!,
                                paper,
                                {
                                    taxonomyHash: taxonomy.hash,
                                    promptVersion: CLASSIFICATION_PROMPT_VERSION,
                                    agentVersion: LLM_CLIENT_VERSION,
                                    provider: cfg.llm.base_url ?? '',
                                    model: cfg.llm.model,
                                },
                                classificationResult,
                            );
                            logger.debug('classify', {
                                arxiv_id: paper.arxivId,
                                category: classificationResult.categories[0],
                                cache_hit: false,
                            });
                        } catch (paperError) {
                            // A single classification failure must not lose the
                            // rest of the run, but the run still reports it.
                            errors += 1;
                            store.addAgentError(
                                runId,
                                'classify',
                                paper.arxivId,
                                paperError,
                                cfg.llm.max_retries,
                            );
                            store.addRunPaper(runId, paper.arxivId, false, 'classify-error', 0, classificationKeys.get(paper.arxivId)!);
                            logger.warn('agent_error', {
                                arxiv_id: paper.arxivId,
                                stage: 'classify',
                                error_type: paperError instanceof Error ? paperError.name : 'Error',
                                error: paperError instanceof Error ? paperError.message : String(paperError),
                            });
                        }
                    }
                }
            }),
        );
        await Promise.all(batchTasks);
        if (newClassifications > 0 && newClassifications % PROGRESS_INTERVAL !== 0) {
            logger.info('classify_progress', {
                classified: newClassifications,
                total: pending.length,
                done: true,
            });
        }
        logger.debug('classify_stage', {
            batches: batches.length,
            batch_size: CLASSIFICATION_BATCH_SIZE,
            new_classifications: newClassifications,
            elapsed_ms: elapsed(classifyMs),
        });

        const classified = sortPapers(
            [...papers.values()]
                .filter((paper) => results.has(paper.arxivId))
                .map((paper) => ({ ...paper, classification: results.get(paper.arxivId)! })),
        );
        classified.forEach((paper, index) =>
            store.addRunPaper(runId, paper.arxivId, true, 'included', index, classificationKeys.get(paper.arxivId)),
        );

        // A paper with primary + secondary categories appears in both files.
        const byCategory = new Map<string, ClassifiedPaper[]>();
        for (const paper of classified) {
            for (const categoryId of paper.classification.categories) {
                const list = byCategory.get(categoryId) ?? [];
                list.push(paper);
                byCategory.set(categoryId, list);
            }
        }

        // Byte-identical output on replay: when this run made no new network or
        // agent work, reuse the previous completed run's generation time so the
        // digest files are stable across identical repeat runs. generatedAt
        // always equals the run's ended_at so replays reproduce the exact files.
        const didWork = newFetches || newClassifications > 0;
        let generatedAt: string;
        if (didWork) {
            generatedAt = new Date().toISOString();
        } else {
            const previous = store.latestRunForWeek(window.week, configHashValue);
            generatedAt = previous?.ended_at ?? new Date().toISOString();
        }

        const renderer = new MarkdownRenderer();
        const documents: DigestDocument[] = [];
        const files: string[] = [];
        for (const categoryId of [...byCategory.keys()].sort()) {
            documents.push({
                week: window.week,
                from: window.from.toISOString().slice(0, 10),
                to: window.to.toISOString().slice(0, 10),
                categoryId,
                categoryName: taxonomy.topics[categoryId]?.name ?? categoryId,
                generatedAt,
                configHash: configHashValue,
                candidateCount: papers.size,
                papers: byCategory.get(categoryId)!,
            });
        }

        if (!opts.dryRun) {
            const outDir = join(opts.root, cfg.output.directory);
            await mkdir(outDir, { recursive: true });
            for (const document of documents) {
                const markdown = renderer.render(document);
                const file = join(
                    outDir,
                    cfg.output.filename
                        .replace('{week}', window.week)
                        .replace('{category}', document.categoryId),
                );
                // Atomic write: temp file + rename so readers never see partial output.
                const temporary = `${file}.tmp-${runId}`;
                await writeFile(temporary, markdown, 'utf8');
                await rename(temporary, file);
                files.push(file);
                store.saveRunDocument(runId, window.week, document.categoryId, document, markdown, file);
            }
        } else {
            for (const document of documents) {
                store.saveRunDocument(
                    runId,
                    window.week,
                    document.categoryId,
                    document,
                    renderer.render(document),
                    '',
                );
            }
        }

        const status = errors > 0 || crawlErrorCount > 0 ? 'error' : 'ok';
        store.finishRun(runId, status, {
            candidates: papers.size,
            classified: classified.length,
            categories: documents.length,
            errors,
            crawl_errors: crawlErrorCount,
            new_fetches: newFetches,
            new_classifications: newClassifications,
            dry_run: !!opts.dryRun,
        }, generatedAt);
        logger.info('run_end', {
            status,
            candidates: papers.size,
            classified: classified.length,
            categories: documents.length,
            errors,
            crawl_errors: crawlErrorCount,
            elapsed_ms: elapsed(startedMs),
        });
        return { runId, files, documents, errors: errors + crawlErrorCount, status };
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

export interface PreviewResult {
    runId: string;
    week: string;
    markdown: string;
    documents: DigestDocument[];
}

/**
 * Reproduce the stored snapshot of a completed run. Output is byte-stable and
 * never rebuilt from "latest" cache entries.
 */
export function previewDigest(
    root: string,
    week: string,
    categoryId?: string,
): PreviewResult {
    const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
    try {
        const run = store.latestRun(week);
        if (!run) throw new Error(`No completed run for ${week}`);
        const snapshots = store.getRunDocuments(run.run_id);
        if (!snapshots.length) {
            throw new Error(
                `Run ${run.run_id} has no document snapshots; run the digest again to regenerate snapshots`,
            );
        }
        const wanted = categoryId
            ? snapshots.filter((snapshot) => snapshot.category_id === categoryId)
            : snapshots;
        if (!wanted.length) {
            throw new Error(`No snapshot for category ${categoryId} in ${week}`);
        }
        const documents = wanted.map((snapshot) => JSON.parse(snapshot.document_json) as DigestDocument);
        const markdown = wanted.map((snapshot) => String(snapshot.markdown ?? '')).join('');
        return { runId: run.run_id, week, markdown, documents };
    } finally {
        store.close();
    }
}

export type RetryStage = 'fetch' | 'classify';

export interface RetryOptions {
    root: string;
    invoker?: LlmInvoker;
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
 * re-executed (classification retries only the papers that failed there); a
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
                logger,
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
        if (!invoker) throw new Error(`No LlmInvoker configured for retry --stage ${stage}`);

        const taxonomy = cfg.topics;
        const failed = new Set(
            store.agentErrorsForRun(targetRunId, 'classify').map((entry) => entry.arxiv_id as string),
        );
        const targets = store
            .papersForRun(targetRunId)
            .map((row) => rowToPaper(row))
            .filter((paper) => failed.has(paper.arxivId));
        let succeeded = 0;
        let failedCount = 0;
        // Retry in batches; a failed batch falls back to per-paper retries so
        // one malformed response does not lose the whole batch.
        for (const batch of chunk(targets, CLASSIFICATION_BATCH_SIZE)) {
            try {
                const batchResults = await classifyPapers(batch, taxonomy, cfg.llm, invoker, logger);
                for (const [arxivId, classification] of batchResults) {
                    const paper = batch.find((entry) => entry.arxivId === arxivId)!;
                    store.saveClassification(
                        classificationCacheKey(paper, cfg, taxonomy.hash),
                        paper,
                        {
                            taxonomyHash: taxonomy.hash,
                            promptVersion: CLASSIFICATION_PROMPT_VERSION,
                            agentVersion: LLM_CLIENT_VERSION,
                            provider: cfg.llm.base_url ?? '',
                            model: cfg.llm.model,
                        },
                        classification,
                    );
                    succeeded += 1;
                    logger.info('retry_item', { stage, arxiv_id: arxivId, ok: true });
                }
            } catch (batchError) {
                logger.warn('batch_error', {
                    stage,
                    batch_size: batch.length,
                    error: batchError instanceof Error ? batchError.message : String(batchError),
                });
                for (const paper of batch) {
                    try {
                        const classification = await classifyPapers([paper], taxonomy, cfg.llm, invoker, logger);
                        store.saveClassification(
                            classificationCacheKey(paper, cfg, taxonomy.hash),
                            paper,
                            {
                                taxonomyHash: taxonomy.hash,
                                promptVersion: CLASSIFICATION_PROMPT_VERSION,
                                agentVersion: LLM_CLIENT_VERSION,
                                provider: cfg.llm.base_url ?? '',
                                model: cfg.llm.model,
                            },
                            classification.get(paper.arxivId)!,
                        );
                        succeeded += 1;
                        logger.info('retry_item', { stage, arxiv_id: paper.arxivId, ok: true });
                    } catch (error) {
                        failedCount += 1;
                        store.addAgentError(runId, 'classify', paper.arxivId, error, cfg.llm.max_retries);
                        logger.warn('retry_item', {
                            stage,
                            arxiv_id: paper.arxivId,
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }
        const status = failedCount ? 'error' : 'ok';
        store.finishRun(runId, status, { stage: 'classify', retried: targets.length, succeeded, failed: failedCount, errors: failedCount });
        logger.info('retry_end', {
            stage,
            retried: targets.length,
            succeeded,
            failed: failedCount,
            status,
            elapsed_ms: elapsed(startedMs),
        });
        return { runId, targetRunId, stage, retried: targets.length, succeeded, failed: failedCount, errors: failedCount, status };
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
