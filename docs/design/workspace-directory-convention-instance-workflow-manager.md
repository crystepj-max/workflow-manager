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
| **LOC-001** | 规格**仅存在**于 `.scratch/LOC-001-edge-outcome-ui/`：`task-spec-V1.md`、`task-spec-V2.md`、`definition-check.md`、`definition-check-V2.md`（共 32 KB） | ✅ **已解决（2026-09-12）**：已补归档到 `docs/tasks/archive/LOC-001/`（任务卡 + 规格 V1/V2 全版本 + 定义检查 + 证据摘要），逐文件校验一致 |
| LOC-011 / LOC-012 | 已于 09-12 由并发会话收口归档（`archive/LOC-011/`、`archive/LOC-012/` 已存在） | ✅ 已解决 |
| LOC-010 | 状态「已取消」，但**有完整 Run 证据链**（21 文件，a1–a3 三轮）与规格 V1 | ✅ **已解决（2026-09-12）**：补归档任务卡 + 规格 + 证据摘要。摘要记录的是一次**唯一的人工 `reject` 裁决**（审查 approve / 测试 pass，但产品经理驳回 → 任务取消）——这类「为什么没做」的记录与「做了什么」同等重要 |

> 🔴 **规格生成源位于临时区**：夜批产物 `.scratch/night-batches/<批次>/<TASK_ID>/task-spec-V*.md` 是任务规格的**生成源**，而 `.scratch/` 属过程产物（收口即删）。已核实 LOC-011/012 的夜批版与归档版内容一致（说明收口归档正确），但 LOC-010 的规格此前**仅存在于夜批目录**。该结构意味着「规格唯一副本躺在临时区」的风险持续存在 → 治理项见 §11.4。

> 🔴 注意：LOC-001 是最早期任务，从未纳入归档流程——印证通用模板 Part 3 §3.4 的提醒：**不能假定「已合并 = 已归档」**，必须逐个核对。

### 7.2 归档位置统一（决策五 = 方案甲）

✅ **已执行（2026-09-12）**。

执行前两处并存：

| 位置 | 内容（执行前） |
|---|---|
| `docs/tasks/specs/<TASK_ID>-<slug>/` | LOC-002、003、004、005、006、007、013、015 |
| `docs/tasks/archive/<TASK_ID>/` | LOC-008、009、011、012、013、015 |

**执行结果**：

| 动作 | 结果 |
|---|---|
| `specs/` 内容并入 `archive/<TASK_ID>/` | 17 个文件迁移，逐文件校验一致 |
| 补齐早期任务任务卡 | LOC-002..007 各补任务卡（PR #8 当年只迁了 specs，未迁任务卡） |
| 补齐归档三件套第三件 | 13 个已合并任务全部生成 `evidence-summary.json` |
| 删除 `docs/tasks/specs/` | ✅ 已移除（删除前守卫：0 缺失） |
| 登记册 `spec_path` 改指 `archive/` | LOC-013、LOC-015 已更新 |
| 校验器 D-8 升级 | 从「2 件」升为「三件套」，并新增「`specs/` 不得残留」告警 |

统一后的唯一归档位置为 `docs/tasks/archive/<TASK_ID>/`，`docs/tasks/specs/` **废弃**。当前 archive 覆盖 LOC-001..009、011..013、015（LOC-010 为已取消任务，无规格，可接受）。

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
| `scripts/local-task-merge.mjs` | 归档从 2 件扩展为 3 件（第三件可**直接调用**已落地的 `workspace-evidence-summary.mjs`，见下）；归档目标统一 `docs/tasks/archive/`；末尾追加 `git worktree prune` |
| `scripts/local-task-registry.mjs` | 支持 `evidence_expires_at` / `evidence_cleared_at` / `branch_retained` |
| 新增 `scripts/task-runs-cleanup.mjs` | 到期清理：扫登记册 → 校验摘要存在 → 删明细 |
| 新增 `scripts/validate-workspace.mjs` | ✅ **已落地（2026-09-12）**：D-1~D-10 校验（尚未并入 `validate.mjs` 阻断路径） |
| 新增 `scripts/workspace-convention-core.cjs` | ✅ **已落地**：命名规则 / porcelain 解析 / 路径判定 / 范围分类（纯逻辑，可单测） |
| 新增 `scripts/workspace-evidence-summary.mjs` | ✅ **已落地**：生成归档三件套之第三件 `evidence-summary.json`；支持 `--no-run-evidence` 降级早期任务 |
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
| `scripts/workspace-evidence-summary.mjs` | 归档三件套之第三件生成器；从 `.agent-runs/<run-id>/` 抽裁决与各阶段结论写入 `archive/<TASK_ID>/evidence-summary.json`；早期无证据任务走 `--no-run-evidence` 降级（标注 `no_run_evidence`，不伪造证据） |
| `CHANGELOG.md` | 变更日志（交付事件唯一存放位置） |
| `docs/design/decisions/README.md` + `0001-workspace-directory-convention.md` | 决策记录骨架 + 首条 ADR（记录本约定 8 项决定与 6 项被否决备选） |
| `package.json` | 新增 `npm run validate:workspace` |

