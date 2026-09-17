# 工作流能力索引（Current / Target / Legacy）

> 只读本文 + 对应模板生成 Skill，即可选对入口、理解真实完成语义及旧 Run 如何恢复。  
> **Current 基线提交**：`25eb94f55e6edf55e6268f6efda8789bc17b3c8a`（核验日期：2026-09-17）  
> **相对评审基线** `775ac84e9c37e2278c2ee32a0f2bcb75cbbb8172`：本索引随 LOC-040 新增；fanout / wf_run 等能力在评审基线上已实现，此前文档滞后。

**分层说明**

| 标签 | 含义 |
|---|---|
| **Current** | main 上可打开的源码/测试证据；可直接使用 |
| **Target** | 目标规格已写，运行时行为尚未完全替换 Current |
| **Legacy** | 仍支持只读/恢复，不是新任务默认入口 |

M2 与 Portable 七阶段关系：**唯一权威** [`m2-vs-portable-delivery.md`](m2-vs-portable-delivery.md)。

---

## 交付入口与主链

| 能力 | 状态 | 入口 / 版本 | 证据 |
|---|---|---|---|
| M2 单任务交付（定义外置） | **Current** | `dsh/skills/construction-bootstrap/` + 蓝图 `wf-construction-full-feature` | [`single-task-delivery-m2.md`](ai-task-define-delivery/single-task-delivery-m2.md)；[`templates/wf-construction-full-feature.json`](../../templates/wf-construction-full-feature.json)；[`scripts/ai-task-preflight-check.mjs`](../../scripts/ai-task-preflight-check.mjs) |
| Portable 七阶段 Stage 语义 | **Legacy**（证据底物） | `construction-workflow-portable-contract` §2–§3 | [`construction-workflow-portable-contract.md`](construction-workflow-portable-contract.md)；**非** M2 主链 — 见 [`m2-vs-portable-delivery.md`](m2-vs-portable-delivery.md) |
| 旧自定义建设种子 | **Legacy** | `dev-workflow-2-0` / `default-workflow` | [`templates/custom-seeds/`](../../templates/custom-seeds/)；恢复说明见 [`m2-vs-portable-delivery.md`](m2-vs-portable-delivery.md) §4 |
| 批量调度 M3 / 定时 M4 | **Current** | `execution-plan` skill + `scripts/ai-task-scheduled-trigger.mjs` | [`execution-plan-m3.md`](ai-task-define-delivery/execution-plan-m3.md)；[`scripts/test/fixtures/ai-task-scheduled-m4/`](../../scripts/test/fixtures/ai-task-scheduled-m4/) |

---

## 四内置模板（生成 Skill 真源）

| 模板 id | 状态 | 人工关口 | 完成 / 收口 | 生成指南 |
|---|---|---|---|---|
| `wf-construction-full-feature` | **Current** | `uat` → `$human-decision`（ACCEPT/REJECT/CONDITIONAL_PASS） | `closeout` → DELIVERED；可含合并/任务关闭 | [`.generated/wf-construction-full-feature/SKILL.md`](../../.generated/wf-construction-full-feature/SKILL.md)（`npm run generate`） |
| `wf-explore` | **Current** | 无固定人工门；`evaluate` 挂起材料供人读 | `PASS`/`INSUFFICIENT` → `$end`；**无 merge** | [`.generated/wf-explore/SKILL.md`](../../.generated/wf-explore/SKILL.md) |
| `wf-optimize` | **Current** | 可选 `$human-decision`（CONFIRM→ACCEPT） | `closeout`；**不要求 PR** | [`.generated/wf-optimize/SKILL.md`](../../.generated/wf-optimize/SKILL.md) |
| `wf-diagnose` | **Current** | 无 UAT 门；审核/回归独立 | `closeout` → DELIVERED；**不要求 PR** | [`.generated/wf-diagnose/SKILL.md`](../../.generated/wf-diagnose/SKILL.md) |

模板节点/产物/完成类型以蓝图为准；生成 Skill 内「模板能力摘要」由 [`scripts/generate.mjs`](../../scripts/generate.mjs) 从蓝图推导。漂移检查：[`scripts/validate-guide-drift.mjs`](../../scripts/validate-guide-drift.mjs)。

---

## 引擎与插件（Current 已实现）

