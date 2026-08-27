import * as cheerio from 'cheerio';
import type { Paper } from './types.js';
import { hash, sleep } from './util.js';
import type { Store } from './db.js';

export type SourceProvider = 'papers.cool' | 'arxiv';

export interface PaperCrawler {
  fetchCategory(category: string, from: Date, to: Date): Promise<Paper[]>;
}

export interface CrawlerOptions {
  baseUrl: string;
  delay: number;
  timeout: number;
  userAgent: string;
  arxivBaseUrl?: string;
  retries?: number;
  pageSize?: number;
  force?: boolean;
}

type FetchOptions = { accept: string };
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRIES = 3;
const DEFAULT_PAGE_SIZE = 100;

function trimText(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function baseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string): Date | undefined {
  const text = trimText(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00.000Z`);
  const candidate = /\bUTC$/i.test(text) ? `${text.replace(/\s+UTC$/i, '')}Z` : text;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function versionNumber(version: string | undefined): number {
  const value = Number(version?.slice(1));
  return Number.isFinite(value) ? value : 1;
}

function splitArxivId(value: string): { id: string; version?: string } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim().replace(/\.pdf$/i, '');
  } catch {
    return undefined;
  }
  const match = decoded.match(/(?:^|\/)((?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7}))(v\d+)?$/i);
  if (!match) return undefined;
  return { id: match[1], version: match[2]?.toLowerCase() };
}

function idFromHref(href: string | undefined): { id: string; version?: string } | undefined {
  if (!href) return undefined;
  try {
    const parsed = new URL(href, 'https://papers.cool');
    const path = parsed.pathname.replace(/^\/(?:arxiv|abs)\//, '');
    return splitArxivId(path);
  } catch {
    return splitArxivId(href);
  }
}

function chooseLatest(previous: Paper | undefined, candidate: Paper): Paper {
  if (!previous) return candidate;
  const candidateVersion = versionNumber(candidate.version);
  const previousVersion = versionNumber(previous.version);
  if (candidateVersion > previousVersion) return candidate;
  if (
    candidateVersion === previousVersion &&
    candidate.updatedAt &&
    (!previous.updatedAt || candidate.updatedAt > previous.updatedAt)
  ) {
    return candidate;
  }
  return previous;
}

/** Shared HTTP/cache behavior. It never constructs or requests PDF URLs. */
class HttpClient {
  constructor(
    private readonly store: Store,
    private readonly opts: CrawlerOptions,
  ) { }

  async text(url: string, options: FetchOptions): Promise<string> {
    const cached = this.store.getFetch(url) as any;
    const cacheValid = cached?.expires_at && new Date(cached.expires_at).getTime() > Date.now();
    if (
      !this.opts.force &&
      cacheValid &&
      cached.status === 200 &&
      typeof cached.body === 'string' &&
      cached.body.length > 0
    ) {
      return cached.body;
    }

    let lastError: unknown = new Error(`Unable to fetch ${url}`);
    const attempts = Math.max(1, this.opts.retries ?? DEFAULT_RETRIES);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), this.opts.timeout);
        const headers: Record<string, string> = {
          'User-Agent': this.opts.userAgent,
          Accept: options.accept,
        };
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        if (cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;
        const response = await fetch(url, { signal: controller.signal, headers });
        if (response.status === 304 && cached?.body) {
          this.store.saveFetch(url, {
            status: 200,
            body: cached.body,
            bodyHash: cached.body_hash || hash(cached.body),
            etag: cached.etag,
            lastModified: cached.last_modified,
            expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
          });
          return cached.body;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        const body = await response.text();
        this.store.saveFetch(url, {
          status: response.status,
          body,
          bodyHash: hash(body),
          etag: response.headers.get('etag') ?? '',
          lastModified: response.headers.get('last-modified') ?? '',
          expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
        });
        if (this.opts.delay > 0) await sleep(this.opts.delay);
        return body;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await sleep(250 * 2 ** attempt);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.store.saveFetch(url, { status: 0, body: '', bodyHash: '', error: String(lastError) });
    throw lastError;
  }
}

export class PapersCoolCrawler implements PaperCrawler {
  private readonly http: HttpClient;
  private readonly opts: CrawlerOptions;

  constructor(
    private readonly store: Store,
    options: CrawlerOptions,
  ) {
    this.opts = { ...options, baseUrl: baseUrl(options.baseUrl) };
    this.http = new HttpClient(store, this.opts);
  }

  async fetchCategory(category: string, from: Date, to: Date): Promise<Paper[]> {
    const found = new Map<string, Paper>();
    // papers.cool's category endpoint is a daily page, so a weekly window
    // requires one request sequence for every day in the half-open interval.
    for (
      let day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
      day < to;
      day = new Date(day.getTime() + DAY_MS)
    ) {
      for (let page = 1; page <= 100; page += 1) {
        const url = new URL(`${this.opts.baseUrl}/arxiv/${encodeURIComponent(category)}`);
        url.searchParams.set('date', dateOnly(day));
        url.searchParams.set('show', String(this.opts.pageSize ?? DEFAULT_PAGE_SIZE));
        url.searchParams.set('page', String(page));
        let html: string;
        try {
          html = await this.http.text(url.toString(), { accept: 'text/html,application/xhtml+xml' });
        } catch {
          break;
        }
        const $ = cheerio.load(html);
        const items = $('div.panel.paper');
        if (items.length === 0) break;
        for (const element of items.toArray()) {
          const paper = this.parseListItem($, element, url.toString());
          if (!paper || !withinWindow(paper.publishedAt, from, to)) continue;
          found.set(paper.arxivId, chooseLatest(found.get(paper.arxivId), paper));
        }
        if (items.length < (this.opts.pageSize ?? DEFAULT_PAGE_SIZE)) break;
      }
    }

    const detailed = new Map<string, Paper>();
    for (const paper of found.values()) {
      let merged = paper;
      const detailUrl = this.detailPageUrl(paper.arxivId, paper.version);
      try {
        const html = await this.http.text(detailUrl, { accept: 'text/html,application/xhtml+xml' });
        merged = mergePaper(paper, this.parseDetail(html, detailUrl));
      } catch {
        // Keep list metadata. A missing abstract is handled by the fallback.
      }
      if (!merged.abstractEn) {
        const fallback = await this.fetchArxivFallback(merged);
        if (fallback) merged = mergePaper(merged, fallback);
      }
      if (withinWindow(merged.publishedAt, from, to)) detailed.set(merged.arxivId, merged);
    }
    return [...detailed.values()].sort((a, b) => a.arxivId.localeCompare(b.arxivId));
  }

  private detailPageUrl(id: string, version?: string): string {
    return `${this.opts.baseUrl}/arxiv/${id}${version ?? ''}`;
  }

  private parseListItem($: cheerio.CheerioAPI, element: any, sourceUrl: string): Paper | undefined {
    const node = $(element);
    const rawId = node.attr('id') ?? '';
    const link = node
      .find('a.title-link, a[href*="/arxiv/"], a[href*="arxiv.org/abs/"]')
      .toArray()
      .find((anchor) => idFromHref($(anchor).attr('href')));
    const rawIdentity = splitArxivId(rawId);
    const linkIdentity = idFromHref(link ? $(link).attr('href') : undefined);
    const identity = rawIdentity
      ? { id: rawIdentity.id, version: rawIdentity.version ?? linkIdentity?.version }
      : linkIdentity;
    if (!identity) return undefined;
    const title =
      trimText(node.find('a.title-link').first().text()) || trimText(node.find('h2.title').first().text());
    const published = parseDate(node.find('span.date-data, p.date .date-data, p.date').first().text());
    if (!title || !published) return undefined;
    const authors = node
      .find('a.author')
      .map((_, item) => trimText($(item).text()))
      .get()
      .filter(Boolean);
    const categories = node
      .find('p.subjects a, .subjects a')
      .map((_, item) => trimText($(item).text()))
      .get()
      .filter(Boolean);
    const abstractEn = trimText(node.find('p.summary, .summary').first().text());
    return makePaper({
      arxivId: identity.id,
      version: identity.version,
      title,
      authors,
      categories,
      abstractEn,
      publishedAt: published.toISOString(),
      detailUrl: `https://arxiv.org/abs/${identity.id}${identity.version ?? ''}`,
      sourceUrl,
    });
  }

  private parseDetail(html: string, sourceUrl: string): Partial<Paper> {
    const $ = cheerio.load(html);
    const title = trimText(
      $('h1.title, a.title-link, meta[name="citation_title"]').first().attr('content') ||
      $('h1.title, a.title-link').first().text(),
    );
    const abstractEn = trimText(
      (
        $('p.summary, blockquote.abstract, div.abstract, meta[name="citation_abstract"]').first().attr('content') ||
        $('p.summary, blockquote.abstract, div.abstract').first().text()
      ).replace(/^Abstract:\s*/i, ''),
    );
    const authors = $('a.author, meta[name="citation_author"]')
      .map((_, item) => trimText($(item).attr('content') || $(item).text()))
      .get()
      .filter(Boolean);
    const categories = $('p.subjects a, .subjects a, span.subject a, meta[name="citation_category"]')
      .map((_, item) => trimText($(item).attr('content') || $(item).text()))
      .get()
      .filter(Boolean);
    const published = parseDate(
      $('span.date-data, time[datetime], meta[name="citation_date"]').first().attr('datetime') ||
      $('span.date-data, time[datetime], meta[name="citation_date"]').first().attr('content') ||
      $('span.date-data').first().text(),
    );
    return {
      title: title || undefined,
      abstractEn: abstractEn || undefined,
      authors: unique(authors),
      categories: unique(categories),
      publishedAt: published?.toISOString(),
      sourceUrl,
    };
  }

  private async fetchArxivFallback(base: Paper): Promise<Partial<Paper> | undefined> {
    const fallbackBase = baseUrl(this.opts.arxivBaseUrl ?? 'https://arxiv.org');
    const url = `${fallbackBase}/abs/${base.arxivId}${base.version ?? ''}`;
    try {
      const html = await this.http.text(url, { accept: 'text/html,application/xhtml+xml' });
      const $ = cheerio.load(html);
      const abstractEn = trimText(
        $('blockquote.abstract').first().text().replace(/^Abstract:\s*/i, ''),
      );
      return abstractEn ? { abstractEn, detailUrl: url } : undefined;
    } catch {
      return undefined;
    }
  }
}

