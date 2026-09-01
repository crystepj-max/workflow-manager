# Workspace / Resource / Integration Isolation

> 状态：#93 Core 实现契约  
> 权威实现：`scripts/workspace-isolation.mjs`  
> Schema：`docs/design/workspace-isolation/schema.json`  
> 产品语义：issue #93；建设契约 §7.2/§7.4；原则文档中的隔离纪律  
> 前置：#78 `scripts/formal-records.mjs`（证明失效只调用，不平行实现）

本文件定义跨四套正式工作流的 **Run Workspace + Resource Lock + Integration Checkpoint** 内核。四套模板只通过 Policy 解析器声明默认 Mode，不自行实现 Git/worktree/锁。

本票不实现 Logical Run 持久化（#79）、DSH Runtime 接入、#82 模板资产、Bootstrap shim 退役（#105）或 Container/Remote Provider。

## 1. 对象与 Mode

```text
Logical Run
├─ workspace_id / workspace_path
├─ source_path          # 业务读写的 Source（Git worktree 或 sandbox 目录）
├─ records_path         # Formal Records / 身份元数据；cleanup 不得删除
├─ workers/<id>/        # Fan-out 独立 scratch
├─ tmp / build / cache
└─ resources.{port,test_db}
```

| Mode | Provider | 用途 |
|---|---|---|
| `ISOLATED_WRITE` | GitWorktreeWorkspace | 可修改 Source；独立 branch + worktree |
| `ISOLATED_READ` | GitWorktreeWorkspace | 冻结 Source Revision；detached worktree；禁止写 source |
| `SANDBOX` | DirectorySandboxWorkspace | 无 Git / 非仓库文件任务 |
| `NONE` | — | 明确不需要文件工作空间；**不是**四套正式模板默认 |

Node Attempt **只能**通过 `getRunWorkspace(registry, logical_run_id)` 取得当前现场，不得猜路径、不得落回共享主仓 cwd。`workspace_id` / `logical_run_id` 必须是已净化的小写连字符形态，且在 Registry 内唯一；`workspace_id` 不得使用保留名 `records`（与 `work_root/records/` 记录根冲突）；`workspace_path` 不得逃出 `work_root`。

## 2. 默认 Workspace Policy

| 模板 identity | 默认 |
|---|---|
| `construction` | `ISOLATED_WRITE` |
| `optimize` | `resource_kind ∈ {git, files}` → `ISOLATED_WRITE`；`document` / `config` / `other` → `SANDBOX` |
| `diagnose` | `ISOLATED_WRITE`，`freeze_from=diagnose`（诊断与修复同一 workspace lineage） |
| `explore` | `ISOLATED_READ` + 共享冻结 source + 每专家独立 scratch |

`NONE` 不会由上述解析器返回。

## 3. Git 写 / 只读

写：`resolve repo → freeze base_ref + base_commit → create branch → git worktree add`。  
默认分支名 `vwf/run/<logical_run_id>`，可被 `work_branch` 覆盖。

只读：对冻结 commit `git worktree add --detach`。`writeSourceFile` 必须拒绝；materialize 后去掉 source 写位并保留原执行位，特权进程（UID 0）再加 immutable（`chattr`/`chflags`）。若探测写入仍成功则 fail closed。cleanup 前先解冻再恢复可写。解析 source/scratch 相对路径时必须按 realpath 校验，禁止目录符号链接逃出 workspace 根。

Provider/Model 的 `config_snapshot_revision` 变化只更新字段，**不得**重建或切换 `source_path`。

## 4. Provenance 与 Proof 绑定

Attempt / Proof 记录：`workspace_id`、`source_revision` / `base_commit`、`work_branch`（若有）、**实际** `verified_head`、`config_snapshot_revision`。

`assertProofBinding` 必须核对 `workspace_id`、`logical_run_id`、`source_revision`、`base_commit`、`work_branch`、`config_snapshot_revision`，并从 `source_path` 读真实 HEAD（及有 branch 时的 branch）。Git workspace 的 `source_revision` 必须等于观测到的 HEAD；HEAD 已前进但未 `recordSourceSync` 时不得签发或绑定 Proof。`recordSourceSync` 若 source 是 Git 目录，只能写入 `git rev-parse HEAD` 观测到的值，禁止自报伪造 SHA。禁止在另一工作区验证却为本 Run 背书。

