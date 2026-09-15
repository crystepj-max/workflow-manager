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
# 分配新任务标识（自动递增 LOC-<序号>，并重写看板）
node scripts/local-task-registry.mjs allocate --name "<任务名称>" --source 会话录入 --source-ref "<日期或路径>"

# 更新状态 / 分支 / GitHub 同步
node scripts/local-task-registry.mjs set --task LOC-001 --status 本地已定义 --branch dev-loc-001-r1
node scripts/local-task-registry.mjs set --task LOC-001 --status 等待验收
node scripts/local-task-registry.mjs set --task LOC-001 --github-sync synced#123

# 重写看板 / 查看待同步 GitHub 的任务
node scripts/local-task-registry.mjs board
node scripts/local-task-registry.mjs list --github-sync pending

# 验收通过后合并回本地主干（一任务一提交；冲突自动中止）
node scripts/local-task-merge.mjs --task LOC-001 --branch dev-loc-001-r1 --decision accept --run-id loc-001-r1 --mirror mirror
```

## 硬规则

1. 任务卡、登记册、看板必须入库（本目录全部文件都被跟踪）——合并后任务的来源、范围、状态在主干历史里永久可查；
2. 本地主干只能由「任务合并」推进，禁止直接在主干上改动；
3. 已合并任务的**工作区由合并脚本自动删除、分支保留**（阶段一口径：工作区可再生，`git worktree add` 随时重建；分支不可再生，是补登 PR 的唯一载体）。
