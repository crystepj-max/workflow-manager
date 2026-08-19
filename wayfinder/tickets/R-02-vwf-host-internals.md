---
id: R-02
title: vwf 宿主与 DSL 盘点
type: research
labels: [wayfinder:research]
status: closed
assignee:
blocked-by: []
resolved: 2026-08-19（charting 会话内联调研，子代理基础设施故障）
---

## Question

`packages/dsh-visual-workflow/src/host.js` 内部机制全貌是什么？——它是生成器（FR-2）与持久化（FR-3）两个决策的事实基础。

## 范围

- `TEMPLATES['dev-workflow-2-0']`（L29-74）完整结构：节点全部字段（含规格 FR-1 未列的 `model`/`manualCheck`/`description`）、边 `on`/`when` 语义、`entry`/`control.maxRounds`。
- `validateDsl`（L184 起）：校验规则、sanitize 行为、错误/fieldErrors 契约。
- `compileDsl`：DSL→script 的编译方式（节点→agent()、边→流程控制、`when`→条件、manualCheck→什么、`$end`/`$entry`/`$new-round` 哨兵）；编译产物长什么样（能否直接作为普通 `workflow` 工具 script 执行——host.js:581 回退路径的明示）。
- `list/save/remove`（L421-453）：`userWorkflows` Map 仅内存、不落盘；`vwf.validate`/`vwf.compile`/`vwf.script` RPC；`wf_run` 工具与 workflowEngine 解析（L526-595）。
- 现有测试覆盖（`packages/dsh-visual-workflow/tests/`）与 `client.js` 面。

## 产物

`docs/research/vwf-host-internals.md`：机制说明 + 行号引用 + compileDsl 产物的最小示例。

## 阻塞

无（立即派发）。

## Resolution（2026-08-19）

机制全貌落盘 `docs/research/vwf-host-internals.md`。要点：模板节点含 `model`（硬编码）/`manualCheck`/`description` 三字段（规格 FR-1 字段清单遗漏）；validateDsl 规则全集（入口拓扑/$end/悬空/保留 id/successCondition 路径在 schema 内/when 仅 success/failure 唯一/success 无环）；**compileDsl 产物是标准 workflow 脚本形态，可被普通 workflow 工具直接执行**（host.js:581 回退路径）→ T-02 复用路线有事实支撑；持久化仅内存 Map（save 不落盘）；engine 由 agent preset 挂载，wf_run 工具面完整。
