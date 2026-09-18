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
import { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

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

function env({ value = null, recordsHost = null, seedRecordsHost = true } = {}) {
  const seeds = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [DIST + '/attempt-ledger.cjs']: attemptLedgerSrc,
    [USER_DIR + '/attempt-spec.json']: JSON.stringify(BP, null, 2) + '\n',
    [SKILL_ROOT + '/attempt-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  if (seedRecordsHost) seeds[REPO + '/scripts/records-host.mjs'] = recordsHostSrc
  const fs = makeFs(seeds)
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT', recordsHost })
  const engine = {
    start: () => {
      const id = 'run-' + (engine.n = (engine.n || 0) + 1)
      let release = () => {}
      const result = new Promise((r) => { release = r })
      engine.pending.push({ id, release })
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
