# Weekly arXiv Digest Agent 实现计划

## 阶段 0：确认约定与脚手架

- 使用 pnpm 初始化 `package.json`、`pnpm-lock.yaml`、TypeScript 配置、`src/`、`test/`、`digests/` 和 `.cache/` 的目录约定，并用 `packageManager` 固定 pnpm 版本。
- 将 `@mariozechner/pi-agent-core` 和 `@mariozechner/pi-ai` 加入项目 `dependencies`，全部从本地 `node_modules` import；生产流程不依赖 `@mariozechner/pi-coding-agent` CLI，并禁止全局 CLI、`npx` 和子进程 fallback。
- 定义 `"digest": "tsx src/cli.ts"` 等 pnpm scripts、CLI 入口、退出码、日志接口和依赖版本（Node 20+）。
- 写配置 schema：兼容当前顶层 `categories`，同时支持 `source.categories`、输出和窗口扩展字段。
- 验收：`pnpm digest --help` 可运行；有效配置可加载；阈值、日期、类别等非法输入给出明确错误且不发网络请求；删除或屏蔽全局 pi 命令不影响运行。

## 阶段 1：日期窗口与论文领域模型

- 实现 ISO 周计算（默认最近一个完整周，UTC；`--from` 含起始日、`--to` 不含结束日）。
- 定义 `Paper`、`InterestCategory`、`RelevanceResult`、`DigestRun` 等 TypeScript 类型和稳定 hash/序列化工具。
- 定义与输出格式解耦的 `DigestDocument` 和 `Renderer` 接口，首版只注册 Markdown renderer。
- 解析 `interest` 的编号条目，生成稳定 category ID 与显示名，并实现自然语言类别到 `cs.*` ID 的映射/直通规则。
- 验收：跨月、跨年、周日/周一边界测试通过；相同输入 hash 稳定。

## 阶段 2：papers.cool 抓取器

- 实现分类列表抓取、分页、日期过滤、详情页解析和相对 URL 规范化。
- 明确阻止 PDF 请求：只从列表页、论文详情/摘要页获取标题、摘要和必要元数据，不实现 PDF URL 下载或正文解析路径。
- 加入 timeout、限速、有限次数指数退避、User-Agent、ETag/Last-Modified；用 arXiv 摘要页作为缺失摘要的 fallback。
- 将 HTML 响应和规范化论文写入 SQLite，按 arXiv ID 合并最新版本并去重。
- 验收：fixture 覆盖分页、实体编码、缺摘要、版本、撤稿/异常 HTML；网络失败不影响其他论文并留下可重试错误；HTTP mock 断言运行期间不存在 PDF 请求。

## 阶段 3：SQLite 缓存层

- 建立 schema migration 和事务封装，完成 `papers`、`fetch_cache`、`relevance_cache`、`translation_cache`、`runs`、`run_papers`、`llm_errors` 表。
- 实现缓存键：摘要 hash、interest hash、prompt 版本、pi agent 包版本、provider、model、目标语言；区分成功、失败和短 TTL 状态。
- 提供 `cache stats` 与安全的按时间 prune；所有命中/未命中写入结构化日志。
- 验收：同一输入重复运行零额外调用；修改 interest、摘要或 prompt 版本只使相关缓存失效。

## 阶段 4：本地 pi agent 模块适配器与 LLM 流程

- 通过本地 Node.js 包的 TypeScript API 实现 `PiAgentAdapter`，封装会话生命周期、模型 API 错误、超时和重试，不启动外部进程。
- 构造评分 prompt 时，论文内容只能包含标题和英文摘要；不得加入作者、arXiv 分类、PDF、正文或其他论文元数据。
- 编写评分 JSON schema 与提示词，校验 score 1--10、受控 categories、最多 3 个 tags；保留 reason 和原始响应。
- 实现独立的中文摘要翻译调用/缓存；评分成功但翻译失败时允许单独重试。
- 空 `interest` 时跳过评分；score 小于阈值的论文不进入翻译和输出。
- 验收：mock pi module 覆盖有效 JSON、坏 JSON、模型 API 错误、超时和阈值 7 的边界行为；prompt 快照测试确认论文判断输入仅含标题和摘要；测试断言没有调用 child process。

## 阶段 5：digest 渲染

- 按 category 顺序、score 降序、发布日期降序、arXiv ID 升序稳定排序。
- 生成包含周信息、统计、category、可选 tag、score、英文摘要和中文摘要的 Markdown；转义标题/正文并校验外链协议。
- 使用临时文件 + 原子 rename；实现 `preview` 复用已缓存数据，不触发网络或 LLM。
- 通过 `Renderer` 接口渲染，增加 renderer contract test；保留未来注册 `HtmlRenderer` 的扩展点，但首版不实现 HTML 模板和样式。
- 验收：golden file 测试字节一致；无 tag、多个 category、中文/Markdown 特殊字符和空结果均有覆盖。

## 阶段 6：端到端命令与运维

- 串联 `pnpm digest run`、`preview`、`retry`、`cache` 子命令，写入 run manifest 和汇总统计。
- 增加 dry-run/debug 模式、并发参数、最大论文数保护和中断后的可恢复运行。
- 补充 README 中的 pnpm 安装、本地 pi agent 依赖、模型认证环境变量、配置示例、合规/速率说明和定时任务示例（cron/systemd）。
- 验收：使用离线 fixture 完整跑通；真实 papers.cool 小范围运行生成一个周 digest；第二次运行验证缓存命中与幂等性。

## 未来改进：HTML 输出

- 基于现有 `DigestDocument` 新增 `HtmlRenderer`，不改动抓取、缓存、评分和翻译流程。
- 支持语义化 HTML、目录、类别筛选、响应式布局和 print CSS，并对所有外部/agent 文本进行 HTML escape。
- 使用 renderer contract test 和 HTML snapshot 验证内容与 Markdown 一致；HTML 生成不得触发额外网络或 LLM 调用。

## 测试与质量门槛

- 单元测试：配置、周窗口、分类解析、HTML 选择器、去重、hash、Markdown 转义和排序。
- 集成测试：SQLite 事务/迁移、HTTP mock、pi mock、重试和缓存失效矩阵。
- 端到端测试：固定 fixture 从抓取到 Markdown，校验统计与输出结构。
- CI 运行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm test`；禁止测试依赖全局 pi、真实 LLM 或无界网络请求。

## 交付顺序

按阶段 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 实施，每阶段合并前完成对应验收。优先保证离线可测试和幂等缓存，再接入真实源和 pi；任何源站选择器变化先更新 fixture/解析器契约测试，再发布新版本。
