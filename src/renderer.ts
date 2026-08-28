import { toWebDocument, stableJson } from './site.js';
import type { DigestDocument, Renderer } from './types.js';

const md = (s: string): string =>
    s
        // Escape characters that carry Markdown meaning anywhere in a line.
        // Backslash-escaping renders the literal character, so display is
        // preserved while line-start structures (lists, headings, blockquotes,
        // strikethrough) can no longer alter the document layout.
        .replace(/[\\`*_[\]{}<>#+.!|~-]/g, (match) => '\\' + match)
        // Normalize line endings and collapse runaway blank lines from
        // multi-line agent output so it cannot inject extra paragraphs.
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');

/** Normalize export.arxiv.org mirrors onto the whitelisted arxiv.org origin. */
const normalizeUrl = (url: string): string =>
    url.replace(/^https:\/\/export\.arxiv\.org\//, 'https://arxiv.org/');

const safeLink = (url: string): string | undefined => {
    const normalized = normalizeUrl(url);
    return /^https:\/\/(?:arxiv\.org|www\.arxiv\.org)\//.test(normalized) ||
        /^https:\/\/papers\.cool\//.test(normalized)
        ? normalized
        : undefined;
};

export class MarkdownRenderer implements Renderer {
    readonly extension = 'md';

    render(document: DigestDocument): string {
        let out = `# Weekly arXiv Digest: ${document.week} — ${md(document.categoryName)}\n\n- Window: ${document.from} to ${document.to} (UTC)\n- Generated: ${document.generatedAt}\n- Config hash: \`${document.configHash}\`\n- Candidates: ${document.candidateCount}\n- Papers in this category: ${document.papers.length}\n\n`;
        if (!document.papers.length) return out + '_No papers in this category._\n';

        for (const paper of document.papers) {
            out += `## ${md(paper.title)}\n\n- **Category:** ${md(document.categoryName)}\n`;
            // Tags are validated kebab-case values from the taxonomy contract,
            // so they are safe inside inline code without escaping.
            if (paper.classification.tags.length) {
                out += `- **Tag:** ${paper.classification.tags.map((tag) => '`' + tag + '`').join(', ')}\n`;
            }
            if (paper.classification.tldr) {
                out += `- **TLDR:** ${md(paper.classification.tldr)}\n`;
            }
            out += `- **Authors:** ${paper.authors.length ? paper.authors.map(md).join(', ') : 'Unknown'}\n`;
            // arXiv IDs are validated structured identifiers, safe unescaped.
            const arxivUrl = safeLink(paper.detailUrl);
            out += `- **arXiv:** [${paper.arxivId}](${arxivUrl ?? '#'})\n`;
            // papers.cool mirrors every arXiv id on a predictable path; the id
            // is validated and the URL never comes from untrusted fields.
            out += `- **papers.cool:** [${paper.arxivId}](https://papers.cool/arxiv/${paper.arxivId})\n`;
            out += `- **Published:** ${paper.publishedAt.slice(0, 10)}\n\n### Abstract\n\n${md(paper.abstractEn)}\n\n`;
        }
        return out;
    }
}

/**
 * Web viewer feed: same document content as the Markdown renderer, serialized
 * as deterministic JSON. Rendering must stay pure: site.ts owns the atomic
 * file write, this class only shapes the payload.
 */
export class JsonRenderer implements Renderer {
    readonly extension = 'json';

    render(document: DigestDocument): string {
        return `${stableJson(toWebDocument(document))}\n`;
    }
}
