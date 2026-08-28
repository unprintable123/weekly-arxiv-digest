# Weekly arXiv Digest Agent 设计

## 1. 目标与范围

本项目是一个 Node.js + TypeScript 命令行 agent：按周从 papers.cool（可选 arXiv API）收集论文，通过 OpenAI 兼容的 chat completion API 按 `TOPICS.yaml` 的受控词表分类，最后为每个分类生成 Markdown digest。

首版默认关注 `cs.LG`、`cs.CL`、`cs.AI`，来源类别和周窗口均由 YAML 配置控制。论文元数据和英文摘要始终来自抓取源；LLM 只负责分类和可选 tag，不负责相关性评分，也不负责摘要翻译。

必须输出的论文字段：标题、分类、作者、英文原始摘要、arXiv/papers.cool 链接。`tag` 是可选的分类细分结果，由 agent 从摘要中提取；没有 tag 时不输出该字段。

非目标：下载或解析 PDF、使用正文筛选论文、LLM 打分/阈值过滤、LLM 翻译摘要、引用图谱、账号订阅服务。静态站点输出按第 9 节的契约实现，是 Markdown 之后的第二个渲染目标；仍不做服务端渲染、不做 Web 框架、不做动态后端。

## 2. 技术栈与模块边界

- Node.js `>=22.19.0`、pnpm `9.15.0`、严格 TypeScript、ESM、`tsx` 和 `tsc`。
- `yaml` + `zod` 负责配置和 agent JSON 校验，`cheerio` 负责 HTML/Atom 解析，`p-limit` 控制并发，`sql.js` 提供单文件 SQLite 缓存。
- LLM 分类通过内置的 OpenAI 兼容 chat completion 客户端（`src/llm.ts`，仅用 Node 内置 `fetch`）完成；端点与密钥来自环境变量 `BASE_URL` / `API_KEY`（`.env` 由 CLI 自动加载）。禁止全局 `pi`、`npx`、运行时下载依赖或子进程启动 agent。

源码职责：

- `src/config.ts`：读取 YAML、校验字段和解析来源类别配置。
- `src/window.ts`：计算 ISO 周窗口，默认最近一个完整周，也支持显式 `--from`/`--to`。
- `src/crawler.ts`：抓取列表并立即解析为论文数据，处理分页、版本去重、限速、重试、HTTP 缓存（仅缓存提取结果）；不为详情页重复请求 PDF。
- `src/llm.ts`：通过 chat completion API 执行分类/tag 请求，并校验受控 JSON 返回值。
- `src/db.ts`：持久化论文、抓取响应和分类结果；写入在内存累积，按固定节奏刷盘。
- `src/pipeline.ts`：编排收集、分类、排序和输出，保证缓存命中时不重复调用网络或 agent。
- `src/renderer.ts`：只消费领域对象并渲染 Markdown/JSON，不访问网络、数据库或 agent。
- `src/site.ts`：静态站点数据层——从输出目录派生两级 manifest 并原子写入 JSON；纯文件推导，不访问网络、数据库或 agent。
- `src/cli.ts`：暴露 `run`、`preview`、`web build` 和缓存管理命令，stdout 保持机器可读。

## 3. 配置设计

推荐配置：

```yaml
source:
  provider: papers.cool # papers.cool | arxiv
  base_url: https://papers.cool
  arxiv_base_url: https://export.arxiv.org
  categories: [cs.LG, cs.CL, cs.AI]
  request_delay_ms: 400
  timeout_ms: 20000
  user_agent: weekly-digest/0.1
  concurrency: 4
window:
  timezone: UTC
  default: last-complete-week
output:
  directory: digests
  subdirectory: '{week}' # 每周文件放入 "YYYY-Www" 子目录；置空则单层存放
  filename: weekly-{week}-{category}.md
llm:
  # OpenAI-compatible chat completion endpoint; BASE_URL/API_KEY come from
  # the environment (.env), base_url here overrides the env endpoint.
  # base_url: https://llmapi.paratera.com/v1
  model: configured-model-id
  timeout_ms: 120000
  max_retries: 2
```

为兼容当前配置，若不存在 `source.categories`，读取顶层 `categories`；自然语言类别可映射为 arXiv ID，也允许直接填写 ID。`llm` 只配置模型连接和重试参数（可选 `base_url` 覆盖环境端点），不提供个人兴趣或自定义 instructions。分类 prompt 必须由代码中的固定模板生成，并通过版本号参与缓存 key。不要再增加 `threshold`、`interest`、`instructions` 或 `output.language` 之类无关字段。配置错误（类别为空、URL 无效、日期无效等）必须在抓取前失败。

