# 本地任务登记册（docs/tasks/）

> **迁移遗留（W8 起冻结）**：本目录是旧本地任务轨道的登记册与档案。迁移后的目标是
> **新任务的身份、状态、负责人与父子关系一律以 Multica Task 为唯一真源**；GitHub 只记录
> 代码交付事实（分支、提交、PR、Review、CI、合并）。本目录的 registry.json / BOARD.md /
> 任务卡与 archive 不再新增活跃任务条目，仅作为迁移前任务的历史证据与指针保留。
> 旧契约 `docs/design/ai-task-define-delivery/public-task-contract.md` §11 与
> `local-track-offline-mode.md` 属历史设计文档，不再描述当前的任务管理方式。

| 文件 | 用途 | 是否入库 |
|---|---|---|
| `registry.json` | 旧任务登记册（迁移遗留冻结存档，不再是活跃任务事实） | 是 |
| `LOC-<序号>-<slug>.md` | 旧任务卡（历史记录） | 是 |
| `archive/<任务标识>/` | 任务卡 + 对应版本规格的归档副本，随合并提交入库 | 是 |
| `BOARD.md` | 旧看板（迁移遗留冻结存档；重写命令已退役，勿手工编辑） | 是 |

## 旧命令状态（迁移遗留）

> 🔴 下列旧写入口已退役，**不得再用它们开新任务或改任务状态**。对应停写（fail-closed）
> 实现见 PR #356 / #357 / #358 / #359（WFM-157 / 158 / 162 / 166）；截至本文基线
> （2026-10-03，main=`861e5a0`）这些 PR 尚未进入 main，当前 main 上旧命令仍可运行——
> **在任何分支上都不应使用**，其输出不构成有效任务事实。导出函数与既有程序化调用者
> （registry-reconcile、remote-issue-sync、github-issues、local-task-merge、任务收口等）
> 不随 CLI 停写而改变，**registry.json / BOARD.md 并未整体只读**。

已退役的旧写入口（只留名称备查，不给调用方法）：

- `local-task-registry.mjs` 的 `allocate` / `set` / `mark-ready` / `board`：旧发号、登记、打施工标签、重写看板（停写见 PR #356）；
- `remote-issue-sync.mjs` 的 `apply` / `reissue`：旧 GitHub issue 批量建号与临时号换正式号（停写见 PR #357）；
- 旧 GitHub issue 施工认领与释放：`github-issues.mjs` 的 `claim` / `release`，以及 `cwf-run-init` 开工时的自动 claim（停写见 PR #359 / WFM-166）；
- `registry-reconcile.mjs` 的 `apply`：主干合并事实回写登记册（停写见 PR #358）；
- 旧定时触发 `ai-task-scheduled-trigger.mjs` 与 M5 夜间自动派发：已退役，不再基于旧账本无人值守派发（停写见 PR #355）。

仍有效的只读入口（仅查询，不写任何文件或远端）：

```bash
# 任务上下文门禁：规格与任务卡是否真的在仓库里、历史活跃任务是否有远端锚点（只读校验）
npm run validate:task-context

# 查询旧登记册存量条目 / 待同步 GitHub 的历史任务（只读）
node scripts/local-task-registry.mjs list --github-sync pending
node scripts/local-task-registry.mjs show --task LOC-001

# 预览旧 GitHub 同步差异，不建 issue（只读）
npm run sync:remote-issues -- plan

# 查询旧 ready 标签存量（只读）
node scripts/github-issues.mjs list-ready
```

仍保留的合并收口（产品职责不变）：

```bash
# 验收通过后合并回本地主干（一任务一提交；冲突自动中止）
# 人工 accept/conditional-pass 门禁、真实 Git merge、archive、Formal Records/Proof、
# 工作区安全检查与 DSH/Release 产品职责全部保留。
node scripts/local-task-merge.mjs --task LOC-001 --branch dev-loc-001-r1 --decision accept --run-id loc-001-r1 --mirror mirror
```

> 🟡 已知限制：`local-task-merge`（含 `--mirror`）仍会更新 registry.json / BOARD.md，
> 这是迁移期程序化写路径的既有行为，不代表旧账本恢复可用。

## 硬规则（存量口径，迁移遗留）

1. 本目录全部文件保持入库跟踪——已合并任务的来源、范围、状态在主干历史里永久可查；不再新增活跃任务条目；
2. **任务规格与任务卡一起入库**：历史规格在 `docs/tasks/specs/<任务标识>-<slug>/`，禁止移入被忽略目录；新任务的规格与任务材料按 Multica Task 流程管理，不再落入本地轨道；
3. 旧「活跃任务必须有远端（GitHub 主源）issue 号」规则已废止：新任务不开 GitHub 任务 issue，任务身份/状态/负责人以 Multica 为准，GitHub 只记录代码交付事实；
4. 旧「编号由远端（GitHub）发」规则已废止：新任务标识由 Multica 发放；存量 `FEAT/FIX/CHORE-<号>` 编号保持原样，不重编；
5. 旧施工信号标签（`ready-for-agent` 可施工 / `施工中` 已认领）冻结为历史证据：不再由工具补打或摘除，施工认领以 Multica 的 Task/Run 记录为准；
6. 本地主干只能由「任务合并」（local-task-merge）推进，禁止直接在主干上改动；
7. 已合并任务的**工作区由合并脚本自动删除、分支保留**（阶段一口径：工作区可再生，`git worktree add` 随时重建；分支不可再生，是补登 PR 的唯一载体）。

> 过渡说明：本文件描述的退役口径先于机器停写生效（依赖 PR #356/#357/#358/#359 合并）。
> 过渡期内「文档已退役、旧命令在 main 上仍可运行」属预期差异；依赖合并后应回读本文件逐句复核。
