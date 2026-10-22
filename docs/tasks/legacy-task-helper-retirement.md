# WFM-466：旧任务源导出边界

本项补齐 WFM-342 / PR #367 关闭 CLI 后遗留的模块入口。Multica 继续是当前 Task 身份、状态、负责人、依赖与执行历史的唯一来源。`docs/tasks/registry.json`、`BOARD.md` 原件保留，任何历史模式都不能恢复写入。

## 导出与调用链盘点

| 模块与导出 | 仓库内调用方 | 当前边界 |
|---|---|---|
| `local-task-registry.mjs`：`loadRegistry` | 候选采集、旧 preflight、旧计划、历史对账、旧 GitHub 锚点查询、旧合并/dispatcher、历史测试 | 默认在 IO 前抛出 `legacy_registry_read_disabled`；仅显式 `{ legacyHistoryAudit: true }` 可读取历史快照 |
| 同模块：`saveRegistry`、`allocate`、`update`、`writeBoard` | 旧 CLI、旧合并流程、历史写入测试 | 写实现删除，兼容导出统一抛出 `legacy_registry_write_disabled`；CLI 写命令保持原退役原因码。不存在历史模式写入旁路 |
| 同模块：`remoteAllocate` | 旧 `allocate`、历史发号测试 | 发号实现删除，导出永久拒绝；不能申请 GitHub 编号、生成本地临时任务或回落 CNB |
| `ai-task-candidate-collect.mjs`：`collectLocalCandidates` | 已退役 dispatcher、旧 CLI、历史采集测试 | 默认拒绝；显式历史模式只读回放，并返回 `source_kind: legacy-history-audit` |
| `ai-task-preflight-check.mjs`：`runPreflight`、`checkCrossGroupDeps` | 旧 `assessAndSort`、LOC-045 C1 fixture、历史 preflight 测试 | 默认在任务卡、登记册和 Git 读取前拒绝，包括空依赖；历史调用逐层显式传递标记。`specOpenItemsZero`、`strictDefinitionCheck` 纯检查保留 |
| `ai-task-execution-plan.mjs`：`assessAndSort` | 已退役 M3 CLI / dispatcher | 默认拒绝；第四参数显式历史模式只用于只读回放。`createBatchState`、`fillCapacity`、`applyRelease`、`autoPhaseDone` 无任务源 IO，继续保留 |
| `registry-reconcile.mjs`：`reconcilePlan` | `plan --legacy-history-audit`、历史对账测试 | 模块调用也须显式历史标记；CLI 只读标记原样传递。`apply` 继续永久拒绝写回 |
| `github-issues.mjs`：`remoteAnchorOfTask` | 旧 CLI show、原 claim/release/mark-ready 前置判断 | 默认拒绝；显式第三参数仅查询历史锚点。`claimIssue`、`releaseIssue`、`markReady` 直接返回已退役结果，不再依赖旧登记册判断当前任务是否存在或缺锚点 |
| `remote-issue-sync.mjs`：`guessType`、`pendingTasks` | 历史测试 | 只处理调用方传入的数据，无文件或远端 IO；不可达的旧同步计划实现已删除 |

`local-task-merge.mjs` 的 `checkMerge` / `runMerge` 仍在入口永久拒绝；其不可达旧实现中的 `loadRegistry` / `update` / `writeBoard` 引用不会重新开启读写。旧 dispatcher 和本地计划 CLI 仍在任何读取/批次文件/Run 创建前退出，也没有导出可调用的启动入口。

## 保留的只读和纯函数

- `local-task-registry.mjs list/show` 继续输出历史提醒，只读原快照；不要求用户迁移或重写历史资料。
- 历史 `reconcilePlan`、候选采集、preflight 和排序的默认调用都拒绝，只有明确历史取证或 fixture 回放才传递 `legacyHistoryAudit: true`。这项选择不授予当前开工资格。
- 序号和 URL 解析、历史记录变换、看板字符串渲染、任务来源准入计算、批次状态机继续可用；`scanOpenRuns` 只读取本地 Run 证据。它们不直接读写旧 Task 账本，也不证明 Multica 当前任务状态。
- `collectMergeFacts` 读取 Git 交付事实；`collectLocalConstructionSignals` / `unclaimedConstructionAlerts` 分析调用方提供的历史快照，历史审计可能只读查询 GitHub 标签，不回写 Task。
- `workspace-isolation-host.mjs` 内部同名 registry 读写针对工作区资源账本 `.vwf-registry/state.json`；`benchmark/loc-045/lib/task-registry.mjs` 管理基准实验清单。两者不是 `docs/tasks/registry.json`，保持现有行为。

## npm、自动调度与安装

`package.json` 不再暴露 `sync:remote-issues`。直接运行旧同步脚本仍返回退出码 2 和 `legacy_github_task_sync_disabled`，不读旧账、不访问 GitHub。旧 CLI 退役检查和显式历史函数测试分别覆盖这两个边界。

当前建设门禁继续由 `construction-preflight-gate.mjs` → `multica-task-preflight.mjs` → `multica-task-source.mjs` 读取显式 profile/workspace 的 Multica Task；不增加本地回退。旧 M3 / M4 / M5 自动调度保持退役，本变更不实现替代调度器，也不更改 `dev-flow`。

没有更改 npm 依赖、安装入口、包导出或蓝图。LOC-045 C1 仅通过显式历史模式读取旧基准 fixture，不把历史 Task 状态带回当前门禁。旧测试中的纯变换和历史算法断言保留；已退役写入的原成功场景改为验证相同场景下零写入、零发号与永久拒绝。

WFM-169 跟踪的 `github-issues.mjs` 六个底层 GitHub 写导出不在本项范围，本项不改变它们；验证使用 fake CLI / 注入 runner 隔离远端。
