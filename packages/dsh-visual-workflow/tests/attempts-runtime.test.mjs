// 逐次持久化节点执行与成果提交（LOC-029）：宿主侧接线验收（fake fs/subprocess + 真实内核）
// records-host 子进程边界用 makeSubprocess 回调替身，回调内驱动真实 records-host.mjs
// 命令函数；attempt 编排内核（scripts/attempt-ledger.cjs）以 dist 种子真实加载。
// 覆盖规格验收标准：
//   AC-01 返工循环 8 次调用 → 8 条完成 attempt 入档 + 3 次评估 3 个 Revision + 最新索引指向第 3 次
//   AC-02 同一节点跨 segment（暂停恢复）再次执行追加记录；段号+序号不碰撞
//   AC-03 结果落盘后中断：已确认结果不丢失、遗留 running 收口 interrupted、恢复段正常续档
//   AC-04 提交失败 fail-closed：不显示「证据有效且完成」，保留专业结论；恢复路径可重放
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeIsolatedSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const DIST = REPO + '/packages/dsh-visual-workflow/dist'
import { recordsAttempt, recordsCommit, recordsList, recordsGet } from '../../../scripts/records-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const RECORDS_COMMANDS = { commit: recordsCommit, list: recordsList, get: recordsGet, attempt: recordsAttempt }
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')
const attemptLedgerSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'attempt-ledger.cjs'), 'utf8')
const recordsHostSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'records-host.mjs'), 'utf8')

