# AI 任务交付 Skill 集合（M1–M3）

> 产品口径（2026-09-05）：M1 需求分析、M2 单任务工作流、M3 批量调度构成**同一套 skill 集合**。  
> **先理顺本集合与双仓同步，再做 M4（定时触发）。**

## 三件套分别是什么

| 代号 | 用户怎么叫 | 形态 | 职责 |
|---|---|---|---|
| **M1** | 做需求分析 / 定义任务 | **配套 Skill** | 把模糊需求谈到「已定义」（未决=0） |
| **M2** | 完整功能开发 / 单任务交付 | **内置工作流模板** + 启动 Skill | 从「已定义」无人值守施工到等待验收 |
| **M3** | 执行计划 / 批量开工 | **配套 Skill** | 选任务、快照、并发、补位、批次汇总 |

边界：M1 不施工；M2 不重新谈需求；M3 不谈需求也不施工，只调度。

## 落在哪里（双仓）

| 仓库 | 角色 |
|---|---|
| **workflow-manager** | **工程真源**：内置蓝图 `templates/construction-full-feature.json`、建设/调度/定义 Skill、公共契约与机械验收 |
| **my-agent-skills** | **通用 skill 集副本**：便于跨设备安装与非本仓会话复用；与工程真源保持同步 |

同步命令（在 workflow-manager 根目录）：

```bash
node scripts/sync-ai-task-skill-set.mjs /path/to/my-agent-skills
```

默认目标：`../my-agent-skills`（若存在）。

## 本仓库路径

| 件 | 路径 |
|---|---|
| M1 Skill | `dsh/skills/requirements-analysis/` |
| M2 内置模板 | `templates/construction-full-feature.json` → 生成 `.generated/construction-full-feature/` |
| M2 启动 Skill | `dsh/skills/construction-bootstrap/` |
| M3 Skill | `dsh/skills/execution-plan/` |
| 公共契约 | `docs/design/ai-task-define-delivery/public-task-contract.md` |

## my-agent-skills 路径

| 件 | 路径 |
|---|---|
| M1 | `my-skills/requirements-analysis/` |
| M2 启动 Skill | `my-skills/construction-bootstrap/` |
| M3 | `my-skills/execution-plan/` |
| 集合说明 | `my-skills/ai-task-skill-set/README.md` |

> 内置工作流**蓝图**只住在 workflow-manager（可视化 / 生成器真源）；通用仓保留可调用的 Skill 入口与契约副本。

## 合入与试用顺序

1. 本集合在 workflow-manager 收齐并机械验收通过  
2. 同步到 my-agent-skills 并合入  
3. 本机 restore / 硬刷新后试跑：定义 → 单任务 → 小批量  
4. **再开 M4**（定时触发同一 Execution Plan）
