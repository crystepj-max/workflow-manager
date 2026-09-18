# 工作区收敛扫描报告（P3 · 只读）

> **性质：只读扫描报告。** 本次未删除、未移动、未改名任何文件；未执行 `git worktree remove` / `prune` / `branch -d`。
> 所有处置建议均待人工确认后分批执行。约定依据：`docs/design/workspace-directory-convention.md`（草案 v1）。
> 扫描时间：2026-09-12 11:13（GMT+8）。扫描时仓库 `main` HEAD = `77abee8`。

---

## 1. 结论摘要

| 指标 | 数值 |
|---|---|
| `git worktree list` 条目数 | **30**（= 29 个链接工作树 + 主检出；其中 1 个为孤儿登记） |
| 工作树分布在 | **5 个根目录** |
| 磁盘可回收（本仓库内，可安全执行） | **约 191 MB** |
| 磁盘可回收（含运行时与其他，需相应责任方执行） | **约 250 MB** |
| 需优先处理的异常 | **2 项**（孤儿登记、指针错乱目录） |
| 建议动作 | 删 5 个工作树 + 1 次 `prune` + 3 处数据卫生修正 |

> 计数口径：2026-09-11 快照为 29 条（28 个链接工作树 + 主检出）；本次扫描 30 条。`.git/worktrees/` 登记目录数始终等于链接工作树数，可交叉验证。
>
> **执行状态：B0 与 B1 已执行完毕（2026-09-12 12:52），另新增一步 B0.5 补归档。结果见 §9。**

**与 09-11 快照的差异：**

- `dev-cwf-185-01` 及其嵌套的 `dev-itest-a-01` 工作树已消失（收口时注销，见 §6）。
- 新增 4 个工作树：`dev-loc-013-r1`、`dev-loc-015-r1`、`dev-loc-017-r1`、`dev-night-w2-01-verify`。
- 已消失：`dev-loc-005-r1`、`dev-projection-converge-01`。
- 任务状态变化：LOC-010 由「等待验收」→ **已取消**；LOC-011/012/013/017 → 等待验收；LOC-015 → 交付中。
- `docs/tasks/specs/` 新增（main 上 PR #8 将 LOC-002..007、LOC-015 的规格归档入库，用于「解除 worktree 悬挂引用」）。

---

## 2. 工作树逐项清单

「已入 main」判定用登记册的 `merge.commit` 是否在 main 中，**不用分支祖先关系**——实测该仓库使用 squash 合并（合并提交父数=1），分支祖先判定会误报。实测：`03e8b4dc`(LOC-008) 与 `c94acf9e`(LOC-009) 两个合并提交**均在 main**，但其分支仍「领先 main 5 / 4 提交」（即被 squash 吸收的原始提交）。

### 2.1 ✅ 建议删除（5 个）——内容已安全，且当前无未提交改动

| 路径 | 分支 | 归属 | 依据 | 体量 |
|---|---|---|---|---|
| `.scratch/worktrees/dev-loc-008-r1` | `dev-loc-008-r1` | LOC-008 | 登记册「已合并」，`03e8b4dc` 在 main | 44 MB |
| `.scratch/worktrees/dev-loc-009-r1` | `dev-loc-009-r1` | LOC-009 | 登记册「已合并」，`c94acf9e` 在 main | 44 MB |
| `.scratch/worktrees/cwf-80-verify` | `dev-cwf-80-01-r2` | #80 | 领先 main 0 提交（已完全合入） | 43 MB |
| `.scratch/worktrees/dev-cwf-74-01` | `dev-cwf-74-01` | #74 | 领先 main 0 提交（已完全合入） | 41 MB |
| `.scratch/worktrees/dev-loc-010-r1` | `dev-loc-010-r1` | LOC-010 | 登记册状态 = **已取消** | 5.8 MB |
| **小计** | | | | **约 178 MB** |

🟡 两点提示：

- `dev-cwf-74-01` 有 **1 个未跟踪文件** `package-lock.json`（`??`，非修改）。未跟踪文件不属有效产出，但删除前请确认无需保留。
- `dev-loc-010-r1` 虽为「已取消」，**分支仍建议按决策四保留**（暂停期口径），仅删工作树。

### 2.2 ⏸ 建议保留（5 个）——任务进行中