const drain = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
const until = async (fn, label, ms = 4000) => {
  const t0 = Date.now()
  while (true) {
    if (fn()) return
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || ''))
    await new Promise((r) => setTimeout(r, 5))
  }
}
const readLogical = (fs, id) => JSON.parse(fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'))

// 规格图：gate（入口门禁，无入边）→ dev（实现）→ review（verifyBranch 评估，REJECT 回跳 dev）
// → closeout（收口）。
const BP = {
  id: 'attempt-spec', displayName: '逐次持久化规格图', description: '', entry: 'gate',
  control: { maxRounds: 9 },
  heteroCheck: 'off',
  bindings: { models: { gate: { provider: 'p1', model: 'm1' }, dev: { provider: 'p1', model: 'm1' }, review: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p1', model: 'm1' } } },
  nodes: [
    { id: 'gate', profile: 'developer', label: '门禁', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'dev', profile: 'developer', label: '实现', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'review', profile: 'reviewer', label: '评估', goal: 'g', verifyBranch: true, output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS', 'REJECT'] }, verified_branch: { type: 'string' }, verified_head: { type: 'string' } }, required: ['verdict', 'verified_branch', 'verified_head'] }, outcomePath: '$.verdict' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
  ],
  edges: [
    { from: 'gate', to: 'dev', outcome: 'PASS' },
    { from: 'dev', to: 'review', outcome: 'PASS' },
    { from: 'review', to: 'dev', outcome: 'REJECT' },
    { from: 'review', to: 'closeout', outcome: 'PASS' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}


// 真实 records-host 命令（磁盘权威）；dir 由测试注入
const realRecordsHost = (dir, overrides = {}) => (cmd, input) => {
  if (overrides[cmd]) return overrides[cmd](input)
  return RECORDS_COMMANDS[cmd]({ ...input, records_dir: dir })
}

function attemptLine(runId, ev) {
  return '[vwf-attempt]' + JSON.stringify(ev)
}

function env({ value = null, recordsHost = null, seedRecordsHost = true, compileScript = '//MOCK-SCRIPT', blueprint = BP } = {}) {
  const seeds = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [DIST + '/attempt-ledger.cjs']: attemptLedgerSrc,
    [USER_DIR + '/attempt-spec.json']: JSON.stringify(blueprint, null, 2) + '\n',
    [SKILL_ROOT + '/attempt-spec/script.mjs']: compileScript,
  }
  if (seedRecordsHost) seeds[REPO + '/scripts/records-host.mjs'] = recordsHostSrc
  const fs = makeFs(seeds)
  const sub = makeIsolatedSubprocess({ fs, compileScript, recordsHost })
  const engine = {
    start: (request) => {
      const id = 'run-' + (engine.n = (engine.n || 0) + 1)
      let release = () => {}
      const result = new Promise((r) => { release = r })
      engine.pending.push({ id, release, request })
      return { id, result }
    },
    pending: [],
    end(id, stopReason, v) {
      const p = engine.pending.find((x) => x.id === id)
      if (p) p.release({ stopReason, value: v === undefined ? null : v, agentsStarted: 0 })
    },
  }
  const { handlers, definedTools, events } = loadHost({
    fs, subprocess: sub, sandboxPolicy, workflowEngine: engine,
    agents: { requireInitiator: () => ({}) },
  })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const ctl = definedTools.find((t) => t.name === 'wf_control')
  return { handlers, wfRun, ctl, events, engine, fs, sub }
}

function settleRun(events, engine, runId, stopReason, value) {
  engine.end(runId, stopReason, value)
  events.get('workflow/end')({ id: runId }, { stopReason })
}

const ckptLog = (events, runId, next, results) => {
  events.get('workflow/log')({ id: runId }, '[pw-ckpt]' + JSON.stringify({ c: next, r: results || {}, h: [], rd: 0, fb: '', bu: 0, mr: 9, ds: 0 }))
}

test('AC-01 返工循环 8 调用：逐次入档 + 3 次评估 3 Revision + 最新索引指向第 3 次 + 无段末重复提交', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-att-host-'))
  const VALUE = {
    status: 'DONE',
    results: {
      dev: { verdict: 'PASS', v: 3 },
      review: { verdict: 'PASS', v: 3, verified_branch: 'b', verified_head: 'h' },
      closeout: { result: 'done' },
    },
    history: [],
  }
  const { wfRun, events, engine, fs, sub } = env({ recordsHost: realRecordsHost(dir) })
  const p = wfRun.execute({ templateId: 'attempt-spec', taskId: 'task-ac01' })
  await until(() => engine.pending.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  await drain()
  // 8 次真实调用（dev×3 + review×3 + 门禁 + 收口），每次调用前 start、后 end（共 16 行事件）
  const calls = [
    [1, 'dev', 'completed', { verdict: 'PASS', v: 1 }],
    [2, 'review', 'completed', { verdict: 'REJECT', v: 1 }],
    [3, 'dev', 'completed', { verdict: 'PASS', v: 2 }],
    [4, 'review', 'completed', { verdict: 'REJECT', v: 2 }],
    [5, 'dev', 'completed', { verdict: 'PASS', v: 3 }],
    [6, 'review', 'completed', { verdict: 'PASS', v: 3 }],
    [7, 'test', 'completed', { verdict: 'PASS', v: 1 }],
    [8, 'closeout', 'completed', { result: 'done' }],
  ]
  for (const [k, n, s, q] of calls) {
    events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 's', k, n, r: 0, t: 'call' }))
    events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 'e', k, n, r: 0, t: 'call', s, q, o: q.verdict || null, u: '$.verdict' }))
  }
  await drain()
  settleRun(events, engine, 'run-1', 'completed', VALUE)
  const out = JSON.parse(await p)
  await drain()
  await drain()
  assert.equal(out.stopReason, 'completed', '专业结果原样返回')
  assert.equal(out.value.status, 'DONE')

  // Store：8 个完成 attempt + 节点索引 Revision 链（dev/review 各 3）
  const list = recordsList({ records_dir: dir, logical_run_id: 'task-ac01' })
  assert.equal(list.attempts.length, 8, '8 次调用留下 8 个 attempt 记录')
  assert.ok(list.attempts.every((a) => a.status === 'completed'))
  const review = recordsGet({ records_dir: dir, logical_run_id: 'task-ac01', record_id: 'node:task-ac01:review' })
  assert.equal(review.current_revision, 3, '3 次评估 3 个正式 Revision')
  assert.equal(review.revisions[2].body.value.v, 3, '最新 Revision 是第 3 次评估')
  // 运行摘要：node_attempts 8 条（含 attempt_id），business_outcomes 指向第 3 次评估结论
  const logical = readLogical(fs, 'task-ac01')
  assert.equal(logical.node_attempts.length, 8, '逐次回填 node_attempts')
  assert.ok(logical.node_attempts.every((a) => a.attempt_id && a.status === 'completed'))
  assert.equal(logical.business_outcomes.review.outcome, 'PASS')
  assert.equal(logical.business_outcomes.review.path, '$.verdict')
  assert.equal(logical.lifecycle.state, 'COMPLETED', '证据齐全：正常完成')
  assert.equal(logical.formal_records.record_count, list.record_count, '摘要互相引用刷新')
  // 逐次提交段不得再走段末扫描 commit（避免重复 Revision）
  const commitCalls = sub._calls.filter((argv) => argv.join(' ').includes('records-host.mjs commit'))
  assert.equal(commitCalls.length, 0, '段末扫描已回退为兼容路径，逐次段无重复提交')
})

