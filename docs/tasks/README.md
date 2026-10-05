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

> 🔴 下列旧写入口已退役，**不得再用它们开新任务或改任务状态**。停写（fail-closed）已随
> PR #355 / #356 / #357 / #358 / #359 全部进入 main（2026-10-04 合并，main=`c9c08cb8`）：
> 这些 CLI 写命令现以非零退出拒绝，并输出稳定原因码（`legacy_registry_write_disabled` /
> `legacy_remote_issue_sync_disabled` / `legacy_github_issue_write_disabled` /
> `legacy_scheduler_disabled` / `legacy_dispatcher_disabled`），不再产生任何写入。
> 导出函数与既有程序化调用者（registry-reconcile、remote-issue-sync、github-issues、
> local-task-merge、任务收口等）不随 CLI 停写而改变，**registry.json / BOARD.md 并未整体只读**。

已退役的旧写入口（只留名称备查，不给调用方法）：

- `local-task-registry.mjs` 的 `allocate` / `set` / `mark-ready` / `board`：旧发号、登记、打施工标签、重写看板（PR #356，`legacy_registry_write_disabled`）；
- `remote-issue-sync.mjs` 的 `apply` / `reissue`：旧 GitHub issue 批量建号与临时号换正式号（PR #357，`legacy_remote_issue_sync_disabled`）；
- 旧 GitHub issue 施工认领、释放与补打可施工标签：`github-issues.mjs` 的 `claim` / `release` / `mark-ready`；`cwf-run-init` 开工时也不再自动 claim（PR #359，`legacy_github_issue_write_disabled`）；
- `registry-reconcile.mjs` 的 `apply`：主干合并事实回写登记册（PR #358，退出码 2，`legacy_registry_write_disabled`）；
- 旧定时触发 `ai-task-scheduled-trigger.mjs` 与 M5 夜间自动派发：默认 fail-closed，不再基于旧账本无人值守派发（PR #355，`legacy_scheduler_disabled` / `legacy_dispatcher_disabled`）。

仍有效的只读入口（仅查询，不写任何文件或远端）：

```bash
# 任务上下文门禁：规格与任务卡是否真的在仓库里、历史活跃任务是否有远端锚点（只读校验）
npm run validate:task-context

# 查询旧登记册存量条目 / 待同步 GitHub 的历史任务（只读）
node scripts/local-task-registry.mjs list --github-sync pending
node scripts/local-task-registry.mjs show --task LOC-001

# 预览旧 GitHub 同步差异，不建 issue（只读）
npm run sync:remote-issues -- plan

# 查询旧 ready 标签存量 / 按任务标识查看旧 issue 只读信息（只读）
node scripts/github-issues.mjs list-ready
node scripts/github-issues.mjs show --task FIX-224
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

> 复核记录：退役口径与机器停写现已一致——依赖 PR #355–#359 已于 2026-10-04 全部合入
> main（合并基点 `c9c08cb8`），本次收口已在合并后的代码上逐句复核上述原因码与只读保留项。
> 后续如再调整停写范围，先改脚本与本文件，保持两者一致。
