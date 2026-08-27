export type InterestCategory = {
  id: string;
  name: string;
  order: number;
};

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
  sourceUrl: string;
  contentHash: string;
};

export type RelevanceResult = {
  score: number;
  reason: string;
  categories: string[];
  tags: string[];
  raw?: string;
};

export type DigestPaper = Paper & {
  relevance: RelevanceResult;
  translationZh: string;
};

export type DigestDocument = {
  week: string;
  from: string;
  to: string;
  generatedAt: string;
  configHash: string;
  candidateCount: number;
  includedCount: number;
  categories: InterestCategory[];
  papers: DigestPaper[];
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
