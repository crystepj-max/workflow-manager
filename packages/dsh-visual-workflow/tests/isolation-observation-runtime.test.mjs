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

function env({ guarantee = 'enforced', fs = null, seed = {}, recordsDir = null } = {}) {
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
    if (cmd === 'probe') return probe(guarantee)
    if (cmd === 'createProviderRoutes') return createProviderRoutes(input)
    if (cmd === 'canIssueProof') return { ok: true, decision: canIssueIndependentProof(input.isolation_guarantee, resolveNodeCapabilities(input.profile, input.node_capabilities)) }
    return { ok: false, error: 'unexpected test command ' + cmd }
  } })
  let finish
  const starts = []
  const engine = { start(req) { starts.push(req); return { id: 'engine-1', result: new Promise((r) => { finish = r }) } } }
  const loaded = loadHost({ fs, subprocess: sub, sandboxPolicy, workflowEngine: engine, agents: { requireInitiator: () => ({}) } })
  const call = (name, args) => loaded.handlers.get(name)(args)
  const wf = loaded.definedTools.find((t) => t.name === 'wf_run')
  return { ...loaded, fs, sub, starts, call, wf, recordErrors, recordsDir, finish: (value) => finish({ stopReason: 'completed', value, agentsStarted: 0 }) }
}

async function completed({ events = false } = {}) {
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
  e.finish({ status: 'DONE', results: { review: { verdict: 'PASS' } } })
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
