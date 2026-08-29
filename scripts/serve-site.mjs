/**
 * Tiny local static server for dist/site with SPA-safe fallback to
 * index.html. No dependencies: uses only node:http/node:fs. Expected usage:
 * `pnpm site:build && pnpm site:serve` (or `serve` directly after the first
 * build). Options: PORT (default 4173), HOST (default 127.0.0.1).
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'site');
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '127.0.0.1';

if (!existsSync(join(root, 'index.html'))) {
    console.error('error: dist/site/index.html is missing; run `pnpm site:build` first');
    process.exit(1);
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
};

createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    // Resolve within root and reject traversal outside it.
    const resolved = resolve(join(root, normalize(pathname).replace(/^([/\\])+/, '')));
    if (!resolved.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    let filePath = resolved;
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        // SPA fallback: unknown non-asset paths serve the shell.
        filePath = join(root, 'index.html');
    }
    const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    createReadStream(filePath).pipe(res);
}).listen(port, host, () => {
    console.log(JSON.stringify({ url: `http://${host}:${port}/`, root }));
});