校验器铁律：**全程只读**——只调用 git 只读子命令与本地读取，不做删除、移动、prune、`worktree remove`。

范围分类：**治理区**（人工/脚本创建，强制）与**例外区**（外部运行时/编辑器创建，计警告不计失败），对应模板 §1.10。

### 11.2 实时违规基线

**首次运行（P1 落地时）**：工作区登记 31 条（含主检出）／链接工作区 30 个；失败 7 项 + 警告 2 项。

**最终基线（2026-09-13，全案落地后）**：工作树 **20 条**（主检出 + 19 个运行时/编辑器工作区）；**11 项检查全部通过**，唯一保留项为例外区接口约定警告（按 §1.10 属 per-agent 适配段责任）。`npm run validate` 已串联本校验作为阻断闸门。

| 编号 | 首次 | 最终 | 说明 |
|---|---|---|---|
| D-1a 禁止嵌套 | ✅ 通过 | ✅ 通过 | P2 后工作树建在仓库外，结构上不可能再嵌套 |
| D-1b 不得位于仓库内 | ❌ 8 项 | ✅ **通过** | `.scratch/worktrees/` 已清空；新工作树由 workspace-paths 落相邻容器 |
| D-2 目录名 = 分支名 | ⚠️ 例外区 22 项 | ⚠️ 例外区 | 例外区目录名多为 `source`（运行时约定），属接口约定待治理 |
| D-3 分支名派生规则 | ❌ 3 项 | ✅ **通过** | 3 个旧式命名分支随工作树收口治理 |
| D-4 工作区内无过程产物目录 | ❌ 8 项 | ✅ **通过** | 产物锚定主检出（P2），工作树不再是产物落点 |
| D-5 运行目录命名 | ❌ 14 项 | ✅ **通过** | CWF 轨道重命名 `-01`→`-r1`；收口拆分目录并入主 Run；无归属遗留入回收区；机制目录（schema/env-store）豁免 |
| D-6 无漏网入库 | ❌ 5 项 | ✅ **通过** | 决策三执行：2 件迁入 `docs/design/vwf-p2/`、3 件移除跟踪 |
| D-7 终态任务已清理 | ❌ 3 项 | ✅ **通过** | LOC-011/012/015/017 及三个待判定工作树全部收口 |
| D-8 归档完整性 | ❌ 1 项 + ⚠️ 6 项 | ✅ **通过** | 14 个已合并任务三件套齐备 |
| D-9 无超期证据残留 | ➖ 未启用 | ✅ **通过**（已启用 8 条） | 登记册 `evidence_expires_at` 落地，最早到期 09-18 |
| D-10 收口口径一致 | ➖ 未启用 | ✅ **通过**（已启用 13 条） | `branch_retained` 与实际分支逐一核对一致 |

### 11.3 已完成批次（存量收敛，2026-09-12）

| 批次 | 内容 | 结果 |
|---|---|---|
| B0 | `git worktree prune` 清孤儿登记 | ✅ 清掉 `dev-itest-a-01` |
| B0.5 | 补归档 `dev-loc-010-r1` 证据（21 文件，此前未归档） | ✅ 源计数 = 归档计数 |
| B1 | 删 5 个终态工作树 | ✅ 回收 177 MB；5 个分支全部保留 |
| B3 | 删 `.scratch/ws-isolation-tests` 等 | ✅ 回收 11 MB；另 4 个目标已被并发会话清除（非本次） |
| B6 | 登记册悬空引用修正 | ✅ LOC-002 置 `null`（首次修改曾被并发脚本覆盖，本次重做） |
| **B8** | **收口 LOC-011/012/015 三个已合并任务** | ✅ 归档 Run 证据（9+9+25 文件）→ 生成证据摘要 → 删工作树 → `prune` 兜底；分支保留 |
| **决策五** | **归档位置统一到 `archive/<TASK_ID>/`** | ✅ 17 文件迁移、补 6 个任务卡、13 个摘要、删除 `specs/` |
| **LOC-001** | **归档缺口补救** | ✅ 5 文件入库（任务卡 + 规格全版本 + 定义检查 + 摘要） |
| **LOC-010** | **归档缺口补救（已取消任务）** | ✅ 补任务卡 + 规格 V1 + 证据摘要（记录唯一一次 `reject` 裁决） |

累计效果（批次 A 止）：工作区 31 → 24 条；`.scratch/` 1.7 GB → 98 MB。

### 11.3.2 批次 B（2026-09-12 深夜–09-13，全案落地）

