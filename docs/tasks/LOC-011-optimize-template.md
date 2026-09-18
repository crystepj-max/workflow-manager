# LOC-011 · 优化 · 快速迭代正式模板

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-011` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W2，#82 优化） |
| 任务名称 | 优化快速迭代正式模板 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无（#77/#72/#73 引擎能力已就绪） |
| 施工环境组 | LOC-011 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

按规格 §9.2 新增 `templates/optimize.json`：目标确认（生成并冻结 evaluation contract）→ 执行（最小必要修改，保护已满足部分）→ 评估（只输出 `PASS / OPTIMIZE / CONFIRM`）→ 收口。自动回退额度默认 3；完成类型区分 `EVALUATION_PASSED / USER_ACCEPTED`。

### 涉及范围

- 做：新蓝图（新语义：`outcomePath` + 业务边 + `countRound`）；`OPTIMIZE → 执行` 边 `countRound: true` 消耗额度；`CONFIRM` 升 `$human-decision`；`RECONFIRM_REQUIRED` 由执行节点输出（不是评估裁决）、回目标确认且 `countRound: false`；行为测试（runtime harness 剧本）。
- 不做：UI；Formal Record 消费强绑（LOC-008 通道就绪后自然获得）；workspace 策略内核变更（resource_kind 通道依赖 LOC-009，未就绪前可用运行参数临时传入）。

### 验收标准

- [ ] `OPTIMIZE → 执行` 消耗额度；额度耗尽返回 `WAITING_HUMAN + MAX_ROUNDS_REACHED` 且评估节点原结果不被改写
- [ ] `CONFIRM` 升人工决策；决策材料包含冻结的 evaluation contract 摘要
- [ ] `RECONFIRM_REQUIRED → 目标确认` 不消耗额度（history 仍记录）
- [ ] 正常 / 回退 / 确认 / 额度耗尽四路径测试绿；`npm run generate`、`npm run validate` 全绿
- [ ] workspace 策略：Git 代码修改 → ISOLATED_WRITE；非 Git 文档/配置 → SANDBOX（依赖 LOC-009 或临时参数，实施时明确）

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §9.2；任务"小"不能成为退回共享 cwd 的理由（同 §6.2）。蓝图字段契约：`docs/design/blueprint-schema.md`；业务结果枚举参考 `docs/design/outcome-presets.json`。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
