import { describe, expect, it, vi } from 'vitest';
import { ArxivCrawler, PapersCoolCrawler } from '../src/crawler.js';
import { Logger } from '../src/log.js';
import { fixture, makeStore, routeContains, stubFetch, week } from './helpers.js';

const listHtml = fixture('papers-cool-list.html');
const detailHtml = fixture('papers-cool-detail.html');
const arxivAbsHtml = fixture('arxiv-abs.html');
const atomXml = fixture('arxiv-atom.xml');

const baseOptions = {
    baseUrl: 'https://papers.cool',
    arxivBaseUrl: 'https://export.arxiv.org',
    delay: 0,
    timeout: 5000,
    userAgent: 'weekly-digest-test/0.1',
};

describe('PapersCoolCrawler', () => {
    it('emits structured debug events without logging response bodies or abstracts', async () => {
        const { store, cleanup } = makeStore();
        let output = '';
        const logger = new Logger({
            debug: true,
            stream: { write: (chunk: string) => { output += chunk; return true; } } as NodeJS.WritableStream,
        });
        const crawler = new PapersCoolCrawler(store, { ...baseOptions, logger });
        stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            routeContains('/arxiv/2401.01234', detailHtml),
            routeContains('/arxiv/2401.01235', detailHtml),
        ]);

        await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));
        await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        const events = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.some((entry) => entry.event === 'crawl_category_start')).toBe(true);
        expect(events.some((entry) => entry.event === 'crawl_list_page')).toBe(true);
        expect(events.some((entry) => entry.event === 'crawl_detail_success')).toBe(true);
        expect(events.some((entry) => entry.event === 'crawl_http_cache_hit')).toBe(true);
        expect(events.some((entry) => entry.event === 'crawl_category_end')).toBe(true);
        expect(output).not.toContain('enriched abstract');
        expect(output).not.toContain(listHtml);

        cleanup();
    });

    it('parses list items and merges detail page metadata', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, baseOptions);
        const { calls } = stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            routeContains('/arxiv/2401.01234', detailHtml),
            routeContains('/arxiv/2401.01235', detailHtml),
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.errors).toEqual([]);
        // 7 days in the window -> 7 list requests, plus 2 detail requests.
        expect(calls.filter((url) => url.includes('/arxiv/cs.LG'))).toHaveLength(7);
        expect(calls.filter((url) => url.includes('/arxiv/2401.'))).toHaveLength(2);
        expect(result.newFetches).toBe(true);
        expect(result.papers).toHaveLength(2);

        const paper = result.papers.find((p) => p.arxivId === '2401.01234')!;
        expect(paper).toBeDefined();
        expect(paper.version).toBeUndefined();
        // Detail page content wins over the list page.
        expect(paper.title).toBe('Attention Is All You Need: A Study of Scalable Attention (Detailed)');
        expect(paper.abstractEn).toBe(
            'This is the enriched abstract from the detail page, with additional experimental context and ablations.',
        );
        expect(paper.authors).toEqual(['Alice Example', 'Bob Sample']);
        expect(paper.categories).toEqual(['cs.LG']);
        expect(paper.publishedAt).toBe('2024-01-02T00:00:00.000Z');
        expect(paper.detailUrl).toBe('https://arxiv.org/abs/2401.01234');
        expect(paper.sourceUrl).toContain('/arxiv/cs.LG');
        expect(paper.contentHash).toBeTruthy();

        cleanup();
    });

    it('filters papers published outside the half-open window', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, baseOptions);
        stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            routeContains('/arxiv/2401.01234', detailHtml),
            routeContains('/arxiv/2401.01235', detailHtml),
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        const ids = result.papers.map((p) => p.arxivId).sort();
        expect(ids).toEqual(['2401.01234', '2401.01235']);
        // 2401.01236 is published 2024-01-09, outside [01-01, 01-08).
        expect(result.papers.some((p) => p.arxivId === '2401.01236')).toBe(false);

        cleanup();
    });

    it('deduplicates by arXiv id and keeps the newest version', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, baseOptions);
        const page = `<!DOCTYPE html><html><body>
      <div class="panel paper" id="2401.01234v1">
        <h2 class="title"><a class="title-link" href="/arxiv/2401.01234v1">Old Version Title</a></h2>
        <p class="date"><span class="date-data">2024-01-01</span></p>
        <p class="authors"><a class="author" href="/a/a">Alice</a></p>
        <p class="subjects"><a href="/cat/cs.LG">cs.LG</a></p>
        <p class="summary">Abstract v1.</p>
      </div>
      <div class="panel paper" id="2401.01234v2">
        <h2 class="title"><a class="title-link" href="/arxiv/2401.01234v2">New Version Title</a></h2>
        <p class="date"><span class="date-data">2024-01-02</span></p>
        <p class="authors"><a class="author" href="/a/a">Alice</a></p>
        <p class="subjects"><a href="/cat/cs.LG">cs.LG</a></p>
        <p class="summary">Abstract v2.</p>
      </div>
    </body></html>`;
        stubFetch([
            routeContains('/arxiv/cs.LG', page),
            routeContains('/arxiv/2401.01234v2', detailHtml),
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(1);
        expect(result.papers[0].arxivId).toBe('2401.01234');
        expect(result.papers[0].version).toBe('v2');
        // Detail request used the latest version URL.
        expect(result.papers[0].sourceUrl).toBeDefined();

        cleanup();
    });

    it('uses the arXiv fallback when the detail page has no abstract', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, baseOptions);
        const page = `<!DOCTYPE html><html><body>
      <div class="panel paper" id="2401.01234">
        <h2 class="title"><a class="title-link" href="/arxiv/2401.01234">Fallback Paper</a></h2>
        <p class="date"><span class="date-data">2024-01-01</span></p>
        <p class="authors"><a class="author" href="/a/a">Alice</a></p>
        <p class="subjects"><a href="/cat/cs.LG">cs.LG</a></p>
      </div>
    </body></html>`;
        stubFetch([
            routeContains('/arxiv/cs.LG', page),
            // No route for the papers.cool detail page -> HTTP 404 recorded.
            routeContains('/abs/2401.01234', arxivAbsHtml),
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(1);
        const paper = result.papers[0];
        expect(paper.abstractEn).toBe(
            'This abstract comes from the arXiv fallback page because the papers.cool detail page had no abstract.',
        );
        expect(paper.detailUrl).toBe('https://export.arxiv.org/abs/2401.01234');
        // The failed detail attempt is surfaced, not silently swallowed.
        expect(result.errors.some((e) => e.stage === 'detail' && e.arxivId === '2401.01234')).toBe(true);

        cleanup();
    });

    it('records an error and skips a paper with no abstract anywhere', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, baseOptions);
        const page = `<!DOCTYPE html><html><body>
      <div class="panel paper" id="2401.01234">
        <h2 class="title"><a class="title-link" href="/arxiv/2401.01234">No Abstract Paper</a></h2>
        <p class="date"><span class="date-data">2024-01-01</span></p>
        <p class="authors"><a class="author" href="/a/a">Alice</a></p>
        <p class="subjects"><a href="/cat/cs.LG">cs.LG</a></p>
      </div>
    </body></html>`;
        stubFetch([
            routeContains('/arxiv/cs.LG', page),
            // Neither detail nor fallback resolves.
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(0);
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
        expect(result.errors.some((e) => e.stage === 'fallback' && e.arxivId === '2401.01234')).toBe(true);
        expect(
            result.errors.some((e) => e.message.includes('missing abstract') && e.arxivId === '2401.01234'),
        ).toBe(true);

        cleanup();
    });

    it('records list fetch failures instead of silently returning an empty digest', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, { ...baseOptions, retries: 0 });
        stubFetch([routeContains('/arxiv/cs.LG', '', 500)]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(0);
        expect(result.newFetches).toBe(true);
        expect(result.errors.every((e) => e.stage === 'list')).toBe(true);
        expect(result.errors.length).toBeGreaterThan(0);

        cleanup();
    });

    it('serves repeat fetches from cache with no additional network traffic', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, baseOptions);
        const { calls } = stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            routeContains('/arxiv/2401.01234', detailHtml),
            routeContains('/arxiv/2401.01235', detailHtml),
        ]);

        const first = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));
        const networkCalls = calls.length;
        expect(first.papers).toHaveLength(2);

        const second = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));
        expect(calls.length).toBe(networkCalls); // no new network requests
        expect(second.newFetches).toBe(false);
        expect(second.papers).toEqual(first.papers);

        cleanup();
    });

    it('force option bypasses the fetch cache', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, { ...baseOptions, force: true });
        const { calls } = stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            routeContains('/arxiv/2401.01234', detailHtml),
            routeContains('/arxiv/2401.01235', detailHtml),
        ]);

        await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));
        const afterFirst = calls.length;
        const second = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(calls.length).toBeGreaterThan(afterFirst);
        expect(second.newFetches).toBe(true);

        cleanup();
    });

    it('handles pagination across multiple list pages', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, { ...baseOptions, pageSize: 2 });
        const page = (ids: string[]) => `<!DOCTYPE html><html><body>
      ${ids
                .map(
                    (id) => `<div class="panel paper" id="${id}">
        <h2 class="title"><a class="title-link" href="/arxiv/${id}">Paper ${id}</a></h2>
        <p class="date"><span class="date-data">2024-01-01</span></p>
        <p class="authors"><a class="author" href="/a/a">Alice</a></p>
        <p class="subjects"><a href="/cat/cs.LG">cs.LG</a></p>
        <p class="summary">Abstract for ${id}.</p>
      </div>`,
                )
                .join('')}
    </body></html>`;
        const detail = (id: string) =>
            `<!DOCTYPE html><html><body><h1 class="title">Paper ${id} Detailed</h1><p class="summary">Detailed abstract for ${id}.</p><span class="date-data">2024-01-01</span></body></html>`;
        const ids = ['2401.00001', '2401.00002', '2401.00003'];
        stubFetch([
            routeContains('page=1', page(['2401.00001', '2401.00002'])),
            routeContains('page=2', page(['2401.00003'])),
            ...ids.map((id) => ({ match: (url: string) => url.endsWith(`/arxiv/${id}`), body: detail(id) })),
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-02'));

        const papers = [...result.papers].sort((a, b) => a.arxivId.localeCompare(b.arxivId));
        expect(papers.map((p) => p.arxivId)).toEqual(['2401.00001', '2401.00002', '2401.00003']);
        expect(papers[0].title).toBe('Paper 2401.00001 Detailed');
        expect(result.errors).toEqual([]);

        cleanup();
    });

    it('caps candidates with maxPapers deterministically', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, { ...baseOptions, maxPapers: 1 });
        stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            routeContains('/arxiv/2401.01234', detailHtml),
            routeContains('/arxiv/2401.01235', detailHtml),
        ]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(1);
        expect(result.papers[0].arxivId).toBe('2401.01234'); // lowest id wins deterministically
        expect(result.errors.some((e) => e.message.includes('cap reached'))).toBe(true);

        cleanup();
    });

    it('runs detail fetching with bounded concurrency', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new PapersCoolCrawler(store, { ...baseOptions, concurrency: 2, delay: 0 });
        let active = 0;
        let peak = 0;
        stubFetch([
            routeContains('/arxiv/cs.LG', listHtml),
            {
                match: (url: string) => url.includes('/arxiv/2401.'),
                body: detailHtml,
                delayMs: 20,
            },
            {
                match: () => false,
                body: '',
            },
        ]);
        // Re-stub with an active-counter wrapper around the detail route.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                if (url.includes('/arxiv/2401.')) {
                    active += 1;
                    peak = Math.max(peak, active);
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    const response = new Response(detailHtml, { status: 200 });
                    active -= 1;
                    return response;
                }
                return new Response(listHtml, { status: 200 });
            }),
        );

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(2);
        // With concurrency=2, at most 2 detail requests run at the same time.
        expect(peak).toBeLessThanOrEqual(2);

        cleanup();
    });
});

