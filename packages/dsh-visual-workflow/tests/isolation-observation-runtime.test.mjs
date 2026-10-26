// WFM-81：使用真实 Records Store，验证宿主探针事实跨记录与重启保留。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeIsolatedSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'
import { createProviderRoutes } from '../../../scripts/node-provider-routes.mjs'
import { canIssueIndependentProof, resolveNodeCapabilities } from '../../../scripts/node-isolation.mjs'
import { recordsAttempt, recordsCommit, recordsList, recordsGet } from '../../../scripts/records-host.mjs'
import isolationClient from '../../../scripts/node-isolation-host-client.cjs'
import routeCore from '../../../scripts/node-provider-core.cjs'

const root = new URL('../../../', import.meta.url)
const source = (p) => readFileSync(new URL(p, root), 'utf8')
const bp = {
  id: 'isolation-spec', displayName: '隔离观测', entry: 'review', heteroCheck: 'off',
  bindings: { models: { review: { provider: 'p1', model: 'm1' } } },
  nodes: [{ id: 'review', profile: 'review', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } }],
  edges: [{ from: 'review', to: '$end', outcome: 'PASS' }],
}
const probe = (guarantee) => ({ ok: true, guarantee, backend: 'fixture-sandbox', evidence: { insideWrite: true, outsideBlocked: guarantee === 'enforced', ...(guarantee === 'unavailable' ? { reason: 'fixture: outside write was allowed' } : {}) } })
const drain = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }
const logicalPath = (id) => DSH_HOME + '/visual-workflow/logical-runs/' + encodeURIComponent(id) + '.json'
const commands = { attempt: recordsAttempt, commit: recordsCommit, list: recordsList, get: recordsGet }
const temporaryDirs = new Set()
after(() => { for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true }) })
function saveFixture(name, value) {
  const dir = process.env.WFM81_FIXTURE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.json'), JSON.stringify({ fixture_only: true, source: 'simulated Probe/engine; real Records Store', ...value }, null, 2) + '\n')
}

function env({ guarantee = 'enforced', fs = null, seed = {}, recordsDir = null, marker = 'first', routeError = false, engineError = false, engineId = 'engine-1', proofQueryFails = false } = {}) {
  if (!recordsDir) { recordsDir = mkdtempSync(join(tmpdir(), 'wfm81-records-')); temporaryDirs.add(recordsDir) }
  const recordErrors = []
  fs = fs || makeFs({
    [USER_DIR + '/isolation-spec.json']: JSON.stringify(bp),
    [SKILL_ROOT + '/isolation-spec/script.mjs']: '//MOCK',
    [REPO + '/scripts/records-host.mjs']: '//MOCK',
    [REPO + '/packages/dsh-visual-workflow/dist/attempt-ledger.cjs']: source('scripts/attempt-ledger.cjs'),
    ...seed,
  })
  const sub = makeIsolatedSubprocess({ fs, recordsHost: (cmd, input) => {
    try { return commands[cmd]({ ...input, records_dir: recordsDir }) }
    catch (error) { recordErrors.push(error.message); throw error }
  }, nodeIsolationHost: (cmd, input) => {
    if (cmd === 'probe') { const p = probe(guarantee); p.evidence.marker = marker; return p }
    if (cmd === 'createProviderRoutes') return routeError ? { ok: false, error: 'fixture: route issue failed' } : createProviderRoutes(input)
    if (cmd === 'canIssueProof') {
      if (proofQueryFails) throw new Error('fixture: qualification query unavailable')
      return { ok: true, decision: canIssueIndependentProof(input.isolation_guarantee, resolveNodeCapabilities(input.profile, input.node_capabilities)) }
    }
    return { ok: false, error: 'unexpected test command ' + cmd }
  } })
  let finish
  const starts = []
  const engine = { start(req) { starts.push(req); if (engineError) throw new Error('fixture: engine start failed'); return { id: engineId, result: new Promise((r) => { finish = r }) } } }
  const loaded = loadHost({ fs, subprocess: sub, sandboxPolicy, workflowEngine: engine, agents: { requireInitiator: () => ({}) } })
  const call = (name, args) => loaded.handlers.get(name)(args)
  const wf = loaded.definedTools.find((t) => t.name === 'wf_run')
  return { ...loaded, fs, sub, starts, call, wf, recordErrors, recordsDir, finish: (value) => finish({ stopReason: 'completed', value, agentsStarted: 0 }) }
}

