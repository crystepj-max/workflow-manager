# AI 任务定义与批量交付 — 设计文档索引

> 当前 M1 使用 `dsh/skills/requirements-analysis/` 中的真源与配套参考；M3 使用 dev-flow 项目级 Skill。下表中旧版 GitHub / 本地任务卡流程文件保留作历史设计记录。

| 文档 | 用途 | 里程碑 |
|---|---|---|
| [public-task-contract.md](./public-task-contract.md) | 2026-09 版 GitHub / 本地任务状态契约，保留作历史记录；当前 Task 状态见 dev-flow 的 Multica dispatch contract | 历史 |
| [task-spec-template.md](./task-spec-template.md) | 本地详细任务规格模板 | M1 |
| [issue-basics-template.md](./issue-basics-template.md) | Issue 基本信息模板 | M1 |
| [definition-check.md](./definition-check.md) | Definition Check 清单 | M1 |
| [baseline-change-v1-v2.md](./baseline-change-v1-v2.md) | 实质变更升版流程 | M1 |
| [single-task-delivery-m2.md](./single-task-delivery-m2.md) | 单任务交付产品主链（定义外置） | M2 |
| [task-workspace-env.md](./task-workspace-env.md) | 单任务分支/工作区：关联沿用、串行、全过再清理 | M2 |
| [preflight-check.md](./preflight-check.md) | 实施前检查清单 | M2 |
| [uat-card-template.md](./uat-card-template.md) | UAT 验收卡模板 | M2 |
| [construction-bridge-m2.md](./construction-bridge-m2.md) | M2 已接线说明 | M2 |
| [execution-plan-m3.md](./execution-plan-m3.md) | Execution Plan（批量调度） | M3 |
| [scheduled-trigger-m4.md](./scheduled-trigger-m4.md) | **定时触发（到点唤起同一执行计划）** | M4 |
| [m4-e2e-trial.md](./m4-e2e-trial.md) | M4 端到端试跑清单 | M4 |
| [skill-set.md](./skill-set.md) | 当前 M1、M2、M3 的职责与 Skill 落点 | M1–M3 |

- 定义入口 Skill：`dsh/skills/requirements-analysis/`（workflow-manager 直接安装到用户级 `~/.agents/skills/requirements-analysis/`）
- 交付入口：内置蓝图 `wf-construction-full-feature` + 其生成 Skill（从已定义开工；命令序列 `docs/runbooks/construction-dsh/runbook.md`）
- 批量调度 Skill：dev-flow 项目级 `.agents/skills/execution-plan/`

机械验收：

```bash
node scripts/ai-task-deliver-m2-check.mjs
node scripts/ai-task-execution-plan-m3-check.mjs
node scripts/ai-task-scheduled-m4-check.mjs
```

> **当前边界**：Multica 管理 Task 身份与状态；dev-flow 读取状态并形成计划；workflow-manager 维护需求分析 Skill 与工作流插件。M4 定时触发仍未作为可用能力验收。
