# WFM-342：本地任务登记册退役清单

## 决定与用户影响

当前任务身份、状态、负责人、项目归属、依赖与执行历史以 Multica Task 为准。`registry.json`、`BOARD.md`、旧任务卡、规格和归档目录保留为迁移前历史材料；它们不再提供当前开工资格或任务状态。未核实的历史记录与 Multica UUID 不做猜测映射。

## 当前路径

| 能力 | 当前实现 | 作用边界 |
|---|---|---|
| 开工资格 | `scripts/construction-preflight-gate.mjs` → `scripts/multica-task-preflight.mjs` | 显式 profile/workspace 读取 Task、定义元数据和依赖；缺数据或服务不可用时阻断 |
| Task 读取 | `scripts/multica-task-source.mjs` | 核对返回 workspace；不从本地历史账本回退 |
| 阶段证据 | `scripts/cwf-record.mjs`、`scripts/workspace-evidence-summary.mjs` | 只读取本地 Run 阶段记录与人工验收证据；摘要不复制 Task 状态、分支或合并字段 |
| 工作区与归档校验 | `scripts/validate-workspace.mjs` | 校验 Git/worktree 与已存在归档目录结构；D-7/D-9/D-10 明确跳过 Task 状态推断 |
| 当前项目说明 | `AGENTS.md`、`docs/tasks/README.md`、DSH Runbook | Multica 是当前 Task 源；GitHub 只记录代码交付事实 |

## 历史资料保全

- `docs/tasks/registry.json`、`BOARD.md` 和旧任务卡/规格/归档全部保留，不重写历史状态。
- `BOARD.md` 与生成器抬头已标为历史快照；旧 `list` / `show` 仅供查阅。
- `docs/tasks/archive/` 中已有的 79 个目录保留。校验器按实际目录检查：轻量远程归档须有存根、`merge.commit` 与 `remote_ref`；完整归档须有任务卡、规格和有效摘要。
- `.agent-runs/` 保留本地阶段证据；Multica Agent Run history 仍是平台执行历史权威。旧七天自动清理已停用，未来保留策略需独立明确。
- 历史编号与 Multica UUID 的交叉表目前未建立；不按标题、旧编号或提交信息自动匹配。

## 退役入口

| 入口 | 处置 |
|---|---|
| `scripts/local-task-registry.mjs` 写命令 | 在本地读写前拒绝；`list` / `show` 只读且标明历史用途 |
| `scripts/local-task-merge.mjs`、`scripts/registry-reconcile.mjs apply` | 旧合并/写回流程退役 |
| `scripts/registry-reconcile.mjs plan` | 只有显式 `--legacy-history-audit` 才进行只读历史取证，不参与当前任务流程 |
| `scripts/task-runs-cleanup.mjs` | 退役；`--apply` 也会在读取或删除前退出，保留 `.agent-runs/` |
| `scripts/backfill-fix72-archives.mjs` | 退役；不批量改写历史归档 |
| `scripts/ai-task-candidate-collect.mjs`、`ai-task-execution-plan.mjs`、`ai-task-dispatcher.mjs`、`ai-task-scheduled-trigger.mjs` | 依赖旧登记册的候选、计划、派发与定时开工入口退役 |
| `scripts/remote-issue-sync.mjs`、`scripts/github-issues.mjs` | 旧 GitHub Task 登记/认领通道退役；GitHub 继续记录 PR、提交、Review、CI 和合并 |
| `scripts/ai-task-preflight-check.mjs`、`scripts/validate-task-spec-sync.mjs` | 旧本地任务卡/登记册门禁退役；当前开工走 Multica 门禁 |
| `npm run evidence:report`、`npm run validate:task-context` | 已从 package scripts 移除 |

## 变更边界与未完成验证

WFM-342 的修改保留在隔离分支 `codex/wfm342-task-source`，不提交、不推送、不改远端状态。Multica profile/workspace 指向已核实的 `multica.ai` workspace；真实服务端行为之外的 Task 元数据样本、跨用户权限和平台历史交叉映射不在本地静态检查范围。

## WFM-466 后续补齐

模块导出的默认读取与程序化写入口，以及 npm 同步入口，见 [旧任务源导出边界](./legacy-task-helper-retirement.md)。历史标记只授予只读回放，不能解锁旧登记册写入或远端发号；PR #367 的原审查结论与历史资料保持原记录。
