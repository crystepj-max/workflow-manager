---
id: R-01
title: dev-workflow-2.0.mjs 语义盘点
type: research
labels: [wayfinder:research]
status: closed
assignee:
blocked-by: []
resolved: 2026-08-19（charting 会话内联调研，子代理基础设施故障）
---

## Question

现有 DSH 编排脚本 `dsh/workflow/dev-workflow-2.0.mjs` 的全部运行时语义是什么？——它即将被抽取为第一份蓝图（FR-1/AC-1），必须知道哪些行为是蓝图的 `nodes/edges/entry/control` 能表达的、哪些是脚本特有必须由生成器保证的。

## 范围

- 入口与续跑：`dispatch` / `closeout` / `dev` 三类 entry、`AWAITING_HUMAN_ACCEPTANCE` 人工验收门禁的手写语义、`A.startRound`/`feedback`/`history` 续跑参数。
- 「分流」实现：脚本内 `if`（L290-291 附近）与 vwf 模板 `route` 节点 + `when` 边的关系。
- 轮次循环：maxRounds=9、超限失败归因与拆分建议、打回路径。
- 契约：`dsh/README.md` 的 args 装配、`dsh/roles/*.md` 经 `roleRef` 注入、STATE.md / 各 report 文件约定、git worktree 隔离。
- 使用的 workflow 工具钩子（agent/pipeline/parallel/phase/log/args）与 agent() 的 schema/successCondition 用法。

## 产物

`docs/research/mjs-semantics.md`：逐项语义 + 行号引用 + 一张「蓝图可表达 / 需生成器保证」对照表。

## 阻塞

无（立即派发）。

## Resolution（2026-08-19）

完整语义盘点落盘 `docs/research/mjs-semantics.md`。要点：入口四态（dispatch/dev/accept/closeout）+ 人工门禁在脚本外（AWAITING_HUMAN_ACCEPTANCE → 主会话裁决 → 续跑）；分流为脚本内 if（无 LLM）；9 轮打回 + 超限自动归因（reschedule）；角色经 roleRef 自读 dsh/roles/*.md；**DSH 侧 3 个增强项为 vwf 编译产物所缺**——超限归因 agent、verifyBranchStep/claimError 可信度闸门（verified_branch/head 硬校验）、异源 warning（仅 warning 不拦截）。「蓝图可表达 vs 需生成器保证」对照表见产物 §7。
