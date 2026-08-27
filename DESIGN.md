# Weekly arXiv Digest Agent 设计

## 1. 目标与范围

本项目是一个 Node.js + TypeScript 的命令行自动化 agent：从 papers.cool 抓取 arXiv 论文，按周建立候选集，调用 pi agent 判断论文是否符合用户兴趣，最后生成可复现的 Markdown digest。

首版默认覆盖 `cs.LG`、`cs.CL`、`cs.AI`，类别、周起止日期、相关性阈值和兴趣描述均由 YAML 配置控制。配置文件中已有的 `topic`、`categories`、`threshold`、`pi_agent` 和 `interest` 是输入约定；其中 `interest` 中每个编号的 IN-SCOPE 条目是一个输出 `category`，而不是把所有论文仅归为一个“大类”。所有 CLI 命令由项目的 pnpm scripts 暴露，pi agent 及其相关库作为项目依赖安装在本地 `node_modules` 中。

### 必须实现

- 抓取 papers.cool 的分类列表和论文详情；保留 arXiv id、标题、作者、分类、发布日期、摘要、详情页和来源 URL，但不下载或解析 PDF。
- 以 ISO 周为单位处理数据。默认窗口为最近一个完整周，也允许通过 CLI 明确传入 `--from`/`--to`。
- 先做确定性去重和本地缓存，再对新候选调用 pi agent。
- 只输出评分大于等于 `threshold` 的论文；空 `interest` 时跳过判断并保留全部候选。
- 对保留论文输出英文原文摘要和中文翻译；输出 `category`（兴趣清单中的一个或多个分类）和可选的 agent 生成 `tag`。
- 重复运行同一周时结果稳定、不会重复调用已缓存的抓取、摘要、评分或翻译任务。

### 非目标

- 不下载或解析论文 PDF，也不使用正文做筛选；这不是首版延后项，而是本工具的明确数据边界。
- 不在首版实现引用图谱、用户账号/订阅服务、Web UI 或 HTML 输出。
- 不把 LLM 当作事实来源：论文元数据和英文摘要始终来自抓取源；LLM 只负责相关性判断、分类/tag 和翻译。

## 2. 推荐技术栈与依赖管理

- Node.js 20+、pnpm、TypeScript、`tsx`（开发运行）和 `tsc`（构建）。`package.json` 使用 `packageManager` 固定 pnpm 版本，并提交 `pnpm-lock.yaml`。
- `yaml` 解析配置，`zod` 校验配置和 LLM JSON，`cheerio` 解析 papers.cool HTML，`p-limit` 控制并发，`date-fns`/原生 UTC 日期函数计算 ISO 周。
- SQLite（推荐 `better-sqlite3`）作为单文件缓存和运行记录；不依赖外部服务。
- Markdown 使用模板渲染（例如 `handlebars` 或小型纯函数），避免把未经转义的标题当成 Markdown 标记。
- pi agent 使用 `@mariozechner/pi-agent-core`，模型/API 抽象使用 `@mariozechner/pi-ai`；两者通过 `pnpm add` 声明在 `dependencies` 中并由 TypeScript 直接 import，测试替身放在 `devDependencies` 中。生产代码不依赖 `@mariozechner/pi-coding-agent` CLI。

应用不调用全局 `pi` 可执行文件，不使用 `npx` 临时下载，也不通过子进程启动 agent。`PiAgentAdapter` 直接使用本地 pi agent TypeScript API 创建会话、发送提示词并读取结果；具体包版本由 lockfile 固定。适配器要求 agent 返回单个 JSON，并用 zod 校验，不能凭自由文本猜测字段。模型服务所需的密钥从环境变量读取，不进入 YAML、源码或日志。

## 3. 配置设计

现有 `config.yaml` 可以继续使用。建议逐步扩展为：

```yaml
source:
  base_url: "https://papers.cool"
  categories: ["cs.LG", "cs.CL", "cs.AI"]
  request_delay_ms: 400
  timeout_ms: 20000
  user_agent: "weekly-digest/0.1"
window:
  timezone: "UTC"
  default: "last-complete-week"
output:
  directory: "digests"
  filename: "weekly-{week}.md"
  language: "zh-CN"
pi_agent:
  provider: "anthropic"
  model: "configured-model-id"
  timeout_ms: 120000
  max_retries: 2
```

