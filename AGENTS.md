# AGENTS.md

## Project Context

`weekly-arxiv-digest-agent` is a private Node.js CLI that builds weekly arXiv paper digests.

- Runtime: Node.js `>=22.19.0`, ECMAScript modules, pnpm `9.15.0`.
- Language and build: strict TypeScript, `tsx` for local execution, `tsc` for the build.
- Runtime libraries: `zod` for validation, `yaml` for configuration, `cheerio` for HTML/Atom parsing, `p-limit` for bounded concurrency, `sql.js` for the SQLite/WASM store, and the built-in OpenAI-compatible chat completion client (`src/llm.ts`) for the LLM.
- Test and quality tools: Vitest and ESLint with the `typescript-eslint` recommended rules.
- Sources: `papers.cool` HTML or the arXiv Export API, selected by `source.provider` in `config.yaml`.
- Storage: `.cache/weekly-digest.sqlite`; generated Markdown is written to `digests/` by default.
- Taxonomy: `TOPICS.yaml` is the maintained machine-readable topic vocabulary; runtime output categories are validated IDs from that fixed vocabulary.

The pipeline is deliberately layered:

1. `src/config.ts` validates YAML and resolves source category aliases. `src/window.ts` computes explicit or configured ISO-week windows.
2. `src/crawler.ts` discovers and normalizes papers, handles pagination, versions, retries, rate limits, bounded detail requests, and HTTP response caching. It must never request PDFs.
3. `src/llm.ts` owns the OpenAI-compatible chat completion client and fixed-template category/tag JSON validation. Prompts may use only the title, English abstract, and the controlled topic vocabulary.
4. `src/db.ts` persists papers, fetches, and classification results in a cache-only store (no run/error-history tables; writes stay in memory and are flushed every 100 new classifications and at stage boundaries).
5. `src/pipeline.ts` coordinates stages and cache keys, while `src/renderer.ts` renders a `DigestDocument` without doing I/O or calling an agent; `src/site.ts` derives the static-site manifests from the output tree and atomically writes JSON (no network/DB/agent access).
6. `src/cli.ts` exposes `run`, `preview`, `web build`, and `cache` commands and keeps stdout machine-readable.

## Repository Documents

Treat the root documents as separate contracts with the following ownership and precedence:

- `AGENTS.md`: contributor instructions for humans and coding agents. It defines repository constraints, module boundaries, coding standards, verification requirements, and the role of every root document. Update it when the development workflow or non-negotiable engineering rules change; do not use it as a product specification or migration log.
- `README.md`: concise operator-facing entry point. It documents prerequisites, setup, supported CLI commands, configuration basics, storage/output locations, and important operational constraints. Update it when a user-visible command, setup step, configuration surface, or output location changes; keep implementation detail in `DESIGN.md`.
- `DESIGN.md`: normative target architecture and behavioral contract. It is the source of truth for pipeline stages, module responsibilities, configuration shape, agent boundaries, persistence, output format, failure semantics, and acceptance criteria. Implementation decisions must conform to it unless the design is deliberately revised first.
- `PLAN.md`: living migration and implementation tracker. It records gaps between the current code and `DESIGN.md`, priorities, phased work, current verification results, risks, and remaining acceptance items. Update status as migration work lands; completed or historical tasks in this file do not override the target contract in `DESIGN.md`.
- `TOPICS.yaml`: sole machine-readable source of truth for the controlled classification taxonomy. Runtime validation, prompt catalogs, category IDs, aliases, limits, and taxonomy hashes must derive from this file. Taxonomy edits require schema validation, focused tests, and human review; do not duplicate the vocabulary in source code or prose documents.
- `config.yaml`: runnable example and local default configuration. It demonstrates only supported public configuration fields and must stay aligned with the schema in `src/config.ts` and the examples in `README.md`/`DESIGN.md`. It must not contain credentials, personal-interest text, custom agent instructions, or obsolete scoring/translation settings.
- `idea.md`: historical problem statement retained for context. It is non-normative and may describe superseded behavior; do not implement from it when it conflicts with `DESIGN.md`, `PLAN.md`, or `TOPICS.yaml`.
- `package.json` and `pnpm-lock.yaml`: executable project metadata and dependency lock, not design documents. Commands documented elsewhere must match `package.json`, and dependency changes must keep the lockfile synchronized without unrelated churn.

When documents disagree, use `AGENTS.md` for contribution constraints, `DESIGN.md` for intended behavior, `TOPICS.yaml` for taxonomy data, and the validated source code/config schema for the currently implemented runtime. Record any remaining difference between current behavior and the target design in `PLAN.md` instead of silently redefining the target in user-facing documentation.

## Agent Role & Scope

