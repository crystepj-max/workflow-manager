// cwf-record.mjs 测试：写记录 / 校验 / 额度记账
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs'
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
    execFileSync('git', ['init', '-q', '-b', 'dev-cwf-test-01'], { cwd: root })
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
  run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  // 同一记录第二次写入（如确认后刷新）：同 attempt 覆盖同文件
  const again = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  assert.equal(again.code, 0)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), true)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a2.json')), false)
  // attempt 2 写入 → 新文件 + index 前移
  const r2 = run(['write', runDir, 'requirements_baseline', payload, '--attempt', '2', '--produced-by', 'test-suite'])
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
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
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

  // 无扩容调整（仍为 3）→ 保持挂起，不误恢复
  const noop = run(['budget', runDir, '3', '--reason', '无扩容确认', '--decided-by', 'tester'])
  assert.equal(noop.code, 0)
  assert.match(noop.out, /保持 WAITING_HUMAN/)
  let midState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(midState.lifecycle, 'WAITING_HUMAN')
  // 人工追加额度（budget 子命令显式入账并恢复挂起态）后，下一次回退可执行且挂起态自动清除
  const rb = run(['budget', runDir, '4', '--reason', '人工决策追加', '--decided-by', 'tester'])
  assert.equal(rb.code, 0, rb.out)
  assert.match(rb.out, /3 → 4/)
  midState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(midState.budget_adjustments.length, 2)
  assert.equal(midState.budget_adjustments[0].decided_by, 'tester')
  assert.equal(midState.lifecycle, undefined) // 恢复：挂起态已清除
  const r2 = run(['rollback', runDir, 'dev'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /额度 4\/4/)
  const after = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(after.lifecycle, undefined) // 成功回退自身也清除挂起态
})

test('rollback：人工触发不耗自动额度（验收 reject / 耗尽后人工选择回退）', () => {
  const { runDir } = makeRunDir()
  // 先用尽自动额度
  for (let i = 0; i < 3; i++) run(['rollback', runDir, 'dev'])
  const exhausted = run(['rollback', runDir, 'dev'])
  assert.equal(exhausted.code, 1)
  // 人工触发必须携带归属：无 --decided-by 拒绝（防伪造 human_triggered）
  const noAttr = run(['rollback', runDir, 'dev', '--by', 'human'])
  assert.equal(noAttr.code, 2)
  assert.match(noAttr.out, /--decided-by/)
  // 人工触发：绕过额度检查，不递增计数，仍推进 stage/attempt 并留痕
  const r = run(['rollback', runDir, 'dev', '--by', 'human', '--decided-by', 'tester', '--reason', '验收打回'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /人工触发，不耗自动额度/)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_used, 3) // 未消耗
  assert.equal(runState.stage, 'dev')
  assert.equal(runState.attempt, 5) // 3 次自动 + 1 次人工
  const last = runState.rollback_history.at(-1)
  assert.equal(last.human_triggered, true)
  assert.equal(last.decided_by, 'tester')
  assert.equal(last.reason, '验收打回')
  assert.equal(runState.lifecycle, undefined) // 人工回退恢复挂起态
})

test('write：非 git 工作区 fail closed（不得绑定未观察的 HEAD）', () => {
  const { runDir } = makeRunDir({ withGit: false })
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  assert.equal(r.code, 1)
  assert.match(r.out, /真实 HEAD|中止/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('write：--attempt 严格正整数解析（2junk / 1.9 / 0 拒绝）', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  for (const bad of ['2junk', '1.9', '0', '-2', '9'.repeat(20)]) {
    const r = run(['write', runDir, 'requirements_baseline', payload, '--attempt', bad])
    assert.equal(r.code, 2)
    assert.match(r.out, /非法 --attempt/)
  }
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false) // 全未落盘
})

test('reverify：checkpoint 重跑推进修订且不耗额度', () => {
  const { runDir } = makeRunDir()
  const r = run(['reverify', runDir, '--reason', 'checkpoint sync'])
  assert.equal(r.code, 0, r.out)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.attempt, 2)
  assert.equal(runState.rollback_used, 0) // 不耗额度
  assert.equal(runState.rollback_history.at(-1).kind, 'reverify')
})

