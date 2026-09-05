# AI 任务定义与批量交付 — 设计文档索引（M1）

| 文档 | 用途 |
|---|---|
| [public-task-contract.md](./public-task-contract.md) | 三块能力共用的字段/状态/版本/验收三态/返工上限 |
| [task-spec-template.md](./task-spec-template.md) | 本地详细任务规格模板 |
| [issue-basics-template.md](./issue-basics-template.md) | Issue 基本信息模板 |
| [definition-check.md](./definition-check.md) | Definition Check 清单 |
| [baseline-change-v1-v2.md](./baseline-change-v1-v2.md) | 实质变更升版流程 |
| [construction-bridge-m1.md](./construction-bridge-m1.md) | 定义外置 → 建设交付的 M1/M2 桥接说明 |

Skill 真源：`dsh/skills/requirements-analysis/`（references 内含同名模板副本，供安装分发）。

机械验收：

```bash
node scripts/ai-task-define-m1-check.mjs
```
