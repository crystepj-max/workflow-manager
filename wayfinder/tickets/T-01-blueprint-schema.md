---
id: T-01
title: 蓝图 schema 与校验规则定稿
type: prototype
labels: [wayfinder:prototype]
status: closed
assignee: charting-session-2026-08-19
blocked-by: [R-01, R-02]
resolved: 2026-08-19（用户评审 6 项决策全部采纳推荐）
---

## Question

蓝图 JSON 的**具体 schema**是什么？——规格 FR-1 只列了字段名，未定结构、约束与校验规则；而 schema 是 FR-7（对话式创作，v2）的契约（规格风险 2），须在 v1 定稿并写入 `docs/design/`。

## 已知约束（须纳入 schema 决策）

- 规格 FR-1 字段：`id`/`displayName`/`name`/`entry`/`control.maxRounds`/`nodes[]`(id/label/profile/goal/output.schema/output.successCondition)/`edges[]`(from/to/on/when)。
- 但 host.js 现有模板节点还有 `model:{provider,model}`（硬编码，规格要求改为 per-entry 绑定配置）与 `manualCheck`（accept 节点，规格未提——漏掉会丢「人工验收门禁」能力）；`description` 也在现有模板中。
- 模型分配与「分流」实现方式作为 per-entry 绑定配置（规格 FR-1 末条）：schema 须规定绑定配置的形态（如 `bindings.entries.<entry>.model` / `bindings.route`），生成器据此编译出 DSH `if` 与 vwf route 节点。
- 校验规则须与 `validateDsl`（R-02 产物）对齐：蓝图校验 = 结构合法（v1），异源（v2，T-06）。

## 产物

- 蓝图 schema 草案（JSON Schema 或等价形式）+ 用 `dev-workflow-2.0` 抽出的**示例蓝图**（对照 R-01 语义，保证不丢能力）。
- 校验规则清单 + 与 validateDsl 的差异表。
- 结论：schema 是否足以表达 R-01 对照表中的全部语义；不足处如何补偿（生成器特例？）。

## 备注

HITL：产出草案供用户/团队评审后定稿；schema 定稿即写入 `docs/design/`。

## Resolution（2026-08-19）

**schema 定稿**：`docs/design/blueprint-schema.md`（v1 契约，v2 FR-7 编写依据）。
决策（D1-D6，用户评审全部采纳推荐）：① 单标识 `id=name`（kebab-case）+ `displayName` 中文；② 节点粒度 `bindings.models[nodeId]`；③ 分流保留 route 节点+双 when 边，DSH 编译器折叠为 if（无 LLM）；④ DSH 三增强进蓝图（顶层 `onMaxRounds`/`heteroCheck` + 节点 `verifyBranch`）；⑤ 校验分层（蓝图级 + DSL 结构级，对齐 validateDsl 规则集，入口不唯一一律拒绝）；⑥ 契约落 `docs/design/`。
评审过程暴露并修复一个设计缺陷：显式 entry 不得豁免「入口不唯一」（对齐 host.js:211-212 严格语义）。R-01 对照表中「需生成器保证」的 3 项（超限归因/可信度闸门/异源警告）已全部进蓝图，v1 仅 DSH 侧实现、vwf 侧忽略；「角色注入/运行上下文」为生成器固定注入约定。

## 资产（prototype）

- 可交互评审台（一次性原型，gitignore 区）：`.scratch/schema-prototype/blueprint-schema-demo.html`（双击打开；8 个校验场景 + vwf 投影 / DSH 折叠预览 + D1-D6 决策表态与导出）。
- 冒烟断言：`.scratch/schema-prototype/smoke.js`（16/16 通过）。
- 草案字段全集与 D1-D6 决策点见 Resolution（评审确认后落定）。
