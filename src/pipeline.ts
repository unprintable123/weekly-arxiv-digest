import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { createCrawler, type PaperCrawler } from './crawler.js';
import { rowToPaper, Store } from './db.js';
import { Logger, elapsed } from './log.js';
import {
    agentVersion,
    classifyPaper,
    CLASSIFICATION_PROMPT_VERSION,
    type PiInvoker,
} from './pi.js';
import { MarkdownRenderer } from './renderer.js';
import type { ClassifiedPaper, DigestDocument, Paper, Window } from './types.js';
import { hash } from './util.js';

export interface RunOptions {
    root: string;
    force?: boolean;
    invoker?: PiInvoker;
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
        pi_agent: cfg.pi_agent,
        categories: cfg.resolvedCategories,
    });
}

/**
 * Classification cache key: any change to paper content, taxonomy, prompt
 * version, agent package, provider, or model invalidates the old entries.
 */
export function classificationCacheKey(
    paper: Paper,
    cfg: Config,
    taxonomyHash: string,
    agentV: string,
): string {
    return hash({
        id: paper.arxivId,
        content: paper.contentHash,
        taxonomy: taxonomyHash,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        agentVersion: agentV,
        provider: cfg.pi_agent.provider,
        model: cfg.pi_agent.model,
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
    const agentV = agentVersion();

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

        // Classify every paper; cache hits never invoke the agent.
        const classificationKeys = new Map<string, string>();
        const limit = pLimit(Math.max(1, cfg.source.concurrency ?? 4));
        const tasks = [...papers.values()].map((paper) =>
            limit(async (): Promise<ClassifiedPaper | undefined> => {
                store.savePaper(paper);
                const key = classificationCacheKey(paper, cfg, taxonomy.hash, agentV);
                classificationKeys.set(paper.arxivId, key);
                const classifyMs = Date.now();
                let classification = opts.force ? undefined : store.getClassification(key);
                if (classification) {
                    logger.debug('classify', {
                        arxiv_id: paper.arxivId,
                        category: classification.categories[0],
                        cache_hit: true,
                        elapsed_ms: elapsed(classifyMs),
                    });
                } else {
                    if (!invoker) throw new Error('No PiInvoker configured');
                    try {
                        classification = await classifyPaper(paper, taxonomy, cfg.pi_agent, invoker);
                        newClassifications += 1;
                        store.saveClassification(
                            key,
                            paper,
                            {
                                taxonomyHash: taxonomy.hash,
                                promptVersion: CLASSIFICATION_PROMPT_VERSION,
                                agentVersion: agentV,
                                provider: cfg.pi_agent.provider,
                                model: cfg.pi_agent.model,
                            },
                            classification,
                        );
                        logger.debug('classify', {
                            arxiv_id: paper.arxivId,
                            category: classification.categories[0],
                            cache_hit: false,
                            elapsed_ms: elapsed(classifyMs),
                        });
                    } catch (error) {
                        // A single classification failure must not lose the rest
                        // of the run, but the run still reports the error.
                        errors += 1;
                        store.addAgentError(runId, 'classify', paper.arxivId, error, cfg.pi_agent.max_retries);
                        store.addRunPaper(runId, paper.arxivId, false, 'classify-error', 0, key);
                        logger.warn('agent_error', {
                            arxiv_id: paper.arxivId,
                            stage: 'classify',
                            error_type: error instanceof Error ? error.name : 'Error',
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return undefined;
                    }
                }
                return { ...paper, classification };
            }),
        );

        const classified = sortPapers(
            (await Promise.all(tasks)).filter((paper): paper is ClassifiedPaper => paper !== undefined),
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
        if (!invoker) throw new Error(`No PiInvoker configured for retry --stage ${stage}`);

        const taxonomy = cfg.topics;
        const agentV = agentVersion();
        const failed = new Set(
            store.agentErrorsForRun(targetRunId, 'classify').map((entry) => entry.arxiv_id as string),
        );
        const targets = store
            .papersForRun(targetRunId)
            .map((row) => rowToPaper(row))
            .filter((paper) => failed.has(paper.arxivId));
        let succeeded = 0;
        let failedCount = 0;
        for (const paper of targets) {
            try {
                const classification = await classifyPaper(paper, taxonomy, cfg.pi_agent, invoker);
                const key = classificationCacheKey(paper, cfg, taxonomy.hash, agentV);
                store.saveClassification(
                    key,
                    paper,
                    {
                        taxonomyHash: taxonomy.hash,
                        promptVersion: CLASSIFICATION_PROMPT_VERSION,
                        agentVersion: agentV,
                        provider: cfg.pi_agent.provider,
                        model: cfg.pi_agent.model,
                    },
                    classification,
                );
                succeeded += 1;
                logger.info('retry_item', { stage, arxiv_id: paper.arxivId, ok: true });
            } catch (error) {
                failedCount += 1;
                store.addAgentError(runId, 'classify', paper.arxivId, error, cfg.pi_agent.max_retries);
                logger.warn('retry_item', {
                    stage,
                    arxiv_id: paper.arxivId,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
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