`TOPICS.yaml` 是分类候选词表和机器可读 schema。模型应优先使用已有 topic 和其中的常见 tag；无法归入现有 topic 时返回 `other`，新增 topic 只能由人工审核后追加。运行时使用 YAML + Zod 校验该文件并计算稳定 hash，分类缓存和固定 prompt 都必须绑定该 hash。运行结果中的 category 必须是 topic 的稳定 ID 或受控的 `other`，不能让 agent 随意创建顶层类别。

## 4. 三阶段流程

```text
加载并校验配置
      |
计算半开周窗口 [from, to)
      |
按配置类别抓取列表 -> 规范化 -> arXiv ID 去重
      |
抓取详情和摘要（缓存、限速、重试；必要时 arXiv fallback）
      |
分类缓存命中则复用，否则通过 chat completion API 返回 category + 可选 tag
      |
按 category、发布日期、arXiv ID 稳定排序
      |
每周每个 category 写一个 Markdown 文件
```

### 4.1 收集论文

列表页用于发现，并直接提供标题、作者、分类、发布时间和摘要；papers.cool 抓取器不得为每篇论文再请求详情页。仅当列表项缺少摘要时，才按 arXiv ID 请求摘要页作为 fallback；fallback 也失败时记录抓取错误并跳过该论文，不阻塞其他类别。

抓取器必须处理分页、相对链接、HTML 实体、时区、撤稿和版本号。同一 arXiv ID 的多个版本只保留最新版本。展示字段保留原文；规范化标题/摘要只用于去重和缓存指纹。任何请求都不得指向 PDF URL。

### 4.2 分类与 tag

分类 prompt 使用代码内固定、版本化的模板，只包含论文标题、英文摘要和 `TOPICS.yaml` 中的候选 topic。作者、PDF、正文和用户自定义 instructions 不得进入分类判断。LLM 仅作为内部自动化执行器，调用方不能注入临时任务说明。

agent 必须返回一个 JSON 对象：

```json
{
  "categories": ["llm-architecture"],
  "tags": ["state-space-model", "efficient-attention"]
}
```

`categories` 至少一个且只能来自受控 topic ID；`tags` 可为空，最多 3 个，使用小写短横线格式。无效 JSON、未知分类、超时或服务错误按配置次数重试，最终失败写入错误表。没有评分，因此所有成功抓取且分类成功的论文都进入输出，不做 threshold 过滤。

分类缓存 key 至少包含 arXiv ID、标题/摘要 hash、topic 词表 hash、固定 prompt 版本、客户端版本、model 和端点。任一输入变化都必须使旧分类缓存失效。

## 5. 缓存与数据模型

SQLite 文件默认位于 `.cache/weekly-digest.sqlite`，它只是一个可复用的缓存库，不是运行历史数据库：没有 runs、run_papers、run_documents 这类运行跟踪表，也没有错误日志表。查找一篇论文的唯一途径是 `papers` 表加上 `classification_cache`（按缓存 key 命中）。保留四张表：

- `papers`：arXiv ID（主键）、版本、标题、作者 JSON、原始 arXiv 分类、英文摘要、发布时间、更新时间、详情 URL、内容 hash、抓取时间。不再保存 `source_url`；papers.cool 链接由 arXiv ID 按固定模板构造。
- `fetch_cache`：URL（主键）、解析后的论文列表 JSON、ETag/Last-Modified、过期时间和抓取时间。不存原始响应体：HTTP 层在拿到响应后立即用 DOM/XML 解析器提取条目，只落盘提取结果，因此命中缓存同时跳过网络请求和解析开销，数据库体积也大幅缩小。失败请求从不落盘，下次运行自然重试。
- `classification_cache`：缓存 key（主键）、arXiv ID、内容 hash、model、category JSON、tag JSON、状态和时间。prompt 版本、client 版本、endpoint 和原始响应不落库：前三者只参与缓存 key 的计算（taxonomy/prompt/client/model/endpoint 任一变化产生新 key，旧条目自动失效），原始 LLM 响应不保存，只保留归一化后的 category/tag。
- `meta`：极小的 key/value 表，目前仅保存 `(week, config hash) -> generated_at`，用于让全缓存重复运行的输出字节一致。