async function completed({ events = false, status = 'DONE' } = {}) {
  const e = env()
  const pending = e.wf.execute({ templateId: bp.id, taskId: 'iso-ok' })
  for (let i = 0; !e.starts.length && i < 100; i++) await drain()
  assert.equal(e.starts.length, 1)
  e.events.get('workflow/start')({ id: 'engine-1' })
  if (events) {
    e.events.get('workflow/log')({ id: 'engine-1' }, '[vwf-attempt]' + JSON.stringify({ a: 's', k: 1, n: 'review', t: 'call' }))
    e.events.get('workflow/log')({ id: 'engine-1' }, '[vwf-attempt]' + JSON.stringify({ a: 'e', k: 1, n: 'review', t: 'call', s: 'completed', o: 'PASS', q: { verdict: 'PASS' } }))
    await drain()
  }
  e.finish({ status, results: { review: { verdict: 'PASS' } } })
  await pending
  await drain()
  return e
}

for (const events of [false, true]) test('WFM-81 enforced：' + (events ? '逐次 attempt' : '段末扫描') + '与正式记录落盘并重启保留', async () => {
  const e = await completed({ events })
  assert.deepEqual(e.recordErrors, [])
  const lr = JSON.parse(e.fs._files.get(logicalPath('iso-ok')))
  assert.equal(lr.isolation_guarantee, 'enforced')
  assert.equal(lr.isolation_probe.backend, 'fixture-sandbox')
  assert.equal(lr.isolation_probe.evidence.outsideBlocked, true)
  const a = lr.node_attempts[0]
  assert.equal(a.isolation_guarantee, 'enforced')
  assert.equal(a.independent_proof_eligible, true)
  assert.equal(a.independent_proof_block_reason, null)
  const records = await e.call('vwf.records.list', { logical_run_id: 'iso-ok' })
  const node = records.records.find((r) => r.record_id === 'node:iso-ok:review')
  assert.equal(node.provenance.isolation_guarantee, 'enforced')
  assert.equal(node.provenance.isolation_probe.evidence.outsideBlocked, true)
  if (events) assert.equal(records.records.find((r) => r.record_id.startsWith('attempt:')).body.value.independent_proof_eligible, true)
  const run = JSON.parse(e.fs._files.get(DSH_HOME + '/visual-workflow/runs/engine-1.json'))
  assert.equal(run.isolation_guarantee, 'enforced')
  const restarted = env({ fs: e.fs, recordsDir: e.recordsDir })
  const reloaded = (await restarted.call('vwf.logicalRuns.get', { logical_run_id: 'iso-ok' })).record
  assert.equal(reloaded.isolation_guarantee, 'enforced')
  assert.deepEqual(reloaded.isolation_probe, lr.isolation_probe)
  assert.equal((await restarted.call('vwf.state', { runId: 'engine-1' })).state.isolation_guarantee, 'enforced')
  const stored = await restarted.call('vwf.records.list', { logical_run_id: 'iso-ok' })
  assert.equal(stored.records.find((r) => r.record_id === 'node:iso-ok:review').provenance.independent_proof_eligible, true)
  saveFixture(events ? 'enforced-attempt' : 'enforced-scan', { logical: reloaded, run, records: stored.records })
})

test('WFM-81 unavailable：保存拒绝启动事实，看板可见，零引擎段或节点执行', async () => {
  const e = env({ guarantee: 'unavailable' })
  assert.match(await e.wf.execute({ templateId: bp.id, taskId: 'iso-failed' }), /拒绝启动/)
  await drain()
  const lr = JSON.parse(e.fs._files.get(logicalPath('iso-failed')))
  assert.equal(lr.isolation_guarantee, 'unavailable')
  assert.equal(lr.isolation_probe.evidence.outsideBlocked, false)
  assert.equal(lr.node_isolation.review.independent_proof_eligible, false)
  assert.match(lr.node_isolation.review.independent_proof_block_reason, /unavailable/)
  assert.equal(lr.lifecycle.reason.code, 'NODE_ISOLATION_UNAVAILABLE')
  assert.equal(e.starts.length, 0)
  assert.deepEqual(lr.segments, [])
  assert.deepEqual(lr.node_attempts, [])
  const listed = await e.call('vwf.runs.list', {})
  assert.equal(listed.runs.length, 1)
  assert.equal(listed.runs[0].execution_not_started, true)
  assert.equal(listed.runs[0].logical_run_id, 'iso-failed')
  assert.equal(listed.runs[0].isolation_guarantee, 'unavailable')
  assert.equal((await e.call('vwf.state', { runId: listed.runs[0].id })).found, false)
  const restarted = env({ fs: e.fs })
  assert.equal((await restarted.call('vwf.runs.list', {})).runs[0].isolation_guarantee, 'unavailable')
  saveFixture('unavailable-unstarted', { logical: lr, runs: listed.runs, records: [] })
})

