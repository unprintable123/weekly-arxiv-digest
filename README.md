# Weekly arXiv Digest Agent

Node.js / TypeScript CLI that discovers papers from the configured `source.provider` (`papers.cool` or `arxiv`), classifies them with a local pi agent using the controlled topics in `TOPICS.yaml`, and writes deterministic weekly Markdown digests by category.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm digest --help
pnpm digest run --from 2026-08-17 --to 2026-08-24
pnpm digest preview --week 2026-W34 [--category TOPIC_ID]
pnpm digest retry --run <run-id> --stage fetch|classify
pnpm digest cache stats
pnpm digest cache prune [--older-than DAYS]
```

## Configuration

Configure source categories and the pi provider/model in `config.yaml`. Classification uses the fixed prompt template and the controlled topics in `TOPICS.yaml` (validated with the taxonomy schema at startup); there is no personal-interest, custom-instructions, threshold, or translation input. Set `source.provider` to `papers.cool` for the HTML source or `arxiv` for the arXiv Export API; `source.base_url` and `source.arxiv_base_url` control their endpoints. The selected crawler only accesses its configured provider. Provider credentials must be supplied through the provider's environment variables; secrets are never read from YAML or written to logs. The classification agent receives only the title, English abstract, fixed template context, and the controlled topic vocabulary. PDF URLs are never requested.

The CLI automatically loads `.env` from the repository root when it exists. Existing shell environment variables take precedence. For a custom OpenAI-compatible endpoint such as Paratera, keep the API key in `.env`:

```dotenv
PARATERA_API_KEY=replace-with-your-key
```

Define the custom provider in `~/.pi/agent/models.json` (replace `MODEL_ID` with an ID returned by the endpoint's `/models` API):

```json
{
  "providers": {
    "paratera": {
      "baseUrl": "https://llmapi.paratera.com/v1",
      "api": "openai-completions",
      "apiKey": "$PARATERA_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [{ "id": "MODEL_ID" }]
    }
  }
}
```

Then set `pi_agent.provider: paratera` and `pi_agent.model: MODEL_ID` in `config.yaml`. Custom providers are loaded through pi's `ModelRuntime`; API keys are resolved from the process environment and never stored in project YAML.

## Output and storage

Each weekly run writes one Markdown file per non-empty classification category to `output.directory` using `output.filename` (default `weekly-{week}-{category}.md`); a paper with a primary and a secondary category appears in both files. `preview` replays the stored per-category run snapshots and performs no network or agent calls. Classification results are cached in `.cache/weekly-digest.sqlite` keyed by paper content, taxonomy hash, prompt version, agent package version, provider, and model, so taxonomy/prompt/model changes automatically invalidate old entries and repeat runs are byte-identical with no new network or agent traffic. The SQLite cache is powered by `sql.js` (SQLite compiled to WebAssembly, so installation does not require native compilation). Requests use a fixed User-Agent, timeout, retry, and delay. Review papers.cool/arXiv terms and robots rules before scheduling recurring runs.

Use `--debug` to emit detailed crawler JSON lines on stderr, including HTTP cache hits, request attempts/status/timing, retries, pagination counts, candidate counts, detail enrichment, and arXiv fallback results. These events never include response bodies or abstracts; stdout remains reserved for the command result.
