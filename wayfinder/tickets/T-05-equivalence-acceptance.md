---
id: T-05
title: 2.0 等价性验收标准
type: grilling
labels: [wayfinder:grilling]
status: closed
assignee: charting-session-2026-08-19
blocked-by: [R-01]
resolved: 2026-08-19（grilling 两轮全树确认）
---

## Question

AC-1/NFR-3 的「现有 2.0 流程经蓝图**等价**运行」怎样才算成立、如何可测地验收？

## 待决策点

- 等价的范围：哪些行为必须逐一存活——三类 entry（dispatch/closeout/dev 续跑）、人工验收门禁（AWAITING_HUMAN_ACCEPTANCE 语义）、9 轮打回与超限归因、分流判定、git worktree 隔离、STATE.md/report 文件契约、角色注入。
- 验收方式：逐项行为对照清单（人工核对）vs 对同一 issue 用新旧两路各跑一遍对拍（成本高）vs 生成器单测断言（编译产物含等价结构）。
- 「等价」的明确边界：允许的差异（如报错文案、日志细节）与不允许的差异（拓扑、门禁、轮次语义）。

## 备注

HITL：grilling 票；依赖 R-01 的语义清单作为核对基准。结论可作为 AC-1 的可执行化补充。

## Resolution（2026-08-19，grilling 两轮全树确认）

**等价定义**：旧 = 手写 mjs，新 = 蓝图 + 生成器产物（T-02）。验收 = **语义等价 + 新契约统一**。
**范围（Q1）**：8 维度全收——入口/续跑、分流判定、轮次+超限归因、人工门禁、可信度闸门、异源警告、文件契约、返回状态机。
**方式（Q2）**：结构断言（进 validate）+ 行为清单（v1 收口人工核对）；不做双路对拍（模型方差不可比）。
**边界与契约（Q3/Q5）**：不允许差异 = 拓扑/门禁/轮次打回/分流判定源/状态机/文件契约/角色注入；允许差异 = 文案/日志/label/风格。返回体统一新契约（`AWAITING_HUMAN_<节点id>` + resume）；**新发现**：三要素缺失旧 mjs 返回 `REJECTED_INCOMPLETE`、生成脚本走 failure 边返回 `FAILED_AT_dispatch`——接受差异（等价点 = 终止且原因可读，missing/reason 在结果中），主会话 runbook 增补 `FAILED_AT_*` 驱动说明；旧 mjs 验收通过后退役。
**断言点（Q4，10 项）**：入口四态校验 / 拓扑（7 节点 12 边 $end）/ 折叠（route→test/review）/ manualCheck+resume / MAX_ROUNDS=9+打回+归因 / verifyBranch+claimError / heteroCheck / output.files 注入 / roleRef 注入 / dispatch schema 三要素字段。
**产出物（Q6）**：断言 = `scripts/equivalence.test.mjs`（node 直跑、validate 集成）；清单 = `docs/design/equivalence-checklist.md`（8 维度勾选）；均引用 R-01 产物。v1 收口时按清单人工核对 + 断言全绿 = AC-1/NFR-3 成立。
