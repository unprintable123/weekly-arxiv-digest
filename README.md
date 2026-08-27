# Weekly arXiv Digest Agent

Node.js 20+ / TypeScript CLI that discovers papers from the configured `source.provider` (`papers.cool` or `arxiv`), filters them with a local pi agent, translates accepted abstracts, and writes a deterministic weekly Markdown digest.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm digest --help
pnpm digest run --from 2026-08-17 --to 2026-08-24
pnpm digest preview --week 2026-W34
pnpm digest cache stats
```

Configure categories, threshold, interest, and pi provider/model in `config.yaml`. Set `source.provider` to `papers.cool` for the HTML source or `arxiv` for the arXiv Export API; `source.base_url` and `source.arxiv_base_url` control their endpoints. The selected crawler only accesses its configured provider. Provider credentials must be supplied through the provider's environment variables; secrets are never read from YAML or written to logs. The agent receives only title and English abstract for relevance scoring. PDF URLs are never requested.

The SQLite cache is `.cache/weekly-digest.sqlite` and is powered by `sql.js` (SQLite compiled to WebAssembly, so installation does not require native compilation); generated files are written to `digests/`. Requests use a fixed User-Agent, timeout, retry, and delay. Review papers.cool/arXiv terms and robots rules before scheduling recurring runs.
