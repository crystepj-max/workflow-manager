# M3 交付报告｜Execution Plan（批量调度）

> 日期：2026-09-05  
> 分支：`feat/ai-task-execution-plan-m3`（基于已拆刀的 M2）  
> 上游：实施任务书 V0.1 §7 / §10 M3  
> 依赖：公共契约 + 单任务交付（#167）；定义 Skill 正本在 my-agent-skills

---

## 完成内容

1. **产品说明**：`docs/design/ai-task-define-delivery/execution-plan-m3.md`
2. **Skill 入口**：`dsh/skills/execution-plan/SKILL.md`（只调度，不施工）
3. **调度内核**：`scripts/ai-task-execution-plan.mjs`（资格 / 快照 / 排序 / 并发补位 / 汇总）
4. **机械验收**：场景 1（A/P0、B/P1、C/P1，并发=2，A 释放后 C 补位）+ 有依赖未纳入
5. **夹具**：`scripts/test/fixtures/ai-task-execution-plan-m3/`

## 对你意味着什么

- 🟢 白天谈清的多个「已定义」任务，可以按优先级与并发批量开工
- 🟢 有人等到验收或卡住时，会让出名额给下一项，不会堵死整晚
- 🟢 批次结束时有一份汇总：谁在等你验收、谁受阻、谁完成、谁没进本批
- 🟡 本里程碑用事件模拟补位（未接真实 DSH 多 Run 编排）；真实夜间批次与定时属 **M4**
- 🟡 真实 3 任务 dogfood 仍建议在 #167 合入后做

## 验收命令

```bash
node scripts/ai-task-execution-plan-m3-check.mjs
node --test scripts/test/ai-task-execution-plan-m3.test.mjs
```

## 明确非本里程碑

- 定时触发（M4）
- 有依赖任务自动接续
- 运行中抢占 / 动态加入新任务
- Execution Plan 改需求或代签 UAT
