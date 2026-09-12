---
status: 实例化说明 v1.0（workflow-manager）
created: 2026-09-12
template: docs/design/workspace-directory-convention.md（通用标准模板 v1.0）
project: workflow-manager（GitHub: crystepj-max/workflow-manager，镜像 cnb）
purposes: 把通用模板填入本项目实际取值；并登记存量任务与工作区基线、决策记录、处置批次
---

# 实例化说明：通用模板在 workflow-manager 的落地

> 通用规则见 `docs/design/workspace-directory-convention.md`。本文件只写**本项目特有的取值、链路、基线与决策**。
> 采集时间：2026-09-12（11:13 / 12:56 / 20:00 / 21:00 四次盘点）。

---

## 1. 占位符取值表

| 模板占位符 | 本项目取值 |
|---|---|
| `<项目>` | `workflow-manager` |
| `<工作区容器根>` | `/Users/chris/workspace/` |
| **主检出路径** | `/Users/chris/workspace/workflow-manager`（**保持不变**） |
| **工作区根（目标）** | `/Users/chris/workspace/workflow-manager-worktrees/` |
| `<主检出>/.task-runs/` | `/Users/chris/workspace/workflow-manager/.task-runs/` |
| `<归档根>` | `docs/tasks/archive/<TASK_ID>/` |
| `<任务标识体系>` | 双轨道：本地 `LOC-<序号>`；GitHub `CWF-<issue 号>` |
| 证据明细保留期 | 7 天 |
| 过程产物目录（现行，待退役） | `.agent-runs/`（运行产物）、`.scratch/`（脚手架） |
| 校验命令 | `npm run validate`（另有 `npm run generate`、`npm test`、`npm run release:verify`） |

### 1.1 命名派生规则（本项目）

| 对象 | 规则 | 示例 |
|---|---|---|
| `TASK_ID` | `LOC-<序号>` 或 `CWF-<issue号>` | `LOC-018`、`CWF-185` |
| `RUN_ID` | `<TASK_ID>-r<n>` | `LOC-018-r1`、`CWF-185-r1` |
| 分支 | `dev-<task-id 小写>-r<n>` | `dev-loc-018-r1`、`dev-cwf-185-r1` |
| 工作区目录 | = 分支名 | `dev-loc-018-r1` |
| 过程产物目录 | `.task-runs/<TASK_ID>/<RUN_ID>/` | `.task-runs/LOC-018/LOC-018-r1/` |

---

## 2. 本位实际链路：谁在建、谁在回收

依据 `dsh/skills/construction-bootstrap/runbook.md`（建设工作流单任务交付 Runbook，产品主链权威为 `docs/design/ai-task-define-delivery/single-task-delivery-m2.md`）。

### 2.1 创建侧（现状：两个入口）

| 环节 | 时点 | 命令 | 出处 |
|---|---|---|---|
| ① 分配任务标识 | 需求分析完成、进入「已定义」 | `node scripts/local-task-registry.mjs allocate --name "..." --source ...` | `docs/tasks/README.md` |
| ② 建分支 + 工作区 + 运行目录 | **Run 引导**（实施前检查通过之后） | GitHub 轨道：`node scripts/cwf-run-init.mjs <issue编号> <run_id>`；本地轨道：`node scripts/cwf-run-init.mjs <任务标识> <run_id> --local-base` | runbook §0（第 18 / 24 行） |
| ③ 环境组解析（多任务并行） | 紧接 ②，实施前检查通过后 | `node scripts/ai-task-workspace-env.mjs resolve --store <dir> --task <标识> --env <组> --role <独立\|成员> --deps <无\|列表>` | runbook §1 第 5 步（第 60–69 行） |

**创建侧的硬前置门禁**：`node scripts/ai-task-preflight-check.mjs <issue-basics快照> <task-spec路径> --run-baseline <版本>`（runbook §1 第 3 步）。失败则 Run → `BLOCKED`、**停止、不进入开发**。

**两条已存在但关键的规定**（应保留并强化）：

