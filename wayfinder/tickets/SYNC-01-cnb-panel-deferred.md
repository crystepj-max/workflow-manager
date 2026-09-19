# CNB 运行控制面板 UI 同步延期与裁决（SYNC-01）

- **状态**：open（阻塞于 FEAT-85 收口裁决 V-12 / UAT-07）
- **日期**：2026-09-18
- **关联**：FEAT-85 收口分歧裁决（复用 / 取代 / 并存）V-12 / UAT-07；CNB PR #192–#202（镜像 cnb#87–#99）

## 背景

2026-09-18 执行 CNB→GitHub 同步时，CNB #87–#99 的 `packages/dsh-visual-workflow/src/client.js`（运行详情界面）与 GitHub 已合并的 FEAT-84/85/86 在同一段代码冲突（三处）。

采取 **Option 1**（用户拍板）：保留 GitHub 上 FEAT-84/85/86 的 `client.js`，逐笔把 CNB PR 的非 `client.js` 价值干净合入 GitHub。结果：

- ✅ cnb#87（#192）、cnb#88（#200）、cnb#89–#95（#193–#199 被 GitHub 在一次合并中一并关掉）、cnb#96（#201）、cnb#99（#202）全部合入 `origin/main`。
- ✅ cnb#97 / cnb#98（从未单独建 PR，位于 cnb#99 祖先链）经 cnb#99 一并带入 GitHub。
- ✅ `client.js` 在 GitHub 仍为 FEAT-84/85/86 版本（CNB 的 `loadMetrics` / `qualityCostRefresh` 面板标记出现次数 = 0，未覆盖）。
- ✅ `npm run generate` 通过（exit 0），并入的 host.js / scripts / client.js 无语法或合并断链。

## 被延期的内容（未合入 GitHub）

CNB 的运行控制面板 UI —— 即 WR-020 在 `client.js` 中的指标看板（`loadMetrics` / `qualityCostRefresh` 调用 `host.call('vwf.metrics.get')`、质量成本展示、运行暂停 / 中断面板）。其**底层逻辑**（`host.js` 的 `vwf.metrics.get` 接口、质量成本记录脚本 `scripts/run-quality-cost.mjs` / `records-host.mjs` 及测试）已随非 `client.js` 部分合入；**仅 UI 入口（client.js 面板）被延期**。

## 待裁决（关联 V-12 / UAT-07）

该面板与 FEAT-85 的运行详情界面存在重叠，需先在 FEAT-85 收口时给出 **复用 / 取代 / 并存** 裁决，再决定实现路径：

- 复用：CNB 指标数据直接喂给 FEAT-85 运行详情界面。
- 取代：以 CNB 面板替换 FEAT-85 对应区域。
- 并存：两套在运行详情界面分区共存。

## 启动实现时的动作

将 cnb#89–#99 的 `client.js` 运行控制面板**融合进** FEAT-85 运行详情界面（真实集成），而非机械覆盖或丢弃；沿用本批同步已落地的 `vwf.metrics.get` 等宿主接口。

## 备注

- 此票只记录「延期决策 + 所需裁决」，不替代 FEAT-85 收口的 V-12/UAT-07 裁决票。
- 若需正式立项实现，按项目约定经 `scripts/local-task-registry.mjs allocate` 由 CNB 远端发号登记入 `docs/tasks/registry.json`。
