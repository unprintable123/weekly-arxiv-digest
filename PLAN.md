# Weekly arXiv Digest 迁移计划

## 1. 目标状态

项目迁移为三阶段自动化流水线：

1. 按配置的 arXiv 类别和周窗口抓取论文元数据与英文摘要，并复用 HTTP/论文缓存。
2. 使用本地 pi agent 和代码内固定、版本化的 prompt，按照 `TOPICS.yaml` 对论文分类并生成可选 tag。
3. 按 category 生成独立的 Markdown digest。

LLM 只负责分类和 tag，不执行相关性评分，不按阈值过滤，不翻译摘要。配置中不包含个人 `interest` 或可注入的 `instructions`。

## 2. 当前状态

### 已完成

- `DESIGN.md` 已更新为新的收集、分类、分组输出设计。
- `TOPICS.yaml` 已成为机器可读 taxonomy，当前包含：
  - 6 个 topic group；
  - 40 个 canonical topic；
  - 每个 topic 的稳定 ID、名称、分类边界和常见 tag；
  - primary/secondary 数量限制、ID/tag 格式、分类优先级和兼容 alias；
  - 分离的 `llm-alignment` 与 `llm-safety`；
  - `llm-physics`，覆盖 scaling laws、training dynamics、loss landscape、optimization stability、grokking 和 phase transition。
- `README.md` 和 `AGENTS.md` 已改为引用 `TOPICS.yaml` 和固定分类模板。
- `TOPICS.yaml` 可以被 `yaml` 包解析；topic ID 无重复，ID/tag 均符合 kebab-case。

### 尚未完成

运行时代码仍基本实现旧的 `interest + score + threshold + translation` 流程。`TOPICS.yaml` 尚未由源码加载，也没有参与 prompt、返回值校验或缓存失效。

当前质量检查：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：失败，37 个测试中 1 个失败。
- 失败项：papers.cool 详情缺少摘要时，arXiv fallback 解析结果错误保留 `Abstract:` 前缀。

## 3. 已发现问题

### P0：核心流程与设计不兼容

1. `src/config.ts` 仍强制要求 `threshold`，并接受 `interest`、`output.language` 和 `pi_agent.instructions`。按新设计编写的配置无法加载。
2. `TOPICS.yaml` 没有运行时 loader 或 Zod schema，category 合法性、alias、最大 category/tag 数量和 `other` fallback 均未执行。
3. `src/pi.ts` 仍生成评分 prompt，要求 `score`/`reason`，并插入个人 interest 和自定义 instructions。
4. `src/pipeline.ts` 仍执行评分、阈值过滤和摘要翻译；分类成功的论文仍可能因低分或翻译失败被排除。

### P1：数据与输出合同不兼容

1. `src/types.ts` 仍使用 `InterestCategory`、`RelevanceResult.score/reason` 和 `translationZh`。
2. `src/db.ts` 仍使用 `relevance_cache` 和 `translation_cache`，没有 `classification_cache` 或 taxonomy hash。
3. `run_documents` 以 `run_id` 为唯一主键，无法保存同一次运行的多个 category 文档。
4. `src/pipeline.ts` 只写一个文件，只替换 `{week}`，未实现 `{category}` 和多文件原子写入。
5. `src/renderer.ts` 仍输出 Score 和中文摘要，缺少 Authors 与 papers.cool Source 链接；链接白名单只接受 arXiv。
6. `src/cli.ts` 仍暴露 `score|translate` retry，preview fallback 仍读取 relevance/translation cache。
7. 分类缓存 key 不包含 `TOPICS.yaml` hash，taxonomy 改动不会使旧结果失效。

### P2：测试与现有缺陷

1. 配置、pipeline 和 renderer 测试仍验证 threshold、interest、score、translation 等旧合同。
2. 缺少 taxonomy schema、alias 规范化、category 合法性、固定 prompt、缓存失效、多 category 输出和 snapshot 测试。
3. `src/crawler.ts` 的 arXiv fallback 摘要前缀清理存在可复现失败。

## 4. 迁移阶段

### 阶段 1：Taxonomy loader 与新领域类型

涉及文件：`src/types.ts`、新建 `src/topics.ts`、`test/topics.test.ts`。

- 为 `TOPICS.yaml` 建立 Zod schema。
- 校验 version/kind、group/topic 唯一性、ID/tag 格式、`unknown_topic` 存在、alias 来源/目标和循环。
- 输出稳定的 topic map、alias map、允许 ID 集合、用于 prompt 的精简 catalog 和 taxonomy hash。
- 用 `TopicDefinition`、`ClassificationResult`、`ClassifiedPaper` 替换 Interest/Relevance/Translation 类型。
- 分类结果最多两个 category，顺序表示 primary/secondary；tag 最多三个。

完成判据：无效 taxonomy 在任何网络/agent 调用前失败；所有新类型不再包含 score、reason 或 translation。

### 阶段 2：配置迁移

涉及文件：`src/config.ts`、`config.yaml`、`test/config.test.ts`。

- 删除 `threshold`、`interest`、`output.language` 和 `pi_agent.instructions`。
- 将输出文件默认值改为 `weekly-{week}-{category}.md`。
- `pi_agent` 只保留 provider、model、timeout 和 retry 参数。
- 保留顶层 `categories` 到 `source.categories` 的兼容读取；移除 `parseInterest`。
- 配置加载时一并加载 `TOPICS.yaml`，或由启动层显式加载并传递 catalog。
- 决定并实现未知配置字段策略，建议 `z.strictObject`，避免旧字段被静默忽略。

完成判据：仓库默认 `config.yaml` 可加载；包含旧字段或无效 category 的配置有明确错误。

