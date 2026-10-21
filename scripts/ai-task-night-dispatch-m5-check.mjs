#!/usr/bin/env node
/** Verify the former local-registry dispatcher is historical and cannot dispatch work. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const doc = fs.readFileSync(path.join(root, 'docs/design/night-batch-dispatcher.md'), 'utf8')
if (!/历史|已退役/.test(doc) || !/Multica/.test(doc)) errors.push('M5 说明须标明历史状态并指向 Multica')

const dispatcher = path.join(root, 'scripts/ai-task-dispatcher.mjs')
const result = spawnSync(process.execPath, [dispatcher, '/path/that/does/not/exist.json', '--now', '--preview'], {
  encoding: 'utf8',
  cwd: root,
})
if (result.status !== 2) errors.push(`旧 M5 CLI 应以 2 退出，实际 ${result.status}`)
let out
try { out = JSON.parse(result.stderr) } catch { errors.push(`M5 CLI 未返回 JSON 原因：${result.stderr}`) }
if (out?.code !== 'legacy_registry_dispatcher_disabled') {
  errors.push(`M5 CLI 原因码错误：${out?.code ?? '无'}`)
}
if (!/未读取 registry\.json/.test(out?.effects ?? '')) errors.push('M5 CLI 未说明其未读取旧登记册')
if (!/未启动 Run/.test(out?.effects ?? '')) errors.push('M5 CLI 未说明其未启动 Run')

if (errors.length) {
  console.error('M5 退役检查失败：')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  milestone: 'M5',
  state: 'historical',
  blockedReason: 'legacy_registry_dispatcher_disabled',
  effects: 'no_registry_read_no_github_call_no_run',
}, null, 2))
