#!/usr/bin/env node
/**
 * M2 当前建设交付契约检查：Multica 是唯一任务源，旧本地 preflight 不属于当前入口。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootIndex = process.argv.indexOf('--root')
const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : path.resolve(here, '..')
const errors = []
function read(rel) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) {
    errors.push(`缺少文件：${rel}`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}
function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message)
}

const m2 = read('docs/design/ai-task-define-delivery/single-task-delivery-m2.md')
requireMatch(m2, /Multica Task/, 'M2 当前交付契约须以 Multica Task 为任务源')
requireMatch(m2, /construction-preflight-gate\.mjs/, 'M2 须指向当前 Multica 施工门禁')
requireMatch(m2, /不回退到本地 `registry\.json`/, 'M2 须明确禁止回退到本地登记册')
requireMatch(m2, /auto_rework_limit\s*=\s*3|返工上限.{0,8}3/, 'M2 须保留自动返工上限 3')
requireMatch(m2, /conditional_pass|有条件通过/, 'M2 须保留有条件通过状态')

const blueprint = read('templates/wf-construction-full-feature.json')
requireMatch(blueprint, /"mechanical":\s*"construction-preflight"/, '完整功能蓝图须调用建设机械门禁')
requireMatch(blueprint, /args\.multicaTaskId/, '完整功能蓝图须以 Multica Task UUID 输入')
requireMatch(blueprint, /严禁读取 docs\/tasks\/registry\.json/, '完整功能蓝图须禁止本地登记册回退')

const gate = read('scripts/construction-preflight-gate.mjs')
requireMatch(gate, /multica-task-preflight\.mjs/, '建设门禁须调用 Multica preflight')

const preflight = read('docs/design/ai-task-define-delivery/preflight-check.md')
requireMatch(preflight, /Multica/, '施工前检查说明须描述 Multica 任务源')
requireMatch(preflight, /registry\.json|BOARD\.md/, '施工前检查说明须明确禁止旧账本回退')

const runbook = read('docs/runbooks/construction-dsh/runbook.md')
requireMatch(runbook, /Multica Task|Multica 任务/, 'DSH 建设 runbook 须以 Multica Task 开工')
requireMatch(runbook, /UAT/, 'DSH 建设 runbook 须保留 UAT 收口')

const uatCard = read('docs/design/ai-task-define-delivery/uat-card-template.md')
requireMatch(uatCard, /执行时机/, 'UAT 卡模板须含执行时机字段')

const oldCli = read('scripts/ai-task-preflight-check.mjs')
requireMatch(oldCli, /legacy_task_preflight_disabled/, '旧任务卡 preflight CLI 须 fail-closed')

if (errors.length) {
  console.error('M2 检查失败：')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  milestone: 'M2',
  taskSource: 'multica',
  legacyLocalPreflight: 'disabled',
  auto_rework_limit: 3,
  acceptance: ['accept', 'reject', 'conditional_pass'],
}, null, 2))