| 批次 | 内容 | 结果 |
|---|---|---|
| **LOC-017** | **合并 + 完整收口** | ✅ `f592902`（tag `task/loc-017/v2`）；证据 11 文件归档 → 摘要 → 删工作树留分支 → prune |
| **P1 ③** | 登记册三字段 + 到期计算 | ✅ `aa7cb29`；18 任务全部补齐；D-9（8 条）/D-10（13 条）转实际判定；🔴 D-10 首跑即揪出 5 个早期分支「标记保留但已不存在」的登记失真 |
| **决策三** | 3 移跟踪 + 2 迁入 | ✅ `9fc9232`；`git ls-files .scratch` 归零；D-6 转通过 |
| **B2** | `ws-cwf-159-01` 指针错乱目录 | ✅ 核实 `.git/worktrees/source` 实为 `ws-uat-lr-01` 正当使用、本目录是残留副本且 artifacts 为空 → 移入 `~/.dsh/.trash/`（可逆） |
| **P2** | 路径解析单一入口 + 创建锚定 + 收口补齐 + 到期清理 | ✅ `6f9b76b` + `9dac09e`（runbook/closeout 同步）；新增 `workspace-paths.mjs`（唯一入口）、`task-runs-cleanup.mjs`（默认只读预演）；`cwf-run-init` 工作树落相邻容器、产物落主检出——**嵌套在结构上不可能再发生**；`local-task-merge` 归档三件套 + prune 兜底 |
| **三个待判定工作树** | dev-cwf-131-01 / dev-cwf-80-01 / dev-night-w2-01-verify | ✅ 逐一核实内容已在 main（`391e620`/`9586a51`/各 LOC 任务）后收口；`cwf-131-01` 证据 22 文件补归档；`dev-cwf-80-01` 的未提交 host.js 改动核实已在 main 后 `--force` 删除 |
| **批次 B（D-5 清零）** | `.agent-runs` 18 项违规归位 | ✅ `dfff0f8`；CWF 轨道 `-01`→`-r1` 重命名、loc-013 拆分目录并入主 Run、无归属遗留入回收区、机制目录豁免 |
| **B7** | 分支治理 50 → 28 | ✅ 删 22 个（领先 0 或内容已核实进 main 或远端 `mirror/*` 有备份）；保留 main + 8 个 `branch_retained=true`；19 个 `vwf/run/*` 等被运行时工作树占用 → 随 B4 由运行时流程处理 |
| **校验接入** | `validate:workspace` 并入 `npm run validate` 阻断路径 | ✅ D 项全绿后接入；生成物过期由 `npm run generate` 重建后全绿 |

**最终状态**：工作树 **31 → 20 条**（治理区归零，剩余全部为运行时/编辑器例外区）；`.scratch/` **1.7 GB → 1.7 MB**；本地分支 **50 → 28**；**11 项校验全部通过**，`npm run validate` 含工作区闸门。

### 11.4 仍待做

| 项 | 内容 | 阻塞 |
|---|---|---|
| B4 | 19 个运行时工作区（`ws-*`）与其占用的 `vwf/run/*` 分支回收 | 用户决定：等运行时任务完成，由运行时自己的流程回收（#185 机制） |
| 夜批规格生成源位置 | `.scratch/night-batches/<批次>/<TASK_ID>/task-spec-V*.md` 是规格生成源却位于临时区 → 应改写为直接落主检出归档位置 | 触及夜批脚本 |
| 托管恢复后阶段二收口 | 8 个保留分支补登 PR 后，按 `branch_retained` 逐个删分支 | 等外部托管恢复 |
| 例外区治理 | `ws-*/source` 目录名不等于分支名（D-2 的 22 项警告） | per-agent 适配段，由插件使用者按 §1.10 接口约定解决 |

---

## 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-12 | 实例化说明 v1.0 | 从原合并文档中拆出 workflow-manager 特有内容：占位符取值、实际创建/回收链路（含 runbook 出处）、五项决策（新增归档位置决策五=方案甲）、四次盘点基线、体量异常定位、逐项处置表、B0–B9 批次、归档缺口、命名修正映射、待改造文件、开放项 |
| 2026-09-12 | 实例化说明 v1.1 | 新增 §11：P1 已落地产物（core + 校验器 + 单测 + 变更日志 + 决策记录）、首次运行的实时违规基线（7 失败 / 2 警告）、仍待做项与阻塞原因 |
| 2026-09-12 | 实例化说明 v1.2 | 存量收敛批次 A 完成：B8 收口 LOC-011/012/015、决策五归档统一（删除 `specs/`）、LOC-001 归档缺口补救、新增证据摘要生成器。§7.1/§7.2 标为已解决并记录执行结果；§9 更新已落地脚本；§11.1 补新脚本；§11.2 更新基线（失败 7→5，D-7/D-8 转通过）；§11.3 改为已完成批次，§11.4 为仍待做 |
| 2026-09-13 | 实例化说明 v1.3（**全案落地**） | LOC-017 合并收口；P1 ③（登记册三字段，D-9/D-10 启用）；决策三执行；B2 处理；P2 全量落地（workspace-paths 单一入口、创建锚定主检出、工作树移出仓库、收口三件套 + prune、到期清理器、runbook/closeout 指令同步）；三个待判定工作树逐一核实后收口；批次 B 清零 D-5；B7 分支治理 50→28；`validate:workspace` 接入 `npm run validate` 阻断路径。§11.2 更新为最终基线（11 项全过），§11.3 拆分批次 A/B，§11.4 仅剩 4 项外部依赖项 |
