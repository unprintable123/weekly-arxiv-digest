#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { PiAgentAdapter } from './pi.js';
import { runDigest } from './pipeline.js';
import { MarkdownRenderer } from './renderer.js';
import type { DigestPaper } from './types.js';
import { weekWindow } from './window.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0] || 'help';

const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};

async function main(): Promise<void> {
    if (command === 'help' || command === '--help') {
        console.log(
            'pnpm digest run [--from YYYY-MM-DD --to YYYY-MM-DD] [--config config.yaml] [--force]\n' +
            'pnpm digest preview --week YYYY-Www\n' +
            'pnpm digest retry --run <run-id> --stage fetch|score|translate\n' +
            'pnpm digest cache stats|prune [--older-than DAYS]',
        );
        return;
    }

    if (command === 'run') {
        const cfg = await loadConfig(join(root, value('--config') || 'config.yaml'));
        const window = weekWindow(value('--from'), value('--to'));
        const result = await runDigest(cfg, window, {
            root,
            force: args.includes('--force'),
            invoker: new PiAgentAdapter(),
        });
        console.log(
            JSON.stringify({
                run_id: result.runId,
                file: result.file,
                stats: {
                    candidates: result.document.candidateCount,
                    included: result.document.includedCount,
                    errors: result.errors,
                },
            }),
        );
        if (result.errors) process.exitCode = 1;
        return;
    }

    if (command === 'retry') {
        const runId = value('--run');
        const stage = value('--stage');
        if (!runId || !['fetch', 'score', 'translate'].includes(stage || '')) {
            throw new Error('Usage: retry --run RUN_ID --stage fetch|score|translate');
        }
        const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
        const run = store.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as any;
        store.close();
        if (!run) throw new Error(`Unknown run: ${runId}`);
        const cfg = await loadConfig(join(root, value('--config') || 'config.yaml'));
        const result = await runDigest(
            cfg,
            weekWindow(run.from_date.slice(0, 10), run.to_date.slice(0, 10)),
            { root, force: true, invoker: new PiAgentAdapter() },
        );
        console.log(
            JSON.stringify({
                run_id: result.runId,
                retried_stage: stage,
                file: result.file,
                errors: result.errors,
            }),
        );
        if (result.errors) process.exitCode = 1;
        return;
    }

    if (command === 'cache') {
        const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
        try {
            if (args[1] === 'stats') {
                console.log(JSON.stringify(store.stats()));
            } else if (args[1] === 'prune') {
                console.log(JSON.stringify({ deleted: store.prune(Number(value('--older-than') || 30)) }));
            } else {
                throw new Error('Usage: cache stats|prune');
            }
        } finally {
            store.close();
        }
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

async function preview(week: string): Promise<void> {
    const cfg = await loadConfig(join(root, value('--config') || 'config.yaml'));
    const store = new Store(join(root, '.cache/weekly-digest.sqlite'));
    const run = store.latestRun(week);
    if (!run) throw new Error(`No completed run for ${week}`);
    const rows = store.listRunPapers(run.run_id).filter((row) => row.included);
    const papers: DigestPaper[] = rows.map((row) => ({
        ...row,
        arxivId: row.arxiv_id,
        version: row.version || undefined,
        authors: JSON.parse(row.authors_json || '[]'),
        categories: JSON.parse(row.categories_json || '[]'),
        abstractEn: row.abstract_en,
        publishedAt: row.published_at,
        updatedAt: row.updated_at || undefined,
        detailUrl: row.detail_url,
        sourceUrl: row.source_url,
        contentHash: row.content_hash,
        relevance:
            store.latestRelevance(row.arxiv_id) || {
                score: 10,
                reason: 'No interest filter configured',
                categories: ['interest-general'],
                tags: [],
            },
        translationZh: store.latestTranslation(row.arxiv_id) || '',
    }));
    const document = {
        week,
        from: run.from_date.slice(0, 10),
        to: run.to_date.slice(0, 10),
        generatedAt: run.ended_at,
        configHash: run.config_hash,
        candidateCount: JSON.parse(run.stats_json).candidates,
        includedCount: papers.length,
        categories: cfg.interestCategories.length
            ? cfg.interestCategories
            : [{ id: 'interest-general', name: 'General relevance', order: 1 }],
        papers,
    };
    console.log(new MarkdownRenderer().render(document));
    store.close();
}

if (command === 'preview') {
    preview(value('--week') || '').catch((error) => {
        console.error(`error: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
    });
} else {
    main().catch((error) => {
        console.error(`error: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
    });
}

