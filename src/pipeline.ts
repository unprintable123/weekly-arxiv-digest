import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { createCrawler, type PaperCrawler } from './crawler.js';
import { Store } from './db.js';
import { Logger, elapsed } from './log.js';
import {
    classifyPapers,
    CLASSIFICATION_BATCH_SIZE,
    CLASSIFICATION_PROMPT_VERSION,
    LLM_CLIENT_VERSION,
    type LlmInvoker,
} from './llm.js';
import { MarkdownRenderer, JsonRenderer } from './renderer.js';
import { refreshManifests } from './site.js';
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
 * Classification cache key: paper content, prompt version, LLM client, model,
 * and endpoint changes invalidate the old entries. The taxonomy hash is
 * deliberately NOT part of the key, so editing TOPICS.yaml never re-classifies
 * cached papers; stale rows are only removed by an explicit cache clear.
 */
export function classificationCacheKey(paper: Paper, cfg: Config): string {
    return hash({
        id: paper.arxivId,
        content: paper.contentHash,
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

/**
 * Byte-stable regenerations: the generation timestamp is keyed by week and
 * config hash, so a fully cached repeat run reproduces the exact previous
 * files instead of restamping every document with a fresh clock reading.
 */
function generationMetaKey(week: string, configHashValue: string): string {
    return `generated_at:${week}:${configHashValue}`;
}

/** Group classified papers into one document per non-empty category. */
function buildDocuments(
    classified: ClassifiedPaper[],
    taxonomy: Config['topics'],
    window: Window,
    configHashValue: string,
    generatedAt: string,
    candidateCount: number,
): DigestDocument[] {
    // A paper with primary + secondary categories appears in both files.
    const byCategory = new Map<string, ClassifiedPaper[]>();
    for (const paper of classified) {
        for (const categoryId of paper.classification.categories) {
            const list = byCategory.get(categoryId) ?? [];
            list.push(paper);
            byCategory.set(categoryId, list);
        }
    }
    return [...byCategory.keys()].sort().map((categoryId) => {
        const topic = taxonomy.topics[categoryId];
        return {
            week: window.week,
            from: window.from.toISOString().slice(0, 10),
            to: window.to.toISOString().slice(0, 10),
            categoryId,
            categoryName: topic?.name ?? categoryId,
            groupId: topic?.groupId,
            groupName: topic?.groupName,
            generatedAt,
            configHash: configHashValue,
            candidateCount,
            papers: byCategory.get(categoryId)!,
        };
    });
}

export async function runDigest(
    cfg: Config,
    window: Window,
    opts: RunOptions,
): Promise<RunResult> {
    const store = new Store(join(opts.root, '.cache/weekly-digest.sqlite'));
    const configHashValue = configHash(cfg);
    const startedMs = Date.now();
    const logger = opts.logger ?? new Logger();
    const invoker = opts.invoker;
    const taxonomy = cfg.topics;

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

        // Persist all crawled papers plus the fetch cache once at the stage
        // boundary; snapshotting per statement was the main IO bottleneck.
        for (const paper of papers.values()) store.savePaper(paper);
        store.flush();

        // Never let a source outage silently produce a "successful" empty digest.
        if (papers.size === 0 && crawlErrorCount > 0) {
            throw new Error(`Source unavailable: all list fetches failed (${crawlErrorCount} error(s))`);
        }

        // Classify every paper; cache hits never invoke the agent. Uncached
        // papers are grouped into fixed-size batches so one LLM call labels
        // several papers at once; a failed batch is retried per paper so one
        // bad response does not lose the whole batch.
        const classificationKeys = new Map<string, string>();
        for (const paper of papers.values()) {
            classificationKeys.set(paper.arxivId, classificationCacheKey(paper, cfg));
        }
        const pending: Paper[] = [];
        const results = new Map<string, ClassificationResult>();
        for (const paper of papers.values()) {
            const key = classificationKeys.get(paper.arxivId)!;
            let cached = opts.force ? undefined : store.getClassification(key);
            // Fallback reuse: a row written under an older key (e.g. before a
            // taxonomy edit or a key-format change) is still valid for this
            // paper+content. Taxonomy changes therefore never force a
            // re-classification; only `digest cache clear-classifications` does.
            if (!cached && !opts.force) {
                cached = store.latestClassification(paper.arxivId, paper.contentHash);
            }
            if (cached) {
                results.set(paper.arxivId, cached);
                logger.debug('classify', {
                    arxiv_id: paper.arxivId,
                    category: cached.categories[0],
                    cache_hit: true,
                });
            } else {
                pending.push(paper);
            }
        }
        const limit = pLimit(Math.max(1, cfg.source.concurrency ?? 4));

        const classifyMs = Date.now();
        const batches = chunk(pending, CLASSIFICATION_BATCH_SIZE);
        // New classification rows are serialized at a fixed cadence instead of
        // per statement or once per stage: every 100 LLM results trigger one
        // snapshot so a long run keeps its recent work durable without turning
        // each insert into a full-file rewrite. Cache-hit reads issue no flush.
        const FLUSH_INTERVAL = 100;
        let unsaved = 0;
        const checkpoint = () => {
            unsaved += 1;
            if (unsaved < FLUSH_INTERVAL) return;
            unsaved = 0;
            store.flush();
        };
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
                            cfg.llm.model,
                            classification,
                        );
                        checkpoint();
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
                                cfg.llm.model,
                                classificationResult,
                            );
                            checkpoint();
                            logger.debug('classify', {
                                arxiv_id: paper.arxivId,
                                category: classificationResult.categories[0],
                                cache_hit: false,
                            });
                        } catch (paperError) {
                            // A single classification failure must not lose the
                            // rest of the run, but the run still reports it.
                            errors += 1;
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
        // Flush the tail below the last 100-paper boundary (no-op for a
        // cache-hit-only run, which never writes classification rows).
        if (unsaved > 0) store.flush();

        const classified = sortPapers(
            [...papers.values()]
                .filter((paper) => results.has(paper.arxivId))
                .map((paper) => ({ ...paper, classification: results.get(paper.arxivId)! })),
        );

        // Byte-identical output on replay: when this run made no new network or
        // agent work, reuse the previous generation time stored in the meta
        // table (keyed by week + config hash) so repeat runs reproduce files.
        const didWork = newFetches || newClassifications > 0;
        const metaKey = generationMetaKey(window.week, configHashValue);
        let generatedAt: string;
        if (didWork) {
            generatedAt = new Date().toISOString();
            store.setMeta(metaKey, generatedAt);
            store.flush();
        } else {
            generatedAt = store.getMeta(metaKey) ?? new Date().toISOString();
        }

        const documents = buildDocuments(
            classified,
            taxonomy,
            window,
            configHashValue,
            generatedAt,
            papers.size,
        );
        const status = errors > 0 || crawlErrorCount > 0 ? 'error' : 'ok';

        if (!opts.dryRun) {
            const outDir = join(opts.root, cfg.output.directory);
            const jsonDir = join(opts.root, cfg.output.json_directory);
            // Two-level layout: one `{week}` subfolder (e.g. "2026-W34") per week.
            const weekDir = join(
                outDir,
                cfg.output.subdirectory.replace('{week}', window.week),
            );
            // JSON twins live in their own tree (same relative layout) so a
            // repository can publish the JSON feed without the Markdown files.
            const jsonWeekDir = join(
                jsonDir,
                cfg.output.subdirectory.replace('{week}', window.week),
            );
            await mkdir(weekDir, { recursive: true });
            await mkdir(jsonWeekDir, { recursive: true });
            const renderer = new MarkdownRenderer();
            const jsonRenderer = new JsonRenderer();
            const files: string[] = [];
            for (const document of documents) {
                const markdown = renderer.render(document);
                const webJson = jsonRenderer.render(document);
                const base = cfg.output.filename
                    .replace('{week}', window.week)
                    .replace('{category}', document.categoryId);
                const file = join(weekDir, base);
                // Atomic write: temp file + rename so readers never see partial output.
                const temporary = `${file}.tmp`;
                await writeFile(temporary, markdown, 'utf8');
                await rename(temporary, file);
                files.push(file);
                // Web twin: same basename, in the separate json_directory tree.
                const jsonFile = join(jsonWeekDir, `${base.slice(0, -(renderer.extension.length + 1))}.json`);
                const jsonTemporary = `${jsonFile}.tmp`;
                await writeFile(jsonTemporary, webJson, 'utf8');
                await rename(jsonTemporary, jsonFile);
                files.push(jsonFile);
            }
            // Manifests are derived by scanning the written JSON documents, so
            // they stay correct no matter which subset of weeks/categories exists.
            refreshManifests(jsonDir, window.week, generatedAt);
            logger.info('run_end', {
                status,
                candidates: papers.size,
                classified: classified.length,
                categories: documents.length,
                errors,
                crawl_errors: crawlErrorCount,
                elapsed_ms: elapsed(startedMs),
            });
            return { files, documents, errors: errors + crawlErrorCount, status };
        }

        logger.info('run_end', {
            status,
            dry_run: true,
            candidates: papers.size,
            classified: classified.length,
            categories: documents.length,
            errors,
            crawl_errors: crawlErrorCount,
            elapsed_ms: elapsed(startedMs),
        });
        return { files: [], documents, errors: errors + crawlErrorCount, status };
    } catch (error) {
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
    week: string;
    markdown: string;
    documents: DigestDocument[];
}

export interface WebBuildResult {
    week: string;
    /** Written .json data files (one per category) + the two manifests. */
    files: string[];
    categories: string[];
    paperCount: number;
}

/**
 * Offline backfill of the static-site data for one week: rebuilds the
 * documents from cached papers + classifications (like preview) and writes
 * the .json twins plus the week and global manifests. No network, no agent.
 */
export async function buildWebDigests(
    root: string,
    cfg: Config,
    week: string,
): Promise<WebBuildResult> {
    const preview = previewDigest(root, cfg, week);
    const jsonDir = join(root, cfg.output.json_directory);
    const weekDir = join(jsonDir, cfg.output.subdirectory.replace('{week}', week));
    await mkdir(weekDir, { recursive: true });
    const jsonRenderer = new JsonRenderer();
    const files: string[] = [];
    const markdownExtensionLength = new MarkdownRenderer().extension.length;
    for (const document of preview.documents) {
        const base = cfg.output.filename
            .replace('{week}', week)
            .replace('{category}', document.categoryId);
        const file = join(weekDir, `${base.slice(0, -(markdownExtensionLength + 1))}.json`);
        const temporary = `${file}.tmp`;
        await writeFile(temporary, jsonRenderer.render(document), 'utf8');
        await rename(temporary, file);
        files.push(file);
    }
    refreshManifests(jsonDir, week, new Date().toISOString());
    files.push(join(weekDir, 'index.json'), join(jsonDir, 'index.json'));
    return {
        week,
        files,
        categories: preview.documents.map((document) => document.categoryId),
        paperCount: preview.documents[0]?.candidateCount ?? 0,
    };
}

/**
 * Rebuild the digest views for a week from stored papers plus the
 * classification cache. No network or agent calls: preview renders the same
 * documents the next `run` for that week would produce.
 */
export function previewDigest(
    root: string,
    cfg: Config,
    week: string,
    categoryId?: string,
): PreviewResult {
    const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
    try {
        const from = weekStart(week);
        if (!from) throw new Error(`Invalid week: ${week}`);
        const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + 7 * 86400000)
            .toISOString()
            .slice(0, 10);
        const papers = store.papersBetween(from, to);
        if (!papers.length) {
            throw new Error(`No cached papers for ${week}; run the digest for that week first`);
        }
        const results = new Map<string, ClassificationResult>();
        for (const paper of papers) {
            const cached =
                store.getClassification(classificationCacheKey(paper, cfg)) ??
                store.latestClassification(paper.arxivId, paper.contentHash);
            if (cached) results.set(paper.arxivId, cached);
        }
        const classified = sortPapers(
            papers
                .filter((paper) => results.has(paper.arxivId))
                .map((paper) => ({ ...paper, classification: results.get(paper.arxivId)! })),
        );
        if (!classified.length) {
            throw new Error(`No cached classifications for ${week}; run the digest first`);
        }
        const documents = buildDocuments(
            classified,
            cfg.topics,
            {
                from: new Date(`${from}T00:00:00Z`),
                to: new Date(`${to}T00:00:00Z`),
                week,
            },
            configHash(cfg),
            new Date().toISOString(),
            papers.length,
        ).filter((document) => !categoryId || document.categoryId === categoryId);
        if (!documents.length) {
            throw new Error(`No snapshot for category ${categoryId} in ${week}`);
        }
        const renderer = new MarkdownRenderer();
        return {
            week,
            documents,
            markdown: documents.map((document) => renderer.render(document)).join(''),
        };
    } finally {
        store.close();
    }
}

/** Monday (UTC) of the ISO week named by `YYYY-Www`. */
function weekStart(week: string): string | undefined {
    const match = /^(\d{4})-W(\d{2})$/.exec(week);
    if (!match) return undefined;
    const year = Number(match[1]);
    const weekNumber = Number(match[2]);
    if (weekNumber < 1 || weekNumber > 53) return undefined;
    // ISO-8601: week 1 contains the first Thursday; Jan 4 is always in week 1.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - day + 1);
    const start = new Date(week1Monday);
    start.setUTCDate(week1Monday.getUTCDate() + (weekNumber - 1) * 7);
    return start.toISOString().slice(0, 10);
}
