# 本地任务登记册（docs/tasks/）

> 本地轨道（GitHub 不可用期间）的任务唯一真源。契约见
> `docs/design/ai-task-define-delivery/public-task-contract.md` §11；方案见同目录 `local-track-offline-mode.md`。

| 文件 | 用途 | 是否入库 |
|---|---|---|
| `registry.json` | 任务登记册（唯一真源，脚本读写） | 是 |
| `LOC-<序号>-<slug>.md` | 每任务一页（人读任务卡，GitHub 恢复后即 issue 正文） | 是 |
| `archive/<任务标识>/` | 任务卡 + 对应版本规格的归档副本，随合并提交入库 | 是 |
| `BOARD.md` | 看板（脚本自动重写，勿手工编辑） | 是 |

## 常用命令（仓库根目录）

```bash
# 分配新任务标识（号由 GitHub 主源服务端发，双机/多会话不会撞号，并重写看板）
node scripts/local-task-registry.mjs allocate --name "<任务名称>" --type FEAT|FIX|CHORE --source 会话录入 --source-ref "<日期或路径>"

# 登记任务规格位置（规格必须落在 docs/tasks/specs/ 并入库，禁止指向 .scratch/）
node scripts/local-task-registry.mjs set --task FEAT-039 --spec-path docs/tasks/specs/FEAT-039-<slug>/task-spec-V1.md

# 更新状态 / 分支 / 远端 issue
node scripts/local-task-registry.mjs set --task LOC-001 --status 本地已定义 --branch dev-loc-001-r1
node scripts/local-task-registry.mjs set --task LOC-001 --status 等待验收
node scripts/local-task-registry.mjs set --task LOC-001 --remote github#123

# GitHub 主源 issue 同步：预览 / 批量建 issue 并回填编号 / 临时号换正式号
npm run sync:remote-issues -- plan
npm run sync:remote-issues -- apply
node scripts/remote-issue-sync.mjs reissue --task TMP-<机器码>-<日期><序号> --type CHORE

# 定义落档后给任务的 GitHub issue 打「可施工」标签（ready-for-agent；幂等，可反复执行）
# 批量调度按这个标签筛任务，落档后不打标签 = 该任务不会被夜间批次选中
node scripts/local-task-registry.mjs mark-ready --task FIX-224

# 施工认领：开工时由 cwf-run-init 自动完成（打「施工中」+ assignee + 认领评论），无需单独执行
# 释放认领（收口 / 人工接手僵尸认领）：摘「施工中」标签 + 留结束评论；ready-for-agent 保留
node scripts/github-issues.mjs release --task FIX-224 --reason "收口"
node scripts/github-issues.mjs list-ready

# 任务上下文门禁：规格与任务卡是否真的在仓库里、活跃任务是否有远端锚点
npm run validate:task-context

# 重写看板 / 查看待同步 GitHub 的任务
node scripts/local-task-registry.mjs board
node scripts/local-task-registry.mjs list --github-sync pending

# 验收通过后合并回本地主干（一任务一提交；冲突自动中止）
node scripts/local-task-merge.mjs --task LOC-001 --branch dev-loc-001-r1 --decision accept --run-id loc-001-r1 --mirror mirror
```

## 硬规则

1. 任务卡、登记册、看板必须入库（本目录全部文件都被跟踪）——合并后任务的来源、范围、状态在主干历史里永久可查；
2. **任务规格必须与任务卡一起入库**：规格落在 `docs/tasks/specs/<任务标识>-<slug>/`，禁止留在 `.scratch/` 等被忽略的目录——否则干净检出或远端克隆后实施前检查必然失败；
3. **活跃任务必须有远端（GitHub 主源）issue 号**：任务不能只活在某台机器的本地文件里，`remote` 字段为 `pending` / `none` 的须尽快换取正式号；
4. **编号由远端发**：新任务一律 `FEAT-<远端号>` / `FIX-<远端号>` / `CHORE-<远端号>`，本机不自己算号；
5. **两个施工信号只由工具写，不手工编造**：`ready-for-agent`（可施工）由 `mark-ready` 或调度器门禁后自动补打；`施工中`（已被认领）由 `cwf-run-init` 开工时写入、`release` 摘除。手工摘 `施工中` 等于放弃「防重复施工」保护，须在会话里说明原因（FEAT-237）；
6. 本地主干只能由「任务合并」推进，禁止直接在主干上改动；
7. 已合并任务的**工作区由合并脚本自动删除、分支保留**（阶段一口径：工作区可再生，`git worktree add` 随时重建；分支不可再生，是补登 PR 的唯一载体）。
