# Weekly arXiv Digest Agent

Node.js / TypeScript CLI that discovers papers from the configured `source.provider` (`papers.cool` or `arxiv`), classifies them through an OpenAI-compatible chat completion API using the controlled topics in `TOPICS.yaml`, and writes deterministic weekly Markdown digests by category.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm digest --help
pnpm digest run --from 2026-08-17 --to 2026-08-24
pnpm digest preview --week 2026-W34 [--category TOPIC_ID]
pnpm digest web build [--week 2026-W34]   # no --week rebuilds every cached week
pnpm digest cache stats
pnpm digest cache prune [--older-than DAYS]
pnpm digest cache clear-classifications [--older-than DAYS]
```

## Static site (GitHub Pages)

Each run writes a `.json` twin for every Markdown digest into the separate JSON feed tree (`output.json_directory`, default `digests-json/`), plus two derived manifests (`digests-json/<week>/index.json` and `digests-json/index.json`). The static viewer in `web/` (vanilla ES module + Tailwind CSS) reads only those JSON files and renders a filterable paper list per week, group and category with `?week=&category=` URL state. Markdown output never reaches the published site — gh-pages contains only the JSON feed and the viewer shell.

```bash
pnpm site:css       # rebuild web/assets/app.css after editing Tailwind classes
pnpm site:build     # web/ + digests-json/ -> dist/site (includes .nojekyll)
pnpm site:deploy    # publish dist/site to the gh-pages branch and push
```

`web build` backfills JSON data offline from the cached papers and classifications (no network, no LLM) for **all cached weeks** by default; pass `--week YYYY-Www` to rebuild a single week. A week must have been `run` before it can be backfilled.

### Deploying to GitHub Pages

1. **One-time repository setup** — on GitHub open Settings → Pages → Build and deployment → Source: **Deploy from a branch**, then choose Branch `gh-pages` and Folder `/ (root)`. (The first `pnpm site:deploy` creates the `gh-pages` branch automatically via an orphan commit; you can enable Pages before or after that first publish.)
2. **Daily publish loop** after each successful digest run:

   ```bash
   pnpm digest run                       # crawl + classify (also writes the JSON twins)
   pnpm digest web build [--week 2026-W34] # default: rebuild all cached weeks; --week limits to one
   pnpm site:deploy                      # site:build + push dist/site to gh-pages
   ```

   `pnpm site:deploy` is idempotent: it mirrors `dist/site` into a temporary git worktree of `gh-pages`, commits only when content actually changed, pushes, and removes the worktree. When nothing changed it reports `pushed: false` without touching the remote.

3. **Custom remote/branch** (optional) — override the defaults without editing scripts:

   ```bash
   GH_PAGES_REMOTE=upstream GH_PAGES_BRANCH=pages pnpm site:deploy
   ```

4. **Verify** — the site URL appears under Settings → Pages once the first deployment finishes; assets use relative paths, so project pages under `https://<user>.github.io/<repo>/` work out of the box.

Links on the site are restricted to arxiv.org and papers.cool, identical to the Markdown whitelist; all dynamic text is inserted via `textContent`, and papers.cool URLs are constructed from arXiv IDs only.

## Configuration

Configure source categories and the LLM model in `config.yaml`. Classification uses the fixed prompt template and the controlled topics in `TOPICS.yaml` (validated with the taxonomy schema at startup); there is no personal-interest, custom-instructions, threshold, or translation-input field. The classifier also writes a one-sentence Simplified-Chinese TLDR per paper together with the categories and tags. Set `source.provider` to `papers.cool` for the HTML source or `arxiv` for the arXiv Export API; `source.base_url` and `source.arxiv_base_url` control their endpoints. The selected crawler only accesses its configured provider. Provider credentials must be supplied through environment variables; secrets are never read from YAML or written to logs. The classification prompt receives only the title, English abstract, fixed template context, and the controlled topic vocabulary. PDF URLs are never requested.

The CLI automatically loads `.env` from the repository root when it exists. Existing shell environment variables take precedence. Classification calls an OpenAI-compatible chat completion endpoint; keep the credentials in `.env` (copy `.env.example`):

```dotenv
BASE_URL=https://llmapi.paratera.com/v1
API_KEY=replace-with-your-key
```

Then set `llm.model` in `config.yaml` to a model ID returned by the endpoint's `/models` API. Optionally set `llm.base_url` in `config.yaml` to override the `BASE_URL` environment endpoint; the API key is always resolved from the process environment and never stored in project YAML.

## Output and storage

Each weekly run writes one Markdown file per non-empty classification category to `output.directory/<week>` (for example `digests/2026-W34/`) and a `.json` twin with the same basename into the separate JSON feed tree `output.json_directory/<week>` (default `digests-json/`), together with the JSON-only manifests (`index.json` at both levels). `output.filename` (default `weekly-{week}-{category}.md`) and `output.subdirectory` (default `{week}`; empty for a single-level layout) apply to both trees. This split lets a repository publish the JSON feed (e.g. to GitHub Pages) while keeping Markdown output local or gitignored. A paper with a primary and a secondary category appears in both files, always with its arXiv link and the mirror link `https://papers.cool/arxiv/<id>` built from the arXiv ID. Each paper card also carries the one-sentence Chinese TLDR produced at classification time. Classification failures are reported through JSON log lines and a non-zero exit code; failed papers are simply retried by running the digest again. `preview` rebuilds the digest views offline from the stored `papers` and `classification_cache` rows (no network or LLM calls); a week must have been run before it can be previewed. Classification results are cached in `.cache/weekly-digest.sqlite` keyed by paper content, prompt version, client version, model, and endpoint (the topic taxonomy is deliberately excluded from the key, so editing `TOPICS.yaml` never re-classifies cached papers — only `digest cache clear-classifications` does), and repeat runs are byte-identical with no new network or LLM traffic. The SQLite cache is powered by `sql.js` (SQLite compiled to WebAssembly, so installation does not require native compilation); the database lives in memory and is written to disk every 100 new classifications plus at stage boundaries, while cache-hit reads perform no disk IO. Use `pnpm digest cache clear-classifications` to delete the stored classification cache (all of it, or only entries older than `--older-than DAYS`) when you want papers re-classified. Requests use a fixed User-Agent, timeout, retry, and delay. Review papers.cool/arXiv terms and robots rules before scheduling recurring runs.

Use `--debug` to emit detailed crawler JSON lines on stderr, including HTTP cache hits, request attempts/status/timing, retries, pagination counts, candidate counts, and arXiv fallback results for list items missing an abstract. These events never include response bodies or abstracts; stdout remains reserved for the command result.
