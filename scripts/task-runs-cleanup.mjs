#!/usr/bin/env node
// 旧登记册驱动的自动清理已退役。此入口在任何文件读取或删除前明确拒绝。
console.error(JSON.stringify({
  ok: false,
  code: 'legacy_task_registry_cleanup_disabled',
  reason: '旧登记册不再是当前 Task 状态来源；本命令未读取或删除任何运行证据。',
  remediation: '保留 .agent-runs 明细，按已批准的独立证据保留策略处理。',
}, null, 2));
process.exit(2);