test('AC-02/AC-03 暂停中断与恢复：已确认结果不丢失、遗留 running 收口、跨段同节点续档不碰撞', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-att-host-'))
  const { wfRun, ctl, events, engine, fs } = env({ recordsHost: realRecordsHost(dir) })
  const p1 = wfRun.execute({ templateId: 'attempt-spec', taskId: 'task-ac02' })
  await until(() => engine.pending.length >= 1, '段1启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  await drain()
  // k1 完成并已确认落盘（结果落盘后的事实）；k2 只发了 start 就被中断
  events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 's', k: 1, n: 'dev', r: 0, t: 'call' }))
  events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 'e', k: 1, n: 'dev', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 1 }, o: 'PASS', u: '$.verdict' }))
  events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 's', k: 2, n: 'review', r: 0, t: 'call' }))
  await drain()
  const r1 = JSON.parse(await ctl.execute({ action: 'interrupt', logical_run_id: 'task-ac02' }))
  assert.equal(r1.ok, true)
  await drain()
  ckptLog(events, 'run-1', 'dev', { dev: { verdict: 'PASS', v: 1 } })
  engine.end('run-1', 'cancelled')
  events.get('workflow/end')({ id: 'run-1' }, { stopReason: 'cancelled' })
  const out1 = JSON.parse(await p1)
  await drain()
  await drain()
  assert.equal(out1.paused, true, '段1翻译为 PAUSED')
  // 段1收尾：k1 已确认结果保留；k2 遗留 running 收口为 interrupted
  const list1 = recordsList({ records_dir: dir, logical_run_id: 'task-ac02' })
  const byId = Object.fromEntries(list1.attempts.map((a) => [a.attempt_id, a.status]))
  assert.equal(byId.a1k1, 'completed', '已确认结果不丢失')
  assert.equal(byId.a1k2, 'interrupted', '中断 attempt 有明确状态')
  const logical1 = readLogical(fs, 'task-ac02')
  assert.equal(logical1.lifecycle.state, 'PAUSED')
  assert.ok(logical1.node_attempts.some((a) => a.attempt_id === 'a1k1' && a.segment === 1))
  assert.ok(logical1.node_attempts.some((a) => a.attempt_id === 'a1k2' && a.status === 'interrupted'), '中断入档运行摘要')

  // 段2：resume_paused 恢复同一逻辑运行，从检查点入口 dev 整体重跑，同节点再次执行
  const p2 = wfRun.execute({ templateId: 'attempt-spec', taskId: 'task-ac02', resume_paused: true })
  await until(() => engine.pending.length >= 2, '段2启动')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  await drain()
  events.get('workflow/log')({ id: 'run-2' }, attemptLine('run-2', { a: 's', k: 1, n: 'dev', r: 0, t: 'call' }))
  events.get('workflow/log')({ id: 'run-2' }, attemptLine('run-2', { a: 'e', k: 1, n: 'dev', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 2 }, o: 'PASS', u: '$.verdict' }))
  events.get('workflow/log')({ id: 'run-2' }, attemptLine('run-2', { a: 's', k: 2, n: 'review', r: 0, t: 'call' }))
  events.get('workflow/log')({ id: 'run-2' }, attemptLine('run-2', { a: 'e', k: 2, n: 'review', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 2, verified_branch: 'b', verified_head: 'h' }, o: 'PASS', u: '$.verdict' }))
  await drain()
  const VALUE2 = { status: 'DONE', results: { dev: { verdict: 'PASS', v: 2 }, review: { verdict: 'PASS', v: 2, verified_branch: 'b', verified_head: 'h' } }, history: [] }
  settleRun(events, engine, 'run-2', 'completed', VALUE2)
  const out2 = JSON.parse(await p2)
  await drain()
  await drain()
  assert.equal(out2.value.status, 'DONE')
  const logical2 = readLogical(fs, 'task-ac02')
  assert.equal(logical2.lifecycle.state, 'COMPLETED')
  assert.equal(logical2.segments.length, 2, '同一逻辑运行两个执行段')
  // 跨段同节点（dev 段1 v1、段2 v2）：a1k1/a1k2/a2k1/a2k2 —— 段号+序号不碰撞
  const segs = logical2.node_attempts.map((a) => a.attempt_id + ':' + a.segment)
  assert.ok(segs.includes('a2k1:2') && segs.includes('a2k2:2'), '段2调用以段号命名空间入档')
  const devGet = recordsGet({ records_dir: dir, logical_run_id: 'task-ac02', record_id: 'node:task-ac02:dev' })
  assert.equal(devGet.current_revision, 2, '跨段同节点再执行推进节点索引 Revision')
  assert.equal(devGet.revisions[1].body.value.v, 2, '段2 的结果成为最新索引内容')
})