test('WFM-81 旧档案：缺字段为 unknown，只读回载不改写磁盘', async () => {
  const data = { logical_run_id: 'legacy', task_id: 'old', title: '旧档案', lifecycle: { state: 'FAILED' }, terminal: true, segments: [], snapshots: [], node_attempts: [{ node: 'review' }] }
  const raw = JSON.stringify(data)
  const e = env({ seed: { [logicalPath('legacy')]: raw } })
  const lr = (await e.call('vwf.logicalRuns.get', { logical_run_id: 'legacy' })).record
  assert.equal(lr.isolation_guarantee, 'unknown')
  assert.equal(lr.isolation_probe, null)
  assert.equal(lr.node_attempts[0].isolation_guarantee, undefined, '旧节点不可回填当前宿主等级')
  await drain()
  assert.equal(e.fs._files.get(logicalPath('legacy')), raw)
  saveFixture('unknown-legacy', { raw: data, logical: lr })
})

for (const failure of ['unavailable', 'route', 'engine']) test('WFM-81 再次准备失败保留成功段 current 与历史 attempt：' + failure, async () => {
  const first = await completed({ status: 'AWAITING_HUMAN_REVIEW' })
  const before = (await first.call('vwf.logicalRuns.get', { logical_run_id: 'iso-ok' })).record
  assert.equal(before.lifecycle.state, 'WAITING_HUMAN')
  const runPath = DSH_HOME + '/visual-workflow/runs/engine-1.json'
  const originalRun = first.fs._files.get(runPath)
  const e = env({ fs: first.fs, recordsDir: first.recordsDir, engineId: 'engine-2', marker: 'next',
    guarantee: failure === 'unavailable' ? 'unavailable' : 'enforced', routeError: failure === 'route', engineError: failure === 'engine', proofQueryFails: true })
  const out = await e.wf.execute({ templateId: bp.id, taskId: 'iso-ok', entry: 'review', results: {} })
  assert.match(out, failure === 'engine' ? /引擎启动失败/ : /拒绝启动/)
  await drain()
  const lr = (await e.call('vwf.logicalRuns.get', { logical_run_id: 'iso-ok' })).record
  assert.equal(lr.isolation_history.length, 2, '失败准备仍有准确独立历史')
  assert.equal(lr.isolation_history[1].isolation_probe.evidence.marker, 'next')
  assert.equal(lr.isolation_history[1].isolation_guarantee, failure === 'unavailable' ? 'unavailable' : 'enforced')
  assert.equal(lr.isolation_history[1].node_isolation.review.independent_proof_eligible, null)
  assert.equal(lr.isolation_guarantee, before.isolation_guarantee)
  assert.deepEqual(lr.isolation_probe, before.isolation_probe, '失败准备不得替换已执行段的探针事实')
  assert.deepEqual(lr.node_isolation, before.node_isolation, '失败准备不得替换已执行段的节点资格')
  assert.deepEqual(lr.node_attempts, before.node_attempts)
  assert.deepEqual(lr.segments, before.segments, '失败准备不得制造执行段')
  assert.equal(first.fs._files.get(runPath), originalRun, '旧引擎段文件原文不变')
  assert.equal(first.fs._files.has(DSH_HOME + '/visual-workflow/runs/engine-2.json'), false)
  assert.equal(lr.lifecycle.reason.code, failure === 'engine' ? 'ENGINE_START_FAILED' : 'NODE_ISOLATION_UNAVAILABLE')
  const restarted = env({ fs: first.fs, recordsDir: first.recordsDir })
  const reloaded = (await restarted.call('vwf.logicalRuns.get', { logical_run_id: 'iso-ok' })).record
  assert.deepEqual(reloaded.isolation_probe, before.isolation_probe, '重启也不得把失败准备当作已执行事实')
})

test('WFM-81 新执行段建立才提交准备事实，旧 attempt 原样保留', async () => {
  const first = await completed({ status: 'AWAITING_HUMAN_REVIEW' })
  const before = (await first.call('vwf.logicalRuns.get', { logical_run_id: 'iso-ok' })).record
  const e = env({ fs: first.fs, recordsDir: first.recordsDir, engineId: 'engine-2', marker: 'next', proofQueryFails: true })
  const pending = e.wf.execute({ templateId: bp.id, taskId: 'iso-ok', entry: 'review', results: {} })
  for (let i = 0; !e.starts.length && i < 100; i++) await drain()
  assert.equal(e.starts.length, 1)
  e.finish({ status: 'DONE', results: { review: { verdict: 'PASS' } } })
  await pending
  await drain()
  const lr = (await e.call('vwf.logicalRuns.get', { logical_run_id: 'iso-ok' })).record
  assert.equal(lr.segments.length, 2)
  assert.equal(lr.isolation_history.length, 2)
  assert.equal(lr.isolation_probe.evidence.marker, 'next')
  assert.equal(lr.node_isolation.review.independent_proof_eligible, null, '查询失败不能猜成允许')
  assert.deepEqual(lr.node_attempts[0], before.node_attempts[0])
  assert.equal(lr.node_attempts[1].isolation_probe.evidence.marker, 'next')
  assert.equal(lr.node_attempts[1].independent_proof_eligible, null)
})

