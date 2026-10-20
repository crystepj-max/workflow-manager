#!/usr/bin/env node
// 旧 M4 触发器依赖本地任务登记册，已退役；Multica/dev-flow 管理当前任务与执行计划。
console.error(JSON.stringify({
  ok: false,
  code: 'legacy_scheduler_disabled',
  reason: '定时任务触发与自动开工入口已退役；本命令未读取旧登记册、未生成计划或启动 Run。',
  remediation: '当前任务状态与执行计划通过 Multica/dev-flow 工作流管理。',
}, null, 2));
process.exit(2);
