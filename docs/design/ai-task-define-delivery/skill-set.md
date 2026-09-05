# AI 任务交付 Skill 集合（M1–M3 + M4 触发）

> 产品口径：M1 需求分析、M2 单任务工作流、M3 批量调度构成**同一套 skill 集合**；**M4** 是对同一执行计划的**到点唤起**（不另建调度 Skill）。

## 三件套 + 到点触发

| 代号 | 用户怎么叫 | 形态 | 职责 |
|---|---|---|---|
| **M1** | 做需求分析 / 定义任务 | **配套 Skill** | 把模糊需求谈到「已定义」（未决=0） |
| **M2** | 完整功能开发 / 单任务交付 | **内置工作流模板** + 启动 Skill | 从「已定义」无人值守施工到等待验收 |
| **M3** | 执行计划 / 批量开工 | **配套 Skill** | 选任务、快照、并发、补位、批次汇总 |
| **M4** | 预约夜间开跑 / 到点开工 | **到点启动**（唤起 M3，不新建 Skill） | 到点后自动开跑并留下夜间报告 |

边界：M1 不施工；M2 不重新谈需求；M3 不谈需求也不施工，只调度；M4 不复制调度规则。

## 落在哪里（双仓）

| 仓库 | 角色 |
|---|---|
| **workflow-manager** | **工程真源**：内置蓝图、建设/调度/定义 Skill、公共契约、到点启动与机械验收 |
| **my-agent-skills** | **通用 skill 集副本**：便于跨设备安装与非本仓会话复用；与工程真源保持同步 |

同步命令（在 workflow-manager 根目录）：

```bash
node scripts/sync-ai-task-skill-set.mjs /path/to/my-agent-skills
```

默认目标：`../my-agent-skills`（若存在）。同步后请确认 `execution-plan` Skill 已含 M4 到点说明。

## 本仓库路径

| 件 | 路径 |
|---|---|
| M1 Skill | `dsh/skills/requirements-analysis/` |
| M2 内置模板 | `templates/construction-full-feature.json` → 生成 `.generated/construction-full-feature/` |
| M2 启动 Skill | `dsh/skills/construction-bootstrap/` |
| M3 Skill | `dsh/skills/execution-plan/` |
| M4 到点启动 | `scripts/ai-task-scheduled-trigger.mjs` |
| M4 产品短文 | `docs/design/ai-task-define-delivery/scheduled-trigger-m4.md` |
| 公共契约 | `docs/design/ai-task-define-delivery/public-task-contract.md` |

## my-agent-skills 路径

| 件 | 路径 |
|---|---|
| M1 | `my-skills/requirements-analysis/` |
| M2 启动 Skill | `my-skills/construction-bootstrap/` |
| M3（含 M4 用法说明） | `my-skills/execution-plan/` |
| 集合说明 | `my-skills/ai-task-skill-set/README.md` |

> 内置工作流**蓝图**与到点启动脚本只住在 workflow-manager；通用仓保留可调用的 Skill 入口。

## 合入与试用顺序

1. M1–M3 集合在 workflow-manager 收齐并机械验收通过  
2. 同步到 my-agent-skills  
3. M4：到点启动机械验收通过后，按 `m4-e2e-trial.md` 做 3～5 任务真实试跑  
4. 本机试跑：定义 → 单任务 → 小批量 →（可选）预约到点  
