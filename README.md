# Weekly arXiv Digest Agent

Node.js / TypeScript CLI that discovers papers from the configured `source.provider` (`papers.cool` or `arxiv`), classifies them through an OpenAI-compatible chat completion API using the controlled topics in `TOPICS.yaml`, and writes deterministic weekly Markdown digests by category.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm digest --help
pnpm digest run --from 2026-08-17 --to 2026-08-24
pnpm digest preview --week 2026-W34 [--category TOPIC_ID]
pnpm digest cache stats
pnpm digest cache prune [--older-than DAYS]
pnpm digest cache clear-classifications [--older-than DAYS]
```

## Configuration

Configure source categories and the LLM model in `config.yaml`. Classification uses the fixed prompt template and the controlled topics in `TOPICS.yaml` (validated with the taxonomy schema at startup); there is no personal-interest, custom-instructions, threshold, or translation input. Set `source.provider` to `papers.cool` for the HTML source or `arxiv` for the arXiv Export API; `source.base_url` and `source.arxiv_base_url` control their endpoints. The selected crawler only accesses its configured provider. Provider credentials must be supplied through environment variables; secrets are never read from YAML or written to logs. The classification prompt receives only the title, English abstract, fixed template context, and the controlled topic vocabulary. PDF URLs are never requested.

The CLI automatically loads `.env` from the repository root when it exists. Existing shell environment variables take precedence. Classification calls an OpenAI-compatible chat completion endpoint; keep the credentials in `.env` (copy `.env.example`):

```dotenv
BASE_URL=https://llmapi.paratera.com/v1
API_KEY=replace-with-your-key
```

Then set `llm.model` in `config.yaml` to a model ID returned by the endpoint's `/models` API. Optionally set `llm.base_url` in `config.yaml` to override the `BASE_URL` environment endpoint; the API key is always resolved from the process environment and never stored in project YAML.

## Output and storage

Each weekly run writes one Markdown file per non-empty classification category to `output.directory/<week>` (for example `digests/2026-W34/`) using `output.filename` (default `weekly-{week}-{category}.md`). `output.subdirectory` (default `{week}`) controls the week subfolder; empty it for a single-level layout. A paper with a primary and a secondary category appears in both files, always with its arXiv link and the mirror link `https://papers.cool/arxiv/<id>` built from the arXiv ID. Classification failures are reported through JSON log lines and a non-zero exit code; failed papers are simply retried by running the digest again. `preview` rebuilds the digest views offline from the stored `papers` and `classification_cache` rows (no network or LLM calls); a week must have been run before it can be previewed. Classification results are cached in `.cache/weekly-digest.sqlite` keyed by paper content, taxonomy hash, prompt version, client version, model, and endpoint, so taxonomy/prompt/model changes automatically invalidate old entries and repeat runs are byte-identical with no new network or LLM traffic. The SQLite cache is powered by `sql.js` (SQLite compiled to WebAssembly, so installation does not require native compilation); the database lives in memory and is written to disk every 100 new classifications plus at stage boundaries, while cache-hit reads perform no disk IO. Use `pnpm digest cache clear-classifications` to delete the stored classification cache (all of it, or only entries older than `--older-than DAYS`) when you want papers re-classified. Requests use a fixed User-Agent, timeout, retry, and delay. Review papers.cool/arXiv terms and robots rules before scheduling recurring runs.

Use `--debug` to emit detailed crawler JSON lines on stderr, including HTTP cache hits, request attempts/status/timing, retries, pagination counts, candidate counts, and arXiv fallback results for list items missing an abstract. These events never include response bodies or abstracts; stdout remains reserved for the command result.
