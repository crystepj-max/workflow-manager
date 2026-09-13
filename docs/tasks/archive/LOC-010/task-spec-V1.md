# LOC-010 · 建设工作流正式化与需求分析技能串联（任务规格 V1）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应任务卡 | `docs/tasks/LOC-010-construction-formal.md`（本规格由该卡派生，三要素原样保留） |
| 优先级 | P0（本批次定义；定义卡记录 P1） |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-10T16:28:39.750Z |
| 当前状态 | 本地已定义 |

## 1. 任务目标

把 M2 交付版 `templates/construction-full-feature.json`（实施前检查 → 开发 → 收敛审查 → 测试 → UAT → 收口，业务结果路由全量新语义）收敛为 #82 的正式"建设 · 完整功能开发" Built-in：需求分析与方案设计前置门由既有 `requirements-analysis` skill 承担（决策①），两者串联覆盖"定义 → 交付"完整开发流程。规格 §9.1 的 7 节点链以"需求分析 skill + 建设工作流"组合达成，不再单独建图。

## 2. 涉及范围

- 做：requirements-analysis skill 产出（任务规格 Vn、已定义状态、无人值守许可、前置依赖=无）作为 `wf_run` 入参传给 preflight 节点的契约固化（args 字段与 preflight goal 文案逐项对齐）；生成 SKILL.md runbook 补"需求分析 → 建设工作流"衔接说明；模板 displayName/description 触发词更新；如需微调 preflight goal 走 V2 基线流程。
- 不做：蓝图拓扑重构（保持 M2 主链与既有节点/边）；新增需求/设计节点；编辑器改造（LOC-001/005 范围）。

## 3. 验收标准

- [ ] 真实任务从 requirements-analysis 定义到建设 Run 收口全流程走通（真机 E2E）
- [ ] 四条路径 E2E：正常交付 / RETURN_DEV 退回（消耗额度）/ UAT 三态（ACCEPT / REJECT / CONDITIONAL_PASS）/ NEED_REDEFINE 回定义
- [ ] preflight 节点拒绝未定义任务（E2E 反例：缺已定义状态或无人值守许可时 route=BLOCKED，不进入开发）
- [ ] `npm run generate`、`npm run validate` 全绿；dist 一致性通过

## 4. 详细规格与权威资料

- 模板真源：`templates/construction-full-feature.json`
- 产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §9.1（建设链与人工验收为正式业务阶段）
- 定义入口契约：`docs/design/ai-task-define-delivery/`（skill-set + public-task-contract）
- 完成类型权威：closeout `completionPath=$.completion_type`（DELIVERED）

## 5. 决策与边界说明

- 决策①（2026-09-11 用户确认）：M2 版升级为正式版，搭配已有需求分析 skill 覆盖整个开发流程，不另建 7 节点版。
- 未决产品事项：0（基线 V1 经用户会话指令确认，开发计划表 v2 落卡，决策①已落卡）。
- 真机 E2E（产品模式验收）需用户配合关闭开发 DSH、重启产品 DSH 后进行；无人值守施工阶段完成到等待验收，不代签。
