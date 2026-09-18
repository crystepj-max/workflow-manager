---
task_id: FEAT-77
title: M5 夜间批次调度器实现
type: FEAT
status: 定义中
priority: P1
remote: cnb#77
slug: night-batch-dispatcher
created: 2026-09-17
---

# FEAT-77 M5 夜间批次调度器实现

## 背景

夜间批次原先由 M4 定时触发器唤起 M3 执行计划，在**单个会话内**管理多个任务的筛选、排序与施工（旧形态）。本轮迭代实现了 M5 夜间批次调度器：每任务开**一个独立 AI CLI 会话**（非 subagent），自带看门狗、`release-event.json` 结束契约、并发补位与批次报告，把调度逻辑从长提示词下沉到脚本。

实现代码在 main 工作树上以未提交改动形式存在（无工单归属），本票为补票入账。

## 范围

以下文件归属本票，迁入 `feat/FEAT-77-night-batch-dispatcher` 分支提交：

- `scripts/ai-task-dispatcher.mjs` — 调度器主体（候选采集→快照冻结→并发拉起独立会话→看门狗→补位→批次报告）
- `scripts/ai-task-candidate-collect.mjs` — 待办清单抓取
- `scripts/night-batch-session-prompt.md` — 单任务会话提示词默认模板
- `scripts/night-batch-machine.example.json` — 运行机器配置样例
- `docs/design/night-batch-dispatcher.md` — 调度器设计文档
- `scripts/test/ai-task-candidate-collect-m5.test.mjs` — 候选采集测试
- `scripts/test/ai-task-night-dispatch-m5.test.mjs` — 调度器测试
- `scripts/test/fixtures/night-batch/` — 测试 fixtures
- `scripts/ai-task-execution-plan.mjs` — 联动改动（对账函数被调度器复用）

## 验收标准

- [ ] 上述文件已提交至 `feat/FEAT-77-night-batch-dispatcher` 分支，main 工作树恢复干净
- [ ] `npm run validate:task-context` 通过
- [ ] 调度器 `node scripts/ai-task-dispatcher.mjs <schedule> --dry-run` 能抓到候选并排出启动顺序
- [ ] 单任务会话提示词渲染正常（占位符 `{{TASK_ID}}` 等由调度器填充）
- [ ] 登记册、看板与本卡同步入库

## 关联

- **FIX-76**（cnb#76，M5 调度器内建登记册对账）：治本项。FIX-76 落地后，总控提示词（`night-batch-prompt-v2.md`）的第 0 步手动对账可移除，本票调度器链路仍保持正确。
