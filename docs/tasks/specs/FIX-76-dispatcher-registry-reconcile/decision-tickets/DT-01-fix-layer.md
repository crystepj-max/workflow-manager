# 决策票 DT-01 · FIX-76 修复挂载在哪一层

- **状态**：已裁定（closed）
- **提出时间**：2026-09-17
- **提出方**：需求分析

## 背景

CHORE-73 已在 `ai-task-execution-plan.mjs` 的 `assessCandidate` 实现了「依赖看事实」判定，但其规格第 4 节挂载点为 execution-plan 层。dispatcher 实际链路是 `collectLocalCandidates`（候选采集）→ `assessAndSort`（execution-plan）→ dispatcher。候选采集在更早一步就用登记册 `status` 排除了依赖未满足项，execution-plan 层对被排除项没有纠错机会。

## 待决选项

| 选项 | 描述 | 结论 |
|---|---|---|
| A. 在 candidate-collect 层修 | `collectLocalCandidates` 入口算一次 `collectMergeFacts`，依赖判定改双源 | **采纳** |
| B. 仅在 execution-plan 层修 | 不动候选采集，指望下游纠正 | 否决：早排除已发生，下游到不了 |
| C. 保留提示词手动对账 | 总控提示词第 0 步手动跑对账 | 否决：非根治，依赖人肉 |

## 裁定

**采纳 A**。理由：
1. 直击早排除根因，与 CHORE-73 规格 §3「依赖看事实」规划一致，不重复建设；
2. 改动局限在 `collectLocalCandidates` 一段（第 99–106 行），不触碰账本写入路径；
3. execution-plan 层既有「看事实」判定保留，二者互补（candidate-collect 决定"进不进候选"，execution-plan 决定"排不排程"）。

## 后续动作

- 落地后移除总控提示词（`.scratch/night-batches/night-batch-prompt-v2.md`）第 0 步手动对账（属 FEAT-77 卡记录的关联项，非本票范围）。
- 不在本票重测 execution-plan 层（已有 CHORE-73 验收覆盖）。
