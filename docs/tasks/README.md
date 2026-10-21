# 任务资料与 Multica 边界

Multica 是新任务登记、项目归属、状态、负责人、依赖和执行历史的唯一真源。GitHub 只记录代码交付事实：分支、提交、PR、Review、CI 与合并。

本目录中的 `registry.json`、`BOARD.md`、旧任务卡、旧规格和 `archive/` 是迁移前历史材料。保留它们用于追溯，不新增任务、不更新状态、不据此判断当前负责人或开工资格。历史条目与 Multica Task 之间没有已核实的 UUID 映射时，保持未映射，不按标题或旧编号猜测。

## 当前任务流程

1. 新任务在目标 Multica workspace/project 中创建；需求定义和依赖按 `dsh/skills/requirements-analysis/` 写入 Task 描述与 `dev-flow.definition.v1`、`dev-flow.dependencies.v1`。
2. 任务状态、负责人、项目归属和当前执行信息用 Multica CLI 查询或更新：

   ```bash
   multica --profile <profile> --workspace-id <workspace-id> issue get <task-uuid-or-key> --output json
   multica --profile <profile> --workspace-id <workspace-id> issue runs <task-uuid-or-key> --output json
   multica --profile <profile> --workspace-id <workspace-id> issue timeline <task-uuid-or-key> --activity-only --output json
   ```

   若有多个 Multica 服务，必须显式选 profile/workspace，并核对返回的 `workspace_id` 与 `project_id`；不依赖默认连接。
3. 需求正文、Definition Check、设计与实现证据可按版本保存在代码仓库。它们不复制 Multica 当前任务状态。
4. 建设工作流入口 `scripts/construction-preflight-gate.mjs` 从指定 Multica workspace 读取当前 Task 和依赖状态，再读取 `spec_ref` 指向的本地规格。缺少 Multica 元数据或服务不可用时 fail-closed，不回退到 `registry.json`。
5. `.agent-runs/` 与 `docs/tasks/archive/` 中的本地记录是工作流阶段证据或迁移前档案，不是 Multica Task 状态，也不替代 Multica Agent Run history。

## 旧资料与工具处置

| 项目 | 当前边界 |
|---|---|
| `registry.json`、`BOARD.md`、任务卡、归档规格 | 保留为只读历史材料；不导入、不批量改号、不猜测对应 Task |
| `local-task-registry.mjs` 的 `list` / `show` | 仅供历史查阅；写命令继续 fail-closed，稳定原因码 `legacy_registry_write_disabled` |
| `local-task-merge.mjs` | 旧本地主干合并链路退役；不得再以本地登记册状态放行或写回状态 |
| `registry-reconcile.mjs` | `plan` 仅可作历史差异取证；`apply` 已退役，不进入批次或当前验收流程 |
| `task-runs-cleanup.mjs`、`backfill-fix72-archives.mjs` | 依赖旧账本的本地清理/回填链路退役；不得自动删除运行证据或改写历史状态 |
| `ai-task-candidate-collect.mjs`、`ai-task-execution-plan.mjs`、`ai-task-dispatcher.mjs`、`ai-task-scheduled-trigger.mjs` | 依赖旧登记册或 GitHub 任务标签的 M3/M4/M5 流程退役；新执行计划由 dev-flow 读取 Multica 状态 |
| `remote-issue-sync.mjs`、`github-issues.mjs` | 旧 GitHub Task 登记/认领通道退役；GitHub 只保留代码交付记录 |
| `validate-task-spec-sync.mjs` | 旧登记册任务上下文门禁退役，不再加入 `npm run validate` |

这些旧脚本的留存仅用于解释历史实现与已有测试，不构成当前可用任务流程。正常任务操作不能调用其登记册读写路径。

## 历史审计记录

WFM-342 的退役清单与调用链结论见 [`legacy-task-registry-retirement.md`](legacy-task-registry-retirement.md)。该清单区分历史档案、当前 Multica 流程和退役脚本，不建立未经核实的旧任务到 Multica UUID 映射。
