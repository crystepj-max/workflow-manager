#!/usr/bin/env node
// 旧登记册/任务卡同步门禁已退役；当前任务状态由 Multica 管理。
console.error(JSON.stringify({
  ok: false,
  code: 'legacy_task_context_check_disabled',
  reason: '本检查不读取 registry.json、BOARD.md 或旧任务卡。',
  remediation: '使用 Multica Task 与 construction-preflight-gate.mjs 核对当前开工资格。',
}, null, 2));
process.exit(2);