| 路径 | 分支 | 归属与状态 | 体量 |
|---|---|---|---|
| `.scratch/worktrees/dev-loc-013-r1` | `dev-loc-013-r1` | LOC-013 等待验收 | 44 MB |
| `.scratch/worktrees/dev-loc-015-r1` | `dev-loc-015-r1` | LOC-015 交付中 | 6.1 MB |
| `.scratch/worktrees/dev-loc-017-r1` | `dev-loc-017-r1` | LOC-017 等待验收 | 6.1 MB |
| `.scratch/worktrees/dev-loc-011-r1` | `dev-loc-011-r1` | LOC-011 等待验收 | 5.8 MB |
| `.scratch/worktrees/dev-loc-012-r1` | `dev-loc-012-r1` | LOC-012 等待验收 | 5.8 MB |
| **小计** | | | **约 68 MB** |

> 这 5 个是 **决策一（A2）迁移的真实对象**：建议**先删除 §2.1 的 5 个终态工作树，再把这 5 个进行中的迁到 `../workflow-manager-worktrees/`**，避免迁移即将被删除的目录。

### 2.3 ⏸ 保留（1 个）——编辑器占用中

| 路径 | 分支 | 说明 | 体量 |
|---|---|---|---|
| `~/.cursor/worktrees/workflow-manager/hplt` | `feat/vwf-editor-slim-oneclick` | 领先 main 3 提交；有 1 个未跟踪文件 `package-lock.json` | 40 MB |

> 位于编辑器自己的 worktree 根，且有独有提交。本约定 §3.7 的例外条款适用：不属人工约定管辖，但应纳入巡检。

### 2.4 ⏸ 外部运行时（13 个）——建议由运行时侧回收

| 分组 | 数量 | 分支 | 状态 | 体量 |
|---|---|---|---|---|
| `~/.dsh-workflow-dev/workspaces/ws-*/source` | 7 | `vwf/run/*` | 全部「领先 main 0 提交」= 已合入，0 未提交改动 | 约 28 MB |
| `~/.dsh/workspaces/ws-*/source` | 6 | `vwf/run/*` | 同上 | 约 25 MB |

**全部 13 个均为终态**（内容已在 main，无未提交改动），且最后活动时间均在 **2026-09-05 ~ 09-10**，距今 2–7 天，无活跃使用迹象。

> 处置路径：这些由 DSH 运行时通过 `scripts/workspace-isolation.mjs`（`removeGitWorktree` + `git worktree prune`，第 778–785 行）管理。建议**由运行时的工作区销毁流程回收，而非手工删除**，否则会绕过其登记注销逻辑。

---

## 3. 🔴 异常项（需优先处理）

### 3.1 孤儿工作树登记：`dev-itest-a-01`

`git worktree prune --dry-run` 唯一命中项：

```
Removing worktrees/dev-itest-a-01: gitdir file points to non-existent location
```

**成因**：该工作树原位于 `.scratch/worktrees/dev-cwf-185-01/.scratch/worktrees/dev-itest-a-01`（即嵌套现场）。其父工作树 `dev-cwf-185-01` 于 09-11 收口时被正规注销，子路径随之消失，但**子登记未一并注销**，成为孤儿。

**影响**：`git worktree list` 会输出一个指向不存在路径的死条目；无数据风险。
**建议**：`git worktree prune`（幂等、只清理失效登记）。

### 3.2 🔴 指针错乱目录：`~/.dsh/workspaces/ws-cwf-159-01/source`

**实测证据（指向矛盾）：**

| 文件 | 内容 |
|---|---|
| `~/.dsh/workspaces/ws-cwf-159-01/source/.git` | `gitdir: /Users/chris/workspace/workflow-manager/.git/worktrees/source` |
| `/Users/chris/workspace/workflow-manager/.git/worktrees/source/gitdir` | `/Users/chris/.dsh-workflow-dev/workspaces/ws-uat-lr-01/source/.git` |

即：`ws-cwf-159-01/source` 的 `.git` 指向了**属于另一个工作树（`ws-uat-lr-01`）的管理目录**，而它自己**不在** `git worktree list` 中。

**危害**：在该目录内执行任何 git 命令，都会以 `ws-uat-lr-01` 的身份操作其索引与 HEAD——可能造成**静默覆盖他人工作区的暂存区**。

**其他特征**：最后修改 `2026-09-05 11:22`（7 天前）；含完整工作区结构（`artifacts/ build/ cache/ source/ tmp/ workers/`）；`source/.scratch` 存在但无 `.agent-runs`。

