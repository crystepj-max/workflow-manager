# OpenSpec 提案：business-outcome-routing

> 对应 issue #77；决策地图 #86。用户确认：#87/#88/#90/#91/#92/#89（2026-08-30–31）。

## OpenSpec

business-outcome-routing

## Problem Statement

现行蓝图只能把节点结果压成 `success` / `failure`。评估节点的 `PASS` / `OPTIMIZE` / `CONFIRM` 无法各走各的路；业务上「需要再改」被伪装成技术失败；人工决策和结束也挤在同一套二态边上。自定义工作流不能声明自己的结果字段名。跑完之后脚本返回体也没有「这次为什么完成」的 Completion Type（完成类型）摘要，看板无法按业务原因筛选。

## Proposed Solution

Blueprint 用 **expand–contract（扩缩兼容）** 同时表达旧二态和新的业务结果路由：

- **旧模式**（节点无 `outcomePath`）：现行 `successCondition` + `on` + `when`，行为不变。
- **新模式**（节点有 `output.outcomePath`）：按该路径等值匹配业务边 `outcome`；技术失败走可选 `{ on: "technical" }`（没有则 `TECHNICAL_FAILURE`）。同一节点禁止新旧混用；同一工作流内允许新旧节点并存。
- 命中 `$human-decision` → 引擎 `ROUTE_HALTED`（`reason=HUMAN_DECISION`），保留 `results[node]`。不发 `WAITING_HUMAN`，不实现决策包（#72）。
- `countRound` 落盘且往返无损，运行时不计数（#73）。
- 走进 `$end` 时，若终态节点声明了 `completionPath`，脚本 `DONE` 上带 `completion: { type, node, path } | null`。不写当前 `runs/`（#79 再抄同一形状）。
- fanout 不参与新模式；`failOn` 仍是技术聚合失败。

节点只报告专业结构化结果；蓝图解释结果并决定流向。框架不写死字段名叫 `outcome`。

## Changes

- `docs/design/blueprint-schema.md`: modify — 双模式边/节点字段、走通性（结构边、业务 SCC 出口）、完整性、`$human-decision` 作为路由目标、`completionPath`、fanout 禁区。
- `docs/design/outcome-presets.json`: create — 可选 Preset 目录（`id`、推荐 `outcomePath`、`values[]`、中文说明）。校验不强制选用。
- `scripts/validate-core.cjs`: modify — 新模式编码、完整性、走通性、HD 出入边、`completionPath` 静态规则、fanout 拒绝 Outcome/Completion。
- `scripts/generate.mjs`: modify — 新模式路由、`ROUTE_HALTED`、`ENDED_NO_OUTCOME_EDGE`、`DONE.completion`；`projectToVwf` 透传 `outcome` / `countRound` / `completionPath`（无 `on` 的业务边）；skill runbook 覆盖新状态。旧模式编译路径保持。
- `scripts/test/`: modify — 校验正负例（#88/#90/#91/#92/#89）；运行时新模式路由、停机、Completion、旧模板回归；额度不改写 Outcome 的夹具不变量。
- `packages/dsh-visual-workflow/src/`: modify — 与生成器一致的投影/逆投影，保存重开不丢新字段。不画 Inspector 选择器（#75）。宿主占用同时认 `ROUTE_HALTED` 与既有终态。
- `specs/business-outcome-routing/`: create — 本提案。
- `CONTEXT.md`: modify — 仅登记已锁定词汇与口径；不把 Current 运行时叙述改成 Target（#76/#84：新语义进 main 后再全文改写）。

## Test Plan

1. 无 `outcomePath` 的蓝图（含当前两份内置模板）校验、生成、运行结果与升级前一致。
2. 新模式：`outcomePath` 指向 schema 内可穷举叶子；每个枚举值恰好一条 `outcome` 出边；自由 `string` 拒绝。自定义字段名（如 `$.decision`）可跑通。
3. 业务 `OPTIMIZE` 走回退节点，不走 failure；`null` / schema 失败 / `verifyBranch` 走 `technical`（或无技术边则 `TECHNICAL_FAILURE`）。缺匹配业务边 → `ENDED_NO_OUTCOME_EDGE`，`results[node]` 原样。
4. 命中 `$human-decision` → `ROUTE_HALTED` + `reason=HUMAN_DECISION`，不改写触发节点结果，不发 `WAITING_HUMAN`。HD 出边校验接受、运行时不走。
5. 走通性：结构边 = success ∪ `outcome`；有出口的业务 SCC 合法；无出口环拒绝；旧 success 环仍拒；走通性不看 `countRound`。
6. `completionPath`：仅有结构边到 `$end` 的非 fanout 可声明；`DONE` 上 `{ type, node, path } | null`；缺值仍 DONE；停机/失败不加该字段。
7. fanout 声明 `outcomePath` / `completionPath` / `outcome` 边 / `on: technical` 被拒；`failOn` 仍走 failure。
8. 保存/重开新字段不丢失。Preset JSON 存在且校验不强制选用。
9. 夹具：不得为制造 Completion 或额度耗尽而改写节点业务结果。有环 E2E 联合 #73/#82，不在本 issue 冒充额度闸门。

## Implementation tickets

垂直切片（路径已清，按 M 拆）：

- [#126](https://github.com/crystepj-max/workflow-manager/issues/126) 契约与校验（frontier）
- [#127](https://github.com/crystepj-max/workflow-manager/issues/127) 编译与运行时（blocked by #126）
- [#128](https://github.com/crystepj-max/workflow-manager/issues/128) VWF 往返（blocked by #126）

## Risks & Open Questions

- [不阻塞] 工作树 `generate.mjs` 已有 `WAITING_HUMAN` 草稿（#72 方向）。#77 新模式命中 `$human-decision` **必须**发 `ROUTE_HALTED`，不得并进 `WAITING_HUMAN`。
- [可并行] #72 把 `ROUTE_HALTED` 映射为 `WAITING_HUMAN` 并走出边；#121 业务 Result 续跑依赖本提案的 HD 出边编码。
- [可并行] #73 额度会计；本提案只保证 `countRound` 落盘与「不改写 Outcome」夹具。
- [可并行] #79 把 `completion` 抄到 Logical Run Summary；本提案不写 `runs/`。
- [可并行] #75 Preset 选择器与画布；本提案只提供 JSON 目录与往返无损。
- [可并行] #82 四套正式模板；有环回退 E2E 须等 #73。
- [不阻塞] `CONTEXT.md` 全文改写时机仍是新语义进入 main 之后。
