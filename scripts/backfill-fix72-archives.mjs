#!/usr/bin/env node
// 旧登记册驱动的批量归档回填已退役；历史归档只允许按明确证据逐项处理。
console.error(JSON.stringify({
  ok: false,
  code: 'legacy_task_registry_backfill_disabled',
  reason: '本命令未读取或改写 registry.json、BOARD.md 或历史归档。',
  remediation: '对单项归档缺口先核实真实来源与内容，再由负责人决定是否补录。',
}, null, 2));
process.exit(2);