- runbook §0 第 34 行：*「之后全部工作在该 worktree 内进行；任何 git / npm 命令一律 `git -C <worktree>` 或先 `cd <worktree>` 并核对 `git rev-parse --abbrev-ref HEAD` = `run.json.work_branch`，不一致即停（不得在主检出或别的 worktree 里"顺手"执行）」* —— 这条纪律约束了「在哪里干活」。
- runbook §1 第 60 行括注：**「批量调度不得代劳」**环境解析。

> 🟡 **缺口**：上述纪律只约束了「在哪里干活」，**没有约束「产物写到哪里」**。这正是通用模板 §1.6 锚定机制要补的后半句。

### 2.2 回收侧（现状：四个入口）

| 入口 | 命令 / 位置 | 覆盖范围 |
|---|---|---|
| 环境回收 | `scripts/cwf-env-recycle.mjs recycle <runDir> --stop --report ...`（收口角色第 5 条） | 本 Run 独占的开发 DSH Home |
| 环境组清理 | `scripts/ai-task-workspace-env.mjs mark-completed` + `maybe-cleanup`（runbook 第 177–184 行） | 同组全部完成时清理工作区 |
| 兜底 GC | `scripts/cwf-env-recycle.mjs gc [--force] [--max-age-days N]`（runbook 第 169–175 行） | 残留 Home（默认 dry-run 只列清单） |
| 任务合并 | `scripts/local-task-merge.mjs --task ... --branch ... --decision accept --run-id ...`（本地轨道） | 合并 + 归档 2 件 |
| 收口角色 | `dsh/roles/closeout.md` 第 6 条 `git worktree remove` + `git branch -D` | 工作区与分支（阶段二口径） |

### 2.3 本地结论：创建与回收各收敛为单一入口

| 环节 | 目标所有者 | 说明 |
|---|---|---|
| 创建 | `cwf-run-init.mjs` 内的**单一解析函数** | `ai-task-workspace-env.mjs resolve` 改为调用该函数，不再各自拼路径 |
| 回收 | **收口命令**（单一入口） | 依次：环境回收 → 归档三件 → 删工作区 → `git worktree prune`；`mark-completed` / `maybe-cleanup` / `local-task-merge` / `gc` 归入其编排 |
| 登记 | `docs/tasks/registry.json` 的运行记录 | 创建时写入 `RUN_ID` + 工作区 + 分支；回收时按同一清单核对删除 |

---

## 3. 决策记录（本项目已定）

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| 一 | 工作区根布局 | **相邻容器** `../workflow-manager-worktrees/` | 实测 `~/.dsh/workspaces/ws-uat-80-01/source/.git` 内容为 `gitdir: /Users/chris/workspace/workflow-manager/.git/worktrees/source7`——十余个运行时工作区以**绝对路径**指回主检出，搬迁将全部失效 |
| 二 | 证据明细保留期与执行方式 | **7 天 + 机会式清理（开工/收口搭车）+ `npm run validate` 闸门** | 开工是最频繁事件；定时任务失败静默 |
| 三 | `.scratch` 下 5 个已入库文件 | **3 个移除跟踪**（`dsh-visual-workflow-p0/` 的 `compile-test.mjs`、`compiled/dev-workflow-2-0.gen.mjs`、`compiled/meta.json`）；**2 个迁入** `docs/design/vwf-p2/`（`decision-map.md`、`requirements-analysis.md`） | `compile-test.mjs` 自述「从插件 pkg-3 原样提取」= 原型一次性脚本；蓝图权威源已迁 `templates/custom-seeds/dev-workflow-2-0.json`；产物现由 `npm run generate` 出到 `.generated/` |
| 四 | 收口清理程度 | **分两阶段**：暂停期删工作区留分支；托管恢复后全清 | 工作区可再生、分支不可再生；`dev-cwf-185-01`（需求分两阶段）与 `dev-loc-008/009-r1`（squash 已入 main 待补 PR）两案例吻合 |
| **五** | **归档位置（2026-09-12 新增）** | **方案甲：统一到 `docs/tasks/archive/<TASK_ID>/`**，作为唯一收口归档位置（任务卡 + 规格终版 + 证据摘要三件）；`docs/tasks/specs/` 内容并入后废弃 | 现状两处并存且 LOC-015 同时在两处 |

