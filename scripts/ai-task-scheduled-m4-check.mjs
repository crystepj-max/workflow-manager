#!/usr/bin/env node
/** Verify the former local-registry scheduler is historical and cannot trigger work. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const doc = fs.readFileSync(path.join(root, 'docs/design/ai-task-define-delivery/scheduled-trigger-m4.md'), 'utf8')
if (!/已退役/.test(doc) || !/Multica/.test(doc)) errors.push('M4 说明须标明退役并指向 Multica')

const trigger = path.join(root, 'scripts/ai-task-scheduled-trigger.mjs')
const result = spawnSync(process.execPath, [trigger], { encoding: 'utf8', cwd: root })
if (result.status !== 2) errors.push(`旧 M4 CLI 应以 2 退出，实际 ${result.status}`)
let out
try { out = JSON.parse(result.stderr) } catch { errors.push(`M4 CLI 未返回 JSON 原因：${result.stderr}`) }
if (out?.code !== 'legacy_scheduler_disabled') errors.push(`M4 CLI 原因码错误：${out?.code ?? '无'}`)
if (!/未读取旧登记册/.test(out?.reason ?? '')) errors.push('M4 CLI 未说明其无旧登记册副作用')

if (errors.length) {
  console.error('M4 退役检查失败：')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  milestone: 'M4',
  state: 'historical',
  cli: 'legacy_scheduler_disabled',
  effects: 'no_registry_read_no_plan_no_run',
}, null, 2))