写入 IO：sql.js 数据库完全驻留内存，写语句不触发磁盘 IO。刷盘（导出内存快照到临时文件再原子 rename）按以下节奏执行：抓取阶段结束一次；分类阶段每积累 100 条新增分类结果一次，阶段结束时再补齐不足 100 条的尾部；meta 更新后；`close()`。纯缓存命中的读取路径不产生任何写入和刷盘。进程崩溃最多丢失最近未刷盘的新增缓存，且由于快照是原子替换，磁盘上的旧库文件永远不会损坏。不做旧版本数据库自动迁移：库文件结构仅由当前代码的 SCHEMA 决定，删除旧库文件即重新开始缓存。`cache prune` 在一个事务中完成删除。默认不自动清理缓存。

分类缓存可通过 `digest cache clear-classifications [--older-than DAYS]` 显式清除：不带参数删除全部分类缓存，带参数只删除早于 N 天的条目，返回删除行数。

## 6. Markdown 输出

每周每个 category 生成 `weekly-{week}-{category}.md`，存放在 `output.directory` 下以 `{week}`（如 `2026-W34`）命名的子目录中（`output.subdirectory` 控制，默认 `{week}`，置空则单层存放）。文件头包含周窗口、生成时间、配置 hash、候选数量和该分类数量；每篇论文包含：

```markdown
## Paper title

- **Category:** Model Architecture
- **Tag:** `state-space-model`, `efficient-attention`
- **Authors:** Alice Example, Bob Sample
- **arXiv:** [2401.01234](https://arxiv.org/abs/2401.01234)
- **papers.cool:** [2401.01234](https://papers.cool/arxiv/2401.01234)
- **Published:** 2026-08-20

### Abstract

Original English abstract.
```

没有 tag 时省略 `Tag` 行。没有单独的 `Source` 行：每篇论文固定输出 arXiv 与 papers.cool 两条链接，papers.cool 链接由 arXiv ID 按固定模板 `https://papers.cool/arxiv/<id>` 构造，不来自任何外部字段。标题、作者、tag 和摘要中的 Markdown 特殊字符必须转义；arXiv 链接仍只允许 `https://arxiv.org/`（含 export 镜像归一化），papers.cool 链接是代码内构造的白名单地址。分类内按发布日期倒序、arXiv ID 正序稳定排序。渲染器不得自行查询数据库或调用 agent。

