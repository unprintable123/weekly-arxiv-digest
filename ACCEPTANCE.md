# 项目代码验收报告

验收结论：**不通过**。

当前实现可以通过 TypeScript 编译和 CLI 帮助命令，但核心流程缺少自动化验证，并且存在会影响结果正确性、幂等性、失败恢复和设计契约的实现问题。

## 验证结果

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `pnpm digest --help`：通过。
- `pnpm test`：失败，Vitest 报告 `No test files found` 并以退出码 1 结束。
- 仓库没有 fixture、单元测试、集成测试或端到端测试文件。
- `package.json` 没有 `lint` script，但 `PLAN.md` 要求 CI 执行 `pnpm lint`。

## 阻塞问题

### P0-1：测试门槛未满足

`pnpm test` 没有任何测试文件，无法验证设计要求的分页、HTML 解析、版本去重、阈值边界、LLM 重试、缓存失效、Markdown 转义和端到端输出。

相关位置：

- `package.json:10`
- `PLAN.md:78`
- `DESIGN.md:171`

## 高风险问题

### P1-1：重复运行不会产生字节一致的 Markdown

`runDigest` 每次使用新的 `generatedAt`，渲染器又把该字段写入 Markdown。因此即使第二次运行完全命中缓存，输出文件仍然不同，违反幂等性验收要求。

相关位置：

- `src/pipeline.ts:126`
- `src/renderer.ts:20`
- `DESIGN.md:173`

### P1-2：`retry --stage` 没有真正的阶段级重试

CLI 接受 `fetch`、`score`、`translate` 三个阶段，但实际无论传入哪个阶段，都以 `force: true` 重新执行完整流程。参数中的 `stage` 只在最终输出中回显，没有控制具体重试范围。

这会导致重试不必要地重新抓取、重新评分和重新翻译所有论文，并可能产生新的结果。

相关位置：

- `src/cli.ts:55`
- `src/cli.ts:66`
- `src/pipeline.ts:36`

### P1-3：抓取失败可能被静默当成成功的空 digest

crawler 在 HTTP 或网络失败后直接 `break`，没有把 fetch 错误写入运行错误记录。若本次没有 LLM 错误，pipeline 仍会写出文件并将 run 标记为 `ok`，因此源站不可用时可能得到看似成功的空 digest。

这违反了“不要静默生成空 digest，并保留可重试错误”的设计要求。

相关位置：

- `src/crawler.ts:149`
- `src/crawler.ts:156`
- `src/crawler.ts:187`
- `src/crawler.ts:347`
- `src/pipeline.ts:39`
- `src/pipeline.ts:144`

### P1-4：缺失摘要没有进入错误表

papers.cool 详情页失败后会继续使用列表数据；arXiv fallback 也失败后，论文仍可能以空摘要返回。后续流程可能对空摘要进行评分，或者在空 interest 时对空内容进行翻译，而不是将该论文记录为抓取错误并跳过。

相关位置：

- `src/crawler.ts:205`
- `src/crawler.ts:212`
- `src/crawler.ts:304`
- `src/crawler.ts:314`

### P1-5：`preview` 不是指定 run 的稳定快照

`run_papers` 只保存论文 ID，preview 再从当前 `papers` 表读取论文数据。评分和翻译则分别通过论文 ID 查询最新缓存，而不是查询该 run 实际使用的缓存结果。

因此后续运行或配置改变后，旧 run 的 preview 可能显示新的标题、摘要、评分、分类或翻译，无法保证历史结果可复现。

相关位置：

- `src/db.ts:286`
- `src/db.ts:332`
- `src/db.ts:382`
- `src/cli.ts:107`
- `src/cli.ts:120`

### P1-6：相关性缓存失效条件不完整

相关性缓存 key 包含论文内容、interest、prompt 版本、provider 和 model，但没有包含 `pi_agent.instructions` 或实际 agent 包版本。保存缓存时 `agentVersion` 还被硬编码为 `local`。

