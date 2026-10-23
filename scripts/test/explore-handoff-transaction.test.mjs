import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exploreHandoffContract } from '../explore-handoff.mjs'
import { prepareNodeContext } from '../node-isolation.mjs'
import { prepareNodeArtifacts, publishNodeArtifacts, failNodeArtifacts } from '../node-artifacts.mjs'

const blueprint = JSON.parse(readFileSync(new URL('../../templates/wf-explore.json', import.meta.url)))
const childPath = fileURLToPath(new URL('./helpers/explore-handoff-transaction-child.mjs', import.meta.url))
const contract = exploreHandoffContract(blueprint)
const plan = { route: 'PLAN_READY', round_type: 'BROAD', research_question: '并发交接', questions: [{ id: 'q-core', required: true }], expert_briefs: ['one', 'two', 'three'].map(expert_id => ({ expert_id, focus: expert_id, brief: '独立 ' + expert_id, question_ids: ['q-core'] })), plan_summary: '当前计划' }
const report = { expert_id: 'one', findings: '真实发布字节', evidence: ['当前报告'], counter_evidence: [], assumptions: [], uncertainties: [], confidence: 'medium' }

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wfm524-tx-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const workspace = { workspace_path: join(root, 'workspace'), source_path: join(root, 'workspace/source'), resources: {} }
  mkdirSync(project)
  mkdirSync(workspace.source_path, { recursive: true })
  const binding = { cwd: project, runDir: '.agent-runs/tx', taskId: 'tx' }
  function attempt(nodeId, call, invocation, prepared = true) {
    const node = blueprint.nodes.find(item => item.id === nodeId)
    const itemNo = nodeId === 'research' ? 1 : null
    const execution = { round: 0, call, invocation_id: invocation, kind: itemNo ? 'item' : 'node', item_no: itemNo }
    const controller = { version: contract.version, node_id: nodeId, phase_id: 0, call_id: call, item_no: itemNo, inputs: {} }
    const bound = { ...binding, explore_handoff: { contract, execution, controller } }
    let context = prepareNodeContext(workspace, { node_id: nodeId, profile: node.profile, node_capabilities: node.node_capabilities, isolation_guarantee: 'enforced', execution })
    if (prepared) context = prepareNodeArtifacts(workspace, context, bound, node).context
    return { node, bound, context }
  }
  const p = attempt('orchestrate', 1, 'tx-plan')
  writeFileSync(join(p.context.artifact_output_path, 'research-plan.md'), '当前计划\n')
  publishNodeArtifacts(workspace, p.context, p.bound, p.node, plan)
  const canonical = join(project, binding.runDir, 'research-one.md')
  const receipt = join(project, binding.runDir, '.handoff', contract.digest, 'round-0/research-item-1/current.json')
  const lock = join(project, binding.runDir, '.handoff/transaction.lock')
  return { root, workspace, binding, attempt, canonical, receipt, lock }
}

