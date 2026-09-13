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
| 当前状态 | 等待验收 |
| 需求基线版本 | V2 |
| 前置依赖 | 无（V1 的 LOC-010 已取消，2026-09-13 用户确认改判） |
| 施工环境组 | LOC-014 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/LOC-014-model-override/task-spec-V2.md`（Definition Check 同目录） |
| 定义时间 | 2026-09-11（V1）；2026-09-13（V2） |
| GitHub 同步 | pending |

> 本地轨道：恢复后补建 issue，`GitHub 同步` 保持 `pending` 直到同步成功。

## 摘要（三要素速览）

### 任务目标

实现规格 §6 的覆盖链：`Built-in Workflow + User Override → Effective Workflow → Run Snapshot`。内置模板结构只读（改节点/边/角色/路由仍须"另存为自定义"），但用户可保存 Provider / Model Override，运行时按有效工作流执行。

### 涉及范围

- 做：覆盖层专用目录 `<dshHome>/visual-workflow/model-overrides/<templateId>.json`（键格式与 #79 对齐：节点 id + `$default` 兜底）；`findWorkflow` + `workflowEntries` 单一合成函数输出有效 DSL（不动内置真源 `templates/*.json` 与 `.generated/` 产物）；模板库最小覆盖入口（保存/清除恢复默认，"已覆盖"最小标记，完整交互归 LOC-016）；容错（坏 JSON 忽略留痕）与 userDir 整份覆盖优先。
- 不做：结构编辑（仍走另存为自定义）；运行中切换（#79 Snapshot Revision 已实现）；完整 UI 打磨（LOC-016）；静默 Failover（§6 明确不做）。

### 验收标准

- [ ] 保存模型覆盖后 `wf_run` 按有效工作流执行（探针/执行均用覆盖后绑定），内置蓝图文件与生成物不变
- [ ] 覆盖可清除并恢复默认绑定（删文件即恢复）
- [ ] 运行创建的 Snapshot Rev 1 冻结的是覆盖后的有效绑定（与 `vwf.logicalRuns.get` 快照记录一致）
- [ ] 模板库列表/详情显示覆盖后绑定；userDir 整份覆盖存在时整份优先、覆盖层忽略
- [ ] 坏覆盖文件不阻断模板加载与运行（忽略并留痕）
- [ ] 插件包测试 + 根目录 `npm test`、`npm run validate` 全绿

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §6（Built-in 只读 + Override）；只读边界与撞名语义沿用 `host.js` 现行 save 规则（内置只读、另存新 id）。运行中 Provider/Model 修订（`appendSnapshotRevision`）已随 #79 落地，本卡只补"持久化覆盖默认值"这一环。完整规格见 `.scratch/LOC-014-model-override/task-spec-V2.md`（业务规则/边界/UAT-01~04/风险）。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
| 2026-09-13 | 等待验收 | run loc-014-r1 交付至 UAT：实现+审查（1 轮退回修复）+独立测试全过、checkpoint/证据链 9/9 绿；UAT 卡 .agent-runs/loc-014-r1/uat-card.md，待人工三态裁决 |
| 2026-09-13 | 本地已定义 | 基线 V2：需求分析会话细化；D1/D2/D3 按推荐落定（专用覆盖层目录 / 统一合成所见即所跑 / 键格式对齐 #79 + userDir 整份优先）；前置依赖 LOC-010 → 无（已取消，用户确认） |
