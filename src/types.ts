export type Paper = {
  arxivId: string;
  version?: string;
  title: string;
  authors: string[];
  categories: string[];
  abstractEn: string;
  publishedAt: string;
  updatedAt?: string;
  detailUrl: string;
  contentHash: string;
};

/** Validated agent classification output. No score, no reason, no translation. */
export type ClassificationResult = {
  /** Canonical topic ids from TOPICS.yaml, primary first, at most `max_categories`. */
  categories: string[];
  /** Lowercase kebab-case tags, at most `max_tags`; may be empty. */
  tags: string[];
  raw?: string;
};

export type ClassifiedPaper = Paper & {
  classification: ClassificationResult;
};

/** Snapshot for exactly one category file of one weekly run. */
export type DigestDocument = {
  week: string;
  from: string;
  to: string;
  categoryId: string;
  categoryName: string;
  generatedAt: string;
  configHash: string;
  /** Unique papers crawled for the run (shared across all category documents). */
  candidateCount: number;
  /** Papers in this category, sorted by publishedAt desc then arxivId asc. */
  papers: ClassifiedPaper[];
};

export interface Renderer {
  readonly extension: string;
  render(document: DigestDocument): string;
}

export type Window = {
  from: Date;
  to: Date;
  week: string;
};