test('AC-04 提交失败 fail-closed：不显示完成、保留专业结论、失败原因可追溯', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-att-host-'))
  const VALUE = { status: 'DONE', results: { dev: { verdict: 'PASS' } }, history: [] }
  const { wfRun, events, engine, fs } = env({
    recordsHost: realRecordsHost(dir, {
      attempt: () => ({ ok: false, error: 'records 写盘故障' }),
    }),
  })
  const p = wfRun.execute({ templateId: 'attempt-spec', taskId: 'task-ac04' })
  await until(() => engine.pending.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  await drain()
  events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 's', k: 1, n: 'dev', r: 0, t: 'call' }))
  events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 'e', k: 1, n: 'dev', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS' }, o: 'PASS', u: '$.verdict' }))
  await drain()
  settleRun(events, engine, 'run-1', 'completed', VALUE)
  const out = JSON.parse(await p)
  await drain()
  assert.equal(out.value.status, 'DONE', '专业结论保留：结果原样返回')
  const logical = readLogical(fs, 'task-ac04')
  assert.equal(logical.lifecycle.state, 'FAILED', '证据缺失不得宣布完成')
  assert.equal(logical.lifecycle.reason.code, 'EVIDENCE_COMMIT_FAILED', '失败原因可追溯')
  assert.ok(logical.control_events.some((e) => e.type === 'evidence_commit_failed'), '控制事件留痕')
})