test('write：未知 -- 选项与多余位置参数拒绝（防 provenance 静默污染）', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  // 拼错的归属选项
  const r1 = run(['write', runDir, 'requirements_baseline', payload, '--produced_by', 'reviewer'])
  assert.equal(r1.code, 2)
  assert.match(r1.out, /未知选项/)
  // 多余位置参数
  const r2 = run(['write', runDir, 'requirements_baseline', payload, 'extra'])
  assert.equal(r2.code, 2)
  assert.match(r2.out, /位置参数须恰好 3 个/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('write/rollback：值选项缺值拒绝（--by 无值不得静默落自动路径）', () => {
  const { runDir } = makeRunDir()
  const r = run(['rollback', runDir, 'dev', '--by'])
  assert.equal(r.code, 2)
  assert.match(r.out, /缺值/)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_used, 0)
})

test('rollback：--by 非法值拒绝（防拼写错误静默落到自动路径）', () => {
  const { runDir } = makeRunDir()
  const r = run(['rollback', runDir, 'dev', '--by', 'huma', '--decided-by', 'tester'])
  assert.equal(r.code, 2)
  assert.match(r.out, /非法 --by 值/)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_used, 0) // 未污染
})

test('rollback：分支切换后拒绝变更 run 状态（lineage 守卫覆盖变更路径）', () => {
  const { root, runDir } = makeRunDir()
  execFileSync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: root })
  const r = run(['rollback', runDir, 'dev'])
  assert.equal(r.code, 1)
  assert.match(r.out, /不一致.*拒绝变更 run 状态/)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_used, 0) // 未被污染
  assert.equal(runState.attempt, 1)
})

test('budget：畸形调额拒绝（4junk / 负数 / 空串）', () => {
  const { runDir } = makeRunDir()
  for (const bad of ['4junk', '-1', 'nope']) {
    const r = run(['budget', runDir, bad, '--decided-by', 'tester'])
    assert.equal(r.code, 2)
    assert.match(r.out, /非法回退额度/)
  }
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.rollback_budget, 3) // 未被污染
})