---

## 4. 现状基线

### 4.1 任务基线（登记册 18 条，2026-09-12 21:00）

| 状态 | 任务 | 数量 |
|---|---|---|
| **已合并** | LOC-001、002、003、004、005、006、007、008、009、011、012、015 | 12 |
| **已取消** | LOC-010 | 1 |
| **在制（等待验收，并发会话作业中）** | LOC-013、LOC-017 | 2 |
| **未开工（本地已定义）** | LOC-014、LOC-016、LOC-018 | 3 |

### 4.2 工作区基线（28 条 = 27 链接工作区 + 主检出）

| 根目录 | 数量 | 归属 | 体量 |
|---|---|---|---|
| `<仓库>/.scratch/worktrees/` | 8 | 人工/脚本创建（待退役） | 1.7 GB |
| `~/.dsh-workflow-dev/workspaces/ws-*/source` | 9 | DSH 开发运行时 | 约 36 MB |
| `~/.dsh/workspaces/ws-*/source` | 6 | DSH 产品运行时 | 约 25 MB |
| `~/.dsh-workflow-loc001/workspaces/ws-*/source` | 2 | LOC-001 专用实例运行时（09-12 新增） | 约 8 MB |
| `~/.cursor/worktrees/workflow-manager/` | 1 | 编辑器 | 40 MB |
| `/private/tmp/wmlist` | 1 | 🟡 系统临时目录内，孤儿登记高危 | 5 MB |

`.agent-runs/` 共 1.6 MB（17 项）；`.scratch/` 共 **1.7 GB**。

### 4.3 🔴 体量异常定位（2026-09-12 从 160 MB 涨到 1.7 GB）

**根因不是嵌套（该假设已实测证伪），而是 LOC-013 在制期间的实验产物**：

| 位置 | 体量 |
|---|---|
| `.scratch/worktrees/dev-loc-013-r1/.scratch/ssvf` | 531 MB |
| `.scratch/worktrees/dev-loc-013-r1/.scratch/research-4` | 342 MB |
| `.scratch/worktrees/dev-loc-013-r1/.scratch/npmcache` | 201 MB |
| `.scratch/worktrees/dev-loc-013-r1/.scratch/sizecheck` | 82 MB |
| `.scratch/worktrees/dev-loc-013-r1/.scratch/research-1`、`only-jest-30`、`exp3`、`only-vitest-5`、`evidence` | 61 / 49 / 37 / 34 / 12 MB |
| 工作区顶层 `.npm-cache` + `.npm-cache-loc013` | 165 + 32 MB |

**这是「缺少生命周期」最直接的证据**：任务尚未结束，过程产物已达 1.3 GB，且没有任何机制回收。同时这批目录名（`ssvf`、`research-*`、`exp3`、`sizecheck`、`only-jest-30`）全部**非 `TASK_ID` 派生**，构成又一套命名体系。

**处置（已定）**：等 LOC-013 收口后随收口流程一并清理（记入批次 B9），不在并发作业期间动手。

---

## 5. 逐项处置表

