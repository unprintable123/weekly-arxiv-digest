# Weekly arXiv Digest Agent

Node.js / TypeScript CLI that discovers papers from the configured `source.provider` (`papers.cool` or `arxiv`), classifies them with a local pi agent using the controlled topics in `TOPICS.yaml`, and writes deterministic weekly Markdown digests by category.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm digest --help
pnpm digest run --from 2026-08-17 --to 2026-08-24
pnpm digest preview --week 2026-W34
pnpm digest cache stats
```

Configure source categories and the pi provider/model in `config.yaml`. Classification uses the fixed prompt template and the controlled topics in `TOPICS.yaml`; there is no personal-interest or custom-instructions input. Set `source.provider` to `papers.cool` for the HTML source or `arxiv` for the arXiv Export API; `source.base_url` and `source.arxiv_base_url` control their endpoints. The selected crawler only accesses its configured provider. Provider credentials must be supplied through the provider's environment variables; secrets are never read from YAML or written to logs. The classification agent receives only the title, English abstract, fixed template context, and the controlled topic vocabulary. PDF URLs are never requested.

The SQLite cache is `.cache/weekly-digest.sqlite` and is powered by `sql.js` (SQLite compiled to WebAssembly, so installation does not require native compilation); generated files are written to `digests/`. Requests use a fixed User-Agent, timeout, retry, and delay. Review papers.cool/arXiv terms and robots rules before scheduling recurring runs.
