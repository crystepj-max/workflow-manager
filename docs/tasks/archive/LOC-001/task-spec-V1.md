# 任务规格 V1 — LOC-001 编辑器边判断条件适配业务结果路由

- 任务标识：LOC-001（slug: edge-outcome-ui）
- 基线：V1（2026-09-09）
- 确认依据：用户会话指令「现在在工作流目标编辑界面，边的判断条件仍然只有 成功/失败，还是已经添加了更多的定义？如果还没有添加，结合之前已完成的功能，做 UI 交互的适配改造」；经调查确认「尚未添加」，指令条件成立。

## 任务目标（Goal）

让可视化工作流编辑界面的边判断条件如实支持引擎已实现的边定义体系——不再只有 成功/失败，还包括业务 outcome 边、technical 技术重试边、countRound 回退记账，并与节点侧「业务结果路由（outcomePath）」模式联动；保证导入→编辑→保存往返不损坏数据、画布标注与真实语义一致。

用户得到：能在编辑器中查看、编辑含业务结果路由的工作流（如 construction-full-feature 蓝图一类），不再被误标「成功」、不再因表单误操作破坏边定义。

## 涉及范围（Scope）

做（全部在 `packages/dsh-visual-workflow`）：

1. 纯函数层（顶层导出，供单测）：`edgeKind`（边类型判定）、`applyEdgeKind`（类型切换的字段互斥清理）、`edgeLabelText`（画布短标签）、`edgeLabelWidth`（标签宽度估算）。
2. 边表单 EdgeInspector：类型四态（成功 / 失败 / 技术重试 / 业务 outcome）；业务 outcome 的名称输入 + countRound 勾选；when 条件仍仅 success 边；字段错误映射到 `edge:<i>:outcome` / `edge:<i>:countRound`。
3. 节点表单：「结果判定方式」新增第 4 态「业务结果路由」——outcomePath 输入（`$.field` 形式）+ output.schema 编辑（复用现有编辑器与 ✨ 美化）；该态不显示 successCondition；进入/离开该态显式清理字段；fanout 转换删除 outcomePath。
4. 画布：边标签如实显示（outcome 名 / 重试 / 失败 / 成功）；颜色区分（失败红、技术重试中性、业务与成功蓝）；标签避让宽度按文本估算。
5. `updateEdge` 互斥清理：on 与 outcome 不并存；when 仅 success；countRound 仅业务边；technical 禁 when/countRound。
6. i18n：zh / en 新增文案；重建 dist。

不做：

- HD（`$human-decision`）节点/边的创作 UI（既有 HD 边如实显示；`result` 字段按原字段编辑兜底）。
- 校验内核、宿主、引擎行为变更（纯 UI 适配）。
- 业务 outcome 枚举覆盖的客户端实时检查（由既有保存校验兜底，错误可定位到字段）。
- `subsequent_effect` 等 HD 附加字段的编辑。

## 验收标准（Acceptance）

1. 打开/粘贴含 `outcomePath` 节点与 outcome 边的工作流：节点表单显示「业务结果路由」态，outcomePath 与 schema 如实回显，不显示成功表达式；边表单如实显示业务 outcome 类型与名称。
2. 选中 outcome 边可查看/编辑 outcome 名与 countRound；切换类型后保存，DSL 中 `on` 与 `outcome` 不并存、废弃字段被清理（往返不损坏）。
3. technical 自环边在表单与画布中显示为「技术重试/重试」，不误标成功/失败。
4. 画布：outcome 边标签显示 outcome 名；失败红、技术重试中性色；标签避让不与节点/其他标签重叠。
5. 旧模式（AI 输出验证 / 人工 check）节点与 success/failure/when 行为不回归；拖拽新建边默认 success。
6. 在旧模式节点把边切到业务 outcome，保存校验报「旧模式节点禁止 outcome 边」且能定位到该边字段。
7. zh/en 文案齐全；插件包测试通过（新增纯函数单测 + 既有回归）；`npm run build` 后 dist 一致性检查通过；仓库根 `npm test`、`npm run validate` 通过。

## 施工备注

- 前置依赖：无；施工环境组：LOC-001；环境角色：独立；无人值守许可：允许（实施与自动检查自主进行，最终验收由用户完成）。
- 测试沿用 `tests/schema-template.test.mjs` 的「顶层纯函数 + new Function(src) 加载」模式，新增 `tests/edge-model.test.mjs`。
- 关键校验事实（已实测）：业务 outcome 边与 technical 边要求节点声明 `outcomePath`；`countRound` 仅业务边可声明；outcome 与 on 互斥；多条 success 出边必须全部带 when。