| 工作区 | 分支 | 归属 | 状态 | 处置 | 体量 |
|---|---|---|---|---|---|
| `.scratch/worktrees/dev-loc-013-r1` | `dev-loc-013-r1` | LOC-013 | 在制（并发使用） | ⏸ 保留；收口时一并清实验残留（B9） | 1.5 GB |
| `.scratch/worktrees/dev-loc-017-r1` | `dev-loc-017-r1` | LOC-017 | 在制（并发使用） | ⏸ 保留 | 6.2 MB |
| `.scratch/worktrees/dev-loc-011-r1` | `dev-loc-011-r1` | LOC-011 | 已合并，干净 | ✅ 可收口（B8） | 6.1 MB |
| `.scratch/worktrees/dev-loc-012-r1` | `dev-loc-012-r1` | LOC-012 | 已合并，干净 | ✅ 可收口（B8） | 6.1 MB |
| `.scratch/worktrees/dev-loc-015-r1` | `dev-loc-015-r1` | LOC-015 | 已合并，干净 | ✅ 可收口（B8） | 6.2 MB |
| `.scratch/worktrees/dev-cwf-80-01` | `dev-cwf-80-01` | `CWF-80` | 领先 1 提交，有 1 个改动文件 | 🟡 待判定 | 42 MB |
| `.scratch/worktrees/dev-cwf-131-01` | `dev-cwf-131-01` | `CWF-131` | 领先 4 提交，无登记册条目 | 🟡 待判定 | 42 MB |
| `.scratch/worktrees/dev-night-w2-01-verify` | `dev-night-w2-01-verify` | 夜间批次验证 | 领先 9 提交 | 🟡 待判定 | 6.1 MB |
| `~/.dsh/workspaces/ws-*/source` ×6 | `vwf/run/*` | DSH 产品运行时 | 内容已在 main、0 改动 | ⏸ 等任务完成后再处理（B4） | 25 MB |
| `~/.dsh-workflow-dev/workspaces/ws-*` ×9 | `vwf/run/*` | DSH 开发运行时 | `ws-uat-loc017-a`/`a2` 在制 | ⏸ 在制保留，其余待运行时回收（B4） | 36 MB |
| `~/.dsh-workflow-loc001/workspaces/ws-uat-loc013-0{1,2}` | detached HEAD | LOC-013 UAT | 活跃 | ⏸ 保留 | 8 MB |
| `~/.cursor/worktrees/workflow-manager/hplt` | `feat/vwf-editor-slim-oneclick` | 编辑器 | 领先 3 提交，1 个改动 | ⏸ 保留（例外条款） | 40 MB |
| `/private/tmp/wmlist` | `fix/auto-grow-manifests` | 临时 | 领先 1 提交 | 🟡 待判定；建议迁出或删除 | 5 MB |

### 5.1 🔴 指针错乱目录（未处理）

`~/.dsh/workspaces/ws-cwf-159-01/source`：

| 文件 | 内容 |
|---|---|
| 该目录 `.git` | `gitdir: /Users/chris/workspace/workflow-manager/.git/worktrees/source` |
| 该管理目录 `gitdir` | `/Users/chris/.dsh-workflow-dev/workspaces/ws-uat-lr-01/source/.git` ← **指向另一个工作区** |

即单向串台：在该目录内执行任何 git 命令都会以 `ws-uat-lr-01` 的身份操作其索引与 HEAD，**可能静默覆盖他人工作区暂存区**。该目录不在 `git worktree list` 中，属残留副本。最后修改 2026-09-05。处置：确认 `artifacts/` 无独有产出后整体删除（B2）。

---

## 6. 存量清理批次

| 批 | 内容 | 状态 | 回收 |
|---|---|---|---|
| **B0** | `git worktree prune` 清孤儿登记 `dev-itest-a-01` | ✅ 已完成 | — |
| **B0.5** | 补归档 `dev-loc-010-r1` 证据（21 个文件）到主检出 | ✅ 已完成 | — |
| **B1** | 删 5 个终态工作区（`dev-loc-008-r1`、`dev-loc-009-r1`、`cwf-80-verify`、`dev-cwf-74-01`、`dev-loc-010-r1`） | ✅ 已完成 | 177 MB |
| **B3** | 删 `.scratch/ws-isolation-tests`（由 `scripts/test/workspace-isolation.test.mjs:24` 在测试时重建） | ✅ 已完成 | 11 MB |
| **B6** | 登记册悬空 `worktree` 引用置空 | ⚠️ **已做但被并发脚本覆盖**，需重做 | — |
| **B2** | 处理 `~/.dsh/workspaces/ws-cwf-159-01/`（指针错乱） | ⏸ 待做 | 3.6 MB |
| **B4** | 外部运行时终态工作区回收 | ⏸ 等任务完成后再处理 | 约 61 MB |
| **B5** | 在制工作区迁移到相邻容器 | ⏸ 待做（属 P2，建议脚本化） | — |
| **B7** | 分支治理（约 40 个分支） | ⏸ 待做（独立议题） | — |
| **B8** | `dev-loc-011`/`012`/`015-r1` 收口 | ⏸ 待做 | 18 MB |
| **B9** | `dev-loc-013-r1` 内部 1.3 GB 实验残留清理 | ⏸ **等 LOC-013 收口后随收口流程执行** | 1.3 GB |