test('write：分支切换后拒绝写入（lineage 不一致）', () => {
  const { root, runDir } = makeRunDir()
  execFileSync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: root })
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  assert.equal(r.code, 1)
  assert.match(r.out, /与 run\.work_branch.*不一致/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('write：过期 --attempt 拒绝（不得回退 attempt 覆盖旧 proof）', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  // 回退推进 attempt 到 2 后，stale 的 --attempt 1 必须被拒
  run(['rollback', runDir, 'dev'])
  const r = run(['write', runDir, 'requirements_baseline', payload, '--attempt', '1', '--produced-by', 'test-suite'])
  assert.equal(r.code, 1)
  assert.match(r.out, /拒绝过期 attempt/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('schema 解析：run 目录提供副本优先，无 docs 路径也能工作', () => {
  const { root, runDir } = makeRunDir()
  // 删除仓库 docs 路径的 schema，仅保留 run 侧提供副本
  rmSync(join(root, 'docs'), { recursive: true, force: true })
  const schemaDir = join(root, '.agent-runs', 'schema')
  mkdirSync(schemaDir, { recursive: true })
  cpSync(schemaSrc, join(schemaDir, 'handoff.schema.json'))
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  assert.equal(r.code, 0, r.out)
})

test('write：已终结记录同 attempt 覆盖拒绝（§8.5/§5），未终结成熟刷新允许', () => {
  const { root, runDir } = makeRunDir()
  const mk = (name, obj) => { const f = join(runDir, name); writeFileSync(f, JSON.stringify(obj)); return f }
  const draft = mk('p1.json', { goal: 'g', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'], gaps: [], outcome: 'baseline_ready', status: 'draft' })
  const confirmed = mk('p2.json', { goal: 'g', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'], gaps: [], outcome: 'baseline_ready', status: 'confirmed', baseline_revision: 'v1', human_confirmation: { confirmed_by: 'x', confirmed_at: '2026-08-30T08:00:00Z' } })
  // draft → confirmed 同 attempt 成熟刷新：允许
  assert.equal(run(['write', runDir, 'requirements_baseline', draft, '--produced-by', 'test-suite']).code, 0)
  assert.equal(run(['write', runDir, 'requirements_baseline', confirmed, '--produced-by', 'test-suite']).code, 0)
  // confirmed 已终结：再覆盖拒绝
  const again = run(['write', runDir, 'requirements_baseline', confirmed, '--produced-by', 'test-suite'])
  assert.equal(again.code, 1)
  assert.match(again.out, /终结态记录.*不可覆盖/)
  // proof 一次写入即终结：同 attempt 重写拒绝
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const realBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const proof = mk('proof.json', { verdict: 'approve', findings: [], verified_branch: realBranch, verified_head: realHead, independent_session: true })
  assert.equal(run(['write', runDir, 'review_proof', proof, '--produced-by', 'test-suite', '--stage', 'review']).code, 0)
  const rewrite = run(['write', runDir, 'review_proof', proof, '--produced-by', 'test-suite', '--stage', 'review'])
  assert.equal(rewrite.code, 1)
  assert.match(rewrite.out, /终结态记录.*不可覆盖/)
})

test('write：无归属（缺 --produced-by 且无 DSH_SESSION_ID）fail closed', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  // 显式清空 DSH_SESSION_ID（本测试运行环境可能自带）
  const r = run(['write', runDir, 'requirements_baseline', payload], { env: { ...process.env, DSH_SESSION_ID: '' } })
  assert.equal(r.code, 2)
  assert.match(r.out, /--produced-by/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('archive：run 证据复制到主检出 .agent-runs（worktree 可移除）', () => {
  const { root, runDir } = makeRunDir()
  // 模拟 worktree 布局：把 run 目录挪进 <root>/.scratch/worktrees/dev-x/ 下
  const wt = join(root, '.scratch', 'worktrees', 'dev-x')
  mkdirSync(join(wt, '.agent-runs'), { recursive: true })
  const wtRunDir = join(wt, '.agent-runs', 'cwf-test-01')
  cpSync(runDir, wtRunDir, { recursive: true })
  writeFileSync(join(wtRunDir, 'evidence.json'), '{}')
  const r = run(['archive', wtRunDir])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /已归档/)
  const dest = join(root, '.agent-runs', 'cwf-test-01')
  assert.equal(existsSync(join(dest, 'evidence.json')), true)
  assert.equal(existsSync(join(dest, 'run.json')), true)
})

test('check：对既有记录只校验', () => {
  const { runDir } = makeRunDir()
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  const r = run(['check', runDir, join(runDir, 'requirements_baseline.a1.json')])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /valid/)
})

test('rollback 成功后 stage/attempt 推进（不覆盖触发回退的 proof）', () => {
  const { runDir } = makeRunDir()
  const r = run(['rollback', runDir, 'dev'])
  assert.equal(r.code, 0, r.out)
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.stage, 'dev')
  assert.equal(runState.attempt, 2)
  assert.equal(runState.rollback_history[0].attempt_after, 2)
})

test('write：proof 绑定与真实工作区比对（不一致拒绝，一致放行）', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const realBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const mkProof = (head, branch) => {
    const p = join(runDir, `proof-${head === realHead ? 'ok' : 'bad'}.json`)
    writeFileSync(p, JSON.stringify({
      verdict: 'approve', findings: [], verified_branch: branch, verified_head: head,
      independent_session: true,
    }))
    return p
  }
  // 绑定不符 → 拒绝（§7.3）
  const bad = run(['write', runDir, 'review_proof', mkProof('deadbeef', realBranch), '--stage', 'review', '--produced-by', 'test-suite'])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /Proof 绑定与工作区不符/)
  assert.equal(existsSync(join(runDir, 'review_proof.a1.json')), false)
  // 绑定一致 → 放行
  const ok = run(['write', runDir, 'review_proof', mkProof(realHead, realBranch), '--stage', 'review', '--produced-by', 'test-suite'])
  assert.equal(ok.code, 0, ok.out)
})
