import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import type { Paper } from './types.js';
import { hash, sleep } from './util.js';
import type { Store } from './db.js';
import type { Logger } from './log.js';

export type SourceProvider = 'papers.cool' | 'arxiv';
export type CrawlStage = 'list' | 'detail' | 'fallback';

export interface CrawlError {
  stage: CrawlStage;
  category?: string;
  arxivId?: string;
  url: string;
  message: string;
}

export interface CrawlResult {
  papers: Paper[];
  errors: CrawlError[];
  /** true when at least one HTTP request actually went to the network */
  newFetches: boolean;
}

export interface PaperCrawler {
  fetchCategory(category: string, from: Date, to: Date): Promise<CrawlResult>;
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
  /** max papers to keep after list dedup (0/undefined = unlimited) */
  maxPapers?: number;
  /** max concurrent detail/fallback requests */
  concurrency?: number;
  /** optional structured logger; detailed crawler events are debug-level */
  logger?: Logger;
}

type FetchOptions = { accept: string };
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRIES = 3;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;
/** Hard cap for the papers.cool `show` parameter; the endpoint has no page parameter. */
const MAX_LIST_SHOW = 1000;

function trimText(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the abstract text: normalize whitespace first so a leading
 * newline/indent before the "Abstract:" label cannot defeat the prefix strip.
 */
function abstractText(value: string | undefined | null): string {
  return trimText(value).replace(/^Abstract:\s*/i, '').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private networkFetches = 0;
  private cacheHits = 0;

  constructor(
    private readonly store: Store,
    private readonly opts: CrawlerOptions,
    private readonly provider: SourceProvider,
  ) { }

  get stats(): { networkFetches: number; cacheHits: number } {
    return { networkFetches: this.networkFetches, cacheHits: this.cacheHits };
  }

  async text(url: string, options: FetchOptions): Promise<string> {
    const requestStarted = Date.now();
    const cached = this.store.getFetch(url) as any;
    const cacheValid = cached?.expires_at && new Date(cached.expires_at).getTime() > Date.now();
    if (
      !this.opts.force &&
      cacheValid &&
      cached.status === 200 &&
      typeof cached.body === 'string' &&
      cached.body.length > 0
    ) {
      this.cacheHits += 1;
      this.opts.logger?.debug('crawl_http_cache_hit', {
        provider: this.provider,
        url,
        http_status: cached.status,
      });
      return cached.body;
    }

    let lastError: unknown = new Error(`Unable to fetch ${url}`);
    const attempts = Math.max(1, this.opts.retries ?? DEFAULT_RETRIES);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.opts.logger?.debug('crawl_http_request', {
          provider: this.provider,
          url,
          attempt: attempt + 1,
          attempts,
        });
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), this.opts.timeout);
        const headers: Record<string, string> = {
          'User-Agent': this.opts.userAgent,
          Accept: options.accept,
        };
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        if (cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;
        this.networkFetches += 1;
        const response = await fetch(url, { signal: controller.signal, headers });
        this.opts.logger?.debug('crawl_http_response', {
          provider: this.provider,
          url,
          http_status: response.status,
          attempt: attempt + 1,
          elapsed_ms: Date.now() - requestStarted,
        });
        if (response.status === 304 && cached?.body) {
          this.store.saveFetch(url, {
            status: 200,
            body: cached.body,
            bodyHash: cached.body_hash || hash(cached.body),
            etag: cached.etag,
            lastModified: cached.last_modified,
            expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
          });
          this.opts.logger?.debug('crawl_http_not_modified', {
            provider: this.provider,
            url,
            elapsed_ms: Date.now() - requestStarted,
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
        this.opts.logger?.debug('crawl_http_success', {
          provider: this.provider,
          url,
          http_status: response.status,
          bytes: Buffer.byteLength(body, 'utf8'),
          elapsed_ms: Date.now() - requestStarted,
        });
        return body;
      } catch (error) {
        lastError = error;
        const retryDelayMs = 250 * 2 ** attempt;
        if (attempt + 1 < attempts) {
          this.opts.logger?.warn('crawl_http_retry', {
            provider: this.provider,
            url,
            attempt: attempt + 1,
            next_attempt: attempt + 2,
            retry_delay_ms: retryDelayMs,
            error: errorMessage(error),
          });
          await sleep(retryDelayMs);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.opts.logger?.error('crawl_http_failure', {
      provider: this.provider,
      url,
      attempts,
      elapsed_ms: Date.now() - requestStarted,
      error: errorMessage(lastError),
    });
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
    this.http = new HttpClient(store, this.opts, 'papers.cool');
  }

  async fetchCategory(category: string, from: Date, to: Date): Promise<CrawlResult> {
    const found = new Map<string, Paper>();
    const errors: CrawlError[] = [];
    const startFetches = this.http.stats.networkFetches;
    const startCacheHits = this.http.stats.cacheHits;
    this.opts.logger?.debug('crawl_category_start', {
      provider: 'papers.cool',
      category,
      from: dateOnly(from),
      to: dateOnly(to),
      force: !!this.opts.force,
    });
    // papers.cool's category endpoint is a daily page with `date` and `show`
    // parameters only — there is no pagination. One request per day returns
    // the full list for that day, so `show` is raised to cover the whole day.
    for (
      let day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
      day < to;
      day = new Date(day.getTime() + DAY_MS)
    ) {
      const url = new URL(`${this.opts.baseUrl}/arxiv/${encodeURIComponent(category)}`);
      url.searchParams.set('date', dateOnly(day));
      url.searchParams.set('show', String(Math.max(this.opts.pageSize ?? DEFAULT_PAGE_SIZE, MAX_LIST_SHOW)));
      let html: string;
      try {
        html = await this.http.text(url.toString(), { accept: 'text/html,application/xhtml+xml' });
      } catch (error) {
        errors.push({
          stage: 'list',
          category,
          url: url.toString(),
          message: errorMessage(error),
        });
        continue;
      }
      const $ = cheerio.load(html);
      const items = $('div.panel.paper');
      this.opts.logger?.debug('crawl_list_page', {
        provider: 'papers.cool',
        category,
        date: dateOnly(day),
        items: items.length,
      });
      for (const element of items.toArray()) {
        const paper = this.parseListItem($, element, url.toString());
        if (!paper || !withinWindow(paper.publishedAt, from, to)) continue;
        found.set(paper.arxivId, chooseLatest(found.get(paper.arxivId), paper));
      }
    }

    let candidates = [...found.values()];
    this.opts.logger?.debug('crawl_candidates', {
      provider: 'papers.cool',
      category,
      unique_candidates: candidates.length,
    });
    if (this.opts.maxPapers && candidates.length > this.opts.maxPapers) {
      candidates = candidates.sort((a, b) => a.arxivId.localeCompare(b.arxivId)).slice(0, this.opts.maxPapers);
      errors.push({
        stage: 'list',
        category,
        url: `${this.opts.baseUrl}/arxiv/${category}`,
        message: `candidate cap reached (max_papers=${this.opts.maxPapers})`,
      });
    }

    const detailed = new Map<string, Paper>();
    // List items already carry title, authors, categories, date and abstract,
    // so no per-paper detail requests are made. The arXiv fallback only runs
    // for the rare list item that is missing an abstract.
    const missingAbstract = candidates.filter((paper) => !paper.abstractEn);
    this.opts.logger?.debug('crawl_list_complete', {
      provider: 'papers.cool',
      category,
      papers: candidates.length,
      missing_abstract: missingAbstract.length,
    });
    const limit = pLimit(this.opts.concurrency ?? DEFAULT_CONCURRENCY);
    const tasks = missingAbstract.map((paper) =>
      limit(async () => {
        this.opts.logger?.debug('crawl_fallback_start', {
          provider: 'papers.cool',
          category,
          arxiv_id: paper.arxivId,
        });
        const fallback = await this.fetchArxivFallback(paper, category, errors);
        this.opts.logger?.debug('crawl_fallback_result', {
          provider: 'papers.cool',
          category,
          arxiv_id: paper.arxivId,
          found: !!fallback?.abstractEn,
        });
        if (!fallback) {
          errors.push({
            stage: 'fallback',
            category,
            arxivId: paper.arxivId,
            url: `${this.opts.baseUrl}/arxiv/${paper.arxivId}`,
            message: 'missing abstract after list page and arXiv fallback',
          });
          return;
        }
        const merged = mergePaper(paper, fallback);
        if (withinWindow(merged.publishedAt, from, to)) detailed.set(merged.arxivId, merged);
      }),
    );
    await Promise.all(tasks);
    for (const paper of candidates) {
      if (paper.abstractEn) detailed.set(paper.arxivId, paper);
    }

    this.opts.logger?.debug('crawl_category_end', {
      provider: 'papers.cool',
      category,
      papers: detailed.size,
      errors: errors.length,
      network_fetches: this.http.stats.networkFetches - startFetches,
      cache_hits: this.http.stats.cacheHits - startCacheHits,
    });

    return {
      papers: [...detailed.values()].sort((a, b) => a.arxivId.localeCompare(b.arxivId)),
      errors,
      newFetches: this.http.stats.networkFetches > startFetches,
    };
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

  private async fetchArxivFallback(
    base: Paper,
    category: string,
    errors: CrawlError[],
  ): Promise<Partial<Paper> | undefined> {
    const fallbackBase = baseUrl(this.opts.arxivBaseUrl ?? 'https://arxiv.org');
    const url = `${fallbackBase}/abs/${base.arxivId}${base.version ?? ''}`;
    try {
      const html = await this.http.text(url, { accept: 'text/html,application/xhtml+xml' });
      const $ = cheerio.load(html);
      const abstractEn = abstractText($('blockquote.abstract').first().text());
      if (!abstractEn) {
        errors.push({
          stage: 'fallback',
          category,
          arxivId: base.arxivId,
          url,
          message: 'arXiv fallback returned no abstract',
        });
        return undefined;
      }
      return { abstractEn, detailUrl: url };
    } catch (error) {
      errors.push({
        stage: 'fallback',
        category,
        arxivId: base.arxivId,
        url,
        message: errorMessage(error),
      });
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
    this.http = new HttpClient(store, this.opts, 'arxiv');
  }

  async fetchCategory(category: string, from: Date, to: Date): Promise<CrawlResult> {
    const found = new Map<string, Paper>();
    const errors: CrawlError[] = [];
    const startFetches = this.http.stats.networkFetches;
    const startCacheHits = this.http.stats.cacheHits;
    this.opts.logger?.debug('crawl_category_start', {
      provider: 'arxiv',
      category,
      from: dateOnly(from),
      to: dateOnly(to),
      force: !!this.opts.force,
    });
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
      } catch (error) {
        errors.push({
          stage: 'list',
          category,
          url: url.toString(),
          message: errorMessage(error),
        });
        break;
      }
      const $ = cheerio.load(xml, { xmlMode: true });
      const entries = $('entry');
      this.opts.logger?.debug('crawl_list_page', {
        provider: 'arxiv',
        category,
        start,
        page_size: pageSize,
        entries: entries.length,
      });
      if (entries.length === 0) break;
      for (const element of entries.toArray()) {
        const paper = this.parseEntry($, element, url.toString());
        if (!paper || !withinWindow(paper.publishedAt, from, to)) continue;
        found.set(paper.arxivId, chooseLatest(found.get(paper.arxivId), paper));
      }
      if (entries.length < pageSize) break;
    }

    let papers = [...found.values()];
    this.opts.logger?.debug('crawl_candidates', {
      provider: 'arxiv',
      category,
      unique_candidates: papers.length,
    });
    if (this.opts.maxPapers && papers.length > this.opts.maxPapers) {
      papers = papers.sort((a, b) => a.arxivId.localeCompare(b.arxivId)).slice(0, this.opts.maxPapers);
      errors.push({
        stage: 'list',
        category,
        url: `${this.opts.baseUrl}/api/query`,
        message: `candidate cap reached (max_papers=${this.opts.maxPapers})`,
      });
    }

    this.opts.logger?.debug('crawl_category_end', {
      provider: 'arxiv',
      category,
      papers: papers.length,
      errors: errors.length,
      network_fetches: this.http.stats.networkFetches - startFetches,
      cache_hits: this.http.stats.cacheHits - startCacheHits,
    });
    return {
      papers: papers.sort((a, b) => a.arxivId.localeCompare(b.arxivId)),
      errors,
      newFetches: this.http.stats.networkFetches > startFetches,
    };
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

export interface CreateCrawlerOptions {
  baseUrl: string;
  arxivBaseUrl: string;
  delay: number;
  timeout: number;
  userAgent: string;
  force?: boolean;
  maxPapers?: number;
  concurrency?: number;
  logger?: Logger;
}

export function createCrawler(
  provider: SourceProvider,
  store: Store,
  opts: CreateCrawlerOptions,
): PaperCrawler {
  if (provider === 'papers.cool') {
    return new PapersCoolCrawler(store, {
      baseUrl: opts.baseUrl,
      arxivBaseUrl: opts.arxivBaseUrl,
      delay: opts.delay,
      timeout: opts.timeout,
      userAgent: opts.userAgent,
      force: opts.force,
      maxPapers: opts.maxPapers,
      concurrency: opts.concurrency,
      logger: opts.logger,
    });
  }
  if (provider === 'arxiv') {
    return new ArxivCrawler(store, {
      baseUrl: opts.arxivBaseUrl,
      delay: opts.delay,
      timeout: opts.timeout,
      userAgent: opts.userAgent,
      force: opts.force,
      maxPapers: opts.maxPapers,
      concurrency: opts.concurrency,
      logger: opts.logger,
    });
  }
  throw new Error(`Unsupported source provider: ${String(provider)}`);
}

// Backwards-compatible name for callers that used the original papers.cool crawler.
export const Crawler = PapersCoolCrawler;
