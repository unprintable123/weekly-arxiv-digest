import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';
import { parseTaxonomy, type TopicTaxonomy } from '../src/topics.js';
import { Store } from '../src/db.js';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Tests must never depend on the repository TOPICS.yaml: a standalone English
 * fixture keeps classification tests stable while the real vocabulary evolves.
 */
export const fixtureTopicsPath = join(here, 'fixtures', 'topics.yaml');

/** Parsed fixture taxonomy (deterministic, independent of repo taxonomy edits). */
export function fixtureTaxonomy(): TopicTaxonomy {
    return parseTaxonomy(readFileSync(fixtureTopicsPath, 'utf8'));
}

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

/**
 * Create a temp config directory containing the given config.yaml plus a copy
 * of the fixture taxonomy, mirroring the default sibling layout that loadConfig
 * expects. The repository TOPICS.yaml is intentionally not used here.
 */
export function makeConfigDir(configYaml: string): { dir: string; file: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'weekly-digest-config-'));
    const file = join(dir, 'config.yaml');
    writeFileSync(file, configYaml);
    writeFileSync(join(dir, 'TOPICS.yaml'), readFileSync(fixtureTopicsPath, 'utf8'));
    return {
        dir,
        file,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
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
