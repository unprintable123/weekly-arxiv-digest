import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '../src/renderer.js';
import type { DigestDocument, DigestPaper, InterestCategory } from '../src/types.js';

const categories: InterestCategory[] = [
    { id: 'interest-1-novel-model-architectures', name: 'Novel Model Architectures & Components', order: 1 },
];

const paper = (overrides: Partial<DigestPaper> = {}): DigestPaper => ({
    arxivId: '2401.01234',
    title: 'A Study of Scalable Attention',
    authors: ['Alice Example'],
    categories: ['cs.LG'],
    abstractEn: 'We study attention and find it helps.',
    publishedAt: '2024-01-01T00:00:00.000Z',
    detailUrl: 'https://arxiv.org/abs/2401.01234',
    sourceUrl: 'https://papers.cool/arxiv/cs.LG',
    contentHash: 'hash',
    relevance: { score: 9, reason: 'r', categories: ['interest-1-novel-model-architectures'], tags: [] },
    translationZh: '我们研究了注意力机制。',
    ...overrides,
});

const document = (papers: DigestPaper[]): DigestDocument => ({
    week: '2024-W01',
    from: '2024-01-01',
    to: '2024-01-08',
    generatedAt: '2024-01-08T00:00:00.000Z',
    configHash: 'abc',
    candidateCount: papers.length,
    includedCount: papers.length,
    categories,
    papers,
});

describe('MarkdownRenderer', () => {
    it('escapes Markdown-significant characters in external text', () => {
        const renderer = new MarkdownRenderer();
        const out = renderer.render(
            document([
                paper({
                    title: '- Leading dash title',
                    abstractEn: '- bullet line\n> quote line\n# heading line\nstate-of-the-art ~~strike~~ _italic_ *bold* [x](y)',
                }),
            ]),
        );
        expect(out).toContain('## \\- Leading dash title');
        expect(out).toContain('\\- bullet line');
        expect(out).toContain('\\> quote line');
        expect(out).toContain('\\# heading line');
        expect(out).toContain('state\\-of\\-the\\-art');
        expect(out).toContain('\\~\\~strike\\~\\~');
        expect(out).toContain('\\_italic\\_');
    });

    it('collapses runaway blank lines from multi-line agent output', () => {
        const renderer = new MarkdownRenderer();
        const out = renderer.render(
            document([
                paper({
                    abstractEn: 'Line one.\n\n\n\n\nLine two.',
                }),
            ]),
        );
        // Dots are escaped for display-safety, so look for the escaped form.
        expect(out).not.toContain('\n\n\n\n');
        expect(out).toContain('Line one\\.\n\nLine two\\.');
    });

    it('omits the tag line when there are no tags and keeps it when present', () => {
        const renderer = new MarkdownRenderer();
        const noTags = renderer.render(document([paper()]));
        expect(noTags).not.toContain('**Tag:**');

        const withTags = renderer.render(
            document([paper({ relevance: { score: 9, reason: 'r', categories: ['interest-1-novel-model-architectures'], tags: ['state-space-model', 'efficient-attention'] } })]),
        );
        expect(withTags).toContain('**Tag:** `state-space-model`, `efficient-attention`');
    });

    it('only emits whitelisted https arxiv links', () => {
        const renderer = new MarkdownRenderer();
        const out = renderer.render(
            document([
                paper({
                    detailUrl: 'https://evil.example/abs/2401.01234',
                }),
            ]),
        );
        // Non-arxiv URLs are replaced with a safe placeholder.
        expect(out).toContain('](#)');
        expect(out).not.toContain('evil.example');

        // Whitelisted arxiv URLs are kept as-is.
        const good = renderer.render(document([paper()]));
        expect(good).toContain('(https://arxiv.org/abs/2401.01234)');
    });

    it('renders category names in interest order and reports counts', () => {
        const renderer = new MarkdownRenderer();
        const out = renderer.render(
            document([paper(), paper({ arxivId: '2401.01235' })]),
        );
        expect(out).toContain('Novel Model Architectures & Components: 2');
        expect(out).toContain('**Category:** Novel Model Architectures & Components');
    });
});