test('WFM-81 首次引擎启动失败保留准备事实但零段、零 attempt', async () => {
  const e = env({ engineError: true })
  assert.match(await e.wf.execute({ templateId: bp.id, taskId: 'first-engine-failed' }), /引擎启动失败/)
  const lr = (await e.call('vwf.logicalRuns.get', { logical_run_id: 'first-engine-failed' })).record
  assert.equal(lr.isolation_guarantee, 'enforced')
  assert.equal(lr.isolation_history.length, 1)
  assert.deepEqual(lr.segments, [])
  assert.deepEqual(lr.node_attempts, [])
  assert.deepEqual((await e.call('vwf.runs.list', {})).runs, [], '引擎没有建立就不创建真实运行行')
})

// 完整提取生产共用函数；这里只替换宿主/引擎边界，不另写一份启动顺序。
const hostSource = source('packages/dsh-visual-workflow/src/host.js')
const autoStartSource = hostSource.slice(hostSource.indexOf('async function startIsolatedSegment('), hostSource.indexOf('\n\n    // ── 工作区隔离：'))
for (const result of ['unavailable', 'route', 'engine', 'started']) test('WFM-81 自动恢复/重跑共用生产启动函数的提交边界：' + result, async () => {
  const logical = { logical_run_id: 'auto-' + result, segments: [] }
  const hostCall = async (cmd, input) => {
    if (cmd === 'canIssueProof') return { ok: true, decision: canIssueIndependentProof(input.isolation_guarantee, resolveNodeCapabilities(input.profile, input.node_capabilities)) }
    if (cmd === 'createProviderRoutes') return result === 'route' ? { ok: false } : createProviderRoutes(input)
    throw new Error('unexpected host command ' + cmd)
  }
  const recordIsolation = (rec, probe, dsl) => isolationClient.recordIsolation(rec, probe, dsl, hostCall)
  await recordIsolation(logical, { ...probe('enforced'), evidence: { marker: 'first' } }, bp)
  logical.segments.push({ run_id: 'auto-1' })
  const before = JSON.parse(JSON.stringify(logical))
  const runs = new Map()
  const start = new Function('loadDist', 'logicalRuns', 'probeIsolationGuarantee', 'recordIsolation', 'homeDirs', 'niHostCall', 'runArtifactCwd', 'ensureRun', 'amKernel', 'amRuns', 'NODE_ISOLATED_PROVIDER', 'return (' + autoStartSource + ')')(
    async () => routeCore, new Map([[logical.logical_run_id, logical]]),
    async () => ({ ...probe(result === 'unavailable' ? 'unavailable' : 'enforced'), evidence: { marker: 'next' } }), recordIsolation,
    async () => ({ workspaces: '/fixture/workspaces' }), hostCall, () => '/fixture/source',
    (id) => { const rec = {}; runs.set(id, rec); return rec }, async () => null, new Map(), 'vwf-node-isolated',
  )
  const engine = { start() {
    assert.deepEqual(logical.isolation_probe, before.isolation_probe, 'engine.start 返回前旧 current 仍有效')
    if (result === 'engine') throw new Error('fixture: automatic segment engine failed')
    return { id: 'auto-2', result: Promise.resolve({ stopReason: 'completed' }) }
  } }
  const pending = start(engine, { args: {} }, logical.logical_run_id, bp, undefined, { source_path: '/fixture/source' })
  if (result === 'started') {
    assert.equal((await pending).id, 'auto-2')
    assert.equal(logical.isolation_probe.evidence.marker, 'next')
    assert.equal(runs.get('auto-2').isolation_probe.evidence.marker, 'next')
  } else {
    await assert.rejects(pending, result === 'engine' ? /automatic segment engine failed/ : /路由签发失败/)
    assert.deepEqual(logical.isolation_probe, before.isolation_probe)
    assert.deepEqual(logical.node_isolation, before.node_isolation)
    assert.equal(runs.size, 0)
  }
  assert.equal(logical.isolation_history.length, 2)
  assert.equal(logical.isolation_history[1].isolation_probe.evidence.marker, 'next')
  assert.deepEqual(logical.segments, before.segments, '只有调用方在拿到真实引擎句柄后才能登记新段')
})