/** arXiv's public Atom Export API implementation. It requests metadata only. */
export class ArxivCrawler implements PaperCrawler {
  private readonly http: HttpClient;
  private readonly opts: CrawlerOptions;

  constructor(
    private readonly store: Store,
    options: CrawlerOptions,
  ) {
    this.opts = { ...options, baseUrl: baseUrl(options.baseUrl) };
    this.http = new HttpClient(store, this.opts);
  }

  async fetchCategory(category: string, from: Date, to: Date): Promise<Paper[]> {
    const found = new Map<string, Paper>();
    const startDate = dateOnly(from).replace(/-/g, '');
    const endDate = dateOnly(new Date(to.getTime() - 1)).replace(/-/g, '');
    const pageSize = this.opts.pageSize ?? DEFAULT_PAGE_SIZE;
    for (let start = 0; start < 2000; start += pageSize) {
      const query = `cat:${category} AND submittedDate:[${startDate}0000 TO ${endDate}2359]`;
      const url = new URL(`${this.opts.baseUrl}/api/query`);
      url.searchParams.set('search_query', query);
      url.searchParams.set('start', String(start));
      url.searchParams.set('max_results', String(pageSize));
      url.searchParams.set('sortBy', 'submittedDate');
      url.searchParams.set('sortOrder', 'descending');
      let xml: string;
      try {
        xml = await this.http.text(url.toString(), { accept: 'application/atom+xml, application/xml' });
      } catch {
        break;
      }
      const $ = cheerio.load(xml, { xmlMode: true });
      const entries = $('entry');
      if (entries.length === 0) break;
      for (const element of entries.toArray()) {
        const paper = this.parseEntry($, element, url.toString());
        if (!paper || !withinWindow(paper.publishedAt, from, to)) continue;
        found.set(paper.arxivId, chooseLatest(found.get(paper.arxivId), paper));
      }
      if (entries.length < pageSize) break;
    }
    return [...found.values()].sort((a, b) => a.arxivId.localeCompare(b.arxivId));
  }