test('同段重放同一事件行：提交键幂等，节点索引不重复生成 Revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-att-host-'))
  const VALUE = { status: 'DONE', results: { dev: { verdict: 'PASS' } }, history: [] }
  const { wfRun, events, engine, fs } = env({ recordsHost: realRecordsHost(dir) })
  const p = wfRun.execute({ templateId: 'attempt-spec', taskId: 'task-replay' })
  await until(() => engine.pending.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  await drain()
  const line = attemptLine('run-1', { a: 'e', k: 1, n: 'dev', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS' }, o: 'PASS', u: '$.verdict' })
  events.get('workflow/log')({ id: 'run-1' }, line)
  await drain()
  events.get('workflow/log')({ id: 'run-1' }, line)
  await drain()
  settleRun(events, engine, 'run-1', 'completed', VALUE)
  await p
  await drain()
  const review = recordsGet({ records_dir: dir, logical_run_id: 'task-replay', record_id: 'node:task-replay:dev' })
  assert.equal(review.current_revision, 1, '重放不生成新 Revision')
  const logical = readLogical(fs, 'task-replay')
  assert.equal(logical.node_attempts.length, 1, '索引只回填一次')
  assert.equal(logical.lifecycle.state, 'COMPLETED')
})

// FIX-224：实际执行无事件行的冻结脚本，只替换引擎进程边界；不靠构造最终
// node_attempts 冒充脚本执行。模型调用以确定性函数代替，同节点确实调用两次。
const LEGACY_SCRIPT = `
const results = Object.assign({}, args.results || {})
for (let i = 1; i <= 2; i++) {
  calls.push('dev')
  results.dev = { verdict: 'PASS', v: i }
  log('[pw-ckpt]' + JSON.stringify({ c: 'review', r: results, h: [], rd: 0 }))
}
calls.push('review')
results.review = { verdict: 'PASS', verified_branch: 'b', verified_head: 'h' }
return { status: 'DONE', results, history: [] }
`
function runFrozen({ engine, events }, index) {
  const { id, request } = engine.pending[index]
  const calls = []
  const logs = []
  const value = new Function('args', 'log', 'calls', request.script)(request.args, (line) => {
    logs.push(line)
    events.get('workflow/log')({ id }, line)
  }, calls)
  assert.ok(logs.every((line) => !line.includes('[vwf-attempt]')), '冻结脚本只发旧检查点，无逐次事件')
  return { value, calls }
}

test('FIX-224 无事件冻结脚本：同节点真实重入仍一扫描条目，段内连续序号且不扫描段首结果', async () => {
  const context = env({ compileScript: LEGACY_SCRIPT })
  const { wfRun, events, engine, fs, sub } = context
  const p = wfRun.execute({ templateId: 'attempt-spec', taskId: 'legacy-scan', results: { gate: { verdict: 'PASS' } } })
  await until(() => engine.pending.length === 1, '旧脚本启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'legacy' } })
  const { value, calls } = runFrozen(context, 0)
  assert.deepEqual(calls, ['dev', 'dev', 'review'], '同一节点实际调用两次，而不是夹具假称重入')
  settleRun(events, engine, 'run-1', 'completed', value)
  await p
  await drain()
  const rec = readLogical(fs, 'legacy-scan')
  assert.deepEqual(rec.node_attempts.map((a) => [a.node, a.attempt_id, a.evidence_source]), [
    ['dev', 'a1s1', 'segment_scan'], ['review', 'a1s2', 'segment_scan'],
  ])
  assert.equal(rec.node_attempts.filter((a) => a.node === 'dev').length, 1, '不重建已经丢失的调用次数')
  assert.equal(rec.business_outcomes.dev.outcome, 'PASS')
  assert.ok(!rec.node_attempts.some((a) => a.node === 'gate'), '段首已有结果不作为新增节点')
  assert.equal(sub._calls.filter((a) => a.join(' ').includes('records-host.mjs attempt')).length, 0, '扫描摘要不伪造逐次 Store 提交')
})

test('FIX-224 合法业务结果 INTERRUPTED 不等于执行中断：完成扫描保持 completed', async () => {
  const blueprint = structuredClone(BP)
  blueprint.nodes.find((n) => n.id === 'dev').output.schema.properties.verdict.enum.push('INTERRUPTED')
  blueprint.edges.push({ from: 'dev', to: 'review', outcome: 'INTERRUPTED' })
  const compileScript = LEGACY_SCRIPT.replace("results.dev = { verdict: 'PASS', v: i }", "results.dev = { verdict: 'INTERRUPTED', v: i }")
  const context = env({ blueprint, compileScript })
  const { wfRun, events, engine, fs } = context
  const p = wfRun.execute({ templateId: 'attempt-spec', taskId: 'business-interrupted' })
  await until(() => engine.pending.length === 1, '允许 INTERRUPTED 业务枚举的旧脚本启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'legacy' } })
  const { value } = runFrozen(context, 0)
  settleRun(events, engine, 'run-1', 'completed', value)
  await p
  await drain()
  const rec = readLogical(fs, 'business-interrupted')
  const dev = rec.node_attempts.find((a) => a.node === 'dev')
  assert.equal(dev.outcome, 'INTERRUPTED', '专业业务值按 schema 原样保留')
  assert.equal(dev.status, 'completed', '业务字符串不能反推执行状态')
  assert.equal(dev.evidence_source, 'segment_scan')
  assert.equal(rec.business_outcomes.dev.outcome, 'INTERRUPTED')
  assert.equal(rec.lifecycle.state, 'COMPLETED', '正常结束的生命周期与业务值分离')
})

test('FIX-224 旧脚本中断后续跑：中断也标扫描来源，段内编号重置，快照旧结果不重复入档', async () => {
  const context = env({ compileScript: LEGACY_SCRIPT })
  const { wfRun, ctl, events, engine, fs } = context
  const p1 = wfRun.execute({ templateId: 'attempt-spec', taskId: 'legacy-resume' })
  await until(() => engine.pending.length === 1, '旧脚本首段')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'legacy' } })
  ckptLog(events, 'run-1', 'review', { dev: { verdict: 'PASS' } })
  assert.equal(JSON.parse(await ctl.execute({ action: 'interrupt', logical_run_id: 'legacy-resume' })).ok, true)
  settleRun(events, engine, 'run-1', 'cancelled', null)
  await p1
  await drain()
  const before = readLogical(fs, 'legacy-resume')
  assert.deepEqual(before.node_attempts.map((a) => [a.node, a.attempt_id, a.evidence_source, a.outcome]), [
    ['dev', 'a1s1', 'segment_scan', 'PASS'], ['review', 'a1s2', 'segment_scan', 'INTERRUPTED'],
  ])
  assert.equal(before.node_attempts.find((a) => a.node === 'dev').status, 'completed')
  assert.equal(before.node_attempts.find((a) => a.node === 'review').status, 'interrupted', '真实 interrupt 的补录仍明确标中断')
  for (const attempt of before.node_attempts) {
    assert.equal(attempt.isolation_guarantee, 'enforced', 'WFM-69 扫描和中断补录均保留 WFM-81 隔离事实')
    assert.equal(attempt.independent_proof_eligible, before.node_isolation[attempt.node].independent_proof_eligible)
  }
  assert.ok(!before.business_outcomes.review, '中断仍不生成成功业务结果')
  const p2 = wfRun.execute({ templateId: 'attempt-spec', taskId: 'legacy-resume', resume_paused: true })
  await until(() => engine.pending.length === 2, '旧脚本恢复段')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'legacy' } })
  assert.equal(engine.pending[1].request.script, LEGACY_SCRIPT, '续跑仍执行 Rev1 冻结脚本')
  const { value } = runFrozen(context, 1)
  settleRun(events, engine, 'run-2', 'completed', value)
  await p2
  await drain()
  const after = readLogical(fs, 'legacy-resume')
  assert.deepEqual(after.node_attempts.filter((a) => a.segment === 1), before.node_attempts, '历史条目不补偿、不翻转来源')
  assert.deepEqual(after.node_attempts.filter((a) => a.segment === 2).map((a) => [a.node, a.attempt_id, a.evidence_source]), [['review', 'a2s1', 'segment_scan']])
})

