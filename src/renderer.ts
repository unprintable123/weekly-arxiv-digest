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

const link = (url: string): string =>
    /^https:\/\/(?:arxiv\.org|www\.arxiv\.org)\//.test(url) ? url : '#';

export class MarkdownRenderer implements Renderer {
    readonly extension = 'md';

    render(document: DigestDocument): string {
        const counts = new Map<string, number>();
        document.papers.forEach((paper) =>
            paper.relevance.categories.forEach((category) =>
                counts.set(category, (counts.get(category) || 0) + 1),
            ),
        );

        let out = `# Weekly arXiv Digest: ${document.week}\n\n- Window: ${document.from} to ${document.to} (UTC)\n- Generated: ${document.generatedAt}\n- Config hash: \`${document.configHash}\`\n- Candidates: ${document.candidateCount}\n- Included: ${document.includedCount}\n\n## Category counts\n\n`;
        for (const category of document.categories) {
            out += `- ${md(category.name)}: ${counts.get(category.id) || 0}\n`;
        }
        if (!document.papers.length) return out + '\n_No papers matched the threshold._\n';

        out += '\n';
        for (const paper of document.papers) {
            out += `## ${md(paper.title)}\n\n- **Category:** ${paper.relevance.categories
                .map((category) => md(document.categories.find((item) => item.id === category)?.name || category))
                .join(', ')}\n`;
            if (paper.relevance.tags.length) {
                out += `- **Tag:** ${paper.relevance.tags.map((tag) => '`' + tag + '`').join(', ')}\n`;
            }
            out += `- **Score:** ${paper.relevance.score}/10\n- **arXiv:** [${md(paper.arxivId)}](${link(paper.detailUrl)})\n- **Published:** ${paper.publishedAt.slice(0, 10)}\n\n### Abstract (English)\n${md(paper.abstractEn)}\n\n### 摘要（中文）\n${md(paper.translationZh)}\n\n`;
        }
        return out;
    }
}
