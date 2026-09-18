# P0 工作流需求开工资格清单

本轮对象为 10 条 P0，正式编号 LOC-024–033。已完成每条 19 节完整规格、41 条验收标准、Definition Check 材料与实际 preflight；用户已于 2026-09-14T10:05:31Z 确认 V1 基线、规则、环境安排和施工许可，10 条现已登记为“本地已定义”。

| 来源 | 正式任务 | 名称 | 当前状态 | 硬前置 |
|---|---|---|---|---|
| WR-001 | [LOC-024](LOC-024-node-input-handoff.md) | 显式交接节点输入与返工反馈 | 本地已定义 | 无 |
| WR-002 | [LOC-025](LOC-025-verdict-consistency.md) | 阻止互相矛盾的裁决进入下一质量关口 | 本地已定义 | 无 |
| WR-003 | [LOC-026](LOC-026-candidate-proof.md) | 将审核与测试证明绑定到真实候选成果 | 本地已定义 | 无 |
| WR-004 | [LOC-027](LOC-027-evaluation-baseline.md) | 系统冻结并核验优化评价契约 | 本地已定义 | 无 |
| WR-005 | [LOC-028](LOC-028-human-completion.md) | 人工接受完成必须具备真实决定与版本来源 | 本地已定义（等待 LOC-026 完成） | LOC-026 |
| WR-006 | [LOC-029](LOC-029-attempt-durability.md) | 逐次持久化节点执行与成果提交 | 本地已定义 | 无 |
| WR-009 | [LOC-030](LOC-030-blocked-lifecycle.md) | 统一受阻、恢复与完成的生命周期语义 | 本地已定义 | 无 |
| WR-011 | [LOC-031](LOC-031-technical-budget.md) | 限制技术重试、超时与无进展循环 | 本地已定义 | 无 |
| WR-012 | [LOC-032](LOC-032-operation-idempotency.md) | 恢复执行时防止重复外部动作 | 本地已定义 | 无 |
| WR-013 | [LOC-033](LOC-033-role-boundaries.md) | 收敛内置角色职责并由节点提供场景信息 | 本地已定义 | 无 |

- [具体 V1 确认单](p0-definition-confirmation-2026-09-14.md)
- [材料校验结果](p0-definition-material-check-2026-09-14.json)
- [确认后的实际开工检查摘要](p0-definition-preflight-2026-09-14.json)
- [任务映射与规格摘要](p0-workflow-manifest.json)

本版本属本地轨道，GitHub 返回 403；任务卡/登记册是交付载具，GitHub 同步 pending。CNB 不作为本批已定义的事实来源。

已完成处理：确认记录与时间已写入，Definition Check、卡片和登记册已同步，并完成确认后的预检。10 条任务的资格字段预检均通过；9 条独立任务可以进入环境解析，LOC-028 的成员环境门禁仍须等待 LOC-026 实际交付完成并沿用其环境。定义完成不能代替依赖完工。详见 [确认后预检](p0-definition-preflight-2026-09-14.json)。

定义阶段不启动建设、不创建运行或假环境；详细规格和定义证据现已位于受 Git 跟踪的 `docs/tasks/specs/` 与 `docs/tasks/p0-*`。原有 23 条任务内容不变，后续施工仍须携带对应 V1 规格并遵守依赖门禁。