test('FIX-224 空扫描段不追加记录，逐次事件段有额外结果也不触发扫描回退', async () => {
  const empty = env()
  const p1 = empty.wfRun.execute({ templateId: 'attempt-spec', taskId: 'legacy-empty', results: { gate: { verdict: 'PASS' } } })
  await until(() => empty.engine.pending.length === 1, '空段')
  settleRun(empty.events, empty.engine, 'run-1', 'completed', { status: 'DONE', results: { gate: { verdict: 'PASS' } } })
  await p1
  await drain()
  assert.deepEqual(readLogical(empty.fs, 'legacy-empty').node_attempts, [])

  const dir = mkdtempSync(join(tmpdir(), 'vwf-att-mixed-'))
  const mixed = env({ recordsHost: realRecordsHost(dir) })
  const p2 = mixed.wfRun.execute({ templateId: 'attempt-spec', taskId: 'event-authority' })
  await until(() => mixed.engine.pending.length === 1, '逐次段')
  mixed.events.get('workflow/log')({ id: 'run-1' }, attemptLine('run-1', { a: 'e', k: 1, n: 'dev', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS' }, o: 'PASS' }))
  await drain()
  settleRun(mixed.events, mixed.engine, 'run-1', 'completed', { status: 'DONE', results: { dev: { verdict: 'PASS' }, review: { verdict: 'PASS' } } })
  await p2
  await drain()
  const rec = readLogical(mixed.fs, 'event-authority')
  assert.deepEqual(rec.node_attempts.map((a) => a.attempt_id), ['a1k1'], '有逐次事件时不从额外结果补造扫描条目')
  assert.ok(rec.node_attempts.every((a) => a.evidence_source !== 'segment_scan'))
  assert.equal(mixed.sub._calls.filter((a) => a.join(' ').includes('records-host.mjs commit')).length, 0, '新脚本段仍零段末提交')
})