  private parseEntry($: cheerio.CheerioAPI, element: any, sourceUrl: string): Paper | undefined {
    const node = $(element);
    const identity = idFromHref(trimText(node.find('id').first().text()));
    if (!identity) return undefined;
    const title = trimText(node.find('title').first().text());
    const abstractEn = trimText(node.find('summary').first().text());
    const published = parseDate(node.find('published').first().text());
    if (!title || !published) return undefined;
    const updated = parseDate(node.find('updated').first().text());
    const authors = node
      .find('author name')
      .map((_, item) => trimText($(item).text()))
      .get()
      .filter(Boolean);
    const categories = node
      .find('category')
      .map((_, item) => trimText($(item).attr('term')))
      .get()
      .filter(Boolean);
    return makePaper({
      arxivId: identity.id,
      version: identity.version,
      title,
      authors,
      categories,
      abstractEn,
      publishedAt: published.toISOString(),
      updatedAt: updated?.toISOString(),
      detailUrl: `https://arxiv.org/abs/${identity.id}${identity.version ?? ''}`,
      sourceUrl,
    });
  }
}

function withinWindow(value: string, from: Date, to: Date): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= from && date < to;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(trimText).filter(Boolean))];
}

function makePaper(input: Omit<Paper, 'contentHash'>): Paper {
  return {
    ...input,
    authors: unique(input.authors),
    categories: unique(input.categories),
    contentHash: hash({ title: input.title, abstract: input.abstractEn }),
  };
}