describe('ArxivCrawler', () => {
    it('parses Atom entries with id, version, metadata and abstract', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new ArxivCrawler(store, { ...baseOptions, baseUrl: 'https://export.arxiv.org' });
        stubFetch([routeContains('/api/query', atomXml)]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.errors).toEqual([]);
        expect(result.papers).toHaveLength(2);
        const paper = result.papers.find((p) => p.arxivId === '2401.01234')!;
        expect(paper.version).toBe('v1');
        expect(paper.title).toBe('Atom Entry Title for Attention');
        expect(paper.abstractEn).toBe('This is the abstract from the arXiv Atom export API.');
        expect(paper.authors).toEqual(['Alice Example', 'Bob Sample']);
        expect(paper.categories).toEqual(['cs.LG', 'cs.AI']);
        expect(paper.publishedAt).toBe('2024-01-01T00:00:00.000Z');
        expect(paper.updatedAt).toBe('2024-01-01T10:00:00.000Z');
        expect(paper.detailUrl).toBe('https://arxiv.org/abs/2401.01234v1');

        cleanup();
    });

    it('records list failures as crawl errors', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new ArxivCrawler(store, {
            ...baseOptions,
            baseUrl: 'https://export.arxiv.org',
            retries: 0,
        });
        stubFetch([routeContains('/api/query', '', 503)]);

        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-08'));

        expect(result.papers).toHaveLength(0);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.every((e) => e.stage === 'list')).toBe(true);

        cleanup();
    });

    it('filters Atom entries outside the window', async () => {
        const { store, cleanup } = makeStore();
        const crawler = new ArxivCrawler(store, { ...baseOptions, baseUrl: 'https://export.arxiv.org' });
        stubFetch([routeContains('/api/query', atomXml)]);

        // Only 2401.01234 (2024-01-01) is inside [01-01, 01-02).
        const result = await crawler.fetchCategory('cs.LG', ...week('2024-01-01', '2024-01-02'));

        expect(result.papers.map((p) => p.arxivId)).toEqual(['2401.01234']);

        cleanup();
    });
});
