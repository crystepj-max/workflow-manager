# OpenSpec 提案：human-decision

> 对应 issue #72；决策地图 #94。用户确认：#95–#101（2026-08-30）。

## OpenSpec

human-decision

## Problem Statement

当前人工等待只有节点级二态门禁：`manualCheck` → `AWAITING_HUMAN_<id>` → `approved` 布尔。系统不能按 Blueprint 声明的条件请用户做结构化取舍；不批准去向写死在 skill 手册里；验收和「要不要继续」混在同一套布尔里。用户无法在自动节点命中 `CONFIRM` 或额度耗尽时看到完整决策材料并留下不可覆盖的选择，也无法在刷新后按同一身份恢复。

## Proposed Solution

Human Decision 成为框架控制能力，不是业务角色、也不是每个工作流的固定节点。

自动节点只有 Blueprint 把某 Outcome 指到 Human Decision 时才升级（校验 + 运行时双闸）。业务验收节点与条件升级、额度耗尽共用同一套运行时：同一 Package / Result / Record / 恢复协议，用 `WAITING_HUMAN.reason` 区分因由。

人看到的卡由节点专业材料 + 框架按蓝图选项组装；硬必填是原因、现状、选项、选择后效果，其余允许显式未知。框架标准 Result 只有控制类 `USER_ACCEPTED` / `ADD_BUDGET` / `STOP`；业务枚举和业务去向由该工作流 Blueprint 声明。#77 命中 `$human-decision` 停在 `ROUTE_HALTED`；#72 翻译为 `WAITING_HUMAN` 并在用户选择后执行蓝图出边或框架控制行为。`ADD_BUDGET` 保留原 Outcome、续跑被额度拦住的自动边。`STOP` 只停本 Run。只有用户明确选新目标/新范围才派生新 Run。

选择写入追加-only 控制面事件（恢复权威），#78 再提升为 Formal Revision（证明权威）。新蓝图走新协议；残留 `manualCheck` 冷冻为今天的引擎行为直到废弃，不做适配器。

## Changes

- `docs/design/blueprint-schema.md`: modify — 增加 Human Decision 规则、控制类 Result、`WAITING_HUMAN` 语义；修正 §6.2 使与引擎事实及新模型一致（旧 manualCheck 段标明残留行为）。
- `scripts/validate-core.cjs`: modify — 无声明不得升级；默认控制选项可覆盖不可删光；fanout/worker 禁止 Human Decision；新蓝图拒绝 `approved`。
- `scripts/generate.mjs`: modify — 编译挂起/恢复；`ROUTE_HALTED` → `WAITING_HUMAN` + Package 组装；控制类 Result 解释；删除 skillWrap 写死 `entry=dev` / `entry=closeout`。
- `scripts/test/`: modify — 新路径 E2E（自动流转、条件升级、刷新恢复、选择后续跑）；残留 `manualCheck` 仍按 1A 回归。
- `packages/dsh-visual-workflow/src/`: modify — 宿主占用同时认 `WAITING_HUMAN` 与残留 `AWAITING_HUMAN_*`；新续跑 args；不实现卡片页面位置（归 #75），须能投影 Package 字段。
- `dsh/skill/SKILL.md`: modify — 去掉固定回 `dev` / 直接 `closeout`；按 Decision Result 续跑。
- `dsh/roles/`: modify — 验收/评价角色产出作为 Package 输入，不代签、不指定 next_node。
- `templates/`: modify — 仅当某模板声明 Human Decision 时采用新规则；旧 `manualCheck` 暂不改行为（#82 再迁）。
- `specs/human-decision/`: create — 本提案。

## Test Plan

1. 新蓝图：自动节点仅在声明的 Outcome 下进入 `WAITING_HUMAN`；无声明时 Agent 请求被拒（校验或运行时）。
2. Package 缺「原因/现状/选项/后果」不得挂起；成本等为「未知」仍可挂起。
3. 额度耗尽：原 Outcome 不变；默认至少可 `USER_ACCEPTED` / `ADD_BUDGET` / `STOP`；`ADD_BUDGET` 后续按被拦边续跑且 Outcome 仍旧。
4. `USER_ACCEPTED` 完成不把 Evaluator Outcome / Baseline 改成 PASS。
5. 刷新或重进会话后 Package 与 `decision_id` 仍在；`user_choice` 后续跑仍是同一 `taskId`。
6. 残留 hello/`manualCheck`：`approved:false` 仍再挂起、不走 failure（#95=1A）。
7. 新蓝图传入 `approved` 被拒绝。fanout 声明 Human Decision 被校验拒绝。
8. skill 生成物不再出现写死的「不通过 → entry=dev」。

## Implementation tickets

- #116 契约键名 + 校验（frontier）
- #117 去掉 skill 硬编码 + 残留 1A（frontier）
- #118 WAITING_HUMAN + Package（blocked by #116）
- #119 控制类 Result（blocked by #118）
- #120 宿主占用与刷新（blocked by #118）
- #121 业务 Result 续跑（blocked by #118, #88）
- #122 E2E（blocked by #121 #119 #120 #117 #88）

## Risks & Open Questions

- [阻塞实施] JSON 字段名由 #116 钉死。
- [阻塞实施] #88 未关则 #121/#122 不得开工；#118 可用注入停机，不得冒充新蓝图 E2E。
- [可并行] #73 额度会计；本提案只假设「已耗尽」信号与 `ADD_BUDGET` 挂钩。
- [可并行] #75 卡片页面位置；本提案只保证 Package 可渲染。
- [可并行] #79 `logical_run_id` / Snapshot；过渡用 `taskId`。
- [可并行] #78 Formal 投影；#72 先交控制面事件。
- [可并行] #82 旧内置迁自定义并去掉 `manualCheck`。
- [不阻塞] `BASELINE_CONFIRM` 是否单独 reason：不锁，按是否为模板正式人工阶段以后补。
