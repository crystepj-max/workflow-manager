---
id: R-03
title: workflow 工具脚本契约
type: research
labels: [wayfinder:research]
status: closed
assignee:
blocked-by: []
resolved: 2026-08-19（charting 会话内联调研，子代理基础设施故障）
---

## Question

DSH `workflow` 工具对 `script` 参数的**有效契约**是什么？——生成器产出的 DSH 侧脚本（FR-2 的「编译蓝图→mjs 脚本」）必须满足该契约。

## 范围

- 在 DSH 源码处（`/Users/chris/.npm/_npx/1e7f6d9597241db0`）找到 workflow 工具/引擎实现：合法 script 的形态（top-level await、可用钩子 agent/pipeline/parallel/phase/log/args、opts.schema 约束、错误即杀脚本的语义）、并发与总 agent 上限、args/meta 如何注入。
- `workflowEngine.start` 的调用面（与 host.js:588 对照）：meta/args/parent、run.result 形态。
- 已知约束对「生成脚本」的要求清单（例如不得用 Node API、不得用外部文件系统等——若有）。

## 产物

`docs/research/workflow-tool-contract.md`：契约要点 + 源码路径引用 + 「生成脚本必须满足」检查清单。

## 阻塞

无（立即派发）。

## Resolution（2026-08-19）

契约落盘 `docs/research/workflow-tool-contract.md`（源码：dsh-workflow-worker-thread / dsh-tool-workflow / dsh-tools）。要点：脚本在 vm 中按 `(async()=>{body})()` 执行，仅 5 个冻结钩子 + args（克隆）；agent opts 白名单 = label/phase/schema/provider/model，其余 loud reject（effort/isolation/agentType 点名拒绝）；schema 仅 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解；引擎 start 同步抛 META_INVALID/SCRIPT_PARSE，run.result 永不 reject；上限 maxConcurrentAgents/maxTotalAgents(默认1000)/maxItemsPerCall(4096)。生成脚本检查清单见产物 §7。
