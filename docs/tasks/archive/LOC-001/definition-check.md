# Definition Check — LOC-001 编辑器边判断条件适配业务结果路由

检查时间：2026-09-09

## 事实核查（Current 实现）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 编辑界面边判断条件**仍只有 success / failure 两态**；拖拽新建边固定 `on:'success'` | `packages/dsh-visual-workflow/src/client.js` EdgeInspector（约 1410-1415 行）、`handleConnect`（约 1885 行） |
| 2 | 引擎/校验内核已支持更丰富的边定义：`on ∈ {success, failure, technical}`、业务 `outcome` 边（与节点 `output.outcomePath` 配套）、`countRound` 回退记账、HD choice 出边 | `scripts/validate-core.cjs`（边校验约 455-484 行；outcomePath 节点规则约 743-800 行） |
| 3 | 🔴 业务 `outcome` 边与 `technical` 边**都要求节点先声明 `outcomePath`**（旧模式节点直接被校验拒绝） | 实测 `validateBlueprint`：`旧模式节点禁止 outcome 边（须先声明 outcomePath）`、`旧模式节点禁止 on: technical（技术失败仍走 failure）` |
| 4 | 画布把所有边统一标注 成功/失败：`outcome` 边被误标为「成功」（蓝色） | `client.js` 约 847、903-904 行 |
| 5 | 编辑器选中 `outcome` 边时表单下拉显示空白；若误操作选 success/failure 会写入 `on`，与 `outcome` 并存 → 校验报「outcome 与 on 互斥」（数据损坏路径） | `client.js` EdgeInspector + `updateEdge`；`validate-core.cjs` 464-465 行 |
| 6 | 节点表单「结果判定方式」只有 不启用/AI 输出验证/人工 check 三态；`outcomePath` 节点会被误渲染为「AI 输出验证」并显示 successCondition（新模式禁止该字段）；切换模式会静默丢弃 `outcomePath` | `client.js` 约 1127-1129、1352-1358 行 |
| 7 | 蓝图粘贴导入（JSON tab）可保留 outcome 边与 outcomePath 节点（布局已兼容），但表单不可查看/编辑 | `client.js` `ingestEditorJson`、`isStructuralEdge`（274-285 行）；`host.js` `ingestToDsl` |

## 硬规则检查

- [x] 未决产品事项 = 0（见下）
- [x] 三要素齐备（见 task-spec-V1.md）
- [x] 无编造补全；范围外事项（HD 创作 UI、引擎行为变更、枚举实时校验）如实列为不做
- [x] 基线确认依据：用户本会话明确指令「如果还没有添加，结合之前已完成的功能，做 UI 交互的适配改造」——触发条件（尚未添加）经上表事实核查成立，视为已获范围与目标确认（简单修正以当前明确请求为需求基线）
- [x] GitHub 不可用（keyring token 失效），走本地轨道；`GitHub 同步 = pending`

## 产品决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 边表单是否要支持 outcome / technical | 要 | 不支持则表单显示空白且存在数据损坏路径（事实 5） |
| 是否同时给节点表单加「业务结果路由」入口 | 要（最小入口） | 校验规则要求 outcome/technical 边必须挂在 outcomePath 节点上（事实 3）；不加则边侧改造无法端到端使用 |
| 拖拽新建边的默认类型 | 保持 success | 不改变现有交互习惯；新建后可在表单切换类型 |
| HD 出边（result/outcome） | 如实显示、outcome 可编辑；`result` 边保留原字段编辑；不做 HD 节点创作 UI | 控制范围；HD 创作是独立后续切片 |
| 枚举覆盖检查 | 依赖既有保存校验，不新增客户端实时检查 | 校验已能定位到字段；避免重复实现 |

## 结论

全部通过，进入「本地已定义」，接续施工（用户已要求完成改造）。
