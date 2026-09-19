# CHORE-110 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-110` |
| 远端 issue | cnb#110（编号由 CNB 远端发号） |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-19 CHORE-106 收口实操中发现（证据见 `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`） |
| 任务名称 | 轻量路线验收包可登记性：acceptance_package schema 放开与签署人留痕 |
| 任务类型 | 维护性 / 契约口径（编号类型 CHORE） |
| 优先级 | P2 |
| 当前状态 | 定义中 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-110-acceptance-package-schema/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | pending |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：本票为契约 schema 与记录口径调整，方案确定后施工无需人取舍；但**方案选择本身需人工裁决**，见规格 §9 与 `decision-tickets/DT-01`。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。

## 摘要（三要素速览）

### 任务目标

让**轻量路线**（无独立评审 / 测试节点、由单人多阶段推进的任务）也能留下**可审计的验收签署记录**，使「谁在什么时候验收了什么」不再因为走轻量路线而永久丢失。

### 涉及范围

- 做：
  - 澄清「正式验收包」与「轻量路线验收记录」的契约关系，明确轻量路线是否、以及如何登记签署
  - 按裁定方案调整 `acceptance_package` 的 schema 约束与/或记录要求
  - 使证据摘要中的 `decision` / `decided_by` / `decided_at` 在轻量路线下也能落值（或明确记录「不适用」而非静默为 null）
  - 同步受影响的契约文档与副本（仓库真源 ↔ skill 引用副本需锁一致）
- 不做：
  - 不改动收口脚本的两处口径缺口（另有 `FIX-109` 承接）
  - 不改动 `delivery-closeout-host.mjs` 与 WR-014 适配层的动作实现
  - 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）
  - 不追溯补齐历史任务的验收签署（已归档记录不动）

### 验收标准

1. 契约层明确：轻量路线登记验收签署的**唯一入口与字段形态**，且与正式验收包不冲突（二者或统一、或显式区分）。
2. 走轻量路线完成一笔实际任务后，其归档 `evidence-summary.json` 的 `decided_by` 与 `decided_at` **非 null**（或按裁定明确写为「不适用」的确定值，而非静默 null）。
3. `cwf-record` / `cwf-validate` 对轻量路线验收记录的校验行为与契约一致，不再出现「因缺五类前置引用而无法登记」。
4. 既有测试全绿，新增用例覆盖轻量路线的登记与校验路径。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| schema 强制项 | `docs/design/construction-workflow/handoff.schema.json` → `acceptancePackagePayload.required = ['status','assembled']`；`assembled.required` = `requirements_baseline_ref` / `design_package_ref` / `dev_handoff_ref` / `review_proof_ref` / `test_proof_ref` / `integration_checkpoint`，且 `additionalProperties: false` |
| 契约要求 | `docs/design/construction-workflow-portable-contract.md` §8.3（L332）明文要求 `assembled` 含**五类前置记录引用** + checkpoint 结果，并逐条校验引用记录类型、同 Run、`verified_head` 一致等 |
| 轻量路线现实 | 本批任务（CHORE-37/38/106 等）无独立评审 / 测试节点，五类前置记录中 `review_proof` / `test_proof` 不存在 → **无法登记正式验收包** |
| 直接后果 | `scripts/workspace-evidence-summary.mjs` L125–L127 的 `decision` / `decided_by` / `decided_at` 取自 `acceptance.summary.*`；无验收包记录 → 三字段**恒为 null** |
| 实测样本 | `docs/tasks/archive/CHORE-106/evidence-summary.json`：`decision=None decided_by=None decided_at=None`；`CHORE-37` 同 |
| 记录类型合法性 | `scripts/cwf-record.mjs` L25 的 `RECORD_TYPES` **已包含** `acceptance_package`，并实现 `awaiting_decision → decided` 成熟度状态机与「不得改写已呈递 assembled」约束 → 缺的不是记录类型，而是**轻量路线无法满足其必填结构** |

## 关联

- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（缺口发现处，第三节「三条工具口径缺口」第 3 条）
- `docs/tasks/specs/CHORE-110-acceptance-package-schema/decision-tickets/DT-01-lightweight-acceptance-record.md`（方案裁决票，**未决**）
- `docs/tasks/FIX-109-closeout-tooling-gaps.md`（同批发现的第一、二处缺口）