修改评分指令或升级 agent 后，旧评分仍可能命中，不符合设计要求的缓存失效规则。

相关位置：

- `src/pipeline.ts:58`
- `src/pipeline.ts:71`
- `src/pipeline.ts:75`
- `src/db.ts:303`

### P1-7：Pi 依赖和架构契约不一致

当前项目应当使用 `@earendil-works/pi-*` `@earendil-works/pi-coding-agent`。

此外，`PiAgentAdapter` 实际只调用 `pi-ai`，没有使用 `pi-agent-core` 创建 agent 会话，和设计中的适配器职责不一致。

相关位置：

- `package.json:16`
- `package.json:17`
- `package.json:18`
- `DESIGN.md:30`
- `PLAN.md:8`
- `src/pi.ts:19`

### P1-8：Node 版本声明与实际依赖不兼容

项目声明支持 Node `>=20`，但当前锁定的 pi 包自身要求 Node `>=22.19.0`。当前验证环境为 Node `22.14.0`，也低于这些依赖声明的最低版本。

相关位置：

- `package.json:7`
- `node_modules/@earendil-works/pi-ai/package.json` 的 `engines.node`
- `node_modules/@earendil-works/pi-agent-core/package.json` 的 `engines.node`

## 中风险问题

### P2-1：数据库持久化不满足中断恢复要求

pipeline 中的写入主要保留在 sql.js 内存数据库中，最终在 `close()` 时一次性写回文件。数据库文件写入也没有使用临时文件和原子 rename。

进程中断时可能同时丢失缓存、run 记录和错误记录；写入过程中中断还可能留下损坏的 SQLite 文件。

相关位置：

- `src/db.ts:71`
- `src/db.ts:86`
- `src/db.ts:193`
- `src/pipeline.ts:149`

### P2-2：可观测性不足

CLI 只输出最终汇总 JSON，没有设计要求的 `run`、`arxiv_id`、`stage`、`cache_hit`、耗时和错误分类信息，也没有 debug trace 文件能力。

相关位置：

- `src/cli.ts:40`
- `src/cli.ts:71`
- `DESIGN.md:160`

### P2-3：配置字段存在但没有生效

`window.timezone` 和 `window.default` 被 schema 接受但没有参与实际逻辑。`output.language` 也可配置为任意字符串，但翻译 prompt 固定要求简体中文，输出字段始终是 `translationZh`。

相关位置：

- `src/config.ts:30`
- `src/config.ts:39`
- `src/pi.ts:88`
- `src/window.ts:12`

### P2-4：计划中的运行能力尚未实现

计划明确列出的 dry-run、debug、并发参数、最大论文数保护、中断恢复、真实源验收和缓存幂等验收仍未实现或未验证。虽然 `p-limit` 已声明为依赖，但源码没有使用它。

相关位置：

- `package.json:23`
- `PLAN.md:65`
- `PLAN.md:68`
- `PLAN.md:70`

### P2-5：Markdown 转义不完整

渲染器对部分 Markdown 字符做了转义，但保留了外部文本中的换行，也没有覆盖所有可能触发 Markdown 语义的字符，例如行首 `-` 和删除线相关字符。翻译结果来自 agent，可能包含多行内容，因此仍存在改变输出结构的风险。

相关位置：

- `src/renderer.ts:3`
- `src/renderer.ts:34`
- `DESIGN.md:147`

## 建议的修复顺序

1. 先补齐 fixture、单元、集成和端到端测试，使 `pnpm test` 真正可执行，并补充 `lint` script。
2. 修复抓取错误传播、缺失摘要处理和阶段级 retry，禁止网络失败生成成功空 digest。
3. 设计 run 级结果快照，确保 preview 使用指定 run 的论文、评分和翻译。
4. 修复缓存 key 和 agent 版本记录，并移除或替换不符合设计的 Pi 依赖。
5. 处理 `generatedAt` 的幂等策略，再验证重复运行的字节一致性。
6. 最后补充持久化原子性、日志、配置字段、并发和 Markdown 转义相关能力。
