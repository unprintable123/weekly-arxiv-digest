#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { Logger } from './log.js';
import { ChatCompletionClient } from './llm.js';
import { previewDigest, runDigest } from './pipeline.js';
import { weekWindow } from './window.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
    loadEnvFile(join(root, '.env'));
} catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const args = process.argv.slice(2);
const command = args[0] || 'help';

const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};

const flag = (name: string): boolean => args.includes(name);

const makeLogger = (): Logger =>
    new Logger({ debug: flag('--debug'), traceFile: value('--trace') });

async function main(): Promise<void> {
    if (command === 'help' || command === '--help') {
        console.log(
            'pnpm digest run [--from YYYY-MM-DD --to YYYY-MM-DD] [--config config.yaml] [--force] [--dry-run] [--debug] [--trace FILE]\n' +
            'pnpm digest preview --week YYYY-Www [--category TOPIC_ID] [--config config.yaml]\n' +
            'pnpm digest cache stats|prune [--older-than DAYS]|clear-classifications [--older-than DAYS]',
        );
        return;
    }

    if (command === 'run') {
        const cfg = await loadConfig(join(root, value('--config') || 'config.yaml'));
        const window = weekWindow(
            value('--from'),
            value('--to'),
            new Date(),
            cfg.window.timezone,
            cfg.window.default,
        );
        const result = await runDigest(cfg, window, {
            root,
            force: flag('--force'),
            dryRun: flag('--dry-run'),
            invoker: new ChatCompletionClient(),
            logger: makeLogger(),
        });
        const uniquePapers = new Set(
            result.documents.flatMap((document) => document.papers.map((paper) => paper.arxivId)),
        );
        console.log(
            JSON.stringify({
                files: result.files,
                categories: result.documents.map((document) => document.categoryId),
                stats: {
                    candidates: result.documents[0]?.candidateCount ?? 0,
                    included: uniquePapers.size,
                    errors: result.errors,
                    status: result.status,
                    dry_run: flag('--dry-run'),
                },
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
            } else if (args[1] === 'clear-classifications') {
                // Drop the stored classification cache so papers are re-classified
                // on the next run (all entries, or only those older than DAYS).
                const raw = value('--older-than');
                const olderThan = raw === undefined ? undefined : Number(raw);
                console.log(JSON.stringify({ deleted: store.clearClassifications(olderThan) }));
            } else {
                throw new Error('Usage: cache stats|prune|clear-classifications');
            }
        } finally {
            store.close();
        }
        return;
    }

    if (command === 'preview') {
        // Preview never touches the network or the agent: it rebuilds the week's
        // documents from stored papers plus the classification cache.
        const cfg = await loadConfig(join(root, value('--config') || 'config.yaml'));
        const preview = previewDigest(root, cfg, value('--week') || '', value('--category'));
        process.stdout.write(preview.markdown.endsWith('\n') ? preview.markdown : `${preview.markdown}\n`);
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
});
