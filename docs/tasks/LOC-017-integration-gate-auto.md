# LOC-017 · Integration Gate 自动重跑闸门

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-017` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W5，#93 §10）；用户决策③：自动重跑（不做半自动提示版）；V2 由需求分析升版（2026-09-11） |
| 任务名称 | Integration Gate 自动重跑闸门 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V2 |
| 前置依赖 | LOC-008（Proof 绑定 Revision 与 stale 判定；已合并） |
| 施工环境组 | LOC-017 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/LOC-017-integration-gate/task-spec-V2.md`；定义检查 `.scratch/LOC-017-integration-gate/definition-check.md` |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

> V2 摘要。V1 摘要的「重算受影响依赖」与「载体施工期定」已在 V2 修正，完整规格见任务规格位置。

### 任务目标

把 #93 §10 的 Integration Checkpoint 从「内核 + Bootstrap shim 人工执行」升级为自动闸门，落在产品运行时（决策 1）：建设流程进入人工验收前，自动观测目标 HEAD；目标已前进则自动获取集成锁 → 同步 → 产生新产物版本 → **自动重跑本 Run 全部审核/测试**（决策 2，保守全量）→ 全部 Proof 覆盖当前版本后才放行集成，否则拦截。不变量：Test Proof 验证 HEAD H1、实际集成 HEAD 是 H2 时，旧 Proof 不得显示为当前有效。

### 涉及范围

- 做：产品侧编排层串接既有内核（`observeTargetHead` / `computeIntegrationCheckpointFromRepo` / `recordSourceSync` / `coverageStatus` / `assertIntegrationAllowed`，`scripts/workspace-isolation.mjs` 已实现，不重写算法）；自动同步；同步后产生新 Record Revision（闸门正确性的必要环节）；审核/测试自动重跑的触发与结果回收（消费 LOC-008 证据链）；集成锁全程持有 + 心跳刷新（决策 3）；判定结果落盘可追溯；双 Run E2E。
- 不做：git merge 策略本身的变更；跨仓库 / 多目标集成；Container/Remote Provider；精确受影响子集重算；Bootstrap shim 自动化；UI（归 LOC-016）；`local-task-merge.mjs` 合并闸门。

### 验收标准

- [ ] E2E：Run A 与 Run B 同 base 派生，A 先合并；Run B 集成被拦 → 自动 sync → 受影响审核/测试自动重跑 → 重验通过才放行
- [ ] 旧 HEAD 的 Test Proof 不为新集成背书（集成前 `coverageStatus` 任一 `not_covering_current` 即拒绝）
- [ ] 同步未产生新产物版本时拒绝放行，且不得报告 `rerun_completed`
- [ ] 重跑结论为 `RETURN_DEV` 时不放行，按既有语义回到开发节点
- [ ] 集成锁被占用 → Run 进 BLOCKED 提示；锁释放后可继续同一逻辑运行；锁在整个闸门窗口内有效
- [ ] 闸门判定结果落盘可追溯，无需人工粘贴
- [ ] 目标未前进时不触发重跑、不额外耗时
- [ ] `workspace-isolation` 既有测试不改断言全绿；`npm test`、`npm run validate` 全绿

## 详细规格

完整需求以本地任务规格为准（见上表「任务规格位置」）。实质变更走 Vn→Vn+1 流程，见 `references/baseline-change-v1-v2.md`。

权威契约：`docs/design/workspace-isolation.md` §7（Integration Checkpoint 与 #78 闸门）、§9（Resource Lock）；产品语义：#93 设计 §10；并行协作规则中的 Integration Checkpoint 步骤（`docs/design/v0.1-parallel-development-plan.md` §9.3）由本卡承接为自动执行。

需求分析结论：`.scratch/LOC-017-integration-gate/requirements-analysis.md`（已核查的缺口 G1–G7 与三项决策）。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡；决策③本卡已落） |
| 2026-09-11 | 待确认 | 需求分析升版 V1→V2：核查发现 3 项未决产品事项（载体 / 重跑范围 / 集成锁窗口）与 1 项闸门误放行缺口；用户采纳推荐方案，产出 `task-spec-V2.md`，Definition Check 全部通过 |
| 2026-09-11 | 本地已定义 | 基线 V2 经用户确认，按该版本进入交付 |
