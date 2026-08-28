# Weekly arXiv Digest 迁移计划

## 1. 目标状态

项目迁移为三阶段自动化流水线：

1. 按配置的 arXiv 类别和周窗口抓取论文元数据与英文摘要，并复用 HTTP/论文缓存。
2. 使用本地 pi agent 和代码内固定、版本化的 prompt，按照 `TOPICS.yaml` 对论文分类并生成可选 tag。
3. 按 category 生成独立的 Markdown digest。

LLM 只负责分类和 tag，不执行相关性评分，不按阈值过滤，不翻译摘要。配置中不包含个人 `interest` 或可注入的 `instructions`。

## 2. 当前状态

迁移已完成。运行时代码不再包含 `interest + score + threshold + translation` 流程：

- `src/topics.ts` 加载并校验 `TOPICS.yaml`（Zod schema + 结构不变量 + 稳定 hash）。
- `src/config.ts` 使用 `z.strictObject`，旧字段会被拒绝；默认输出文件名为 `weekly-{week}-{category}.md`。
- `src/pi.ts` 只提供固定、版本化的分类 prompt 和 `classifyPaper`；`scorePaper`/`translateAbstract` 已删除。
- `src/db.ts` 使用 `classification_cache`、`agent_errors` 和按 `(run_id, category_id)` 建键的 `run_documents`，并对旧数据库做前向迁移（旧表保留但不再读写）。
- `src/pipeline.ts` 按 primary/secondary category 生成多个文档和文件；`src/renderer.ts` 只消费 `DigestDocument`。
- `src/cli.ts` 暴露 `run`、`preview`（run 快照回放，支持 `--category`）、`retry`（仅 `fetch|classify`）和 `cache` 命令。
- `TOPICS.yaml` 中 precedence 条目的行内说明文字已改为 YAML 注释，使每个条目都是可解析的两个 topic ID。

当前质量检查（2026-08-28）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，8 个文件 75 个测试（覆盖 taxonomy、config、严格 agent 输出契约、pi、db、crawler 日志、pipeline、renderer、window）。
- `pnpm build`：通过。
- `pnpm digest --help` / `cache stats`：CLI wiring 正常。

## 3. 已发现问题（全部已解决）

以下问题在迁移过程中确认并修复：

1. ~~`src/config.ts` 仍强制要求 `threshold` 等~~：已删除并用 strict schema 拒绝旧字段。
2. ~~`TOPICS.yaml` 没有运行时 loader~~：新增 `src/topics.ts`，分类合法性、alias、数量上限和 `other` fallback 均已执行。
3. ~~`src/pi.ts` 生成评分 prompt~~：已替换为固定分类 prompt。
4. ~~`src/pipeline.ts` 执行评分、阈值过滤和翻译~~：已删除；分类失败记录 `agent_errors` 并使 run 返回非零。
5. ~~数据与输出合同不兼容~~：`types.ts`、`db.ts`、`renderer.ts`、`cli.ts` 均已迁移到新合同。
6. ~~arXiv fallback 摘要保留 `Abstract:` 前缀~~：`crawler.ts` 先规范化空白再剥离标签（`abstractText`），并有 fixture 测试覆盖。

## 4. 迁移阶段（全部完成）

### 阶段 1：Taxonomy loader 与新领域类型 ✅

- `src/topics.ts`：Zod schema；校验 version/kind、group/topic 唯一性、文件声明的 ID/tag pattern、`unknown_topic` 存在、alias 来源/目标/循环、precedence 引用；输出 topic map、alias map、precedence、prompt catalog 和稳定 hash。
- `src/types.ts`：`ClassificationResult`、`ClassifiedPaper`、按 category 的 `DigestDocument`；不再包含 score、reason、translation。
- 分类结果最多两个 category（顺序即 primary/secondary），tag 最多三个。

### 阶段 2：配置迁移 ✅

- 删除 `threshold`、`interest`、`output.language`、`pi_agent.instructions` 和 `topic`；`z.strictObject` 使旧字段报错。
- 输出文件默认值 `weekly-{week}-{category}.md`，加载时校验占位符。
- `loadConfig` 同时加载并校验同级 `TOPICS.yaml`；仓库默认 `config.yaml` 可直接加载。
- 保留顶层 `categories` 兼容读取；`parseInterest` 已删除。

### 阶段 3：固定分类 agent 合同 ✅

