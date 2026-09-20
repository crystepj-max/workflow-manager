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
| 当前状态 | 待确认 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | CHORE-110 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-110-acceptance-package-schema/task-spec-V1.md`（入库） |
| 定义时间 | 2026-09-19T13:13:00Z |
| GitHub 同步 | synced#110 |

> 说明（不进机器解析字段）：
> - `当前状态 = 待确认` 的依据：Definition Check 已全过、未决产品事项 0（DT-01 两项开放项于 2026-09-19 裁定：A·b3 存在性分层 + 摘要修复并入本票）；待人工一句「确认需求基线 V1，可进入交付」即可转「已定义」。
> - 需求基线保持 V1：更正与范围并入发生在人工确认之前，属同一基线的定义收敛，不构成版本变更。
> - 施工环境组取本任务标识（独立任务，自建分支/工作区，不与他人共用现场）。
> - `无人值守许可 = 允许` 的依据：本票为契约 schema 与记录口径调整，方案确定后施工无需人取舍；但**方案选择本身需人工裁决**，见规格 §9 与 `decision-tickets/DT-01`。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。

## 摘要（三要素速览）

### 任务目标

让验收签署在**任何路线**下都留下可审计的永久记录：轻量路线（无独立评审 / 测试节点）能按本 Run 实际拥有的证据登记验收包，同时修掉「人已签字、永久档案却没取到」的取值缺陷，使「谁在什么时候验收了什么」事后查得到。

### 涉及范围

- 做：
  - `acceptance_package.assembled` 改为**存在性分层**：四类前置引用可选，缺失须声明原因 + 人工知情批准；`dev_handoff_ref` 与 checkpoint 仍必填（规格 §7.1）
  - 机器校验按记录有无分支（`cwf-evidence-verify`），并消除五类规则的第二份硬编码副本分叉（`formal-records.mjs`）
  - 证据摘要层：按 task_id 自动关联 Run、签收后可刷新、无验收包时显式标记而非静默 null（规格 §7.4）
  - 存量修复：CHORE-36 / LOC-032 / LOC-033 三例摘要重生成，取回盘上已存在的真实签署
  - 同步契约文档、examples 与 skill 引用副本（仓库真源 ↔ skill 副本需锁一致）
- 不做：
  - 不改动收口脚本的两处口径缺口（另有 `FIX-109` 承接）
  - 不改动 `delivery-closeout-host.mjs` 与 WR-014 适配层的动作实现
  - 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）
  - 不追溯补齐历史任务的验收签署（**没发生过的签字一律不补**；仅让已发生的签署被永久层正确读到）
  - 不前移 `record_version`（保持 `v0.1.8`，纯放宽使历史记录全部继续合法）

### 验收标准

1. 契约与 schema 明确轻量路线登记验收签署的唯一入口与字段形态，与正式验收包不冲突；正式路线五类校验一字不降。
2. 走轻量路线完成一笔实际任务并登记验收包后，归档 `evidence-summary.json` 的 `decided_by` 与 `decided_at` 非 null；未登记时以 `acceptance_state` 显式说明成因，不再静默 null。
3. `cwf-record` / `cwf-evidence-verify` 对轻量档的校验行为与契约一致：缺评审 / 测试须带人工知情批准方可登记，伪造评审 / 测试与 AI 代签均被拒。
4. 契约中存在明文禁止伪造独立评审 / 测试记录的条款。
5. 向后兼容：453 个在盘记录文件与 7 个 examples 改动后仍通过校验；`formal-records` 与 schema 判定不分叉。
6. 既有测试全绿，新增用例覆盖分层登记、缺失声明、代签拒绝与摘要刷新路径。
7. CHORE-36 / LOC-032 / LOC-033 重生成摘要后取到真实签署值。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| schema 强制项 | `docs/design/construction-workflow/handoff.schema.json` → `acceptancePackagePayload.required = ['status','assembled']`；`assembled.required` = `requirements_baseline_ref` / `design_package_ref` / `dev_handoff_ref` / `review_proof_ref` / `test_proof_ref` / `integration_checkpoint`，且 `additionalProperties: false` |
| 契约要求 | `docs/design/construction-workflow-portable-contract.md` §8.3（L332）明文要求 `assembled` 含**五类前置记录引用** + checkpoint 结果，并逐条校验引用记录类型、同 Run、`verified_head` 一致等 |
| 轻量路线现实 | Run 在盘但无 `review_proof` / `test_proof`（或缺 design）→ **无法登记正式验收包**；实测 6 例（CHORE-106、LOC-037/038/041/042/045）。注：CHORE-37 / 38 属「先于 Run 机制落地」，不是本因 |
| 直接后果 | `scripts/workspace-evidence-summary.mjs` L125–L127 的 `decision` / `decided_by` / `decided_at` 取自 `acceptance.summary.*`；无验收包记录 → 三字段**恒为 null** |
| 实测样本 | `docs/tasks/archive/CHORE-106/evidence-summary.json`：`decision=None decided_by=None decided_at=None`；`CHORE-37` 同 |
| 记录类型合法性 | `scripts/cwf-record.mjs` L25 的 `RECORD_TYPES` **已包含** `acceptance_package`，并实现 `awaiting_decision → decided` 成熟度状态机与「不得改写已呈递 assembled」约束 → 缺的不是记录类型，而是**轻量路线无法满足其必填结构** |
| 🔴 **全量复核修正**（2026-09-19） | 51 个已归档任务的三字段 null 分成**五类成因**，schema 阻塞仅 **6** 例（CHORE-106、LOC-037/038/041/042/045）；另有 **3** 例签署**已发生且记录在盘**却被永久层丢失（CHORE-36 摘要在签收前生成、LOC-032/033 摘要未关联 Run），此类失效与路线无关、`.agent-runs/` 过 7 天保留期即不可恢复 |
| 🔴 **画像修正** | 6 例阻塞任务缺失项各异：LOC-037 / LOC-045 **仅缺 design_package**、LOC-038 **仅缺 review_proof**、LOC-041 缺 design/review、CHORE-106 只有 dev_handoff、LOC-042 五类全无 → 「轻量＝只有 dev_handoff」不成立，分层判据不能粗到只认 `dev_handoff_ref` |
| 兼容性硬约束 | `record_version` 为 `const:"v0.1.8"`，盘上 **453** 条记录 + 7 个 examples 全为该值；五类引用规则在 `handoff.schema.json` 与 `scripts/formal-records.mjs:50-63` **各存一份**；`route` 一名已表示「节点下一跳」，新字段须换名 |

## 关联

- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（缺口发现处，第三节「三条工具口径缺口」第 3 条）
- `docs/tasks/specs/CHORE-110-acceptance-package-schema/decision-tickets/DT-01-lightweight-acceptance-record.md`（方案裁决票，**未决**）
- `docs/tasks/FIX-109-closeout-tooling-gaps.md`（同批发现的第一、二处缺口）
