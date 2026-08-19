# R-03 · workflow 工具脚本契约

> 调研票 R-03 产物。一手资料（DSH 源码，@deepseek-ai/dsh 包族，位于 npx 缓存）：
> - `dsh-workflow-worker-thread/lib/worker.cjs`（783 行，vm 执行 + 钩子）
> - `dsh-workflow-worker-thread/lib/index.js`（919 行，引擎 start/校验/上限）
> - `dsh-workflow/lib/types/index.js`（服务接缝与 WorkflowError 语义）
> - `dsh-tool-workflow/lib/index.js`（工具面与 DESCRIPTION 契约）
> - `dsh-tools/lib/index.js`（JSON Schema 子集校验）

## 1. 脚本执行形态

- 脚本体在 **node vm** 中按 `(async () => { <body> })()` 编译执行（worker.cjs），天然支持顶层 await；`export const meta` 会被专门拒绝（`SCRIPT_PARSE`，提示 meta 走请求字段，index.js `assertBodyParses`）。
- vm 是**容器而非安全边界**（index.js/types：escapable vm context + fresh worker，防宿主阻塞、可强杀线程）；脚本内没有 require/process/网络/文件系统——**只有冻结的钩子全局**（worker.cjs：`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`）。
- `args` 是唯一克隆传入的数据（脚本改动不影响宿主初始化数据）；脚本返回值经 JSON 物化（不支持的值 → `RESULT_UNSERIALIZABLE`）。

## 2. 钩子契约

| 钩子 | 行为 | 关键约束 |
|---|---|---|
| `agent(prompt, opts?)` | 跑一个子代理到完成；无 schema 时 resolve 最终文本；带 schema 时 resolve 校验后的对象；子代理失败 resolve `null` | opts 白名单：`label` / `phase` / `schema` / `provider` / `model`；**其余一律 loud reject**（`effort`/`isolation`/`agentType` 被点名拒绝，worker.cjs SUPPORTED_AGENT_OPTIONS） |
| `parallel(thunks)` | 并发执行并 await 全部；thunk 抛错 → 该项 `null` | fatal 错误（WorkflowError）会**杀死脚本**而非 null 化 |
| `pipeline(items, ...stages)` | 每项独立过各 stage，**无跨 stage 屏障**；stage 抛错丢该项 | 同上 |
| `phase(title)` | 开始进度阶段 | — |
| `log(message)` | 叙述进度 | — |
| `args` | 工具调用 args 原样 | 只读语义 |

- 错误语义：**钩子误用（参数错/未知选项/不支持的 schema/超上限）抛 WorkflowError 且 fatal=true → 直接杀死脚本**，不会溶解为逐项 null（与「rejected loudly」一致）。
- 取消：cancel 后下一个钩子边界即抛 `CANCELLED`；永不收敛的脚本由宿主宽限定时强杀线程。

## 3. 上限（引擎 Config，index.js）

- `maxConcurrentAgents`（默认 0 → 自动 `min(16, cpu-2)`）、`maxTotalAgents`（默认 1000，单 run 总子代理上限，`AGENT_CAP`）、`maxItemsPerCall`（默认 4096，parallel/pipeline 单次上限，`ITEM_CAP`）、`syncTimeoutMs`、`disposeGraceMs`。

## 4. JSON Schema 子集（dsh-tools `assertObjectJsonSchema`）

- 允许关键字：`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解 `description`/`title`/`default`/`examples`；**pattern/format/数值边界一律 `UNSUPPORTED_SCHEMA` 拒绝**（与工具 DESCRIPTION 一致）。
- 类型枚举：object/array/string/number/integer/boolean/null。

## 5. 引擎调用面

- `engine.start({script, meta, args, parent, subagentProvider?, maxTotalAgents?, signal?})`（index.js）：**同步抛** `META_INVALID`（meta 未知字段/缺 name/description/phases 畸形）、`SCRIPT_PARSE`；返回 `WorkflowRun`，其 `result` **永不 reject**——失败都映射为 stopReason 变体（`completed`/`error`/`cancelled`），含 `agentsStarted`。
- meta 契约：必填 `name`（kebab-case）/`description`；可选 `whenToUse`/`phases[]`（`{title, detail?, provider?, model?}`）；未知字段报错。
- 宿主接线：host.js:588 以 `{script, meta, args, parent}` 调用；`run.result.stopReason/value/agentsStarted` 消费（host.js:589-590）。

## 6. 工具面（dsh-tool-workflow）

- 工具参数：`script`（plain JS body，无 `export const meta`）+ `meta`（JSON）+ `args`（可选，原样传给脚本）；前台执行，返回脚本最终值。
- 显式调用指引：仅当用户明确要求 workflow 或大规模多代理编排时使用；一两个委托用普通 subagent。

## 7. 生成脚本必须满足的检查清单

1. 无 `export const meta` 语句（meta 走请求字段）。
2. 只用 `agent/parallel/pipeline/phase/log/args` 五个全局；agent 只传 `label/phase/schema/provider/model`。
3. schema 只用白名单关键字（type/oneOf/properties/required/additionalProperties/items/enum/const）。
4. 不依赖任何 Node API/文件系统/网络（vm 内无）。
5. 顶层 await 形态，`return <JSON 可序列化值>` 结尾。
6. meta.name 为 kebab-case 且非空；meta.description 非空；phases（若有）title 唯一且非空。
7. 考虑 `args` 是唯一输入通道；子代理总数 ≤ 引擎 maxTotalAgents。
8. 错误路径：能 throw 即 throw（fatal 会杀掉脚本并给出 stopReason=error）；如需容错用 `filter(Boolean)` 处理 null。
