# LOC-017 · Integration Gate 自动重跑闸门

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-017` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W5，#93 §10）；用户决策③：自动重跑（不做半自动提示版） |
| 任务名称 | Integration Gate 自动重跑闸门 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | LOC-008（Proof 绑定 Revision 与 stale 判定） |
| 施工环境组 | LOC-017 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

把 #93 §10 的 Integration Checkpoint 从"内核 + Bootstrap shim 人工执行"升级为自动闸门：正式集成前比较 `run.integration_base_head` 与目标当前 HEAD；目标已变化时自动执行——获取集成锁 → sync/rebase/merge → 产生新 Source / Artifact Revision → 重算受影响依赖 → 标旧 Proof stale → **自动重跑受影响的审核/测试**（决策③）→ 全部 Proof 覆盖当前 Revision 后才放行集成。不变量：Test Proof 验证 HEAD H1、实际集成 HEAD 是 H2 时，旧 Proof 不得显示为当前有效。

### 涉及范围

- 做：编排层（host 编排或 `cwf-*` Bootstrap shim 升级为正式 Runtime 路径，实施 Definition Check 定）串接既有内核：`observeTargetHead` / `computeIntegrationCheckpointFromRepo` / `recordSourceSync` / `coverageStatus` / `assertIntegrationAllowed`（`scripts/workspace-isolation.mjs` 已实现，不重写算法）；受影响 Proof 自动重跑的触发与结果回收（消费 LOC-008 证据链）。
- 不做：git merge 策略本身的变更；跨仓库 / 多目标集成；Container/Remote Provider。

### 验收标准

- [ ] E2E：Run A 与 Run B 同 base 派生，A 先合并；Run B 集成被拦 → 自动 sync → 受影响审核/测试自动重跑 → 重验通过才放行
- [ ] 旧 HEAD 的 Test Proof 不为新集成背书（集成前 `coverageStatus` 任一 `not_covering_current` 即拒绝）
- [ ] 集成锁被占用 → Run 进 BLOCKED 提示；锁释放后可继续同一逻辑运行
- [ ] `workspace-isolation` 既有测试不改断言全绿；`npm test`、`npm run validate` 全绿

## 详细规格

权威契约：`docs/design/workspace-isolation.md` §7（Integration Checkpoint 与 #78 闸门）、§9（Resource Lock）；产品语义：#93 设计 §10；并行协作规则中的 Integration Checkpoint 步骤（`docs/design/v0.1-parallel-development-plan.md` §9.3）由本卡承接为自动执行。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡；决策③本卡已落） |
