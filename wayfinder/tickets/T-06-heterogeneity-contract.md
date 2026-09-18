---
id: T-06
title: 异源 enforcement 契约（v2）
type: grilling
labels: [wayfinder:grilling]
status: closed
assignee: charting-session-2026-08-19
blocked-by: []
resolved: 2026-08-19（grilling 两轮全树确认）
---

## Question

FR-8 异源异模型 enforcement 的**精确契约**是什么？——规格已定「仅 dev↔review」+「save/update 拒绝同 provider」+「过渡期 host.js save/validate 双保险」，但执行细节待定。

## 待决策点

- 判定粒度：provider 不同即通过？同 provider 但模型不同（现 dev=v4-pro、review=v4-flash，同 provider）——拒。判定是 provider 级还是 provider+model 级（规格「至少不同模型」暗示 model 级也要强制？）。
- 强制点：仅 save/validate（规格明示）还是 engine start 也拦？错误消息契约（AC-8 要求「dev/review 同 provider」类错误）与 HTTP/API 返回形态。
- 绑定配置的默认值：蓝图 per-entry 绑定配置缺省时如何处置（沿用 host.js 现状全 deepseek-official 即被拒？还是给推荐默认）。
- 测试用例：AC-8 的正反例（全同 provider 拒、推荐异源分配过）。

## 备注

HITL：grilling 票；无阻塞、已可决策（v2 执行时落地）。依赖 T-01 的绑定配置形态。

## Resolution（2026-08-19，grilling 两轮全树确认）

**判定粒度（Q1，消解规格措辞冲突）**：判定键 = provider+model 组合——不同 provider → 过；同 provider 不同 model（弱异源）→ 过 + warning；同 provider 同 model → 拒。与现状弱异源语义连续；AC-8 用例相应明确为「完全同模型被拒」（现模板 dev=v4-pro/review=v4-flash 为弱异源，save 通过+警告）。
**强制点（Q2）**：save / update / validate 三处校验；engine start 不拦（蓝图已过校验）；DSH 脚本 heteroCheck 退化为运行时陈述性日志。
**范围与缺绑定（Q3）**：全局强制（凡含 dev+review 节点的蓝图一律校验）；dev/review 任一缺 `bindings.models` → 拒（无法证明异源，提示显式配置）；无 dev/review 节点跳过。
**错误契约（Q4）**：沿用 `errors[]` 结构（at=`bindings.models`，消息含实际 provider/model + 修复指引）；缺绑定单独文案。
**测试用例（Q5，AC-8 细化 6 例）**：T1 完全同模型拒 / T2 弱异源过+警告 / T3 真异源过 / T4 缺绑定拒 / T5 无 dev/review 跳过 / T6 update 同 save。
**联动**：blueprint-schema.md §2.1 heteroCheck 语义更新 + §3.1 新增规则 7（异源硬规则，v2 生效）；地图 fog「CI 细化」剩余项 = 多模板回归（异源校验集成已随本票落定）。

## Supersession（2026-09-14，LOC-021 修订）

本票 Resolution 中 **Q2/Q3 的「全局强制」口径已被 LOC-021「异源档位三态可配置」修订**（规格 `docs/tasks/archive/LOC-021/task-spec-V1.md` V1；决策 D1/D1-b/D2/D6）：

- **判定粒度（Q1）**：保留——关/弱两档语义与本票一致（弱档 = 弱异源过 + 完全同模型拒）。
- **强制范围（Q3）**：**由「全局强制」改为按蓝图 `heteroCheck` 档位生效**——`"off"` 不校验、`"weak"`（默认）为本票原口径、`"strong"` 要求 provider 必须不同。档位缺失或旧布尔 `true` → 弱档（存量蓝图行为不变）；旧布尔 `false` → 关档。
- **强制点（Q2）**：保留 save / update / validate 三处；engine start 仍不拦（由三处校验前置保证）。
- **heteroCheck 语义（Q1/Q2 附带结论）**：**不再是「退化为运行时陈述性日志」**——异源档位是蓝图属性，同时驱动 save/validate 校验强度与运行时日志；运行时日志识别口径统一为按节点 `id` 或 `profile`（修复诊断模板开发节点 id=`fix` 时日志不触发）。
- **配对范围**：保留——仍只 `dev↔review` 一对，`dev↔test`、`execute↔evaluate` 不纳入。

权威契约现以 `docs/design/blueprint-schema.md` 字段语义行 + §3.1 规则 4/7 为准（已同步修订）。本票保留为历史决策记录。
