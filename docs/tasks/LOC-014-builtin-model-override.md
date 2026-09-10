# LOC-014 · 内置模板模型覆盖（Model Override）

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-014` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W2，#82 Built-in Model Override） |
| 任务名称 | 内置模板模型覆盖 Model Override |
| 任务类型 | 完整功能开发 |
| 优先级 | P2 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | LOC-010（建设正式化定稿后做，覆盖机制四模板共用） |
| 施工环境组 | LOC-014 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

实现规格 §6 的覆盖链：`Built-in Workflow + User Override → Effective Workflow → Run Snapshot`。内置模板结构只读（改节点/边/角色/路由仍须"另存为自定义"），但用户可保存 Provider / Model Override，运行时按有效工作流执行。

### 涉及范围

- 做：Override 的持久化形态（用户目录覆盖层，不动内置真源 `templates/*.json` 与 `.generated/` 产物）；`host.js findWorkflow` 合成有效 DSL（覆盖层叠内置 bindings.models）；模板库 UI 覆盖入口（最小可用即可，完整交互归 LOC-016 一并打磨）；清除/恢复默认。
- 不做：结构编辑（节点/边/Outcome Routing/Human Decision/回退规则的修改仍走另存为自定义）；运行中切换（那已是 #79 Snapshot Revision 能力，续跑 `model_overrides` 已实现）。

### 验收标准

- [ ] 保存模型覆盖后 `wf_run` 按有效工作流执行（探针/执行均用覆盖后绑定），内置蓝图文件与生成物不变
- [ ] 覆盖可清除并恢复默认绑定
- [ ] 运行创建的 Snapshot Rev 1 冻结的是覆盖后的有效绑定（与 `vwf.logicalRuns.get` 快照记录一致）
- [ ] 插件包测试 + 根目录 `npm test`、`npm run validate` 全绿

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §6（Built-in 只读 + Override）；只读边界与撞名语义沿用 `host.js` 现行 save 规则（内置只读、另存新 id）。运行中 Provider/Model 修订（`appendSnapshotRevision`）已随 #79 落地，本卡只补"持久化覆盖默认值"这一环。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