**建议**：判定为**残留副本，非有效工作树**，建议整体删除 `~/.dsh/workspaces/ws-cwf-159-01/`。执行前需人工确认其中 `artifacts/` 无独有产出。

### 3.3 数据卫生：登记册悬空引用与未启用字段

| 问题 | 证据 | 建议 |
|---|---|---|
| 悬空 `worktree` 引用 | `registry.json` 中 LOC-002 的 `worktree = dev-projection-converge-01`，该工作树已不存在 | 置空 |
| `runs` 字段 18/18 全为 `[]` | 但 `.agent-runs/` 下实有 16 个运行目录 | 启用该字段，或明确废弃该字段 |
| 新增字段缺位 | §3.5.3 要求的 `evidence_expires_at` / `evidence_cleared_at` / `branch_retained` 尚未存在 | P1 阶段补 |

---

## 4. 非工作树残留（`.scratch/` 内，工作树之外）

`.scratch/` 共 348 MB，其中工作树 335 MB，其余 **约 13 MB**：

| 路径 | 体量 | 判定 |
|---|---|---|
| `.scratch/ws-isolation-tests/` | 11 MB | 工作区隔离测试夹具，可重生成 → 可删 |
| `.scratch/uat-loc015-demo/` | 624 KB | LOC-015 UAT 演示产物，任务交付中 → 保留 |
| `.scratch/probe-verify/` | 248 KB | 探针验证残留 → 待确认 |
| `.scratch/night-batches/` | 112 KB | 夜间批次产物 → 待确认 |
| `.scratch/LOC-017-integration-gate/` | 44 KB | LOC-017 进行中 → 保留 |
| `.scratch/dsh-visual-workflow-p0/` | 36 KB | 决策三：3 个已入库文件移除跟踪 |
| `.scratch/LOC-001-edge-outcome-ui/` | 32 KB | LOC-001 已合并 → 可删 |
| `.scratch/ai-task-env-store/` | 28 KB | 环境存储 → 待确认 |
| `.scratch/dsh-visual-workflow-p2/` | 20 KB | 决策三：2 个文件迁入 `docs/design/vwf-p2/` |
| `.scratch/LOC-013-explore-template/`、`.scratch/loc013-uat/` | 各 20 KB | LOC-013 进行中 → 保留 |
| 其余约 10 个小型目录 | 合计 < 100 KB | 逐项判定 |

`.agent-runs/` 共约 **1.6 MB**，16 个运行目录。按新约定将收敛为 `.task-runs/<TASK_ID>/<RUN_ID>/`；其中 `cwf-185-01`（192 KB）对应任务第二阶段未开工，建议随分支一并保留。

---

## 5. 分支层面的待清项（无工作树或已同步）

按决策四，**暂停期只删工作树、保留分支**。但以下分支已无补 PR 价值或已完全同步，属可选清理：

| 分支 | 领先 main | 说明 |
|---|---|---|
| `cnb/loc-008-closeout` | 0 | 已同步，可删 |
| `feat/ai-task-define-m1` / `deliver-m2` / `execution-plan-m3` / `scheduled-m4` / `workspace-env` | 0 | 5 个已同步里程碑分支，可删 |
| `dev-cwf-74-01`、`dev-cwf-80-01-r2` | 0 | 内容已在 main，工作树拟删 |
| `codex/vwf-layout-core`(1)、`cursor/c49da66c`(2)、`feat/dev-#79`(1)、`feat/vwf-two-level-seq`(2)、`featrue/streamline-host&client`(2)、`sync-176`(6)、`sync-main-176`(5) | >0 | 有独有提交，**需人工确认归属后再决定** |
| `dev-cwf-185-01` | 5 | 任务第二阶段待开工 → **保留** |

🟡 注意：当前仓库有 **40 个分支**，其中约 20 个已无对应工作树。分支治理应作为独立议题，不与本次工作树收敛混做。

---

## 6. `dev-cwf-185-01` 与嵌套现场：收口核实结论