## 7. CLI 与验证

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm lint
pnpm test
pnpm digest --help
pnpm digest run [--from YYYY-MM-DD --to YYYY-MM-DD] [--config config.yaml] [--force] [--dry-run]
pnpm digest preview --week 2026-W34 [--category TOPIC_ID] [--config config.yaml]
pnpm digest cache stats
pnpm digest cache prune [--older-than DAYS]
pnpm digest cache clear-classifications [--older-than DAYS]
pnpm digest web build --week YYYY-Www [--config config.yaml]
pnpm site:css      # 生成 web/assets/app.css（提交进仓库）
pnpm site:build    # web/ + digests/ -> dist/site
pnpm site:deploy   # site:build 后把 dist/site 发布到 gh-pages 分支
```

`run` 的 stdout 输出 `files`、`categories` 和 `stats`（无 run ID，因为不再记录运行行）。抓取或分类失败通过 JSON lines 日志报告并返回非零退出码；失败不会被写库，直接重新 `run` 即可重试（失败的论文没有缓存条目，会自动重新分类），`--force` 用于强制重新抓取和重新分类。

`preview` 不读取任何快照：它按 ISO 周（`YYYY-Www`）反推周窗口，从 `papers` 表取出该周的论文并按当前 config 的缓存 key 查 `classification_cache`，然后离线重建每个 category 的 Markdown 视图。若本周没有缓存的论文或分类结果，preview 报错提示先运行 `digest run`。因为没有存档快照，preview 的 `Generated` 时间是当前时间，其余内容与对应 run 的输出一致。

## 8. 可靠性与验收标准

- 遵守 papers.cool/arXiv robots、服务条款和合理速率；固定 User-Agent、请求间隔、超时、指数退避和最大并发。
- 错误只通过 JSON lines 日志报告（stage、arxiv_id、error 类型等），不写入数据库；普通日志不打印摘要全文、完整 prompt 或密钥。分类失败返回非零退出码并保留已成功结果。
- 不下载 PDF，不把密钥写入配置、源码、日志或 Markdown；只使用 lockfile 固定的本地依赖。
- 解析器使用 DOM/XML 解析器而非正则。网络源变化时通过 fixture 契约测试发现，不静默生成空 digest。
- 固定 fixture、周窗口和 agent 分类结果时，重复运行输出字节一致；第二次运行不增加网络或 agent 调用。
- 自动化测试覆盖分页、版本去重、摘要 fallback、分类 JSON 校验、topic/tag 约束、缓存命中/失效、失败重试、Markdown 转义和多 category 文件输出。

## 9. 静态站点输出（gh-pages）

Markdown 之外，每次 `run` 为每个 category document 额外写一个同名 `.json` 副本（`weekly-{week}-{category}.json`），内容由 `JsonRenderer` 用稳定键序 JSON 序列化（`stableJson`，键排序 + 尾部换行），因此与 Markdown 一样满足"重复运行字节一致"。JSON 保留文档头字段（week/from/to/generatedAt/configHash/candidateCount）与每篇论文的展示字段（arxivId/title/authors/abstractEn/publishedAt/categories/classification），不输出 `contentHash`、`detailUrl` 等内部字段；papers.cool 链接不落盘，由前端按 arXiv ID 以固定模板构造。

两级 manifest 由文件系统扫描派生（`src/site.ts`），任何写入路径（run、`web build` 回填）之后都全量重建，不存在增量合并：

- `digests/<week>/index.json`：该周 categories（id/name/count，按 id 排序），驱动类别选择器与数量徽章；
- `digests/index.json`：所有含有效周 index 的周（week/from/to，按周倒序），驱动周选择器。

损坏或缺失的 JSON 文件在扫描时被跳过（解析失败视为不存在），一个坏文件不会破坏站点。JSON 写入与 Markdown 相同：临时文件 + 原子 rename。

`web build --week YYYY-Www` 离线回填某周的站点数据：走 `preview` 的缓存重建路径（只读 `papers` + `classification_cache`，不访问网络与 agent），重写该周 JSON 与两级 manifest。前提是该周已成功 `run` 过且分类缓存未被清除。

### 9.1 站点前端（web/ → dist/site）

`web/` 是无框架静态源码：`index.html` + `assets/app.js`（原生 ES module）+ `app.css`（Tailwind v4 入口）。`pnpm site:css` 用 tailwindcss CLI 产出压缩后的 `assets/app.css`；`pnpm site:build` 把 `web/` 与 `digests/` 数据树拷贝为发布产物 `dist/site`（含 `.nojekyll`）。前端行为契约：

- 页面只消费 JSON 文件；全部动态文本经 `textContent`/`createElement` 插入，不使用 `innerHTML`；
- 链接白名单与 Markdown 渲染器一致：仅 `https://arxiv.org/`（含 export 镜像归一化）与 `https://papers.cool/`，其余一律降级为纯文本；papers.cool 链接由 arXiv ID 前端构造；
- URL 状态用 query 参数（`?week=YYYY-Www&category=<id>`）：选择变化 `pushState`，前进/后退由 `popstate` 恢复；首次加载无参数时取最新周与首个类别并 `replaceState` 规范化；不使用 path 路由（Pages 静态托管无 rewrite）；
- 卡片字段与 Markdown 一致：标题、tag chips、Category/Authors/arXiv/papers.cool/Published、摘要（默认 4 行截断，可展开）；附客户端过滤框（标题/作者/摘要 substring，不参与 URL）与暗色模式（localStorage + `prefers-color-scheme`）。

### 9.2 GitHub Pages 部署（gh-pages 分支）

`pnpm site:deploy` = `site:build` + `scripts/deploy-site.mjs`：脚本在 `dist/gh-pages-worktree` 建临时 git worktree（分支已存在则检出，否则从 orphan 提交创建 `gh-pages`），把 `dist/site` 镜像为分支根目录，提交并推送（`GH_PAGES_REMOTE`/`GH_PAGES_BRANCH` 可覆盖默认 `origin`/`gh-pages`），最后移除 worktree。无内容变化时不推送。仓库侧一次性设置：Settings → Pages → Deploy from branch → `gh-pages` / `(root)`。日常发布流程：`pnpm digest run` →（可选 `pnpm digest web build`）→ `pnpm site:deploy`。站点资源全部使用相对路径，兼容项目页子路径。
