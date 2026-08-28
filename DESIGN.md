# Weekly arXiv Digest Agent 设计

## 1. 目标与范围

本项目是一个 Node.js + TypeScript 命令行 agent：按周从 papers.cool（可选 arXiv API）收集论文，使用本地 pi agent 按 `TOPICS.yaml` 的受控词表分类，最后为每个分类生成 Markdown digest。

首版默认关注 `cs.LG`、`cs.CL`、`cs.AI`，来源类别和周窗口均由 YAML 配置控制。论文元数据和英文摘要始终来自抓取源；LLM 只负责分类和可选 tag，不负责相关性评分，也不负责摘要翻译。

必须输出的论文字段：标题、分类、作者、英文原始摘要、arXiv/papers.cool 链接。`tag` 是可选的分类细分结果，由 agent 从摘要中提取；没有 tag 时不输出该字段。

非目标：下载或解析 PDF、使用正文筛选论文、LLM 打分/阈值过滤、LLM 翻译摘要、引用图谱、账号订阅服务、Web UI 和 HTML/CSS 展示。HTML 是 Markdown 版本稳定后再考虑的独立工作。

## 2. 技术栈与模块边界

- Node.js `>=22.19.0`、pnpm `9.15.0`、严格 TypeScript、ESM、`tsx` 和 `tsc`。
- `yaml` + `zod` 负责配置和 agent JSON 校验，`cheerio` 负责 HTML/Atom 解析，`p-limit` 控制并发，`sql.js` 提供单文件 SQLite 缓存。
- `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 从本地依赖加载。禁止全局 `pi`、`npx`、运行时下载依赖或子进程启动 agent。

源码职责：

- `src/config.ts`：读取 YAML、校验字段和解析来源类别配置。
- `src/window.ts`：计算 ISO 周窗口，默认最近一个完整周，也支持显式 `--from`/`--to`。
- `src/crawler.ts`：抓取分类列表和详情页，解析元数据与摘要，处理分页、版本去重、限速、重试和 HTTP 缓存。
- `src/pi.ts`：创建本地 pi 会话，仅执行分类/tag 请求，并校验受控 JSON 返回值。
- `src/db.ts`：持久化论文、抓取响应、分类结果、运行记录和错误记录。
- `src/pipeline.ts`：编排收集、分类、排序和输出，保证缓存命中时不重复调用网络或 agent。
- `src/renderer.ts`：只消费领域对象并渲染 Markdown，不访问网络、数据库或 agent。
- `src/cli.ts`：暴露 `run`、`preview` 和缓存管理命令，stdout 保持机器可读。

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
  filename: weekly-{week}-{category}.md
pi_agent:
  provider: anthropic
  model: configured-model-id
  timeout_ms: 120000
  max_retries: 2
```

为兼容当前配置，若不存在 `source.categories`，读取顶层 `categories`；自然语言类别可映射为 arXiv ID，也允许直接填写 ID。`pi_agent` 只配置模型连接和重试参数，不提供个人兴趣或自定义 instructions。分类 prompt 必须由代码中的固定模板生成，并通过版本号参与缓存 key。不要再增加 `threshold`、`interest`、`instructions` 或 `output.language` 之类无关字段。配置错误（类别为空、URL 无效、日期无效等）必须在抓取前失败。

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
分类缓存命中则复用，否则 pi agent 返回 category + 可选 tag
      |
按 category、发布日期、arXiv ID 稳定排序
      |