| 核实点 | 结论 | 证据 |
|---|---|---|
| 是否为正规注销 | ✅ 是 | `.git/worktrees/dev-cwf-185-01/gitdir` 不存在；同探针在 `dev-cwf-131-01` 上有效（文件存在） |
| 子工作树登记是否一并注销 | ❌ **未一并注销** | `dev-itest-a-01` 仍登记且指向不存在路径 → 见 §3.1 |
| 分支是否保留 | ✅ 保留（有意） | `dev-cwf-185-01` 分支仍在；任务需求分两阶段，当前仅完成第一阶段 |
| 规则出处 | — | `dsh/roles/closeout.md` 第 5 条「合并后用 `git worktree remove` 原子清理」 |
| #185 成果是否进 main | ❌ 未进 | 另一分支正在处理，本约定**不应依赖其实现** |

**对本约定的影响**：本案例恰好验证了 §3.5.1 的两阶段口径——**工作区（可再生）已删除、分支（不可再生）已保留**，符合暂停期正确行为。但暴露了一个收口流程缺口：**删除父工作树时未级联注销其内部嵌套的子登记**，残留孤儿（§3.1）。建议在收口命令中固定追加 `git worktree prune`。

---

## 7. 建议执行顺序（需人工确认，分批）

| 批 | 动作 | 风险 | 可回收 |
|---|---|---|---|
| **B0** | `git worktree prune`（清 §3.1 孤儿登记） | 无（幂等） | — | ✅ **已执行** |
| **B0.5** | 补归档 `dev-loc-010-r1` 的证据到主检出（扫描前置校验发现其未归档） | 低（复制，不删除源） | — | ✅ **已执行** |
| **B1** | 删 §2.1 的 5 个终态工作树（`git worktree remove`，勿用 `rm -rf`） | 低；建议先确认 `dev-cwf-74-01` 的未跟踪文件 | 178 MB | ✅ **已执行**（实收 177 MB） |
| **B2** | 处理 `~/.dsh/workspaces/ws-cwf-159-01/`（§3.2，指针错乱残留） | 🟡 中；需先确认 `artifacts/` 无独有产出 | 3.6 MB |
| **B3** | 清 `.scratch/ws-isolation-tests/`（11 MB）与 LOC-001 残留（32 KB） | 低（可重生成） | 11 MB |
| **B4** | 触发 DSH 运行时回收 13 个终态运行时工作区（§2.4） | 🟡 中；应由运行时流程执行 | 约 53 MB |
| **B5** | 把 §2.2 的 5 个进行中工作树迁到 `../workflow-manager-worktrees/`（决策一 A2） | 中；属 P2 改造，建议脚本化 | — |
| **B6** | 数据卫生修正（§3.3：悬空引用、`runs` 字段） | 低 | — |
| **B7** | 分支治理（§5）作为独立议题 | — | — |

**硬性前置条件**（每批执行前）：

1. 再次确认目标工作树 `git status --porcelain` 为空（或未跟踪文件已确认无需保留）；
2. 删除用 `git worktree remove <路径>`；被拒时**先查明原因**，不直接升级到 `--force`；
3. 每批执行后立即 `git worktree list` 复核，确认登记数与磁盘一致；
4. 每批最多 5 个目标，逐批确认后再进行下一批。

---

## 8. 本次**扫描阶段**未做的事

以下描述的是扫描阶段（2026-09-12 11:13 前）的状态。扫描完成后经人工确认，B0/B0.5/B1 已执行，见 §9。

- 未删除 / 未移动 / 未改名任何文件或目录。
- 未执行 `git worktree remove`、`git worktree prune`（仅 `--dry-run`）、`git branch -d`。
- 未触碰 DSH 运行时工作区（仅读数）。
- 未修改 `registry.json`。
- 未提交任何变更。

---

## 9. 执行记录（B0 / B0.5 / B1，2026-09-12 12:52）

### 9.1 前置校验的一个发现

按「删除前确认无未归档内容」核对 5 个目标工作树内部的 `.agent-runs/`，发现**一处归档缺口**：

| 工作树 | 内部 `.agent-runs/` | 主检出是否已归档 | 结论 |
|---|---|---|---|
| `dev-loc-008-r1` | `loc-008-r1`、`schema` | ✅ 是 | 可删 |
| `dev-loc-009-r1` | `loc-009-r1`、`schema` | ✅ 是 | 可删 |
| `cwf-80-verify` | `cwf-80-01` + 15 个散落文件 | ✅ 是（15 个文件在主检出 `cwf-80-01/` 中逐一核对存在） | 可删 |
| `dev-cwf-74-01` | `cwf-74-01`、`schema` | ✅ 是 | 可删 |
| `dev-loc-010-r1` | `loc-010-r1`（21 个文件） | ❌ **否** | **必须先补归档** |

