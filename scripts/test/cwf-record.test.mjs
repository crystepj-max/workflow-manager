// cwf-record.mjs 测试：写记录 / 校验 / 额度记账
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateEvidenceSummary } from '../workspace-evidence-summary.mjs'

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
  assert.match(r.out, /无法解析 run\.work_branch|拒绝变更 run 状态/)
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

test('write：主检出切走且无一致 worktree 检出时拒绝写入（lineage fail closed）', () => {
  const { root, runDir } = makeRunDir()
  execFileSync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: root })
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite'])
  assert.equal(r.code, 1)
  assert.match(r.out, /无法解析 run\.work_branch.*不一致|拒绝变更 run 状态/)
  assert.equal(existsSync(join(runDir, 'requirements_baseline.a1.json')), false)
})

test('write：主检出切走但 work_branch 有相邻容器 worktree 检出时放行（P2 主检出锚定）', () => {
  const { root, runDir } = makeRunDir()
  // 主检出切走（模拟交付期 main 检出停在别的分支），work_branch 检出在约定 worktree 容器
  execFileSync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: root })
  const wt = join(join(root, '..'), `${root.split('/').pop()}-worktrees`, 'dev-cwf-test-01')
  mkdirSync(wt, { recursive: true })
  execFileSync('git', ['worktree', 'add', wt, 'dev-cwf-test-01'], { cwd: root })
  const payload = join(runDir, 'payload.json')
  writeFileSync(payload, JSON.stringify({
    goal: '测试', scope: { include: ['a'], exclude: ['b'] }, acceptance: ['x'],
    gaps: [], outcome: 'baseline_ready', status: 'draft',
  }))
  const r = run(['write', runDir, 'requirements_baseline', payload, '--produced-by', 'test-suite', '--stage', 'requirements'])
  assert.equal(r.code, 0, r.out)
  const written = JSON.parse(readFileSync(join(runDir, 'requirements_baseline.a1.json'), 'utf-8'))
  // HEAD 必须来自 work_branch 的实际检出（worktree HEAD），不得绑主检出的 other-branch HEAD
  const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim()
  assert.equal(written.run.current_head, wtHead)
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

test('archive：--separate-git-dir 布局下主检出经 worktree list 推导，schema 连带归档', () => {
  // git init --separate-git-dir：common gitdir 在检出之外
  const main = mkdtempSync(join(tmpdir(), 'cwf-main-'))
  const gd = mkdtempSync(join(tmpdir(), 'cwf-gd-'))
  execFileSync('git', ['init', '-q', '-b', 'dev-x', '--separate-git-dir', gd, main])
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: main })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: main })
  writeFileSync(join(main, 'README.md'), '# test\n')
  execFileSync('git', ['add', '-A'], { cwd: main })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: main })
  const runDir = join(main, '.agent-runs', 'cwf-sep-01')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run_id: 'cwf-sep-01', work_branch: 'dev-x' }))
  writeFileSync(join(runDir, 'evidence.json'), '{}')
  mkdirSync(join(main, '.agent-runs', 'schema'), { recursive: true })
  writeFileSync(join(main, '.agent-runs', 'schema', 'handoff.schema.json'), '{}')
  const r = run(['archive', runDir])
  assert.equal(r.code, 0, r.out)
  // 归档目标必须是主检出自身（不是 gitdir 的父目录）
  assert.equal(existsSync(join(main, '.agent-runs', 'cwf-sep-01', 'evidence.json')), true)
  assert.equal(existsSync(join(main, '.agent-runs', 'schema', 'handoff.schema.json')), true)
})

test('write：awaiting→decided 成熟刷新禁止改写 assembled（签收对呈递版本）', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const realBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const assembled = {
    requirements_baseline_ref: 'r', design_package_ref: 'd', dev_handoff_ref: 'v',
    review_proof_ref: 'rp', test_proof_ref: 'tp',
    integration_checkpoint: { target_ref: 'main', target_head_at_check: realHead, target_advanced: false, proofs_state: 'still_valid' },
  }
  const mk = (name, status, extra = {}) => {
    const f = join(runDir, name)
    writeFileSync(f, JSON.stringify({ status, assembled, ...extra }))
    return f
  }
  // awaiting 写入
  assert.equal(run(['write', runDir, 'acceptance_package', mk('a1.json', 'awaiting_decision'), '--produced-by', 'test-suite', '--stage', 'human_acceptance']).code, 0)
  // decided 且 assembled 不变 → 允许成熟刷新
  assert.equal(run(['write', runDir, 'acceptance_package', mk('a2.json', 'decided', { decision: 'accept', decided_by: 'x', decided_at: '2026-08-30T08:00:00Z', verified_branch: realBranch, verified_head: realHead }), '--produced-by', 'test-suite', '--stage', 'human_acceptance']).code, 0)
})

