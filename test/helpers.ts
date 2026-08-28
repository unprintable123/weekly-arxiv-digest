import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';
import { Store } from '../src/db.js';

const here = fileURLToPath(new URL('.', import.meta.url));

export function makeStore(): { store: Store; dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'weekly-digest-test-'));
    const store = new Store(join(dir, 'cache.sqlite'));
    return {
        store,
        dir,
        cleanup: () => {
            try {
                store.close();
            } catch {
                /* already closed */
            }
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best effort */
            }
        },
    };
}

export interface Route {
    match: (url: string) => boolean;
    status?: number;
    body?: string;
    etag?: string;
    lastModified?: string;
    /** artificial response delay, useful for concurrency assertions */
    delayMs?: number;
}

export interface StubFetchResult {
    calls: string[];
    fn: ReturnType<typeof vi.fn>;
}

/**
 * Stub the global fetch with a route table. Every call's URL is recorded so
 * tests can assert that repeat runs add no network traffic.
 */
export function stubFetch(routes: Route[]): StubFetchResult {
    const calls: string[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        const route = routes.find((item) => item.match(url));
        if (!route) return new Response('route not found', { status: 404 });
        if (route.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, route.delayMs));
        }
        return new Response(route.body ?? '', {
            status: route.status ?? 200,
            headers: {
                'content-type': 'application/xhtml+xml',
                ...(route.etag ? { etag: route.etag } : {}),
                ...(route.lastModified ? { 'last-modified': route.lastModified } : {}),
            },
        });
    });
    vi.stubGlobal('fetch', fn);
    return { calls, fn };
}

export const routeContains = (needle: string, body?: string, status = 200): Route => ({
    match: (url: string) => url.includes(needle),
    status,
    body,
});

export const fixture = (name: string): string =>
    readFileSync(join(here, 'fixtures', name), 'utf8');

export const week = (from: string, to: string): [Date, Date] => [
    new Date(`${from}T00:00:00Z`),
    new Date(`${to}T00:00:00Z`),
];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
