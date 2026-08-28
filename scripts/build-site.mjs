/**
 * Build the static site into dist/site (gitignored): the web shell plus the
 * digests data tree. deploy-site.mjs then publishes dist/site to gh-pages.
 * No bundler: assets are copied verbatim; the Tailwind step runs separately
 * via `pnpm site:css` (chosen dist CSS is committed so Pages needs no build).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');
const digestsDir = join(root, 'digests');
const outDir = join(root, 'dist', 'site');

const digestsDataDir = join(digestsDir);
if (!existsSync(join(digestsDataDir, 'index.json'))) {
    console.error('error: digests/index.json is missing; run `pnpm digest web build --week YYYY-Www` first');
    process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Site shell: index.html + built assets (app.css is produced by site:css,
// app.js is plain ES module and copied as-is).
cpSync(join(webDir, 'index.html'), join(outDir, 'index.html'));
cpSync(join(webDir, 'assets'), join(outDir, 'assets'), { recursive: true });

// Digest data: the whole digests/ tree (manifests + per-week JSON/Markdown).
cpSync(digestsDataDir, join(outDir, 'digests'), { recursive: true });

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