The AI assistant may modify source, tests, configuration examples, and project documentation when the change supports the weekly digest workflow. It should preserve the existing module boundaries and make the smallest coherent change that satisfies the request.

The assistant must:

- inspect the relevant source, tests, configuration, and documentation before editing;
- keep paper metadata and English abstracts sourced from the configured provider;
- preserve deterministic ordering, stable hashes, and cache invalidation metadata;
- record recoverable fetch and classification-agent failures instead of silently producing an empty successful digest;
- keep secrets in environment variables and out of YAML, source, logs, fixtures, and generated Markdown;
- add or update focused tests for behavior changes, preferably using the existing fixtures and mocked `fetch`/`LlmInvoker` helpers.

The assistant must not:

- download or parse paper PDFs, or include PDF/body text in classification prompts;
- invoke a global `pi` binary, `npx`, runtime package downloads, or child processes for the LLM;
- bypass the configured provider, source categories, fixed topic vocabulary, or output format;
- weaken TypeScript validation or replace structured parsers with regular expressions for HTML/XML;
- delete or reset user files, caches, generated digests, or unrelated worktree changes without explicit approval;
- add a Web UI/HTML renderer as part of a Markdown-only task.

## Coding Standards

- Use strict TypeScript and the existing NodeNext ESM style. Relative TypeScript imports use the emitted `.js` suffix; use `import type` for type-only imports.
- Follow existing naming: `PascalCase` for classes/types, `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for module constants, and `arxivId` for the domain identifier. Keep public contracts in `src/types.ts` or near the owning module.
- Prefer small pure helpers for normalization, hashing, date/window logic, and rendering. Keep external I/O at crawler, store, adapter, pipeline, or CLI boundaries.
- Validate untrusted YAML and agent JSON with Zod or an equivalent structured parser. Normalize whitespace and arrays consistently; use `stableStringify`/`hash` when a value participates in a cache key.
- Classification categories must be parsed from the controlled topic vocabulary and filtered to allowed IDs. Tags are lowercase hyphenated values with a maximum of three entries. The classification prompt is a fixed, versioned template; do not add personal-interest or user-supplied instruction fields.
- When changing classification behavior, use the existing `TOPICS.yaml` vocabulary first. New topics require schema-valid YAML and human review; an agent must not invent unrestricted top-level categories in output.
- Markdown output must escape external and agent text, whitelist `https://arxiv.org/` links, omit empty tag lines, and use atomic temporary-file writes. Renderers consume `DigestDocument` only. The web JSON twin follows the same whitelist: the viewer inserts text via `textContent` only, whitelists arxiv.org/papers.cool links, and builds papers.cool URLs from the arXiv ID.
- Use bounded concurrency (`p-limit`), configured delay/timeouts, retries with backoff, and a fixed User-Agent for network work. Never log full prompts, abstracts, credentials, or agent responses at normal log levels.
- Keep comments short and explain only non-obvious invariants. Do not reformat unrelated files or introduce dependency churn without a concrete need.

## Useful Commands

Run commands from the repository root:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm lint
pnpm test
pnpm digest --help
pnpm digest run [--from YYYY-MM-DD --to YYYY-MM-DD] [--config config.yaml] [--force] [--dry-run] [--debug] [--trace FILE]
pnpm digest preview --week YYYY-Www [--config config.yaml]
pnpm digest cache stats
pnpm digest cache prune [--older-than DAYS]
pnpm digest cache clear-classifications [--older-than DAYS]
pnpm digest web build [--week YYYY-Www] [--config config.yaml]
pnpm site:css
pnpm site:build
pnpm site:deploy
```

`pnpm test` runs `test/**/*.test.ts` with Vitest in the Node environment. Tests should remain deterministic and must not depend on live papers.cool, arXiv, or model services.

## Workflow Expectations

1. Read `README.md`, `DESIGN.md`, `config.yaml`, the affected modules, and nearby tests. Check the worktree before editing and preserve unrelated user changes.
2. State the intended scope, then edit with the repository's existing patterns. Update `DESIGN.md`, `TOPICS.yaml`, or `README.md` when a public contract changes.
3. For pipeline changes, cover cache hit/miss behavior, deterministic repeat runs, half-open date windows, topic/tag boundaries, provider failures, retries, and Markdown safety as applicable.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` for normal code changes. At minimum, run the directly affected checks for documentation-only changes and report what was not run.
5. Use `pnpm digest --help` or a fixture-backed dry run to verify CLI wiring. Do not run a live provider or model call in tests.
6. Review the final diff for accidental generated files, secrets, network URLs outside configuration, non-atomic writes, and violations of the no-PDF boundary. Report remaining limitations and test results clearly.