function mergePaper(base: Paper, patch: Partial<Paper>): Paper {
  return makePaper({
    ...base,
    ...patch,
    arxivId: base.arxivId,
    version: patch.version ?? base.version,
    title: patch.title || base.title,
    authors: patch.authors?.length ? patch.authors : base.authors,
    categories: patch.categories?.length ? patch.categories : base.categories,
    abstractEn: patch.abstractEn || base.abstractEn,
    publishedAt: patch.publishedAt || base.publishedAt,
    detailUrl: patch.detailUrl || base.detailUrl,
    sourceUrl: base.sourceUrl,
  });
}

export function createCrawler(
  provider: SourceProvider,
  store: Store,
  opts: { baseUrl: string; arxivBaseUrl: string; delay: number; timeout: number; userAgent: string; force?: boolean },
): PaperCrawler {
  if (provider === 'papers.cool') {
    return new PapersCoolCrawler(store, {
      baseUrl: opts.baseUrl,
      arxivBaseUrl: opts.arxivBaseUrl,
      delay: opts.delay,
      timeout: opts.timeout,
      userAgent: opts.userAgent,
      force: opts.force,
    });
  }
  if (provider === 'arxiv') {
    return new ArxivCrawler(store, {
      baseUrl: opts.arxivBaseUrl,
      delay: opts.delay,
      timeout: opts.timeout,
      userAgent: opts.userAgent,
      force: opts.force,
    });
  }
  throw new Error(`Unsupported source provider: ${String(provider)}`);
}

// Backwards-compatible name for callers that used the original papers.cool crawler.
export const Crawler = PapersCoolCrawler;
