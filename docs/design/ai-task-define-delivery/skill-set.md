# AI 任务定义与交付能力的职责边界

本文件记录 M1、M2、M3 的当前归属。Multica 管理任务身份和任务状态；dev-flow 读取这些状态并安排本地计划；workflow-manager 维护 DSH 工作流插件与需求分析入口。

## 能力与维护位置

| 能力 | 维护位置 | 使用方式 | 当前边界 |
|---|---|---|---|
| **M1 需求分析** | workflow-manager：`dsh/skills/requirements-analysis/` | `./dsh/install-requirements-analysis.sh` 直接安装到用户级 `~/.agents/skills/requirements-analysis/` | 需求定义经人工确认后写入 Multica Task；不创建本地任务状态副本 |
| **M2 单任务交付** | workflow-manager：`templates/wf-construction-full-feature.json` 及 DSH 插件 | 由蓝图生成内置 Skill；命令序列见 `docs/runbooks/construction-dsh/runbook.md` | 根据已确认的任务定义施工，并进入人工验收 |
| **M3 执行计划** | dev-flow：`.agents/skills/execution-plan/` | 在 dev-flow 项目会话中使用项目级 Skill | 当前 planner 读取 Multica 状态并生成只读计划；不 claim、不启动 Agent |
| **M4 定时触发** | 尚未作为可用能力验收 | 不安装、不启用 | 仍需验证 Multica Claim、Run 停止、释放、重试、接管及工作区生命周期 |

## 状态与执行分工

- Multica 是 Task 身份、工作状态和状态变更的唯一来源。
- `backlog` 不进入本地计划；`todo` 只有在定义、依赖和并发检查通过后才进入计划。
- `blocked` 期间不启动 Agent。接管由 Multica 记录；状态恢复为 `todo` 后，dev-flow 再读取新状态并安排计划。
- `in_progress`、`in_review`、`done`、`cancelled` 均不由 dev-flow 重复派发。
- Agent 是执行者；Runtime 是 Agent 所在的执行环境。Task 状态、Agent 身份和 Runtime 不互相替代。
- 工作流运行状态（例如 `WAITING_HUMAN`）与 Multica Task 状态是不同对象。

任务状态与分派契约详见 dev-flow 仓库的 `docs/multica-status-dispatch-contract.md`。M1 定义流程与元数据详见 `dsh/skills/requirements-analysis/references/public-task-contract.md`。

## 分发边界

- workflow-manager 直接维护并分发 `requirements-analysis` 用户级 Skill。
- workflow-manager 不再运行 `scripts/sync-ai-task-skill-set.mjs`，也不向 `my-agent-skills` 复制 M1 或 M3。
- `execution-plan` 作为项目级 Skill 由 dev-flow 维护，不安装为全局用户级 Skill。
- 旧版 GitHub / 本地任务卡流程文档保留作历史记录，不作为当前 Task 状态规则。
