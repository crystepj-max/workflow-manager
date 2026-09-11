import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ai-task-preflight-check.mjs')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'))
}

const SPEC = `# 任务规格 V1

**版本**：V1

未决产品事项：0

已确认的关键决策：无
`

function writeBasics(dir, fields) {
  const rows = Object.entries(fields)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n')
  const basics = `# 任务基本信息

| 字段 | 值 |
|---|---|
${rows}
`
  const basicsPath = path.join(dir, 'task-basics.md')
  const specPath = path.join(dir, 'task-spec-V1.md')
  fs.writeFileSync(basicsPath, basics)
  fs.writeFileSync(specPath, SPEC)
  return { basicsPath, specPath }
}

const BASE = {
  任务名称: '示例任务',
  任务类型: '完整功能开发',
  优先级: 'P1',
  当前状态: '已定义',
  需求基线版本: 'V1',
  前置依赖: '无',
  施工环境组: 'LOC-001',
  施工环境角色: '独立',
  无人值守许可: '允许',
  任务规格位置: '.scratch/LOC-001-demo/task-spec-V1.md',
  定义时间: '2026-09-08T23:00:00+08:00',
}

function run(basicsPath, specPath, extra = []) {
  try {
    const out = execFileSync(process.execPath, [script, basicsPath, specPath, ...extra], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

test('GitHub 轨道：「已定义」照旧通过', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, BASE)
  const r = run(basicsPath, specPath)
  assert.equal(r.code, 0, r.err)
  const j = JSON.parse(r.out.slice(r.out.indexOf('{')))
  assert.equal(j.track, 'github')
  assert.equal(j.status, '已定义')
})

test('本地轨道：「本地已定义」+ 任务标识 + pending 视为可开工', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, {
    ...BASE,
    当前状态: '本地已定义',
    任务标识: 'LOC-001',
    需求来源: '会话录入',
    来源定位: '2026-09-08 会话',
    'GitHub 同步': 'pending',
  })
  const r = run(basicsPath, specPath)
  assert.equal(r.code, 0, r.err)
  const j = JSON.parse(r.out.slice(r.out.indexOf('{')))
  assert.equal(j.track, 'local')
  assert.equal(j.task_id, 'LOC-001')
  assert.equal(j.github_sync, 'pending')
})

test('本地轨道：缺任务标识则受阻', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, {
    ...BASE,
    当前状态: '本地已定义',
    'GitHub 同步': 'pending',
  })
  const r = run(basicsPath, specPath)
  assert.equal(r.code, 1)
  assert.match(r.err, /任务标识/)
})

test('本地轨道：缺 GitHub 同步字段则受阻', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, {
    ...BASE,
    当前状态: '本地已定义',
    任务标识: 'LOC-001',
  })
  const r = run(basicsPath, specPath)
  assert.equal(r.code, 1)
  assert.match(r.err, /GitHub 同步/)
})

test('本地轨道：GitHub 同步取值非法则受阻', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, {
    ...BASE,
    当前状态: '本地已定义',
    任务标识: 'LOC-001',
    'GitHub 同步': '待同步',
  })
  const r = run(basicsPath, specPath)
  assert.equal(r.code, 1)
  assert.match(r.err, /GitHub 同步取值非法/)
})

test('历史状态「本地准备完成，待同步」不具备开工资格', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, {
    ...BASE,
    当前状态: '本地准备完成，待同步',
    任务标识: 'LOC-001',
    'GitHub 同步': 'pending',
  })
  const r = run(basicsPath, specPath)
  assert.equal(r.code, 1)
  assert.match(r.err, /已定义/)
})

test('本地轨道：版本不一致仍受阻（契约不放松）', () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeBasics(dir, {
    ...BASE,
    当前状态: '本地已定义',
    需求基线版本: 'V2',
    任务标识: 'LOC-001',
    'GitHub 同步': 'pending',
  })
  const r = run(basicsPath, specPath, ['--run-baseline', 'V1'])
  assert.equal(r.code, 1)
  assert.match(r.err, /版本/)
})