> ⚠️ **并发作业教训（09-12 实测）**：执行 B3/B6 期间检测到另一会话在同一工作区作业——`main` 当天推进多次（`77abee8` → `755c695` → `f126654` → `4a0e2fb`）；4 个清理目标在执行前已被其清除；且 **B6 对 `registry.json` 的修改被其脚本重写覆盖**。

---

## 7. 归档缺口

### 7.1 规格未入库（🔴 需补，属 P5）

| 任务 | 现状 | 处置 |
|---|---|---|
| **LOC-001** | 规格**仅存在**于 `.scratch/LOC-001-edge-outcome-ui/`：`task-spec-V1.md`、`task-spec-V2.md`、`definition-check.md`、`definition-check-V2.md`（共 32 KB） | **补归档**到 `docs/tasks/archive/LOC-001/`（任务卡 + 规格终版 V2 + 定义检查），入库后删 `.scratch` 副本 |
| LOC-011 / LOC-012 | 已于 09-12 由并发会话收口归档（`archive/LOC-011/`、`archive/LOC-012/` 已存在） | ✅ 已解决 |
| LOC-010 | 已取消，无规格归档 | 可接受 |

> 🔴 注意：LOC-001 是最早期任务，从未纳入归档流程——印证通用模板 Part 3 §3.4 的提醒：**不能假定「已合并 = 已归档」**，必须逐个核对。

### 7.2 归档位置统一（决策五 = 方案甲）

现状两处并存：

| 位置 | 内容 |
|---|---|
| `docs/tasks/specs/<TASK_ID>-<slug>/` | LOC-002、003、004、005、006、007、015 |
| `docs/tasks/archive/<TASK_ID>/` | LOC-008、009、011、012、015 |

**执行**：`specs/` 内容并入 `archive/<TASK_ID>/`，随后删除 `specs/`；`local-task-merge.mjs` 的归档目标统一为 `archive/`（三件套）。

---

## 8. 命名修正映射

| 位置 | 现名 | 修正为 |
|---|---|---|
| `.agent-runs/` | `cwf-74-01`、`cwf-80-01`、`cwf-163-01`、`cwf-185-01`、`cwf-79-01` | `.task-runs/CWF-<n>/CWF-<n>-r1/` |
| `.agent-runs/` | `loc-008-r1`、`loc-009-r1`、`loc-010-r1` | `.task-runs/LOC-00<n>/LOC-00<n>-r1/` |
| `.agent-runs/` | `uat-budget-01`、`uat-budget-02`、`uat-80-03/04/05`、`uat-lr-04` | 无任务归属 → 归入对应任务，或标记为运行时非任务产物 |
| `.agent-runs/` | `task`、`env-store` | **删除**（非运行标识） |
| `.agent-runs/` | `schema` | 迁至 `docs/design/` |
| 工作区目录 | `cwf-80-verify`（挂 `dev-cwf-80-01-r2`） | 目录名改为 `dev-cwf-80-r2` |
| 工作区内部 | `.npm-cache`、`.npm-cache-loc013`、`.scratch/npmcache` | 指向主检出外的统一缓存位置 |
| 工作区内部 | `ssvf`、`research-*`、`exp3`、`sizecheck`、`only-jest-30`、`only-vitest-5` | 置于 `<RUN_ID>/scratch/<子名>/` 之下 |
| 分支/工作区 | `dev-cwf-<n>-01`（切片语义） | `dev-cwf-<n>-r<n>`，切片后缀另加 `-s<nn>` |
| 分支（无工作区） | `dev-projection-converge-01`、`dev-night-w2-01-verify`、`dev-itest-a-01` | 随任务收口一并清理 |

