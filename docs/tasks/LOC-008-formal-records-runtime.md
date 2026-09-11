# LOC-008 · Formal Records 运行时集成与证据链落地

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-008` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：v0.1 正式产品规格差距分析 → 开发计划表 v2（W1，对应 #78 运行时集成） |
| 任务名称 | Formal Records 运行时集成与证据链落地 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1（关键路径） |
| 当前状态 | 等待验收（Run `loc-008-r1`，分支 `dev-loc-008-r1`@f515ca1，UAT 卡见 run 目录 uat-card.md） |
| 需求基线版本 | V1 |
| 前置依赖 | 无（`scripts/formal-records.mjs` 内核已就绪） |
| 施工环境组 | LOC-008 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

把已完成的 #78 Formal Records 内核（`scripts/formal-records.mjs`：追加式 Store、覆盖判定、依赖失效、Portable 映射）接入运行时：节点产物自动形成 Record + Revision + 依赖链；verifyBranch 节点（审核/测试）强制签发绑定真实 HEAD 与 Record Revision 的 Proof；多格式产物入库从"写 legacy runs 记录的 formalRecords 字段"升级为走正式 Store。

### 涉及范围

- 做：`scripts/generate.mjs` 编译脚本节点收尾处提交 Formal Record 的单一通道（经宿主 RPC，具体形态实施时定）；`packages/dsh-visual-workflow/src/host.js` 新增 records commit/list/get RPC 与持久化（随 #79 logical-runs 目录组织，与运行摘要互相引用）；verifyBranch 节点 Proof 记录 `verified_head` + 所依赖 Record Revision，可经 #78 `coverageStatus` 判 covering/stale；`vwf.artifacts.ingest` 升级走正式 Store（保留旧行为兼容或明确迁移）。
- 不做：探索 targeted 重算编排（归 LOC-013）；Integration Gate 自动编排（归 LOC-017）；UI 呈现（归 LOC-016）；`formal-records.mjs` 内核语义变更；`docs/design/formal-records.md` 契约正文修改。

### 验收标准

- [ ] 产生 Implementation I2 后，依赖 I1 的 RV1/T1 被 `coverageStatus` 判为 `not_covering_current`（旧 Proof 保留不删，标记 stale）
- [ ] verifyBranch 节点签发的 Proof 记录 workspace / verified_head / Record Revision 绑定；另一 HEAD 的 Proof 不为当前 Revision 背书（E2E 反例）
- [ ] 节点产物 Record 在产品 DSH 重启后仍可按 logical_run_id 查询（持久化生效）
- [ ] 既有 `formal-records` / `runtime-host` / `runtime-logical-run` 测试不改断言全绿；`npm test`、`npm run validate` 全绿

## 详细规格

权威契约：`docs/design/formal-records.md`（#78 实现契约）+ `docs/design/formal-records/schema.json`；产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §2.7 / §7；原则 R3–R5。内核边界声明"不接入 generate.mjs / 插件"，本卡即解除该边界的那张票；落盘组织与 #79 摘要（`host.js` logical-runs）对齐，不新建第二套存储。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡；决策①②③已拍板，见 LOC-010/012/017） |