为兼容当前文件：若不存在 `source.categories`，读取顶层 `categories`；自然语言类别（如 `Artificial Intelligence`）可通过内置映射转换到 arXiv ID，也允许直接填写 ID。配置错误（阈值不在 1--10、日期无效、类别为空等）在抓取前直接失败。

`interest` 的编号条目应被解析为稳定的分类 ID，例如 `interest-1-novel-model-architectures`。如果无法可靠解析编号，则保留一条 `interest-general`，并在输出中使用 agent 返回的受控分类名；不能让 LLM 任意创建新的顶层分类。

## 4. 系统流程

```text
配置加载/校验
      |
计算周窗口（UTC，含起始日、不含结束日）
      |
按 source.categories 抓取列表 -> 规范化 -> arXiv ID 去重
      |
抓取详情/摘要（HTTP 缓存、限速、重试）
      |
缓存命中则复用，否则 pi agent 评分 + category/tag
      |
保留 score >= threshold 的论文
      |
翻译摘要（独立缓存）
      |
按分类、评分、发布日期、arXiv ID 稳定排序
      |
渲染 digests/weekly-{ISO-week}.md，并写运行清单
```

列表页是发现入口，详情页是元数据的优先来源。若 papers.cool 页面缺少摘要，可按 arXiv ID 请求 arXiv 摘要页作为补充，并在记录中标注 fallback；若两者都失败，该论文进入错误表而不阻塞其他论文。

抓取器必须处理分页、相对链接、HTML 实体、时区和撤稿/版本号。规范化标题和摘要只用于去重/缓存指纹，展示内容保留原文；同一 arXiv ID 的多个版本默认保留最新版本。

## 5. LLM 合同

评分提示词中的论文内容严格只包含标题和英文摘要，此外仅附带完整 `interest`、评分规则和 `pi_agent.instructions`。作者、arXiv 分类、PDF、正文及其他论文元数据不作为判断输入，避免无关信息影响相关性评分。提示词明确要求只依据标题和摘要，不编造摘要未提供的实验结果；无法判断时给出低分并说明原因。

要求 pi 返回：

```json
{
  "score": 1,
  "reason": "short evidence-based reason",
  "categories": ["interest-1-novel-model-architectures"],
  "tags": ["state-space-model"],
  "translation_zh": "中文翻译"
}
```

评分调用和翻译调用逻辑上分离：评分缓存不会因为翻译失败而失效，翻译也可以在不重新评分的情况下重试。`categories` 只能来自解析后的 interest 分类 ID；`tags` 最多 3 个、短横线格式，非法值被丢弃。若 agent 返回无效 JSON、模型 API 报错或超时，则按可配置次数重试；最终失败的论文记入 `llm_errors`，默认不进入 digest，并让本次 pnpm command 返回非零退出码。

## 6. 缓存与数据模型

SQLite 文件默认放在 `.cache/weekly-digest.sqlite`，数据库目录和 digest 输出目录均可配置。建议表：

- `papers`: `arxiv_id` 主键、版本、标题、作者 JSON、categories JSON、abstract_en、published_at、updated_at、source_url、content_hash、抓取时间。
- `fetch_cache`: URL、请求参数指纹、HTTP 状态、响应体 hash、etag/last-modified、过期时间、错误信息。成功响应可长期复用，失败响应使用短 TTL。
- `relevance_cache`: `arxiv_id`、`abstract_hash`、`interest_hash`、`prompt_version`、`agent_package_version`、`provider`、`model`、score、reason、categories/tags JSON、原始响应、状态和时间。以上字段组成唯一缓存键，兴趣、提示词、agent 版本或模型变化会自然失效。
- `translation_cache`: `arxiv_id`、`abstract_hash`、目标语言、`prompt_version`、译文、原始响应、状态和时间。
- `runs`: `run_id`、周窗口、配置 hash、开始/结束时间、状态、统计信息 JSON。
- `run_papers`: 运行与论文的关联、最终纳入与否、过滤原因、排序序号。
- `llm_errors`: 阶段、论文、错误分类、重试次数、最后错误，便于后续只重试失败项。