function start(t, f, label, spec) {
  const args = { workspace: f.workspace, canonical: f.canonical, receipt: f.receipt, report,
    started: join(f.root, label + '-started'), reached: join(f.root, label + '-reached'), resume: join(f.root, label + '-resume'), result: join(f.root, label + '-result'), ...spec }
  const path = join(f.root, label + '-args.json')
  writeFileSync(path, JSON.stringify(args))
  const child = spawn(process.execPath, [childPath, path], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stderr.on('data', chunk => { output += chunk })
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, output })))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done })
  return { args, child, done }
}
async function waitFile(path) {
  const deadline = Date.now() + 8000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('未到达测试交错点：' + path)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const resultOf = child => JSON.parse(readFileSync(child.args.result, 'utf8'))

for (const mode of ['publish', 'begin', 'fail']) test('WFM-524 事务：旧 ' + mode + ' 临界区不能被新 attempt 插入并回退 current/canonical', async t => {
  const f = fixture(t)
  const old = f.attempt('research', 2, 'tx-old', mode !== 'begin')
  if (mode === 'publish') {
    writeFileSync(join(old.context.artifact_output_path, 'research-one.md'), 'OLD bytes\n')
    writeFileSync(join(old.context.artifact_output_path, 'STATE.md'), 'OLD bytes\n')
  }
  const oldChild = start(t, f, 'old', { mode, attempt: old, pause: mode === 'publish' ? 'canonical' : 'receipt' })
  await waitFile(oldChild.args.reached)
  const newer = f.attempt('research', 3, 'tx-new', false)
  const newChild = start(t, f, 'new', { mode: 'begin-publish', attempt: newer, bytes: 'NEW bytes\n' })
  await waitFile(newChild.args.started)
  await new Promise(resolve => setTimeout(resolve, 150))
  const publishedInsideOld = existsSync(newChild.args.result)
  writeFileSync(oldChild.args.resume, 'resume\n')
  assert.equal((await oldChild.done).code, 0)
  assert.equal((await newChild.done).code, 0)
  assert.equal(resultOf(oldChild).ok, true, JSON.stringify(resultOf(oldChild)))
  assert.equal(resultOf(newChild).ok, true, JSON.stringify(resultOf(newChild)))
  const current = JSON.parse(readFileSync(f.receipt))
  const bytes = readFileSync(f.canonical, 'utf8')
  t.diagnostic(JSON.stringify({ mode, publishedInsideOld, final_invocation: current.invocation_id, final_status: current.status, final_bytes: bytes }))
  assert.equal(publishedInsideOld, false, '新 attempt 不能在旧短事务内提交')
  assert.equal(current.invocation_id, 'tx-new')
  assert.equal(current.status, 'ready')
  assert.equal(bytes, 'NEW bytes\n')
  assert.equal(readFileSync(join(f.binding.cwd, f.binding.runDir, 'STATE.md'), 'utf8'), 'NEW bytes\n')
})

for (const crash of [false, true]) test('WFM-524 事务：' + (crash ? '崩溃残锁保留并有界报错，核对 owner 后显式恢复' : '仍存活的 owner 不会被按等待时间抢占'), async t => {
  const f = fixture(t)
  const old = f.attempt('research', 2, 'tx-old')
  writeFileSync(join(old.context.artifact_output_path, 'research-one.md'), 'OLD bytes\n')
  const oldChild = start(t, f, 'old', { mode: 'publish', attempt: old, pause: crash ? 'receipt' : 'canonical' })
  await waitFile(oldChild.args.reached)
  const owner = JSON.parse(readFileSync(f.lock))
  assert.equal(owner.pid, oldChild.child.pid)
  if (crash) {
    oldChild.child.kill('SIGKILL')
    assert.equal((await oldChild.done).signal, 'SIGKILL')
  }
  const newer = f.attempt('research', 3, 'tx-new', false)
  const started = performance.now()
  const blocked = start(t, f, 'blocked', { mode: 'begin-publish', attempt: newer, bytes: 'NEW bytes\n' })
  assert.equal((await blocked.done).code, 0)
  const elapsed = performance.now() - started
  assert.equal(resultOf(blocked).ok, false)
  assert.equal(resultOf(blocked).code, 'EXPLORE_HANDOFF_BUSY')
  assert.ok(elapsed >= 1800 && elapsed < 7000, '等待必须有界：' + elapsed)
  assert.deepEqual(JSON.parse(readFileSync(f.lock)), owner, '不得自动删除、重写或抢占原 owner')
  assert.equal(JSON.parse(readFileSync(f.receipt)).status, 'running', '崩溃/等待不能制造 ready')
  if (crash) assert.equal(readFileSync(f.canonical, 'utf8'), 'OLD bytes\n', '崩溃时可能已有 canonical 字节，但不能伪造 ready')
  else assert.equal(existsSync(f.canonical), false)
  if (crash) {
    assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' })
    assert.equal(JSON.parse(readFileSync(f.lock)).token, owner.token)
    unlinkSync(f.lock) // 本测试明确拥有的 fixture；owner 已退出且 token 已核对。
    const consumer = f.attempt('synthesize', 4, 'tx-consumer', false)
    consumer.bound.explore_handoff.controller.inputs = { orchestrate: plan, research: { total: 3, okCount: 1, failedCount: 2, items: [report, null, null] } }
    assert.throws(() => prepareNodeArtifacts(f.workspace, consumer.context, consumer.bound, consumer.node), /非 null.*成功 attempt/, '崩溃半成品不能从 canonical 混入消费者')
  } else {
    writeFileSync(oldChild.args.resume, 'resume\n')
    assert.equal((await oldChild.done).code, 0)
    assert.equal(resultOf(oldChild).ok, true)
    assert.equal(existsSync(f.lock), false)
  }
  const retried = start(t, f, 'retry', { mode: 'begin-publish', attempt: newer, bytes: 'NEW bytes\n' })
  assert.equal((await retried.done).code, 0)
  assert.equal(resultOf(retried).ok, true, JSON.stringify(resultOf(retried)))
  assert.equal(JSON.parse(readFileSync(f.receipt)).invocation_id, 'tx-new')
  assert.equal(readFileSync(f.canonical, 'utf8'), 'NEW bytes\n')
  assert.equal(existsSync(f.lock), false)
})

test('WFM-524 事务：上游计划替换也必须等待旧发布，替换后旧 phase 报告不可消费', async t => {
  const f = fixture(t)
  const old = f.attempt('research', 2, 'tx-old')
  writeFileSync(join(old.context.artifact_output_path, 'research-one.md'), 'OLD bytes\n')
  const oldChild = start(t, f, 'old', { mode: 'publish', attempt: old, pause: 'canonical' })
  await waitFile(oldChild.args.reached)
  const next = f.attempt('orchestrate', 3, 'tx-plan-new', false)
  const newChild = start(t, f, 'new', { mode: 'begin-publish', attempt: next, report: plan, files: { 'research-plan.md': 'NEW plan\n' } })
  await waitFile(newChild.args.started)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(existsSync(newChild.args.result), false)
  writeFileSync(oldChild.args.resume, 'resume\n')
  await oldChild.done
  await newChild.done
  assert.equal(resultOf(oldChild).ok, true)
  assert.equal(resultOf(newChild).ok, true)
  const consumer = f.attempt('synthesize', 4, 'tx-consumer', false)
  consumer.bound.explore_handoff.controller.inputs = { orchestrate: plan, research: { total: 3, okCount: 1, failedCount: 2, items: [report, null, null] } }
  assert.throws(() => prepareNodeArtifacts(f.workspace, consumer.context, consumer.bound, consumer.node), /生产版本不匹配/)
  assert.equal(existsSync(f.lock), false)
})

test('WFM-524 事务：释放前 owner token 不符时保留外来锁并明确报错', async t => {
  const f = fixture(t)
  const old = f.attempt('research', 2, 'tx-old')
  writeFileSync(join(old.context.artifact_output_path, 'research-one.md'), '报告\n')
  const child = start(t, f, 'owner-change', { mode: 'publish', attempt: old, replaceOwner: true, lock: f.lock })
  assert.equal((await child.done).code, 0)
  assert.equal(resultOf(child).ok, false)
  assert.match(resultOf(child).error, /owner 已变化.*拒绝释放/)
  assert.equal(JSON.parse(readFileSync(f.lock)).token, 'foreign-owner')
})

for (const kind of ['malformed', 'directory']) test('WFM-524 事务：未知 ' + kind + ' owner 保留并有界失败', t => {
  const f = fixture(t)
  if (kind === 'directory') mkdirSync(f.lock)
  else writeFileSync(f.lock, '{incomplete owner')
  const newer = f.attempt('research', 3, 'tx-new', false)
  const started = performance.now()
  assert.throws(() => prepareNodeArtifacts(f.workspace, newer.context, newer.bound, newer.node), { code: 'EXPLORE_HANDOFF_BUSY' })
  assert.ok(performance.now() - started < 5000)
  assert.equal(existsSync(f.lock), true)
  if (kind === 'malformed') assert.equal(readFileSync(f.lock, 'utf8'), '{incomplete owner')
  assert.equal(existsSync(f.receipt), false)
})

test('WFM-524 事务：发布异常标失败并释放自身锁，迟到 fail 不得改写新 ready', async t => {
  const f = fixture(t)
  const old = f.attempt('research', 2, 'tx-old')
  assert.throws(() => publishNodeArtifacts(f.workspace, old.context, old.bound, old.node, report), /必需产物缺失/)
  assert.equal(JSON.parse(readFileSync(f.receipt)).status, 'failed')
  assert.equal(existsSync(f.lock), false)
  const newer = f.attempt('research', 3, 'tx-new')
  writeFileSync(join(newer.context.artifact_output_path, 'research-one.md'), 'NEW bytes\n')
  publishNodeArtifacts(f.workspace, newer.context, newer.bound, newer.node, report)
  assert.throws(() => failNodeArtifacts(f.workspace, old.context, old.bound, old.node, '迟到旧失败'), /当前生产 attempt/)
  assert.equal(JSON.parse(readFileSync(f.receipt)).invocation_id, 'tx-new')
  assert.equal(JSON.parse(readFileSync(f.receipt)).status, 'ready')
  assert.equal(readFileSync(f.canonical, 'utf8'), 'NEW bytes\n')
  assert.equal(existsSync(f.lock), false)
})
