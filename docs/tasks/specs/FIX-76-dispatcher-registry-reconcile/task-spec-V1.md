# M5 调度器内建登记册对账（本地任务规格）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 任务标识 | `FIX-76` |
| 任务类型 | 修复（FIX） |
| 优先级 | P1 |
| 前置依赖 | `CHORE-73`（cnb#73，已合并，提供 `registry-reconcile.mjs`） |
| 施工环境组 | `FIX-76` |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-17 |
| 当前状态 | 已由 FEAT-77 实现（实现见 PR #87 / cnb#77，FIX-76 修复代码随 FEAT-77 一并合并） |
| 未决产品事项 | 0 |
| 远端 issue | cnb#76 |

---

## 1. 问题（实测证据）

M5 夜间批次调度器链路（candidate-collect → execution-plan → dispatcher）在候选采集阶段用 `collectLocalCandidates` 做依赖排除：

```js
// scripts/ai-task-candidate-collect.mjs:99-106
const unmetDep = (record.deps || []).find((d) => {
  const dep = byId.get(d)
  return !dep || dep.status !== STATUS_MERGED
})
if (unmetDep) {
  exclude(`依赖未满足（${unmetDep} 登记册未记合并）`)
  continue
}
```

只看登记册 `dep.status`，不查主干事实。当依赖任务**实际已合并**（有提交信息任务号 `(FEAT-12 V1)` 或收口标签 `task/feat-012/v1`）但登记册 `status` 因同步滞后未回写「已合并」时，会被判「依赖未满足」排除，任务整晚不被开工。

这正是 LOC-028 在 M5 链路下的复现风险：LOC-026 已合并 9 小时后，登记册仍滞后，导致依赖它的任务被连续跳过。

**与 CHORE-73 的关系（非重复）**：CHORE-73（cnb#73，已合并）已在 `ai-task-execution-plan.mjs` 的 `assessCandidate` 实现「依赖看事实」，但其规格第 4 节挂载点是 execution-plan 层。dispatcher 链路里 `collectLocalCandidates` 在**更早一步**就用登记册 status 排除了依赖未满足项，execution-plan 那层判定被早排除绕开、永远到不了。FIX-76 补 `collectLocalCandidates` 这一层，使 dispatcher 链路真正受益。

## 2. 目标

候选采集的依赖判定基于「登记册已合并 **或** 主干有合并痕迹」，与 CHORE-73 规格第 3 条规划一致；登记册滞后不再导致依赖误排除。

## 3. 涉及范围

- **做**：
  1. `scripts/ai-task-candidate-collect.mjs` 的 `collectLocalCandidates`：在依赖排除处调用 `collectMergeFacts(repo)` 取得合并事实 Map；依赖满足判定改为 `dep 存在且（dep.status === STATUS_MERGED 或 facts 含该 dep 的合并痕迹）`；仍不满足才排除并说明。
  2. 测试：在 `scripts/test/ai-task-candidate-collect-m5.test.mjs` 增加用例——依赖任务已合并（git 事实）但登记册 `status` 未回写时，依赖方仍进入候选。
- **不做**：重写 execution-plan 的 `assessCandidate`（CHORE-73 已实现，保留）；改动账本乐观锁/对账脚本本身（`registry-reconcile.mjs`）；改验收三态、返工上限等纪律。

## 4. 实现说明

| 层 | 载体 | 挂载点 |
|---|---|---|
| 合并事实 | `scripts/registry-reconcile.mjs` 的 `collectMergeFacts` | 候选采集入口一次性计算，传参给依赖判定 |
| 依赖判定 | `scripts/ai-task-candidate-collect.mjs` 的 `collectLocalCandidates` | 替换第 99–106 行的早排除逻辑 |

## 5. 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1 | 依赖判定结合 git 事实：依赖已合并但登记滞后时不再误排除 | 单测：构造依赖任务有合并痕迹、登记 `status=本地已定义`，验证依赖方进入候选 |
| 2 | 依赖真实未满足仍排除且说明 | 单测：依赖任务无合并痕迹且非已合并，验证被排除并标注原因 |
| 3 | 不破坏既有采集闸门（状态/run/黑名单/环境组/先导） | `ai-task-candidate-collect-m5.test.mjs` 全绿 |
| 4 | 全量回归 | 现有测试套件通过 |

## 6. 打包项

- 总控提示词（`.scratch/night-batches/night-batch-prompt-v2.md`）当前第 0 步手动跑 `registry-reconcile.mjs apply` 作为止血。FIX-76 落地后，该手动步骤可移除，链路仍正确——届时同步删去提示词第 0 步（属 FEAT-77 卡记录的关联项）。

## 7. 流程约定

走维护性交付流程（实现 → 自验 → 审核 → 验收 → 收口）；改动只限于候选采集依赖判定，不触碰共享账本的写入路径（`saveRegistry` / `writeBoard`）。