## 5. Fan-out scratch

`assembleWorkerContext(workspace, workerId)` 只给出 `source_path` + 该专家 `scratch_path`，**不**列出兄弟 scratch。读写 scratch 必须经过 `readWorkerFile` / `writeWorkerFile`，路径限制在自己的 scratch 根下。

## 6. 资源与锁

可分配资源默认按 Run 派生：`tmpdir` / `build_dir` / `cache_dir` / `port` / `test_db=vwf_<id>`。

不可独立分配的共享资源用 **resource-scoped lock**，绑定 `logical_run_id`、`resource_key`、`owner`、`acquired_at`、`expires_at`、`released_at`。刷新与释放必须同时校验 `logical_run_id` 与 `owner`。

集成锁键：`repo:<repository>:target:<ref>:integration`。不同仓库的 target 可并行；同一 target 上第二把锁被拒，直到释放或过期。

**不提供** global closeout lock。`concurrency_key`（默认 `repository::task_identity`）只阻止同任务第二份 Active Run，不是工作区技术隔离。

## 7. Integration Checkpoint 与 #78

生产路径必须由 Core **观测仓库实况**：`observeTargetHead(repository_path, ref)` fail closed 执行 `git rev-parse`；`computeIntegrationCheckpointFromRepo({ base_ref, base_commit, repository_path, target_ref })` 用观测值计算。不得在集成闸门上回落调用方自报 HEAD。

纯函数 `computeIntegrationCheckpoint({ base_ref, base_commit, target_head })` 仅用于单测（与 `cwf-checkpoint.computeCheckpoint` 同一实现）。

`target_advanced=true` 之后：

1. `recordSourceSync` 更新 `current_head` / `source_revision`（新 Artifact Revision）；
2. `assertIntegrationAllowed` 对目标 `record_id` 调用 #78 `coverageStatus`；任一对当前 Revision 为 `not_covering_current` 则拒绝集成。

不得用旧 HEAD 的 Proof 为 sync 后的结果背书。

## 8. Lifecycle / Cleanup / Stale

| Lifecycle | cleanup |
|---|---|
| `WAITING_HUMAN` / `PAUSED` / `BLOCKED` | **拒绝**删除 workspace（可 Resume） |
| `COMPLETED` / `STOPPED` / `FAILED` | 进入 eligibility；若 `hold_integration` / `hold_review` 仍拒绝 |
| `RUNNING` 且 `abandoned` | `recoverStale` 标为 cleanup eligible；`cleanupWorkspace(..., { force_abandoned: true })` **仅**允许该组合，不得对未标记 abandoned 的 READY/RUNNING 强删 |

cleanup 必须写审计（worktree / branch / artifacts 处理结果）。删除 worktree **不得**删除 `records_path` 与 timeline。过期锁在 acquire / recover 时释放。

## 9. 模块边界

| 路径 | 职责 |
|---|---|
| `scripts/workspace-isolation.mjs` | Policy、Registry、两种 Provider、资源、锁、Checkpoint+#78 闸门、cleanup |
| `scripts/test/workspace-isolation.test.mjs` | #93 Core 验收的可执行证据 |
| 本文件 + schema.json | 对外数据契约（供 #79 / #82 / DSH integration 消费） |

不接入 `scripts/generate.mjs`、`packages/dsh-visual-workflow`。Registry 默认内存；落盘归 #79。不删除 `cwf-run-init` / `cwf-checkpoint`。

## 10. 映射

| 来源 | 映射 |
|---|---|
| portable `run_id` | `logical_run_id`（#79 落地前占位） |
| bootstrap `run.workspace_id` | `workspace.workspace_id` |
| bootstrap `base_ref` / `base_commit` / `work_branch` / `current_head` | 同名 Source Revision 字段 |
| `cwf-checkpoint.computeCheckpoint` | `computeIntegrationCheckpoint` |
| #78 `coverageStatus` / `staleProofsFor` | `assertIntegrationAllowed` |
| 建设契约 §7.2 `ISOLATED_WRITE` | 本内核 Mode 枚举；字段以本契约为权威 |
