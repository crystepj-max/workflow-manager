# AI 任务定义与批量交付 — 设计文档索引

| 文档 | 用途 | 里程碑 |
|---|---|---|
| [public-task-contract.md](./public-task-contract.md) | 三块能力共用的字段/状态/版本/验收三态/返工上限 | M1 |
| [task-spec-template.md](./task-spec-template.md) | 本地详细任务规格模板 | M1 |
| [issue-basics-template.md](./issue-basics-template.md) | Issue 基本信息模板 | M1 |
| [definition-check.md](./definition-check.md) | Definition Check 清单 | M1 |
| [baseline-change-v1-v2.md](./baseline-change-v1-v2.md) | 实质变更升版流程 | M1 |
| [construction-bridge-m1.md](./construction-bridge-m1.md) | M1 预留桥接说明 | M1 |
| [single-task-delivery-m2.md](./single-task-delivery-m2.md) | 单任务交付产品主链（定义外置） | M2 |
| [preflight-check.md](./preflight-check.md) | 实施前检查清单 | M2 |
| [uat-card-template.md](./uat-card-template.md) | UAT 验收卡模板 | M2 |
| [construction-bridge-m2.md](./construction-bridge-m2.md) | M2 已接线说明 | M2 |

定义入口 Skill：`dsh/skills/requirements-analysis/`  
交付入口 Skill：`dsh/skills/construction-bootstrap/`（从已定义开工）

机械验收：

```bash
node scripts/ai-task-define-m1-check.mjs
node scripts/ai-task-deliver-m2-check.mjs
```

> **落点**：定义 Skill（「做需求分析」→「已定义」）正本在 [my-agent-skills](https://github.com/crystepj-max/my-agent-skills) 的 `requirements-analysis`。本目录只保留交付侧共用的公共契约与 M2 主链说明；本仓库不再维护第二套定义 Skill。
