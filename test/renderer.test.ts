import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '../src/renderer.js';
import type { ClassifiedPaper, DigestDocument } from '../src/types.js';

const paper = (overrides: Partial<ClassifiedPaper> = {}): ClassifiedPaper => ({
    arxivId: '2401.01234',
    title: 'A Study of Scalable Attention',
    authors: ['Alice Example', 'Bob Sample'],
    categories: ['cs.LG'],
    abstractEn: 'We study attention and find it helps.',
    publishedAt: '2024-01-02T00:00:00.000Z',
    detailUrl: 'https://arxiv.org/abs/2401.01234',
    contentHash: 'hash',
    classification: { categories: ['llm-architecture', 'physics-of-llm'], tags: [] },
    ...overrides,
});

const document = (papers: ClassifiedPaper[], overrides: Partial<DigestDocument> = {}): DigestDocument => ({
    week: '2024-W01',
    from: '2024-01-01',
    to: '2024-01-08',
    categoryId: 'llm-architecture',
    categoryName: '大模型架构',
    generatedAt: '2024-01-08T00:00:00.000Z',
    configHash: 'abc',
    candidateCount: 5,
    papers,
    ...overrides,
});

describe('MarkdownRenderer', () => {
    it('renders the header with window, generation time, config hash and counts', () => {
        const out = new MarkdownRenderer().render(document([paper()], { candidateCount: 7 }));
        expect(out).toContain('# Weekly arXiv Digest: 2024-W01 — 大模型架构');
        expect(out).toContain('- Window: 2024-01-01 to 2024-01-08 (UTC)');
        expect(out).toContain('- Generated: 2024-01-08T00:00:00.000Z');
        expect(out).toContain('- Config hash: `abc`');
        expect(out).toContain('- Candidates: 7');
        expect(out).toContain('- Papers in this category: 1');
    });

    it('renders category, optional tag, authors, both links and the published date', () => {
        const out = new MarkdownRenderer().render(
            document([paper({ classification: { categories: ['llm-architecture'], tags: ['attention', 'state-space-model'] } })]),
        );
        expect(out).toContain('- **Category:** 大模型架构');
        expect(out).toContain('- **Tag:** `attention`, `state-space-model`');
        expect(out).toContain('- **Authors:** Alice Example, Bob Sample');
        expect(out).toContain('- **arXiv:** [2401.01234](https://arxiv.org/abs/2401.01234)');
        expect(out).toContain('- **papers.cool:** [2401.01234](https://papers.cool/arxiv/2401.01234)');
        expect(out).not.toContain('**Source:**');
        expect(out).toContain('- **Published:** 2024-01-02');
        expect(out).toContain('### Abstract');
        expect(out).toContain('We study attention and find it helps\\.');
    });

    it('omits the tag line when there are no tags', () => {
        const out = new MarkdownRenderer().render(document([paper()]));
        expect(out).not.toContain('**Tag:**');
    });

    it('does not emit scores or translations', () => {
        const out = new MarkdownRenderer().render(document([paper()]));
        expect(out).not.toContain('Score');
        expect(out).not.toContain('中文');
    });

    it('escapes Markdown-significant characters in external text', () => {
        const out = new MarkdownRenderer().render(
            document([
                paper({
                    title: '- Leading dash title',
                    authors: ['Eve *Evil*'],
                    abstractEn: '- bullet line\n> quote line\n# heading line\nstate-of-the-art ~~strike~~ _italic_',
                }),
            ]),
        );
        expect(out).toContain('## \\- Leading dash title');
        expect(out).toContain('Eve \\*Evil\\*');
        expect(out).toContain('\\- bullet line');
        expect(out).toContain('\\> quote line');
        expect(out).toContain('\\# heading line');
        expect(out).toContain('state\\-of\\-the\\-art');
        expect(out).toContain('\\~\\~strike\\~\\~');
        expect(out).toContain('\\_italic\\_');
    });

    it('collapses runaway blank lines from multi-line abstracts', () => {
        const out = new MarkdownRenderer().render(
            document([paper({ abstractEn: 'Line one.\n\n\n\n\nLine two.' })]),
        );
        expect(out).not.toContain('\n\n\n\n');
        expect(out).toContain('Line one\\.\n\nLine two\\.');
    });

    it('only emits whitelisted links and normalizes the arXiv export mirror', () => {
        const out = new MarkdownRenderer().render(
            document([
                paper({
                    detailUrl: 'https://export.arxiv.org/abs/2401.01234',
                }),
            ]),
        );
        expect(out).toContain('(https://arxiv.org/abs/2401.01234)');
        expect(out).not.toContain('export.arxiv.org');

        const evil = new MarkdownRenderer().render(
            document([paper({ detailUrl: 'https://evil.example/abs/2401.01234' })]),
        );
        expect(evil).toContain('](#)');
        expect(evil).not.toContain('evil.example');
    });

    it('renders an empty category document with a placeholder', () => {
        const out = new MarkdownRenderer().render(document([]));
        expect(out).toContain('- Papers in this category: 0');
        expect(out).toContain('_No papers in this category._');
    });
});