test('write：awaiting→decided 改写 assembled 拒绝', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const realBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const assembled = {
    requirements_baseline_ref: 'r', design_package_ref: 'd', dev_handoff_ref: 'v',
    review_proof_ref: 'rp', test_proof_ref: 'tp',
    integration_checkpoint: { target_ref: 'main', target_head_at_check: realHead, target_advanced: false, proofs_state: 'still_valid' },
  }
  const mk = (name, status, extra = {}) => {
    const f = join(runDir, name)
    writeFileSync(f, JSON.stringify({ status, assembled, ...extra }))
    return f
  }
  run(['write', runDir, 'acceptance_package', mk('a1.json', 'awaiting_decision'), '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  // decided 且 assembled 被改 → 拒绝
  const r = run(['write', runDir, 'acceptance_package', mk('a2.json', 'decided', { assembled: { ...assembled, review_proof_ref: 'tampered' }, decision: 'accept', decided_by: 'x', decided_at: '2026-08-30T08:00:00Z', verified_branch: realBranch, verified_head: realHead }), '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  assert.equal(r.code, 1)
  assert.match(r.out, /不得改写已呈递的 assembled/)
})

test('reverify 同步刷新 run.current_head', () => {
  const { root, runDir } = makeRunDir()
  // 产生新提交后 reverify → run.json current_head 应反映实际 HEAD
  writeFileSync(join(root, 'x.txt'), 'x')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: root })
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  run(['reverify', runDir, '--reason', 'checkpoint sync'])
  const runState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(runState.current_head, realHead)
})

test('write：dev_handoff handoff_ready 即终结，blocked 允许刷新（3891543026）', () => {
  const { root, runDir } = makeRunDir()
  const mk = (name, outcome) => {
    const f = join(runDir, name)
    writeFileSync(f, JSON.stringify({ summary: 's', outcome, changes: [], self_check: [{ check: 'c', result: 'pass' }] }))
    return f
  }
  // handoff_ready 写入后同 attempt 重写拒绝
  assert.equal(run(['write', runDir, 'dev_handoff', mk('d1.json', 'handoff_ready'), '--produced-by', 'test-suite', '--stage', 'dev']).code, 0)
  const rewrite = run(['write', runDir, 'dev_handoff', mk('d2.json', 'handoff_ready'), '--produced-by', 'test-suite', '--stage', 'dev'])
  assert.equal(rewrite.code, 1)
  assert.match(rewrite.out, /终结态记录/)
})

test('write：dev_handoff blocked 允许同 attempt 刷新（可恢复态）', () => {
  const { runDir } = makeRunDir()
  const mk = (name) => {
    const f = join(runDir, name)
    writeFileSync(f, JSON.stringify({ summary: 's', outcome: 'blocked', blocked_reason: '环境不可用', changes: [], self_check: [{ check: 'c', result: 'blocked' }] }))
    return f
  }
  assert.equal(run(['write', runDir, 'dev_handoff', mk('d1.json'), '--produced-by', 'test-suite', '--stage', 'dev']).code, 0)
  assert.equal(run(['write', runDir, 'dev_handoff', mk('d2.json'), '--produced-by', 'test-suite', '--stage', 'dev']).code, 0) // 刷新允许
})

test('closeout：引用验收包交叉校验（未决/reject/错配/跨 Run 全拒，一致放行）', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const realBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const mk = (name, status, extra = {}) => {
    const f = join(runDir, name)
    writeFileSync(f, JSON.stringify({
      status,
      assembled: {
        requirements_baseline_ref: 'r', design_package_ref: 'd', dev_handoff_ref: 'v',
        review_proof_ref: 'rp', test_proof_ref: 'tp',
        integration_checkpoint: { target_ref: 'main', target_head_at_check: realHead, target_advanced: false, proofs_state: 'still_valid' },
      },
      ...extra,
    }))
    return f
  }
  const writeCloseout = (outcome) => {
    const f = join(runDir, 'co.json')
    writeFileSync(f, JSON.stringify({
      deliverables: ['x'], integration: { pr: '#1', checkpoint: 'c' },
      acceptance_package_ref: 'acceptance_package.a1.json', acceptance_outcome: outcome, records_retained: true,
    }))
    return run(['write', runDir, 'closeout_summary', f, '--produced-by', 'test-suite', '--stage', 'closeout'])
  }
  // 未决 → 拒
  run(['write', runDir, 'acceptance_package', mk('a-await.json', 'awaiting_decision'), '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  assert.equal(writeCloseout('accept').code, 1)
  // reject → 拒
  run(['write', runDir, 'acceptance_package', mk('a-reject.json', 'decided', { decision: 'reject', decided_by: 'x', decided_at: '2026-08-31T00:00:00Z', feedback: 'f', rejection_root_cause: 'dev', verified_branch: realBranch, verified_head: realHead }), '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  // 注意：同 attempt 同文件成熟——改用新文件名引用拒绝态
  const badRef = writeCloseout('accept')
  // 上面的 writeCloseout 引用 acceptance_package.a1.json，但该文件从未被写过（mk 只写 payload 文件）——先补真实引用目标
  const ap = join(runDir, 'acceptance_package.a1.json')
  writeFileSync(ap, JSON.stringify({
    record_type: 'acceptance_package', record_version: 'v0.1.8', created_at: '2026-08-31T00:00:00Z',
    produced_by: 'x', run: { run_id: 'cwf-test-01', issue_or_task_identity: '#999', workspace_id: 'wt-test', repository: 'crystepj-max/workflow-manager', base_ref: 'main', base_commit: 'abc', work_branch: realBranch, current_head: realHead, stage: 'human_acceptance', attempt: 1 },
    payload: { status: 'decided', assembled: {}, decision: 'reject', decided_by: 'x', decided_at: '2026-08-31T00:00:00Z', feedback: 'f', rejection_root_cause: 'dev', verified_branch: realBranch, verified_head: realHead },
  }))
  const rReject = writeCloseout('accept')
  assert.equal(rReject.code, 1)
  assert.match(rReject.out, /reject/)
  // outcome 与 decision 错配 → 拒
  writeFileSync(ap, JSON.stringify({
    record_type: 'acceptance_package', record_version: 'v0.1.8', created_at: '2026-08-31T00:00:00Z',
    produced_by: 'x', run: { run_id: 'cwf-test-01', issue_or_task_identity: '#999', workspace_id: 'wt-test', repository: 'crystepj-max/workflow-manager', base_ref: 'main', base_commit: 'abc', work_branch: realBranch, current_head: realHead, stage: 'human_acceptance', attempt: 1 },
    payload: { status: 'decided', assembled: {}, decision: 'conditional_pass', decided_by: 'x', decided_at: '2026-08-31T00:00:00Z', feedback: 'f', verified_branch: realBranch, verified_head: realHead },
  }))
  const rMismatch = writeCloseout('accept')
  assert.equal(rMismatch.code, 1)
  assert.match(rMismatch.out, /acceptance_outcome/)
  // 一致 → 放行
  const rOk = run(['write', runDir, 'closeout_summary', (() => { const f = join(runDir, 'co-ok.json'); writeFileSync(f, JSON.stringify({ deliverables: ['x'], integration: { pr: '#1', checkpoint: 'c' }, acceptance_package_ref: 'acceptance_package.a1.json', acceptance_outcome: 'conditional_pass', records_retained: true, leftovers: ['下次定义：优化意见'] })); return f })(), '--produced-by', 'test-suite', '--stage', 'closeout'])
  assert.equal(rOk.code, 0, rOk.out)
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

// ── FIX-220：成熟刷新的呈递保护（契约 §3.6 / §5.3）────────────────────────
function designPayload(decReq, decision) {
  const p = {
    summary: '既有摘要文本', outcome: 'package_ready', decision_required: true,
    decision_required_reasons: ['命中条件门'],
  }
  if (decReq) p.decision_request = decReq
  if (decision) p.decision = decision
  return p
}
const REQ_A = { question: '该选哪个方案？', options: [{ name: 'A', tradeoffs: 't' }, { name: 'B', tradeoffs: 't' }], recommendation: 'A' }
const DEC_A = { question: '该选哪个方案？', options: [{ name: 'A', tradeoffs: 't' }, { name: 'B', tradeoffs: 't' }], chosen: 'A', rationale: '选 A 的理由文本', decided_by: 'human', decided_at: '2026-08-30T08:00:00Z' }

test('write：design 门成熟刷新不得替换已呈递的 decision_request（§3.6/§5.3）', () => {
  const { runDir } = makeRunDir()
  const mk = (name, payload) => { const f = join(runDir, name); writeFileSync(f, JSON.stringify(payload)); return f }
  const pending = designPayload(REQ_A, null)
  pending.outcome = 'decision_required'
  assert.equal(run(['write', runDir, 'design_package', mk('d1.json', pending), '--produced-by', 'test-suite', '--stage', 'design']).code, 0)
  // 把呈递过的候选集换一份再答——必须拒
  const swapped = designPayload({ ...REQ_A, options: [{ name: 'A', tradeoffs: 't' }, { name: 'C', tradeoffs: 't' }] }, DEC_A)
  const r = run(['write', runDir, 'design_package', mk('d2.json', swapped), '--produced-by', 'test-suite', '--stage', 'design'])
  assert.equal(r.code, 1)
  assert.match(r.out, /不得替换已呈递的 decision_request/)
})

test('write：design 门原样保留 decision_request 的成熟刷新放行（防保护过头）', () => {
  const { runDir } = makeRunDir()
  const mk = (name, payload) => { const f = join(runDir, name); writeFileSync(f, JSON.stringify(payload)); return f }
  const pending = designPayload(REQ_A, null)
  pending.outcome = 'decision_required'
  assert.equal(run(['write', runDir, 'design_package', mk('d1.json', pending), '--produced-by', 'test-suite', '--stage', 'design']).code, 0)
  assert.equal(run(['write', runDir, 'design_package', mk('d2.json', designPayload(REQ_A, DEC_A)), '--produced-by', 'test-suite', '--stage', 'design']).code, 0)
})

test('E-2 场景经实测不可达：decision_required 缺 decision_request 已被 schema 拒（保护无需处理）', () => {
  const { runDir } = makeRunDir()
  const f = join(runDir, 'd1.json')
  writeFileSync(f, JSON.stringify({ summary: '既有摘要文本', outcome: 'decision_required', decision_required: true, decision_required_reasons: ['命中条件门'] }))
  const r = run(['write', runDir, 'design_package', f, '--produced-by', 'test-suite', '--stage', 'design'])
  assert.equal(r.code, 1)
  assert.match(r.out, /校验失败/)
})

test('write：baseline draft→confirmed 不得改动已呈递的三要素', () => {
  const { runDir } = makeRunDir()
  const mk = (name, payload) => { const f = join(runDir, name); writeFileSync(f, JSON.stringify(payload)); return f }
  // 契约 §3.1：awaiting_human_input 必须显式带非空 gaps（schema 强制）
  const draft = { goal: '原目标文本', scope: { include: ['含'], exclude: ['不含'] }, acceptance: ['验收项一'], gaps: [{ element: '验收口径未定', suggestion: '补一条可验收入口' }], outcome: 'awaiting_human_input', status: 'draft' }
  assert.equal(run(['write', runDir, 'requirements_baseline', mk('b1.json', draft), '--produced-by', 'test-suite', '--stage', 'requirements']).code, 0)
  const tampered = { ...draft, gaps: [], goal: '换过的目标文本', outcome: 'baseline_ready', status: 'confirmed', baseline_revision: 'V1', human_confirmation: { confirmed_by: 'human', confirmed_at: '2026-08-30T08:00:00Z' } }
  const r = run(['write', runDir, 'requirements_baseline', mk('b2.json', tampered), '--produced-by', 'test-suite', '--stage', 'requirements'])
  assert.equal(r.code, 1)
  assert.match(r.out, /不得改动已呈递的基线三要素/)
})

test('write：baseline 三要素原样冻结放行；换内容走前进 attempt 通道（R-2）', () => {
  const { runDir } = makeRunDir()
  const mk = (name, payload) => { const f = join(runDir, name); writeFileSync(f, JSON.stringify(payload)); return f }
  // 契约 §3.1：awaiting_human_input 必须显式带非空 gaps（schema 强制）
  const draft = { goal: '原目标文本', scope: { include: ['含'], exclude: ['不含'] }, acceptance: ['验收项一'], gaps: [{ element: '验收口径未定', suggestion: '补一条可验收入口' }], outcome: 'awaiting_human_input', status: 'draft' }
  assert.equal(run(['write', runDir, 'requirements_baseline', mk('b1.json', draft), '--produced-by', 'test-suite', '--stage', 'requirements']).code, 0)
  const same = { ...draft, gaps: [], outcome: 'baseline_ready', status: 'confirmed', baseline_revision: 'V1', human_confirmation: { confirmed_by: 'human', confirmed_at: '2026-08-30T08:00:00Z' } }
  assert.equal(run(['write', runDir, 'requirements_baseline', mk('b2.json', same), '--produced-by', 'test-suite', '--stage', 'requirements']).code, 0)
  // 内容确需变更：前进 attempt，旧修订保留
  const changed = { ...same, goal: '第二版目标文本', baseline_revision: 'V2' }
  assert.equal(run(['write', runDir, 'requirements_baseline', mk('b3.json', changed), '--produced-by', 'test-suite', '--stage', 'requirements', '--attempt', '2']).code, 0)
  assert.ok(existsSync(join(runDir, 'requirements_baseline.a1.json')), '旧 attempt 修订必须保留')
})
// —— CHORE-110：轻量档验收包可登记 + 签收刷新永久层 ——

const CKPT = { target_ref: 'main', target_head_at_check: 'abc', target_advanced: false, proofs_state: 'still_valid' }
const GAPS = {
  review_proof: { reason: '轻量路线未设独立评审节点', acknowledged_by: 'human:song', acknowledged_at: '2026-09-19T00:00:00Z' },
  test_proof: { reason: '轻量路线未设独立测试节点', acknowledged_by: 'human:song', acknowledged_at: '2026-09-19T00:00:00Z' },
}

test('write：轻量档验收包（缺 review/test + evidence_gaps）可登记并落盘', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const payload = join(runDir, 'ap-light.json')
  writeFileSync(payload, JSON.stringify({
    status: 'decided',
    assembled: { requirements_baseline_ref: 'requirements_baseline.a1.json', dev_handoff_ref: 'dev_handoff.a1.json', integration_checkpoint: CKPT, evidence_gaps: GAPS },
    decision: 'accept', decided_by: 'human:song', decided_at: '2026-09-19T01:00:00Z',
    decided_by_evidence: 'closeout.md §验收', verified_branch: 'dev-cwf-test-01', verified_head: realHead,
  }))
  const r = run(['write', runDir, 'acceptance_package', payload, '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  assert.equal(r.code, 0, r.out)
  assert.ok(existsSync(join(runDir, 'acceptance_package.a1.json')))
})

test('write：轻量档缺 evidence_gaps 声明时被 schema 拒绝（不许静默绕过评审）', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const payload = join(runDir, 'ap-nogap.json')
  writeFileSync(payload, JSON.stringify({
    status: 'decided',
    assembled: { dev_handoff_ref: 'dev_handoff.a1.json', integration_checkpoint: CKPT },
    decision: 'accept', decided_by: 'human:song', decided_at: '2026-09-19T01:00:00Z',
    decided_by_evidence: 'closeout.md §验收', verified_branch: 'dev-cwf-test-01', verified_head: realHead,
  }))
  const r = run(['write', runDir, 'acceptance_package', payload, '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  assert.equal(r.code, 1)
  assert.match(r.out, /acceptance_package 校验失败/)
  assert.equal(existsSync(join(runDir, 'acceptance_package.a1.json')), false)
})

test('write：签收 decided 时刷新已归档摘要，让签署人进永久层（CHORE-36 类回归）', () => {
  const { root, runDir } = makeRunDir()
  const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
  const archDir = join(root, 'docs/tasks/archive/999')
  mkdirSync(archDir, { recursive: true })
  // 收口时生成的旧快照：签收发生在后，摘要停在 null——本次 write 必须把它刷回来
  writeFileSync(join(archDir, 'evidence-summary.json'), JSON.stringify({
    task_id: '999', run_id: 'cwf-test-01', decision: null, decided_by: null, decided_at: null,
  }, null, 2))
  const payload = join(runDir, 'ap.json')
  writeFileSync(payload, JSON.stringify({
    status: 'decided',
    assembled: { dev_handoff_ref: 'dev_handoff.a1.json', integration_checkpoint: CKPT, evidence_gaps: GAPS },
    decision: 'accept', decided_by: 'human:song', decided_at: '2026-09-19T01:00:00Z',
    decided_by_evidence: 'closeout.md §验收', verified_branch: 'dev-cwf-test-01', verified_head: realHead,
  }))
  const r = run(['write', runDir, 'acceptance_package', payload, '--produced-by', 'test-suite', '--stage', 'human_acceptance'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /已刷新归档摘要/)
  const refreshed = JSON.parse(readFileSync(join(archDir, 'evidence-summary.json'), 'utf-8'))
  assert.equal(refreshed.decided_by, 'human:song')
  assert.equal(refreshed.acceptance_state, 'decided')
})

test('摘要：登记册无 branch 时按任务标识反查唯一 Run（LOC-032/033 类）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwf-sum-'))
  mkdirSync(join(root, 'docs/tasks'), { recursive: true })
  writeFileSync(join(root, 'docs/tasks/registry.json'), JSON.stringify({
    tasks: [{ task_id: 'TIER-1', status: '已合并', branch: null }],
  }))
  const dir = join(root, '.agent-runs', 'tier-1-r1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: 'tier-1-r1', issue_or_task_identity: '#TIER-1' }))
  writeFileSync(join(dir, 'acceptance_package.a1.json'), JSON.stringify({
    record_type: 'acceptance_package', record_version: 'v0.1.8', created_at: '2026-09-19T00:00:00Z',
    produced_by: 'test-suite', run: { run_id: 'tier-1-r1', stage: 'human_acceptance' },
    payload: { status: 'decided', assembled: { dev_handoff_ref: 'x', integration_checkpoint: CKPT, evidence_gaps: GAPS }, decision: 'accept', decided_by: 'human:song', decided_at: '2026-09-19T01:00:00Z' },
  }))
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ acceptance_package: 'acceptance_package.a1.json' }))
  const { summaryJson } = generateEvidenceSummary({ root, taskId: 'TIER-1', now: () => new Date('2026-09-19T02:00:00Z') })
  assert.equal(summaryJson.run_id, 'tier-1-r1')
  assert.equal(summaryJson.run_id_source, 'discovered_from_agent_runs')
  assert.equal(summaryJson.decided_by, 'human:song')
  assert.equal(summaryJson.acceptance_state, 'decided')
})

test('摘要：多个 Run 声明同一任务时报错不猜', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwf-sum2-'))
  mkdirSync(join(root, 'docs/tasks'), { recursive: true })
  writeFileSync(join(root, 'docs/tasks/registry.json'), JSON.stringify({ tasks: [{ task_id: 'TIER-2', branch: null }] }))
  for (const rid of ['tier-2-r1', 'tier-2-r2']) {
    const dir = join(root, '.agent-runs', rid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: rid, issue_or_task_identity: '#TIER-2' }))
  }
  assert.throws(() => generateEvidenceSummary({ root, taskId: 'TIER-2' }), /多个 Run 声明同一任务/)
})

test('摘要：无验收包时显式标 no_record 并给成因，不再静默 null（CHORE-106 类）', () => {
  const { root, runDir } = makeRunDir()
  mkdirSync(join(root, 'docs/tasks'), { recursive: true })
  writeFileSync(join(root, 'docs/tasks/registry.json'), JSON.stringify({
    tasks: [{ task_id: '999', status: '等待验收', branch: 'dev-cwf-test-01' }],
  }))
  writeFileSync(join(runDir, 'index.json'), JSON.stringify({}))
  const { summaryJson } = generateEvidenceSummary({ root, taskId: '999', runId: 'cwf-test-01', now: () => new Date('2026-09-19T02:00:00Z') })
  assert.equal(summaryJson.decided_by, null)
  assert.equal(summaryJson.acceptance_state, 'no_record')
  assert.match(summaryJson.acceptance_note, /evidence_gaps/)
})