所有 JSON 字段使用稳定序列化；写入采用事务，单篇失败不回滚已成功的论文。缓存命中必须记录命中来源，便于审计和调试。可提供 `cache prune --older-than`，但默认不自动删除数据。

## 7. 输出与渲染层

抓取、筛选和翻译阶段输出与展示格式无关的 `DigestDocument` 领域对象；渲染器只接收该对象，不直接查询数据库或调用 agent。首版实现 `MarkdownRenderer`，通过统一接口（如 `Renderer.render(document): string`）生成 Markdown。文件命名、扩展名和 MIME type 由渲染器声明，而不是散落在流水线中。

这种边界为未来增加 `HtmlRenderer` 留出余裕：HTML 输出可复用同一份排序后数据、分类、tag 和中英文摘要，无需重新抓取、评分或翻译。后续 HTML renderer 可增加语义化结构、目录、类别筛选、响应式样式和 print CSS；所有外部文本必须 HTML escape，禁止直接注入 agent 输出。HTML 是未来改进项，不属于首版验收范围。

### Markdown 输出

文件头包含周窗口、生成时间、配置 hash、候选数/纳入数和类别统计。每篇论文包含：

```markdown
## Paper title

- **Category:** Novel Model Architectures & Components
- **Tag:** `state-space-model`, `efficient-attention`
- **Score:** 9/10
- **arXiv:** [2401.01234](https://arxiv.org/abs/2401.01234)
- **Published:** 2026-08-20

### Abstract (English)
原始英文摘要

### 摘要（中文）
缓存的中文翻译
```

没有 tag 时省略该行；category 至少一个，多个时按 interest 顺序输出。标题、tag、摘要中的 Markdown 特殊字符须转义，链接使用白名单协议。输出采用临时文件写入后原子 rename，避免中断留下半文件。渲染器 contract test 应确保同一 `DigestDocument` 可由不同 renderer 消费，且不会触发网络、数据库或 LLM 调用。

## 8. CLI 与可观测性

`package.json` 提供 `"digest": "tsx src/cli.ts"`。所有用户命令从项目根目录通过 pnpm 执行，不要求全局安装 CLI：

- `pnpm digest run [--from YYYY-MM-DD --to YYYY-MM-DD] [--config config.yaml] [--force]`
- `pnpm digest preview --week 2026-W34`（只渲染，不调用网络/LLM）
- `pnpm digest cache stats|prune`
- `pnpm digest retry --run <run-id> --stage fetch|score|translate`

安装使用 `pnpm install --frozen-lockfile`，构建、类型检查和测试也分别通过 `pnpm build`、`pnpm typecheck`、`pnpm test` 执行。定时任务必须先切换到项目目录，再调用同一 pnpm script，确保解析到项目本地 `node_modules`。

日志使用 JSON lines 或带时间戳的结构化文本，包含 run、arxiv_id、stage、cache_hit、耗时和错误分类；摘要正文和完整 prompt 默认不打印到普通日志，可在 debug 模式写入受保护的 trace 文件。

## 9. 可靠性、合规与安全

- 遵守 papers.cool 和 arXiv 的 robots、服务条款和合理速率；使用固定 User-Agent、请求间隔、指数退避和最大并发。
- 仅保存公开论文元数据和用户本地 LLM 响应；不把密钥写入配置或日志。
- 运行时只加载 lockfile 固定的本地 Node.js 依赖；禁止 fallback 到全局 pi 命令或运行时下载包。
- HTML 解析使用 DOM 解析器，不用正则解析页面结构；所有外部文本在 Markdown 输出前转义。
- 抓取器不得请求 PDF URL；agent 适配器不得读取本地或远程 PDF，评分 prompt 的论文输入字段只能是 `title` 和 `abstract_en`。
- 网络源变化时通过解析器契约测试和选择器版本记录快速定位；必要时停止运行并保留部分结果，而不是静默生成空 digest。

## 10. 验收标准

给定固定的 fixture HTML、固定周窗口和 mock pi 输出：重复运行产生字节一致的 Markdown，第二次运行不增加网络/LLM 调用；分类过滤、版本去重、阈值边界、失败重试和中英文摘要均有自动化测试。真实环境运行一次 `digest run` 能生成目标周文件，并在日志中报告抓取、缓存和过滤统计。
