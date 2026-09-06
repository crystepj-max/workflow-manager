# M4 交付报告｜定时触发（到点唤起）

> 日期：2026-09-06  
> 分支：`feat/ai-task-scheduled-m4`  
> 上游：实施任务书 V0.1 §10 M4  
> 依赖：M1–M3 skill 集合已双仓理顺；同一套 Execution Plan（#169 链）

---

## 完成内容

1. **产品短文**：`docs/design/ai-task-define-delivery/scheduled-trigger-m4.md`（到点唤起、约一次、不含工作台/每晚循环）
2. **试跑清单**：`docs/design/ai-task-define-delivery/m4-e2e-trial.md`（机械对照 + 3～5 真实任务闭环）
3. **到点启动**：`scripts/ai-task-scheduled-trigger.mjs`（只判断到点 → 唤起 `ai-task-execution-plan.mjs` → 写夜间报告）
4. **夜间批次报告**：对齐 M3 汇总字段，加「由到点触发 / 未另写调度」抬头
5. **机械验收**：立即跑 vs 到点跑（`--now`）快照与启动序一致；未到点 pending；夹具 3 任务（A/B/C）
6. **Skill 说明**：`execution-plan` 补充到点预约用法（不新建第二套定时 Skill）

## 对你意味着什么

- 白天谈清的一批任务，可以约一个时刻自动开跑，不必夜里盯着
- 第二天打开夜间报告，就能看到谁等你验收、谁卡住、谁做完
- 立即开工与到点开工规则相同，不会「约了之后换一套排队逻辑」

## 验收命令

```bash
node scripts/ai-task-scheduled-m4-check.mjs
node --test scripts/test/ai-task-scheduled-m4.test.mjs
```

## 明确非本里程碑

- 完整待验收工作台 / 验收快速操作界面
- 每晚常驻循环、漏跑自动补跑、关机错过策略
- 第二套调度规则；有依赖自动接续；运行中抢占
- 批量里改需求或代签验收

## 试跑证据（机械）

夹具 3 任务（复用 M3 场景 A/P0、B/P1、C/P1，并发=2）：到点强制启动后启动序与立即跑一致（A→B，A 释放后补 C）；夜间报告含等待验收与已完成分段。真实 3～5 任务 dogfood 按 `m4-e2e-trial.md` 在合入后执行。
