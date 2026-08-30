// cwf-record.mjs 测试：写记录 / 校验 / 额度记账
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const recordScript = join(repo, 'scripts/cwf-record.mjs')
const schemaSrc = join(repo, 'docs/design/construction-workflow/handoff.schema.json')

function makeRunDir() {
  // 造一个最小仓库结构：<tmp>/.agent-runs/<run>/ + <tmp>/docs/design/construction-workflow/handoff.schema.json
  const root = mkdtempSync(join(tmpdir(), 'cwf-test-'))
  const runDir = join(root, '.agent-runs', 'cwf-test-01')
  mkdirSync(runDir, { recursive: true })
  const schemaDir = join(root, 'docs/design/construction-workflow')
  mkdirSync(schemaDir, { recursive: true })
  cpSync(schemaSrc, join(schemaDir, 'handoff.schema.json'))
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    run_id: 'cwf-test-01', issue_or_task_identity: '#999', workspace_id: 'wt-test',
    repository: 'crystepj-max/workflow-manager', base_ref: 'main', base_commit: 'abc',
    work_branch: 'dev-issue-999', current_head: 'abc', stage: 'requirements', attempt: 1,
    rollback_budget: 3, rollback_used: 0, created_at: '2026-08-30T08:00:00Z',
  }, null, 2))
  return { root, runDir }
}

function run(args, opts = {}) {
  try {
    const out = execFileSync('node', [recordScript, ...args], { encoding: 'utf-8', ...opts })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

test('write：组装信封、校验并落盘，回写 run.json stage/attempt', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite', '--stage', 'requirements'])
  assert.equal(r.code, 0, r.out)
  const written = JSON.parse(readFileSync(join(runDir, 'requirements_baseline.json'), 'utf-8'))
  assert.equal(written.record_type, 'requirements_baseline')
  assert.equal(written.produced_by, 'test-suite')
  assert.equal(written.run.run_id, 'cwf-test-01')
  assert.match(written.record_version, /^v0\.1\.\d+$/)
})

test('write：非法 payload 拒绝落盘', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'bad.json')
  writeFileSync(payload, JSON.stringify({ goal: 'g' })) // 缺 scope/acceptance/gaps/status/outcome
  const r = run(['write', runDir, 'requirements_baseline', payload])
  assert.equal(r.code, 1)
  assert.match(r.out, /校验失败/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.json')), false)
})

test('rollback：额度记账与耗尽升级', () => {
  const { runDir } = makeRunDir()
  for (let i = 1; i <= 3; i++) {
    const r = run(['rollback', runDir, 'dev'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`额度 ${i}/3`))
  }
  const r = run(['rollback', runDir, 'dev'])
  assert.equal(r.code, 1)
  assert.match(r.out, /额度耗尽.*升级人工.*MAX_ROUNDS_REACHED/s)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_used, 4) // 原样保留并持久化，不回滚计数
})

test('check：对既有记录只校验', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  run(['write', runDir, 'requirements_baseline', payload])
  const r = run(['check', runDir, join(runDir, 'requirements_baseline.json')])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /valid/)
})