若不做这一步校验，`dev-loc-010-r1` 的 21 个证据文件（116 KB）会随工作树一并消失。

### 9.2 执行动作

| 步骤 | 动作 | 结果 |
|---|---|---|
| B0 | `git worktree prune` | ✅ 清除孤儿登记 `dev-itest-a-01`；复核 `--dry-run` 输出为空 |
| B0.5 | `cp -R .scratch/worktrees/dev-loc-010-r1/.agent-runs/loc-010-r1 .agent-runs/loc-010-r1` | ✅ 21 源文件 → 21 归档文件，数量一致 |
| B1 | `git worktree remove` × 4（`dev-loc-008-r1`、`dev-loc-009-r1`、`cwf-80-verify`、`dev-loc-010-r1`） | ✅ 全部一次成功 |
| B1 | `git worktree remove --force` × 1（`dev-cwf-74-01`） | ✅ 普通删除被拒（未跟踪 `package-lock.json`，可再生成），改用 `--force` |

### 9.3 执行后复核

| 检查项 | 结果 |
|---|---|
| `git worktree list` 条目数 | 30 → **24**（清 1 孤儿 + 删 5 工作树） |
| `git worktree prune --dry-run --verbose` | 空 → 无残留登记 |
| 分支是否按决策四保留 | ✅ 5 个分支**全部保留**：`dev-loc-008-r1`(e3ecb08)、`dev-loc-009-r1`(6dfcb65)、`dev-cwf-80-01-r2`(ee32f39)、`dev-cwf-74-01`(a30f579)、`dev-loc-010-r1`(3767454) |
| `.scratch/` 体量 | 348 MB → **171 MB**（回收 **177 MB**） |
| `.scratch/worktrees/` | 335 MB → **159 MB** |
| `.agent-runs/` 体量 | 1.6 MB（新增 `loc-010-r1` 归档） |
| 主检出工作区 | 仅 2 个本次新增的未跟踪文档；业务文件未受影响 |

### 9.4 执行后 `.scratch/worktrees/` 剩余（8 个）

`dev-cwf-131-01`、`dev-cwf-80-01`、`dev-loc-011-r1`、`dev-loc-012-r1`、`dev-loc-013-r1`、`dev-loc-015-r1`、`dev-loc-017-r1`、`dev-night-w2-01-verify`

其中 `dev-loc-011`/`012`/`013`/`015`/`017` 属 §2.2 的进行中工作树（保留）；`dev-cwf-131-01` 与 `dev-night-w2-01-verify` 属 §2.3/§2.4 的待判定项，仍需人工确认归属。

### 9.5 待继续的批次

**B2**（`ws-cwf-159-01` 指针错乱目录）、**B4**（运行时工作区回收，用户决定等任务完成后再处理）、**B5**（迁移进行中工作树到 A2 容器）、**B7**（分支治理）——均**未执行**，待逐批确认。

**B3**、**B6** 已于同日执行，见 §10。

---

## 10. 执行记录（B3 / B6，2026-09-12 12:56）

### 10.1 前置校验又发现一处归档缺口

按 §9.1 同一方法核对 `.scratch` 各残留目录是否已归档，发现 **3 个任务的规格从未入库**：

| 任务 | 残留位置 | `docs/tasks/specs/` | `docs/tasks/archive/` | 结论 |
|---|---|---|---|---|
| LOC-001 | `.scratch/LOC-001-edge-outcome-ui/`（4 个文件） | ❌ 无 | ❌ 无 | **不可删** |
| LOC-011 | `.scratch/LOC-011-task/task-spec-V1.md` | ❌ 无 | ❌ 无 | **不可删** |
| LOC-012 | `.scratch/LOC-012-task/task-spec-V1.md` | ❌ 无 | ❌ 无 | **不可删** |

`docs/tasks/specs/` 现有归档为 LOC-002/003/004/005/006/007/015（main 上 PR #8 迁入），**不含 LOC-001、008、009、011、012**；其中 008/009 的规格在 `docs/tasks/archive/` 内有副本，**001/011/012 三处则仅存在于 `.scratch`**。

