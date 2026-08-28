/**
 * Build the static site into dist/site (gitignored): the web shell plus the
 * JSON digest data tree. deploy-site.mjs then publishes dist/site to gh-pages.
 * Only the JSON feed (json_directory) is shipped — Markdown output never
 * reaches the published site. No bundler: assets are copied verbatim; the
 * Tailwind step runs separately via `pnpm site:css` (chosen dist CSS is
 * committed so Pages needs no build).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');
// The published feed tree: JSON documents + manifests produced by the
// pipeline (config output.json_directory, default `digests-json`).
const jsonDir = join(root, 'digests-json');
const outDir = join(root, 'dist', 'site');

if (!existsSync(join(jsonDir, 'index.json'))) {
    console.error('error: digests-json/index.json is missing; run `pnpm digest web build` first');
    process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Site shell: index.html + built assets (app.css is produced by site:css,
// app.js is plain ES module and copied as-is).
cpSync(join(webDir, 'index.html'), join(outDir, 'index.html'));
cpSync(join(webDir, 'assets'), join(outDir, 'assets'), { recursive: true });

// Digest data: the whole json feed tree (manifests + per-week JSON docs),
// copied under the same `digests/` URL path the viewer expects.
cpSync(jsonDir, join(outDir, 'digests'), { recursive: true });

// GitHub Pages must not run Jekyll on this tree.
writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');

const count = countFiles(outDir);
console.log(JSON.stringify({ out: outDir, files: count }));
if (count === 0) {
    console.error('error: site build produced no files');
    process.exit(1);
}

function countFiles(dir) {
    let total = 0;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        total += statSync(full).isDirectory() ? countFiles(full) : 1;
    }
    return total;
}
