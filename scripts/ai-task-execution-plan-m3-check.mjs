#!/usr/bin/env node
/**
 * M3 was a local-registry batch planner. Verify it is historical and its CLI stays retired.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const doc = fs.readFileSync(path.join(root, 'docs/design/ai-task-define-delivery/execution-plan-m3.md'), 'utf8')
if (!/历史设计/.test(doc) || !/dev-flow/.test(doc)) {
  errors.push('M3 文档须标明历史设计，并指向 dev-flow 当前计划')
}

const plan = path.join(root, 'scripts/ai-task-execution-plan.mjs')
const batch = path.join(root, 'scripts/test/fixtures/ai-task-execution-plan-m3/batch.json')
const events = path.join(root, 'scripts/test/fixtures/ai-task-execution-plan-m3/events-scene1.json')
const result = spawnSync(process.execPath, [plan, batch, '--simulate', events], {
  encoding: 'utf8',
  cwd: root,
})
if (result.status !== 2) errors.push(`旧 M3 CLI 应以 2 退出，实际 ${result.status}`)
let out
try { out = JSON.parse(result.stderr) } catch { errors.push(`M3 CLI 未返回 JSON 原因：${result.stderr}`) }
if (out?.code !== 'legacy_registry_execution_plan_disabled') {
  errors.push(`M3 CLI 原因码错误：${out?.code ?? '无'}`)
}

if (errors.length) {
  console.error('M3 退役检查失败：')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  milestone: 'M3',
  state: 'historical',
  cli: 'legacy_registry_execution_plan_disabled',
  effects: 'no_registry_read_no_dispatch_no_report',
}, null, 2))