### 阶段 3：固定分类 agent 合同

涉及文件：`src/pi.ts`、`test/pi.test.ts`。

- 删除 `scorePaper` 和 `translateAbstract`。
- 新增固定常量 `CLASSIFICATION_PROMPT_VERSION` 和不可由配置覆盖的 prompt builder。
- prompt 输入仅为 title、abstract_en 和 taxonomy catalog。
- agent JSON 只允许 `{ categories, tags }`。
- category 经 alias 规范化后必须存在于 canonical topic map；最多两个且去重。
- tag 必须符合 taxonomy tag pattern、去重且最多三个；优先接受 catalog tags，允许证据充分的合法新 tag。
- 保留超时、重试和本地 pi TypeScript API 适配器。

完成判据：未知 category、空 categories、超量 category/tag 和非法 tag 均被拒绝或按明确策略规范化；prompt 不包含 interest、instructions、score 或 translation。

### 阶段 4：数据库与缓存迁移

涉及文件：`src/db.ts`、数据库测试。

- 新建 `classification_cache`，字段至少包含：cache key、arXiv ID、内容 hash、taxonomy hash、prompt version、agent version、provider、model、categories/tags JSON、raw、status 和时间。
- 新建或迁移为 `agent_errors`；stage 使用 `classify`。
- `run_papers` 保存该 run 使用的分类快照或指向确定的 classification cache key。
- `run_documents` 主键改为 `(run_id, category_id)`，保存每个 category 的 document JSON、Markdown 和文件路径。
- `cache stats/prune` 改为 fetch/classification 统计。
- 为已有数据库制定向前兼容迁移：可以保留旧表但新代码不再读写；不能依赖清空用户缓存。

完成判据：taxonomy/prompt/model/论文内容变化会产生新的分类缓存 key；同一次 run 可保存多个 category snapshot。

### 阶段 5：Pipeline 与多文件输出

涉及文件：`src/pipeline.ts`、`src/renderer.ts`、`src/cli.ts`。

- 抓取后对每篇论文查分类缓存；未命中时调用分类 agent。
- 删除 score、threshold、translation 和对应计数/日志。
- 分类成功的论文全部保留；分类失败记录错误并使命令返回非零，但不丢失其他成功结果。
- 按 primary/secondary category 建立文档。若一篇论文有两个 category，应出现在两个对应文件中。
- 每个 category 内按 `publishedAt` 降序、`arxivId` 升序稳定排序。
- 文件名替换 `{week}` 和 `{category}`；每个文件使用临时文件 + rename。
- Markdown 输出标题、Category、可选 Tag、Authors、arXiv、Source、Published、英文 Abstract；不输出 Score 或中文摘要。
- 链接白名单支持 `https://arxiv.org/` 和 `https://papers.cool/`。
- `RunResult` 返回文件列表和文档列表；CLI JSON 同步更新。
- preview 从 run document snapshots 读取并稳定输出一个或全部 category。
- 删除 score/translate retry；如保留 retry，只支持 `fetch|classify` 并与文档一致。

完成判据：一个固定周运行生成多个 category 文件；重复缓存运行输出字节一致且不增加网络/agent 调用。

### 阶段 6：测试迁移与现有 bug 修复

涉及文件：`test/**/*.test.ts`、crawler fixture。

- 重写 config、pi、pipeline、renderer 测试以覆盖新合同。
- 增加 `TOPICS.yaml` loader/schema/alias 测试。
- 增加 taxonomy hash 改动导致缓存失效测试。
- 增加 primary/secondary 多文件输出、作者/来源链接、无 tag 省略行和 Markdown escaping 测试。
- 增加分类失败部分成功、缓存重复运行、run snapshot preview 测试。
- 修复 arXiv fallback 的 `Abstract:` 前缀：先规范化空白，再剥离标签，或使用 DOM 节点级提取。

完成判据：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过，测试不访问真实网络或模型服务。

## 5. 迁移风险与决策

- **旧数据库兼容：** 不删除用户现有 `.cache`；通过建新表或 schema migration 前向升级。
- **一篇论文多分类：** primary 与 secondary 均生成对应 category 文件，因此总文件条目数可能大于唯一论文数。
- **跨 topic 重复 tag：** `TOPICS.yaml` 中允许共享 tag，例如 `planning`、`calibration` 和 `prompt-injection`；合法性按 tag pattern 和单篇数量校验，不要求全局唯一。
- **动态 tag：** topic 内 tag 是建议词表，不是硬枚举；列表外 tag 仍必须符合 kebab-case 且有摘要证据。
- **部分失败：** 分类失败不应阻止其他论文写入，但 run 状态和 CLI 退出码必须反映错误。
- **文档稳定性：** taxonomy hash、prompt version 和 agent version 都进入缓存 key；snapshot 不从“最新缓存”动态重建。

## 6. 最终验收清单

- [ ] 默认配置不含 threshold、interest、instructions 或 output language。
- [ ] 启动时解析并校验 `TOPICS.yaml`。
- [ ] 分类 prompt 固定且版本化，只接收标题、英文摘要和 taxonomy。
- [ ] agent 输出 category/tag 通过结构和语义校验。
- [ ] 不存在评分、阈值过滤或摘要翻译运行路径。
- [ ] classification cache 包含 taxonomy/prompt/agent/model 失效条件。
- [ ] 每周每个 category 生成独立 Markdown。
- [ ] Markdown 含标题、category、可选 tag、作者、arXiv/source 链接、日期和英文摘要。
- [ ] preview 使用 run 级分类和文档快照。
- [ ] 重复运行不增加网络/agent 调用且输出字节一致。
- [ ] fixture 测试覆盖抓取、分类、缓存、错误和多文件输出。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过。
