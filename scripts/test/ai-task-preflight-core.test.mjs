// LOC-003：runPreflight 结构化接口直测（不经子进程、不退出）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPreflight, specOpenItemsZero } from '../ai-task-preflight-check.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-core-'))
}

const SPEC = `# 任务规格 V1

**版本**：V1

未决产品事项：0
`

const DEF_CHECK = `# Definition Check

| 未决产品事项 | 0 |

- [x] 全部通过
`

function writeBasics(dir, fields, specText = SPEC, specName = 'task-spec-V1.md') {
  const rows = Object.entries(fields).map(([k, v]) => `| ${k} | ${v} |`).join('\n')
  const basicsPath = path.join(dir, 'task-basics.md')
  const specPath = path.join(dir, specName)
  fs.writeFileSync(basicsPath, `# 任务基本信息\n\n| 字段 | 值 |\n|---|---|\n${rows}\n`)
  fs.writeFileSync(specPath, specText)
  fs.writeFileSync(path.join(dir, 'definition-check.md'), DEF_CHECK)
  return { basicsPath, specPath }
}

const BASE = {
  任务名称: '示例任务',
  任务类型: '完整功能开发',
  优先级: 'P1',
  当前状态: '已定义',
  需求基线版本: 'V1',
  前置依赖: '无',
  施工环境组: 'LOC-000',
  施工环境角色: '独立',
  无人值守许可: '允许',
  任务规格位置: '.scratch/x/task-spec-V1.md',
  定义时间: '2026-09-09T00:00:00Z',
}

test('runPreflight：合法任务返回结构化结果且含进程内消费字段', async () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, BASE)
  const r = await runPreflight(basicsPath, specPath, { runBaseline: 'V1', repo: dir })
  assert.equal(r.ok, true)
  assert.deepEqual(r.failures, [])
  assert.equal(r.fields.status, '已定义')
  assert.equal(r.fields.track, 'github')
  assert.equal(r.fields.name, '示例任务')
  assert.equal(r.fields.defined_at, '2026-09-09T00:00:00Z')
  assert.equal(r.fields.priority, 'P1')
})

test('runPreflight：受阻任务返回 ok:false + failures，不抛出不退出', async () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, { ...BASE, 无人值守许可: '不允许' })
  const r = await runPreflight(basicsPath, specPath, { repo: dir })
  assert.equal(r.ok, false)
  assert.equal(r.fields, null)
  assert.ok(r.failures.some((f) => f.includes('无人值守许可')))
})

test('runPreflight：文件缺失返回失败而非抛出', async () => {
  const dir = tmpdir()
  const r = await runPreflight(path.join(dir, 'nope.md'), path.join(dir, 'nope-spec.md'))
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.includes('文件不存在')))
})

test('runPreflight：Run 绑定版本不一致进入 failures', async () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, BASE)
  const r = await runPreflight(basicsPath, specPath, { runBaseline: 'V2', repo: dir })
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.includes('Run 绑定版本不一致')))
})

test('runPreflight：需求基线缺失时记失败而非崩溃（2026-09-20 夜批评估回归）', async () => {
  const dir = tmpdir()
  const fields = { ...BASE }
  delete fields['需求基线版本']
  const { basicsPath, specPath } = writeBasics(dir, fields)
  // 规格含版本号而卡缺基线：修复前对 null baseline 调 toUpperCase 会抛 TypeError
  const r = await runPreflight(basicsPath, specPath, { runBaseline: 'V1', repo: dir })
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.includes('需求基线版本缺失或非法')))
})

test('specOpenItemsZero：加粗零（**0**）变体可识别', () => {
  assert.equal(specOpenItemsZero('未决产品事项：**0**。'), true)
  assert.equal(specOpenItemsZero('> 未决产品事项：**0**。'), true)
  assert.equal(specOpenItemsZero('未决产品事项：0。'), true)
  assert.equal(specOpenItemsZero('未决产品事项：2。'), false)
})