→ 这三项**被保留、未删除**。它们需要的是「补归档到 `docs/tasks/specs/<任务卡同名目录>/`」，属内容变更（与决策三的 5 个文件同批，即约定文档 §6 的 **P5**），不在清理批次范围内。

### 10.2 B3 执行结果

| 目标 | 结果 |
|---|---|
| `.scratch/ws-isolation-tests/` | ✅ 已删（11 MB）。由 `scripts/test/workspace-isolation.test.mjs:24` 作为 `fixtureRoot` 在测试运行时重建，可安全再生成 |
| `.scratch/LOC-008-formal-records/` | ⚪ 执行时已不存在（规格已在 `docs/tasks/archive/LOC-008/`，删前守卫通过） |
| `.scratch/LOC-009-workspace/` | ⚪ 执行时已不存在（规格已在 `docs/tasks/archive/LOC-009/`，删前守卫通过） |
| `.scratch/LOC-011-optimize-template/`、`.scratch/LOC-012-diagnose-template/` | ⚪ 执行时已不存在（原为空目录） |
| **保留（未归档，见 §10.1）** | `.scratch/LOC-001-edge-outcome-ui/`(32 KB)、`.scratch/LOC-011-task/`(4 KB)、`.scratch/LOC-012-task/`(4 KB) |
| **保留（进行中或归属未定）** | `uat-loc015-demo`(624 KB，LOC-015 交付中)、`LOC-017-integration-gate`、`LOC-013-explore-template`、`loc013-uat`、`probe-verify`、`night-batches`、`logical-run-runtime`、`run-pause-guidance`、`task-env-coordination`、`preflight-probe`、`ai-task-env-store`、`vwf-pkg5`、`hd-outcome-control-reserved`、`compile-input-size-guard`、`routing-demo`、`dev-bug-repro`、`backlog` |
| **不属本批（决策三，P5）** | `.scratch/dsh-visual-workflow-p0/`、`.scratch/dsh-visual-workflow-p2/`（含已入库文件，删除会在版本控制中显示为删跟踪文件） |

**体量变化**：`.scratch/` 171 MB → **160 MB**（回收 11 MB）。

### 10.3 B6 执行结果

| 项 | 处理 |
|---|---|
| `registry.json` 中 `LOC-002.worktree = dev-projection-converge-01`（悬空引用，该工作树已不存在） | ✅ 已置为 `null`；JSON 合法性校验通过；diff 为 **1 行** |
| `runs` 字段 18/18 为空 | ⏸ **不动**。该字段应记录新约定的 `.task-runs/<TASK_ID>/<RUN_ID>/`，而现在填充只会写入即将作废的旧命名（如 `cwf-74-01`、`loc-008-r1`）。建议在 P2 落地后再启用；本报告记录该决定 |
| §3.5.3 所需新字段（`evidence_expires_at`、`evidence_cleared_at`、`branch_retained`） | ⏸ 未加。属 P1 schema 变更，不在数据卫生批次内 |
| `updated_at` | ⏸ 未改。本次是引用修正而非状态流转，避免与脚本写入的语义混淆 |

### 10.4 ⚠️ 并发作业发现

执行期间检测到**另一个会话正在同一工作区作业**，证据：

- `main` 在本次会话期间推进多次，扫描时 `77abee8` → 执行时 `755c695` → 执行后 `f126654`（`Merge cnb/main: 汇入「任务环境协调机制」（#185 / PR #10）`）。
- 新增备份分支 `cnb/backup/main-20260912-1250`。
- **4 个 `.scratch` 目标目录在本节执行前已被其清除**（§10.2 中标 ⚪ 者）——它们在前一次的列表检查中尚存在，数分钟后即消失。这部分**不是本次操作删除的**。
- 登记册状态也在期间变化：LOC-011/012 由「等待验收」变为**已合并**（`f08e9aed` / `ee3b04c6`）。

**影响与建议：**

1. 本次 B6 对 `registry.json` 的修改**尚未提交**，存在被并发会话的脚本重写覆盖的风险，需人工确认后再决定提交时机。
2. `dev-loc-011-r1`、`dev-loc-012-r1` 两个工作树因状态转为「已合并」，**已成为新的清理候选**（原列入 §2.2 保留），但不在本批批准范围内，未处理。
3. 后续批次（尤其 B5 迁移工作树）**应在无并发写入时执行**，否则「删除/迁移」与「另一会话正在使用」可能冲突。
