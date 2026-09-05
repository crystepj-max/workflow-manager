# M2 交付报告｜单任务交付（定义外置）

> 日期：2026-09-05  
> 分支：`feat/ai-task-deliver-m2`（基于 `feat/ai-task-define-m1`）  
> 上游：AI 任务定义与批量交付工作流 V0.1 + 实施任务书 V0.1  
> 产品拍板：定义外置；返工上限 **3**；验收严格三态；不新建第二交付入口

---

## 完成内容

1. **产品主链改造**：建设 Skill / runbook 改为「实施前检查 → 开发 → 收敛审查 → 测试 → UAT 验收卡 → 等待验收 → 收口」；从「已定义」开工，交付中不再重开需求分析/方案设计人工门
2. **实施前检查**：清单 + 机械脚本（状态/无人值守/版本一致/前置依赖=无等）；失败即执行受阻
3. **验收严格三态接线**：交接包枚举改为 `accept` / `reject` / `conditional_pass`；废弃 `user_accepted`；有条件通过须保留优化意见并正常收口
4. **自动返工上限 3**：文档与预检输出明示 `auto_rework_limit = 3`（与建设默认额度对齐）
5. **UAT 验收卡模板**与 M2 桥接说明、外部 Profile runbook 同步
6. **机械验收**：`scripts/ai-task-deliver-m2-check.mjs` + 单测；用 M1 两份已定义示例跑通实施前检查

## 影响范围（业务语言）

- 🟢 已定义好的任务可以直接开工施工，不必在交付里再被问一遍产品决策
- 🟢 人工验收只有三种清晰结果：通过 / 退回 / 有条件通过（后者=这件收口，改进留到下次定义）
- 🟢 自动修修补补最多 3 轮，避免无人值守无限打转
- 🟡 真实会话端到端（开发→等人）仍需产品/研发 dogfood 一次
- 🟡 批量夜间施工（M3）尚未开始

## 本里程碑未修改内容

- 未实现 Execution Plan / 批量补位 / 定时（M3/M4）
- 未做有前置依赖任务的自动接续
- 未新建第二套交付 Skill 入口（仍用建设入口）
- 未在可视化蓝图编辑器里新增独立「完整功能开发」内置模板文件（调用入口仍为建设 Skill；正式 Runtime 收敛属既有路线图）

## 验收场景及结果

| 场景 | 方式 | 结果 |
|---|---|---|
| 已定义简单任务通过实施前检查 | M1 fixture `simple-clear-cache` + preflight | 通过 |
| 已定义含决策复杂任务通过实施前检查 | M1 fixture `complex-with-decisions` + preflight | 通过 |
| 非已定义不得开工 | 临时改状态为「定义中」 | 机械拒绝 |
| 验收三态 schema | handoff.schema + cwf-validate 探针 | 通过 |
| 废弃 user_accepted | schema 负例 + evidence-verify 拒绝放宽通道 | 通过 |
| 返工上限 = 3 | 文档 + 预检 JSON | 通过 |
| 真实会话跑到等待验收 | — | **待人工 dogfood** |
| 验收退回 / 有条件通过原 Run 继续 | 流程已写入 runbook | **待人工 dogfood** |

机械命令：

```bash
node scripts/ai-task-deliver-m2-check.mjs
node --test scripts/test/ai-task-deliver-m2.test.mjs scripts/test/cwf-validate.test.mjs scripts/test/cwf-evidence-verify.test.mjs scripts/test/cwf-record.test.mjs
```

## 已知限制

- 本环境未对真实 GitHub Issue 跑完整「开发→审查→测试→UAT→等人」会话
- Portable Contract 正文仍保留旧七阶段证据叙事；产品冲突时以 M2 overlay + 公共契约为准（文档头已声明）

## 发现但未处理的非本次问题

- 可视化「完整功能开发」正式 Built-in 模板与 #105 收敛仍属既有 epic，未在本里程碑新建蓝图 JSON
- 上游规格正文仍写返工 2 次——继续以产品拍板 3 为准

## 下一里程碑是否具备启动条件

**具备启动 M3 的交付契约前提**：单任务主链、实施前检查、三态验收、返工上限 3、WAITING_HUMAN 语义已在仓库落地。

建议 M3：Execution Plan（候选筛选、快照、并发、补位、批次汇总）；勿在单任务未 dogfood 前放大批量。
