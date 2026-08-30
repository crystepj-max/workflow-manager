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

function makeRunDir({ withGit = true } = {}) {
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
    work_branch: 'dev-cwf-test-01', current_head: 'abc', stage: 'requirements', attempt: 1,
    rollback_budget: 3, rollback_used: 0, rollback_history: [], created_at: '2026-08-30T08:00:00Z',
  }, null, 2))
  if (withGit) {
    // fail-closed HEAD 依赖真实 git 工作区
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root })
  }
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
  const written = JSON.parse(readFileSync(join(runDir, 'requirements_baseline.a1.json'), 'utf-8'))
  assert.equal(written.record_type, 'requirements_baseline')
  assert.equal(written.produced_by, 'test-suite')
  assert.equal(written.run.run_id, 'cwf-test-01')
  assert.match(written.record_version, /^v0\.1\.\d+$/)
  const index = JSON.parse(readFileSync(join(runDir, 'index.json'), 'utf-8'))
  assert.equal(index.requirements_baseline, 'requirements_baseline.a1.json')
})

test('write：重跑不覆盖旧记录，index 指向最新 attempt', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  run(['write', runDir, 'requirements_baseline', payload])
  // 同一记录第二次写入（如确认后刷新）：同 attempt 覆盖同文件
  const again = run(['write', runDir, 'requirements_baseline', payload])
  assert.equal(again.code, 0)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), true)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a2.json')), false)
  // attempt 2 写入 → 新文件 + index 前移
  const r2 = run(['write', runDir, 'requirements_baseline', payload, '--attempt', '2'])
  assert.equal(r2.code, 0, r2.out)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), true) // 旧 attempt 保留
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a2.json')), true)
  const index = JSON.parse(readFileSync(join(runDir, 'index.json'), 'utf-8'))
  assert.equal(index.requirements_baseline, 'requirements_baseline.a2.json')
})

test('write：非法 payload 拒绝落盘', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'bad.json')
  writeFileSync(payload, JSON.stringify({ goal: 'g' })) // 缺 scope/acceptance/gaps/status/outcome
  const r = run(['write', runDir, 'requirements_baseline', payload])
  assert.equal(r.code, 1)
  assert.match(r.out, /校验失败/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.json')), false)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('rollback：额度记账、耗尽持久化生命周期、追加额度后可继续', () => {
  const { runDir } = makeRunDir()
  for (let i = 1; i <= 3; i++) {
    const r = run(['rollback', runDir, 'dev'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`额度 ${i}/3`))
  }
  // 所选回退边持久化（根因 + 源/目标 stage + attempt + 计数）
  let runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_history.length, 3)
  assert.equal(runState.rollback_history[0].root_cause, 'dev')
  assert.equal(runState.rollback_history[0].target_stage, 'dev')
  assert.equal(runState.rollback_history[0].source_stage, 'requirements')

  // 第 4 次被拒：不递增，但持久化 WAITING_HUMAN + MAX_ROUNDS_REACHED（§4.3）
  const r = run(['rollback', runDir, 'dev'])
  assert.equal(r.code, 1)
  assert.match(r.out, /额度耗尽.*升级人工.*MAX_ROUNDS_REACHED/s)
  runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_used, 3)
  assert.equal(runState.lifecycle, 'WAITING_HUMAN')
  assert.equal(runState.lifecycle_reason, 'MAX_ROUNDS_REACHED')
  assert.equal(runState.rollback_history.length, 4)
  assert.equal(runState.rollback_history[3].rejected, true)

  // 人工追加额度到 4 后，下一次回退可执行（契约 §4.2 显式记录追加）
  runState.rollback_budget = 4
  delete runState.lifecycle
  delete runState.lifecycle_reason
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runState, null, 2))
  const r2 = run(['rollback', runDir, 'dev'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /额度 4\/4/)
})

test('write：非 git 工作区 fail closed（不得绑定未观察的 HEAD）', () => {
  const { runDir } = makeRunDir({ withGit: false })
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload])
  assert.equal(r.code, 1)
  assert.match(r.out, /真实 HEAD|中止/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('check：对既有记录只校验', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  run(['write', runDir, 'requirements_baseline', payload])
  const r = run(['check', runDir, join(runDir, 'requirements_baseline.a1.json')])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /valid/)
})