- 固定常量 `CLASSIFICATION_PROMPT_VERSION`；prompt 只含 title、abstract_en 和 taxonomy catalog，配置不可覆盖。
- agent JSON 只允许 `{ categories, tags }`；category 经 alias 规范化后必须存在于 canonical topic map，去重、precedence 排序、按 `max_categories` 截断；空结果按重试策略处理。
- tag 小写规范化、按 taxonomy tag pattern 过滤、去重且最多三个；保留超时、重试与本地 pi TypeScript API 适配器。

### 阶段 4：数据库与缓存迁移 ✅

- `classification_cache`：cache key、arXiv ID、内容 hash、taxonomy hash、prompt version、agent version、provider、model、categories/tags JSON、raw、status、时间。
- `agent_errors`（stage `classify`）；`run_papers` 增加 `classification_key` 列；`run_documents` 主键 `(run_id, category_id)`。
- `cache stats/prune` 基于 fetch/classification；旧表前向保留，legacy `run_documents` 自动迁移且数据不丢。

### 阶段 5：Pipeline 与多文件输出 ✅

- 抓取后查分类缓存，未命中调用 agent；删除评分、阈值与翻译路径。
- 分类成功的论文全部保留；失败记录错误、run 状态 `error`、CLI 退出码非零，不影响其他论文。
- 按 primary/secondary category 建立文档；双 category 论文出现在两个文件中；category 内按 `publishedAt` 降序、`arxivId` 升序稳定排序。
- 文件名替换 `{week}` 和 `{category}`，临时文件 + rename 原子写入。
- Markdown 含标题、Category、可选 Tag、Authors、arXiv、Source、Published、英文 Abstract；链接白名单支持 `https://arxiv.org/`（含 export.arxiv.org 归一化）和 `https://papers.cool/`。
- `RunResult` 返回文件与文档列表；preview 从 run document snapshots 读取，支持单 category 或全部。
- retry 仅支持 `fetch|classify`。

### 阶段 6：测试迁移与现有 bug 修复 ✅

- 重写 config、pipeline、renderer 测试；新增 topics、pi、db 测试。
- 覆盖：taxonomy schema/alias/hash、固定 prompt、category/tag 规范化、缓存命中与 taxonomy 失效、多 category 输出、双 category 论文、作者/来源链接、无 tag 省略行、Markdown escaping、分类失败部分成功、classify retry、run snapshot preview、legacy `run_documents` 迁移。
- 修复 arXiv fallback `Abstract:` 前缀（先规范化空白再剥离）。

## 5. 迁移风险与决策

- **旧数据库兼容：** 不删除用户现有 `.cache`；新表通过 `CREATE TABLE IF NOT EXISTS` 增量创建，legacy `run_documents` 自动迁移，旧 relevance/translation 表保留但不再读写。
- **一篇论文多分类：** primary 与 secondary 均生成对应 category 文件，因此总文件条目数可能大于唯一论文数。
- **跨 topic 重复 tag：** `TOPICS.yaml` 中允许共享 tag；合法性按 tag pattern 和单篇数量校验，不要求全局唯一。
- **动态 tag：** topic 内 tag 是建议词表；列表外 tag 必须符合文件声明的 tag pattern，小写规范化后接受。
- **未知/空分类：** 归一化后无有效 category 视为失败，进入重试并最终记录 `agent_errors`，不静默降级。
- **部分失败：** 分类失败不阻止其他论文写入，但 run 状态和 CLI 退出码反映错误。
- **文档稳定性：** taxonomy hash、prompt version 和 agent version 都进入缓存 key；snapshot 不从"最新缓存"动态重建；全缓存重放复用上一次 run 的 `ended_at` 保证字节一致。
- **TOPICS.yaml precedence 行内注释：** 解析要求每条 precedence 恰好是 `a > b`，行内说明文字一律写成 YAML 注释。

## 6. 最终验收清单

- [x] 默认配置不含 threshold、interest、instructions 或 output language。
- [x] 启动时解析并校验 `TOPICS.yaml`。
- [x] 分类 prompt 固定且版本化，只接收标题、英文摘要和 taxonomy。
- [x] agent 输出 category/tag 通过结构和语义校验。
- [x] 不存在评分、阈值过滤或摘要翻译运行路径。
- [x] classification cache 包含 taxonomy/prompt/agent/model 失效条件。
- [x] 每周每个 category 生成独立 Markdown。
- [x] Markdown 含标题、category、可选 tag、作者、arXiv/source 链接、日期和英文摘要。
- [x] preview 使用 run 级分类和文档快照。
- [x] 重复运行不增加网络/agent 调用且输出字节一致。
- [x] fixture 测试覆盖抓取、分类、缓存、错误和多文件输出。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过。