每周每个 category 写一个 Markdown 文件，并记录运行结果
```

### 4.1 收集论文

列表页用于发现，详情页用于补全标题、作者、分类、发布时间和摘要。papers.cool 缺少摘要时可以按 arXiv ID 请求摘要页作为 fallback；两者都失败时记录抓取错误并跳过该论文，不阻塞其他类别。

抓取器必须处理分页、相对链接、HTML 实体、时区、撤稿和版本号。同一 arXiv ID 的多个版本只保留最新版本。展示字段保留原文；规范化标题/摘要只用于去重和缓存指纹。任何请求都不得指向 PDF URL。

### 4.2 分类与 tag

分类 prompt 使用代码内固定、版本化的模板，只包含论文标题、英文摘要和 `TOPICS.yaml` 中的候选 topic。作者、PDF、正文和用户自定义 instructions 不得进入分类判断。pi agent 仅作为内部自动化执行器，调用方不能注入临时任务说明。

agent 必须返回一个 JSON 对象：

```json
{
  "categories": ["llm-architecture"],
  "tags": ["state-space-model", "efficient-attention"]
}
```

`categories` 至少一个且只能来自受控 topic ID；`tags` 可为空，最多 3 个，使用小写短横线格式。无效 JSON、未知分类、超时或服务错误按配置次数重试，最终失败写入错误表。没有评分，因此所有成功抓取且分类成功的论文都进入输出，不做 threshold 过滤。

分类缓存 key 至少包含 arXiv ID、标题/摘要 hash、topic 词表 hash、固定 prompt 版本、agent 包版本、provider 和 model。任一输入变化都必须使旧分类缓存失效。

## 5. 缓存与数据模型

SQLite 文件默认位于 `.cache/weekly-digest.sqlite`，成功的抓取和分类响应可复用，失败响应使用短 TTL。建议表：

- `papers`：arXiv ID、版本、标题、作者 JSON、原始 arXiv 分类、英文摘要、发布时间、详情 URL、来源 URL、内容 hash、抓取时间。
- `fetch_cache`：URL、请求指纹、HTTP 状态、响应体 hash、ETag/Last-Modified、过期时间和错误。
- `classification_cache`：论文内容 hash、topic/prompt/agent 元信息、category JSON、tag JSON、原始响应、状态和时间。
- `runs`：run ID、周窗口、配置 hash、开始/结束时间、状态和统计信息。
- `run_papers`：运行与论文的关联、分类结果、是否输出、排序序号和过滤/错误原因。
- `crawl_errors` / `agent_errors`：阶段、论文、URL（如有）、错误类型、重试次数和消息。
- `run_documents`：每个 category 文件的文档快照和输出路径，供 `preview` 稳定重现。

写入使用事务；运行期间的成功记录不能因单篇失败回滚。数据库和 Markdown 文件都采用临时文件加原子 rename。默认不自动清理缓存，可显式执行 `cache prune`。

## 6. Markdown 输出

每周每个 category 生成 `weekly-{week}-{category}.md`。文件头包含周窗口、生成时间、配置 hash、候选数量和该分类数量；每篇论文包含：

```markdown
## Paper title

- **Category:** Model Architecture
- **Tag:** `state-space-model`, `efficient-attention`
- **Authors:** Alice Example, Bob Sample
- **arXiv:** [2401.01234](https://arxiv.org/abs/2401.01234)
- **Source:** [papers.cool](https://papers.cool/arxiv/2401.01234)
- **Published:** 2026-08-20

### Abstract

Original English abstract.
```

没有 tag 时省略 `Tag` 行。标题、作者、tag 和摘要中的 Markdown 特殊字符必须转义；链接只允许 `https://arxiv.org/` 和 `https://papers.cool/`。分类内按发布日期倒序、arXiv ID 正序稳定排序。渲染器不得自行查询数据库或调用 agent。

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
pnpm digest retry --run <run-id> --stage fetch|classify [--config config.yaml]
pnpm digest cache stats
pnpm digest cache prune [--older-than DAYS]
```

分类失败应返回非零退出码并保留已成功结果。日志使用 JSON lines，至少包含 run、stage、arxiv_id、category、cache_hit、耗时和错误类型；普通日志不打印摘要全文、完整 prompt 或密钥。

## 8. 可靠性与验收标准

- 遵守 papers.cool/arXiv robots、服务条款和合理速率；固定 User-Agent、请求间隔、超时、指数退避和最大并发。
- 不下载 PDF，不把密钥写入配置、源码、日志或 Markdown；只使用 lockfile 固定的本地依赖。
- 解析器使用 DOM/XML 解析器而非正则。网络源变化时通过 fixture 契约测试发现，不静默生成空 digest。
- 固定 fixture、周窗口和 agent 分类结果时，重复运行输出字节一致；第二次运行不增加网络或 agent 调用。
- 自动化测试覆盖分页、版本去重、摘要 fallback、分类 JSON 校验、topic/tag 约束、缓存命中/失效、失败重试、Markdown 转义和多 category 文件输出。
