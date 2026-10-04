# M2 单任务交付与 Portable 旧七阶段关系（权威说明）

> **用途**：接手者只需读本文，即可区分「当前 M2 主链」与「Portable 契约七阶段证据底物」。其他指南（`docs/runbooks/construction-dsh/`、`docs/runbooks/construction-external/`、生成 Skill、`CONTEXT.md`）**引用本文**，不得再写第二套互相矛盾的主链叙事。

| 元数据 | 值 |
|---|---|
| 权威级别 | Current 产品语义（M2）+ Legacy 兼容边界 |
| 关联契约 | [`single-task-delivery-m2.md`](ai-task-define-delivery/single-task-delivery-m2.md)、[`construction-workflow-portable-contract.md`](construction-workflow-portable-contract.md) |
| Portable 七阶段冻结底物 | `construction-workflow-portable-contract.md` §2–§3（v0.1.8 证据类型与 Proof 纪律） |
| 当前内置建设蓝图 | `templates/wf-construction-full-feature.json` |

## 1. 两句话结论

1. **当前 M2 产品可见主链**（新任务默认入口）：`实施前检查 → 开发 → 收敛审查 → 测试 → UAT 验收卡 → WAITING_HUMAN → 人工三态 → 收口`。定义外置，**不含**需求分析/方案设计人工门。权威：`single-task-delivery-m2.md`；内置蓝图：`wf-construction-full-feature`（入口 = 其生成 Skill；DSH 轨道命令序列见 `docs/runbooks/construction-dsh/runbook.md`）。
2. **Portable 旧七阶段**是 **证据与 Stage 语义底物**（requirements → design → dev → review → test → human acceptance → closeout），用于理解交接包字段、Proof 绑定与旧 Run 恢复；**不是**当前 M2 产品主链。权威：`construction-workflow-portable-contract.md` §0.1 overlay 已声明冲突裁决。

## 2. 对照表

| 维度 | M2 当前主链 | Portable 七阶段（契约底物） |
|---|---|---|
| 产品入口 | `wf-construction-full-feature`（内置蓝图 + 生成 Skill） | 契约 §2 固定顺序（含 requirements/design） |
| 定义阶段 | **外置**（`requirements-analysis` 产出「已定义」） | requirements Stage 在链内 |
| 人工验收 | `uat` → `$human-decision` 严格三态 | human acceptance Stage |
| 收口 | `closeout`（仅验收通过后） | closeout Stage |
| 自动返工 | 上限 3；耗尽 → `BLOCKED` | 契约 §4 自动回退额度 |
| 适用场景 | **新建单任务交付** | 读 Proof/交接包、理解 Stage 字段 |

## 3. 新建 M2 任务：从哪里开始

1. 任务经「需求分析」落到 **已定义**（本地任务规格 Vn + Definition Check 通过）。
2. 执行 `node scripts/ai-task-preflight-check.mjs <任务卡> <规格> --run-baseline Vn`；通过后在本任务隔离 worktree 施工。
3. 在 DSH 或等效会话调用 **`wf_run`**（首选）或回退 `workflow` 工具，模板 **`wf-construction-full-feature`**；Run 引导、证据呈递与收口命令序列按 `docs/runbooks/construction-dsh/runbook.md`。
4. 到达 **WAITING_HUMAN** 后停止，等人工 UAT 三态；**不得**跳过 UAT 直接 closeout。

## 4. 旧 Run：如何恢复

> **原则**：旧 Run 使用 **冻结快照**（角色文本、蓝图版本、run 目录 index）；恢复时不静默迁移到新 M2 语义。

| 场景 | 识别 | 恢复入口 | 不要做的事 |
|---|---|---|---|
| Portable 契约交接包 | `handoff.schema.json` 型证据、`stage` 字段为 requirements/design/… | 按 `construction-workflow-portable-contract.md` §3 Stage 读 Proof；Controller 路由见契约 §5 | 不要把 requirements/design 当成 M2 必跑门 |
| M2 建设 Run 受阻 | `status=BLOCKED` + `termination.reason_code` | 同 `taskId` + `entry=<termination.resume_node>`；`NEEDS_REDEFINE` 须重定义后 **新 Run** | 不要用 `approved:true` 跳过 UAT |

历史 Run **只读对照**以 Run 目录内的冻结快照（角色文本、run 目录 index）为准；须与 Run 起始时 HEAD 一致，仓库已不再保留其对应蓝图（当前内置蓝图见 [`workflow-capability-index.md`](workflow-capability-index.md)）。

## 5. 与其他文档的引用关系

- `construction-workflow-portable-contract.md` §0.1：已指向本文与 M2 overlay；七阶段正文保留为证据底物。
- `docs/runbooks/construction-dsh/runbook.md`：DSH 轨道命令序列只引用本文与契约，不复制主链语义（原 `dsh/skills/construction-bootstrap/` 已随 #105 收敛退役，见契约 §9.6）。
- 四模板 **生成 Skill**（`.generated/*/SKILL.md`）：「模板能力摘要」节链接本文与能力索引。
- `CONTEXT.md`：术语层链接本文，fanout / wf_run 等 Current 事实以能力索引为准。

## 6. 维护

- 变更 M2 主链或 Portable 兼容边界时：**先改本文 + 关联契约**，再改生成器/蓝图，最后 `npm run generate && npm run validate`。
- 不得手改 `.generated/`；漂移由 `scripts/validate-guide-drift.mjs` 检测。