| 能力 | 状态 | 说明 | 证据 |
|---|---|---|---|
| 扇出 fanout | **Current** | 受限并行；4096 items / 1000 agents 上限 | [`templates/wf-explore.json`](../../templates/wf-explore.json)（research fanout）；[`scripts/generate.mjs`](../../scripts/generate.mjs) `compileBlueprint`；[`scripts/test/generate.test.mjs`](../../scripts/test/generate.test.mjs) fanout 用例；[`packages/dsh-visual-workflow/tests/`](../../packages/dsh-visual-workflow/tests/) |
| wf_run 首选 / Logical Run | **Current** | 插件发起完整 Run；内置 workflow 回退退化 | [`packages/dsh-visual-workflow/src/host.js`](../../packages/dsh-visual-workflow/src/host.js)；[`scripts/test/runtime-logical-run.test.mjs`](../../scripts/test/runtime-logical-run.test.mjs) |
| 统一编译器 compileBlueprint | **Current** | 双入口唯一翻译员 | [`scripts/generate.mjs`](../../scripts/generate.mjs)；[`scripts/test/runtime-host.test.mjs`](../../scripts/test/runtime-host.test.mjs) |
| 蓝图校验 validate-core | **Current** | 结构 + 业务规则 | [`scripts/validate-core.cjs`](../../scripts/validate-core.cjs)；[`scripts/test/validate-blueprint.test.mjs`](../../scripts/test/validate-blueprint.test.mjs) |
| 生成物一致性 validate | **Current** | 重生成 diff | [`scripts/validate.mjs`](../../scripts/validate.mjs) |
| 工作区隔离 / capability | **Current** | Run 级 worktree + RPC capability | [`scripts/workspace-isolation.mjs`](../../scripts/workspace-isolation.mjs)；[`packages/dsh-visual-workflow/tests/host.test.mjs`](../../packages/dsh-visual-workflow/tests/host.test.mjs) A3-2 |
| 技术预算 retryPolicy | **Current** | 四模板 control.retryPolicy | [`templates/wf-construction-full-feature.json`](../../templates/wf-construction-full-feature.json)；[`scripts/test/blocked-lifecycle.test.mjs`](../../scripts/test/blocked-lifecycle.test.mjs) |
| 评价基线冻结 | **Current** | optimize 模板 evaluationBaseline | [`templates/wf-optimize.json`](../../templates/wf-optimize.json)；[`scripts/generate.mjs`](../../scripts/generate.mjs) `evaluationBaselineDecl` |
| M2 额度耗尽 → BLOCKED | **Current** | 建设模板 maxRoundsExhausted | [`templates/wf-construction-full-feature.json`](../../templates/wf-construction-full-feature.json)；[`scripts/test/blocked-lifecycle.test.mjs`](../../scripts/test/blocked-lifecycle.test.mjs) |
| `$human-decision` 路由 | **Current**（部分模板） | 建设/优化 | 建设/优化蓝图 `$human-decision` 边；探索模板无 HD 节点 |
| Business Outcome Routing | **Target** | 新模式 outcome 边 / `$human-decision` 全面替换 success/failure | [`CONTEXT.md`](../../CONTEXT.md) v0.1 目标词汇；[`specs/business-outcome-routing/proposal.md`](../../specs/business-outcome-routing/proposal.md) |
| Run Lifecycle 统一 BLOCKED/COMPLETED | **Target**（部分 Current） | LOC-030 已落地建设受阻；#79 全生命周期 | [`CONTEXT.md`](../../CONTEXT.md)；建设模板 TERMINATIONS |
| 协议 capabilities / Preflight 统一 | **Target** | WR-016 / WR-018 等 P1 条目 | 任务卡 LOC-039 / LOC-038；**未**列入 Current |

---

## 明确未交付（Target 规格存在 ≠ 已上线）

以下仅在任务规格或 roadmap 出现，**不得**当 Current 使用：

| 条目 | 规格/来源 | 状态 |
|---|---|---|
| WR-009 状态恢复核心 | LOC-044 task-spec | Target / 未合入 |
| WR-016 协议版本 | LOC-039 task-spec | Target / 未合入 |
| 逻辑 Run UI 续跑交互 | LOC-016 V2 片2 | Target / 待 DT-01 |
| 全库 Run Lifecycle #79 | roadmap | Target |

---

## 维护规则

1. 新能力合入 main 后，由**该变更**更新本表对应行（状态、证据链接、基线提交）。
2. 改蓝图或 [`scripts/generate.mjs`](../../scripts/generate.mjs) 后必须 `npm run generate` 并 `npm run validate`（含 guide 漂移检查）。
3. 禁止手改 `.generated/` 或已安装全局 Skill 副本。