---

## 9. 待改造文件（本项目）

| 文件 | 改什么 |
|---|---|
| `scripts/cwf-run-init.mjs` | 第 122 行锚点改为 `--git-common-dir` 推导主检出；第 128–129 行工作区路径改为 `../workflow-manager-worktrees/`；第 168 行产物目录改为 `.task-runs/<TASK_ID>/<RUN_ID>/`；抽出**单一路径解析函数** |
| `scripts/ai-task-workspace-env.mjs` | `resolve` 改为调用上述解析函数，不再自行拼接 |
| `scripts/cwf-record.mjs` | 归档目标改为 `.task-runs/.../evidence/` 单一写入 |
| `scripts/local-task-merge.mjs` | 归档从 2 件扩展为 3 件（增证据摘要）；归档目标统一 `docs/tasks/archive/`；末尾追加 `git worktree prune` |
| `scripts/local-task-registry.mjs` | 支持 `evidence_expires_at` / `evidence_cleared_at` / `branch_retained` |
| 新增 `scripts/task-runs-cleanup.mjs` | 到期清理：扫登记册 → 校验摘要存在 → 删明细 |
| 新增 `scripts/validate-workspace.mjs` | D-1~D-10 校验（可并入 `validate.mjs`） |
| `dsh/roles/closeout.md` | 第 6 条补 `git worktree prune`（级联注销嵌套子登记） |
| `docs/tasks/README.md` | 硬规则 3 补注适用期（阶段一口径）；新字段说明 |
| `AGENTS.md`、`CONTEXT.md` | 写入 §1.4 / §1.6 / §1.7 / §1.12 条款 |
| 新增 `CHANGELOG.md`、`docs/design/decisions/README.md` | 变更日志与决策记录索引 |
| `docs/design/ai-task-define-delivery/*` | 同步单一创建入口与锚定规则 |

---

## 10. 开放项（待人工决策或待条件满足）

| # | 事项 | 阻塞原因 | 建议 |
|---|---|---|---|
| 1 | `dev-cwf-80-01`、`dev-cwf-131-01`、`dev-night-w2-01-verify` 归属与处置 | 无登记册条目 | 人工确认后归入 B1/B8 或保留 |
| 2 | `/private/tmp/wmlist` 处置 | 位于系统临时目录，高危 | 迁出或删除 |
| 3 | 约 40 个分支的治理 | 独立议题 | 不与工作区收敛混做 |
| 4 | B4 运行时工作区回收 | 用户决定等任务完成 | 由运行时流程执行，不手工删 |
| 5 | B6 重做（登记册悬空引用） | 需无并发写入 | 等并发会话收工后重做 |
| 6 | P5（决策三 5 个文件 + LOC-001 归档） | 改动已入库文件，需独立提交 | 单独立项执行 |

---

## 11. P1 已落地产物与实时违规基线（2026-09-12）

### 11.1 新增文件

| 文件 | 作用 |
|---|---|
| `scripts/workspace-convention-core.cjs` | 纯逻辑核心（命名规则、porcelain 解析、路径包含、范围分类），无副作用、可单测 |
| `scripts/validate-workspace.mjs` | D-1~D-10 只读校验器；支持 `--json` / `--warn-only` / `--repo <path>` |
| `scripts/test/workspace-convention-core.test.mjs` | core 单测 12 例（含「同级目录不算嵌套」「相邻容器不算嵌套」「旧式 `-01` 结尾非法」等边界） |
| `CHANGELOG.md` | 变更日志（交付事件唯一存放位置） |
| `docs/design/decisions/README.md` + `0001-workspace-directory-convention.md` | 决策记录骨架 + 首条 ADR（记录本约定 8 项决定与 6 项被否决备选） |
| `package.json` | 新增 `npm run validate:workspace` |

