# LOC-012 · 诊断缺陷修复正式模板（任务规格 V1）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应任务卡 | `docs/tasks/LOC-012-diagnose-template.md`（本规格由该卡派生，三要素原样保留） |
| 优先级 | P2（本批次定义；定义卡记录 P1） |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-10T16:28:39.861Z |
| 当前状态 | 本地已定义 |

## 1. 任务目标

按规格 §9.3 新增 `templates/diagnose.json`：缺陷诊断 → 修复 → 审核 → 回归验证 → 收口；`control.maxRounds = 3`（决策②）。先诊断、后修复；原始 feedback signal 贯穿诊断、修复、回归；修复问题回修复、证据推翻根因回诊断；修改后必须重新审核和回归；默认无独立人工验收节点。

## 2. 涉及范围

- 做：新蓝图（新语义全量）；"修复问题 → 修复"与"根因被推翻 → 诊断"两条回退边的 `countRound` 按业务路径声明；证据不足且不可复现时节点输出受阻结果（不猜根因，技术执行层面沿 failure/technical 兜底）；行为测试。
- 不做：独立人工验收节点（规格：默认无）；UI；workspace 内核变更。

## 3. 验收标准

- [ ] `maxRounds=3` 生效；回退路径 E2E：修复问题 → 修复、证据推翻根因 → 诊断
- [ ] 额度耗尽 `WAITING_HUMAN + MAX_ROUNDS_REACHED`，原 Node Business Outcome 保留
- [ ] 诊断从冻结 Source 开始，与修复同一 workspace lineage（诊断针对 commit A、修复却在 commit B 的情形被阻断，依赖 LOC-009 或以 verified_head 断言兜底）
- [ ] 正常 / 回退 / 受阻 / 额度耗尽四路径测试绿；`npm run generate`、`npm run validate` 全绿

## 4. 详细规格与权威资料

- 产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §9.3
- workspace 默认 `ISOLATED_WRITE`、`freeze_from=diagnose`（`docs/design/workspace-isolation.md` §2）
- 额度数值 3 为用户 2026-09-11 决策②，规格 §14 相应条目随本卡关闭

## 5. 决策与边界说明

- 决策②（2026-09-11 用户确认）：默认自动回退额度 = 3。
- 未决产品事项：0（基线 V1 经用户会话指令确认，开发计划表 v2 落卡，决策②已落卡）。