校验器铁律：**全程只读**——只调用 git 只读子命令与本地读取，不做删除、移动、prune、`worktree remove`。

范围分类：**治理区**（人工/脚本创建，强制）与**例外区**（外部运行时/编辑器创建，计警告不计失败），对应模板 §1.10。

### 11.2 实时违规基线（首次运行，2026-09-12）

工作区登记 31 条（含主检出）／链接工作区 30 个；**失败 7 项 + 警告 2 项**，退出码 1。

| 编号 | 结果 | 违规 |
|---|---|---|
| D-1a 禁止嵌套 | ✅ 通过 | 无嵌套（09-12 清掉孤儿登记后未复发） |
| D-1b 不得位于仓库内 | ❌ 8 项 | `.scratch/worktrees/` 下全部 8 个工作区 → 待 P2/B5 迁移到相邻容器 |
| D-2 目录名 = 分支名 | ✅ 治理区通过／⚠️ 例外区 22 项 | 例外区目录名多为 `source`（运行时约定），属接口约定待治理 |
| D-3 分支名派生规则 | ❌ 3 项 | `dev-cwf-131-01`、`dev-cwf-80-01`（旧式 `-01` 结尾）、`dev-night-w2-01-verify` |
| D-4 工作区内无过程产物目录 | ❌ 8 项 | 8 个工作区内部各有一份 `.agent-runs/` |
| D-5 运行目录命名 | ❌ 14 项 | `cwf-*`（旧式）、`uat-*`（无任务归属）、`task`、`env-store`、`schema` |
| D-6 无漏网入库 | ❌ 5 项 | 决策三的 5 个文件（`.scratch/dsh-visual-workflow-p0/`、`p2/`） |
| D-7 终态任务已清理 | ❌ 3 项 | LOC-011、LOC-012、LOC-015 已合并但工作区仍在 → 待 B8 |
| D-8 归档完整性 | ❌ 1 项 + ⚠️ 6 项 | 🔴 **LOC-001 规格既不在 `archive/` 也不在 `specs/`**；另 6 个仅在 `specs/`（决策五方案甲待执行） |
| D-9 无超期证据残留 | ➖ 未启用 | 登记册尚无 `evidence_expires_at` 字段 |
| D-10 收口口径一致 | ➖ 未启用 | 登记册尚无 `branch_retained` 字段 |

**该基线就是存量收敛的待办清单**：D-1b/D-3/D-4/D-5 → P2 与 B5；D-6/D-8 及 P5；D-7 → B8；D-9/D-10 字段 → P1 ③。

### 11.3 仍待做

| 项 | 内容 | 阻塞 |
|---|---|---|
| P1 ③ | 登记册加 `evidence_expires_at` / `evidence_cleared_at` / `branch_retained` 三字段，并让 `local-task-registry.mjs` 支持读写 | 🟡 改共享文件，需无并发写入窗口（B6 曾被并发脚本覆盖） |
| P2 | 脚本改造：锚定主检出、切相邻容器、创建入口收敛、收口命令补齐、到期清理函数 | 🟡 触及在制工作流依赖的脚本 |
| 校验接入 | 待存量收敛后，把 `validate:workspace` 接入 `npm run validate` 阻断路径 | 依赖 D-1b~D-8 清零 |

---

## 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-12 | 实例化说明 v1.0 | 从原合并文档中拆出 workflow-manager 特有内容：占位符取值、实际创建/回收链路（含 runbook 出处）、五项决策（新增归档位置决策五=方案甲）、四次盘点基线、体量异常定位、逐项处置表、B0–B9 批次、归档缺口、命名修正映射、待改造文件、开放项 |
| 2026-09-12 | 实例化说明 v1.1 | 新增 §11：P1 已落地产物（core + 校验器 + 单测 + 变更日志 + 决策记录）、首次运行的实时违规基线（7 失败 / 2 警告）、仍待做项与阻塞原因 |
