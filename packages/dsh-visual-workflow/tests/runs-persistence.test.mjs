// runs 运行记录持久化（issue #40，P2-T2b）单元测试（fake fs 服务）：
// 落盘（事件流一致 + start 快照）/ wf_run 权威终态 / 重启回载 / 跨重启门禁互斥 /
// 内存 miss 磁盘回落 / 容量淘汰 / 损坏文件容错 / 落盘失败隔离
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = DSH_HOME + '/visual-workflow/runs'
const realGenerated = join(here, '..', '..', '..', '.generated', 'dev-workflow-2-0', 'vwf-dsl.json')
// 统一校验内核（候选二 T-IMP-13）：宿主经 fs 读源码求值——wf_run 路径需种入真实内核
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')

const MINIMAL_BUILTIN = JSON.stringify({
  id: 'dev-workflow-2-0', name: '开发工作流 2.0', description: '内置最小样例', entry: 'dispatch',
  control: { maxRounds: 9 },
  nodes: [
    { id: 'dispatch', profile: 'dispatcher', label: '调度', goal: 'g', model: { provider: 'p1', model: 'm1' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', manualCheck: true, model: { provider: 'p1', model: 'm1' } },
  ],
  edges: [
    { from: 'dispatch', to: 'closeout', on: 'success' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}, null, 2) + '\n'

const call = async (handlers, method, args) => handlers.get(method)(args)
// 落盘/回载/淘汰均为微任务链（假 fs 无真 IO）：setImmediate 宏任务边界前微任务全数排空
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)) }
const runFiles = (fs) => [...fs._files.keys()].filter((k) => k.startsWith(RUNS_DIR + '/'))
const readRun = (fs, id) => JSON.parse(fs._files.get(RUNS_DIR + '/' + id + '.json'))

function seedRun(id, over = {}) {
  return JSON.stringify({
    id: id, meta: { name: 'seed ' + id, description: '' }, status: 'DONE', phase: 'closeout',
    logs: ['[phase] closeout'], agents: [], taskId: 'task-' + id, workflowId: 'w',
    startedAt: 1000, supersededBy: '', updatedAt: 1000, ...over,
  }, null, 2) + '\n'
}

function env({ failPattern, extra = {}, seed = {} } = {}) {
  const base = {
    [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: existsSync(realGenerated) ? readFileSync(realGenerated, 'utf8') : MINIMAL_BUILTIN,
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
  }
  Object.assign(base, seed)
  const fs = makeFs(base)
  const compileScript = existsSync(realGenerated)
    ? readFileSync(join(here, '..', '..', '..', '.generated', 'dev-workflow-2-0', 'script.mjs'), 'utf8')
    : '//MOCK-SCRIPT'
  const sub = makeSubprocess({ failPattern, fs, compileScript })
  const { handlers, definedTools, events, ctx } = loadHost({ fs, subprocess: sub, sandboxPolicy, ...extra })
  return { handlers, definedTools, events, ctx, fs, sub }
}

// idPrefix：重启场景避免假引擎 id 复用（真引擎 runId 全局唯一，跨进程不会撞号）
function makeEngine(idPrefix = 'run-') {
  const pending = []
  return {
    starts: [],
    start(req) {
      this.starts.push(req)
      const id = idPrefix + this.starts.length
      let release = () => {}
      const result = new Promise((r) => { release = r })
      pending.push({ id, release })
      return { id, result }
    },
    end(id, stopReason, value) {
      const p = pending.find((x) => x.id === id)
      if (p) p.release({ stopReason, value: value === undefined ? null : value, agentsStarted: 0 })
    },
  }
}

// 结束一次运行：resolve 引擎 result（wf_run 回执需要）+ 投递 workflow/end 事件
// （真实引擎语义：workflow/end 只带 stopReason，脚本终态在 result.value 里）
function settleRun(eng, events, id, scriptStatus) {
  eng.end(id, 'completed', { status: scriptStatus })
  const ev = events.get('workflow/end')
  if (ev) ev({ id }, { stopReason: 'completed' })
}

function engineEnv(eng, opts = {}) {
  return env({
    extra: { workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null }, ...(opts.extra || {}) },
    seed: opts.seed,
  })
}

async function until(fn, label, ms = 4000) {
  const t0 = Date.now()
  while (true) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || '条件未满足'))
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('#40 AC2：workflow/start 后即有可见快照；事件流与落盘内容一致', async () => {
  const { events, fs } = env()
  events.get('workflow/start')({ id: 'run-p1', meta: { name: '样例', description: 'd' } })
  await drain()
  let rec = readRun(fs, 'run-p1')
  assert.equal(rec.status, 'running', 'start 后即落 running 快照')
  assert.equal(rec.meta.name, '样例')
  assert.equal(typeof rec.startedAt, 'number')
  assert.equal(typeof rec.updatedAt, 'number')

  events.get('workflow/phase')({ id: 'run-p1' }, '开发')
  events.get('workflow/log')({ id: 'run-p1' }, '开发日志一行')
  events.get('workflow/agent-start')({ id: 'run-p1' }, { seq: 1, label: 'dev', phase: '开发' })
  events.get('workflow/agent-end')({ id: 'run-p1' }, { seq: 1, outcome: 'completed' })
  await drain()
  rec = readRun(fs, 'run-p1')
  assert.equal(rec.phase, '开发')
  assert.ok(rec.logs.includes('[phase] 开发') && rec.logs.includes('开发日志一行'), '日志随事件流落盘')
  assert.deepEqual(rec.agents, [{ seq: 1, label: 'dev', phase: '开发', outcome: 'completed' }], '子代理 label/outcome 落盘')

  events.get('workflow/end')({ id: 'run-p1' }, { stopReason: 'completed' })
  await drain()
  rec = readRun(fs, 'run-p1')
  assert.equal(rec.status, 'completed', '终态落定落盘')
})

test('#40：wf_run 权威终态（value.status 回写 DONE）落盘；runTag 元数据随快照持久化', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = engineEnv(eng)
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-40' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '开发工作流 2.0' } })
  settleRun(eng, events, 'run-1', 'DONE')
  await p1
  await drain()
  const rec = readRun(fs, 'run-1')
  assert.equal(rec.status, 'DONE', '权威终态 DONE 覆盖事件层 completed 后落盘')
  assert.equal(rec.taskId, 'issue-40', '启动边界登记的 taskId 随快照持久化')
  assert.equal(rec.workflowId, 'dev-workflow-2-0')
})

test('#40 AC1：重启后按原 runId 仍可查看终态/阶段/子代理表/日志（数据来自磁盘回载）', async () => {
  // 实例 A：完整跑一轮停在人工门禁
  const engA = makeEngine()
  const a = engineEnv(engA)
  const wfRunA = a.definedTools.find(t => t.name === 'wf_run')
  const p1 = wfRunA.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-77' })
  await until(() => engA.starts.length >= 1, 'A 启动')
  a.events.get('workflow/start')({ id: 'run-1', meta: { name: '开发工作流 2.0', description: '' } })
  a.events.get('workflow/phase')({ id: 'run-1' }, '验收')
  a.events.get('workflow/log')({ id: 'run-1' }, '等待人工验收')
  a.events.get('workflow/agent-start')({ id: 'run-1' }, { seq: 1, label: 'accept', phase: '验收' })
  settleRun(engA, a.events, 'run-1', 'AWAITING_HUMAN_accept')
  await p1
  await drain()

  // 实例 B：同一磁盘（同一假 fs）重新加载插件 = DSH 进程重启
  const engB = makeEngine('rb-')
  const b = loadHost({
    fs: a.fs, subprocess: makeSubprocess({ fs: a.fs }), sandboxPolicy,
    workflowEngine: engB, agents: { requireInitiator: () => ({}), currentInitiator: () => null },
  })
  let s = null
  await until(async () => { s = await call(b.handlers, 'vwf.state', { runId: 'run-1' }); return s.found }, 'B 回载 run-1')
  assert.equal(s.state.status, 'AWAITING_HUMAN_accept', '终态来自磁盘回载')
  assert.equal(s.state.phase, '验收')
  assert.ok(s.state.logs.includes('等待人工验收'), '日志来自磁盘回载')
  assert.deepEqual(s.state.agents.map(x => x.label), ['accept'], '子代理表来自磁盘回载')
  assert.equal(s.state.taskId, 'issue-77')
  assert.equal(s.state.workflowId, 'dev-workflow-2-0')
  const list = await call(b.handlers, 'vwf.runs.list', {})
  assert.ok(list.runs.some(r => r.id === 'run-1' && r.taskId === 'issue-77'), '回载记录进入运行清单')
})

test('#40：重启后 AWAITING_HUMAN 门禁继续保持同 taskId 互斥；entry 续跑接管并回写磁盘', async () => {
  const engA = makeEngine()
  const a = engineEnv(engA)
  const wfRunA = a.definedTools.find(t => t.name === 'wf_run')
  const p1 = wfRunA.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-78' })
  await until(() => engA.starts.length >= 1, 'A 启动')
  a.events.get('workflow/start')({ id: 'run-1', meta: { name: '开发工作流 2.0' } })
  settleRun(engA, a.events, 'run-1', 'AWAITING_HUMAN_accept')
  await p1
  await drain()

  const engB = makeEngine('rb-')
  const b = loadHost({
    fs: a.fs, subprocess: makeSubprocess({ fs: a.fs }), sandboxPolicy,
    workflowEngine: engB, agents: { requireInitiator: () => ({}), currentInitiator: () => null },
  })
  await until(async () => (await call(b.handlers, 'vwf.state', { runId: 'run-1' })).found, 'B 回载 run-1')
  const wfRunB = b.definedTools.find(t => t.name === 'wf_run')
  const blocked = await wfRunB.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-78' })
  assert.ok(blocked.includes('串行互斥'), '重启后门禁仍占用 taskId：' + blocked)
  assert.equal(engB.starts.length, 0, '被拒调用未触达引擎')

  const p2 = wfRunB.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-78', entry: 'accept', approved: true })
  await until(() => engB.starts.length >= 1, 'B 续跑绕过互斥')
  b.events.get('workflow/start')({ id: 'rb-1', meta: { name: '开发工作流 2.0' } })
  const s1 = await call(b.handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(s1.state.supersededBy, 'rb-1', '重启后旧门禁被续跑接管')
  settleRun(engB, b.events, 'rb-1', 'DONE')
  await p2
  await drain()
  assert.equal(readRun(a.fs, 'run-1').supersededBy, 'rb-1', '接管标记回写磁盘')
  assert.equal(readRun(a.fs, 'rb-1').status, 'DONE', '续跑终态落盘')
})

test('#40：内存 miss 磁盘回落——未回载进内存的历史记录按 runId 直查并水合', async () => {
  const seed = {}
  for (let i = 0; i < 25; i++) {
    const id = 'seed-' + String(i).padStart(2, '0')
    seed[RUNS_DIR + '/' + id + '.json'] = seedRun(id, { startedAt: 2000 + i, updatedAt: 2000 + i })
  }
  const { handlers } = env({ seed })
  await until(async () => (await call(handlers, 'vwf.runs.list', {})).runs.length === 20, '内存只回载最近 20 条')
  const list = await call(handlers, 'vwf.runs.list', {})
  assert.ok(!list.runs.some(r => r.id === 'seed-00'), '最旧 5 条不占内存（留在磁盘）')
  assert.ok(list.runs.some(r => r.id === 'seed-24'), '最新记录已回载')

  const s = await call(handlers, 'vwf.state', { runId: 'seed-00' })
  assert.equal(s.found, true, '磁盘回落命中')
  assert.equal(s.state.taskId, 'task-seed-00')
  assert.equal(s.state.status, 'DONE')
  const list2 = await call(handlers, 'vwf.runs.list', {})
  assert.equal(list2.runs.length, 21, '回落命中即水合进内存清单')
})

test('#40：vwf.runs.history 返回磁盘全量清单（最新在前、不水合内存、损坏跳过）', async () => {
  const seed = {}
  for (let i = 0; i < 25; i++) {
    const id = 'seed-' + String(i).padStart(2, '0')
    seed[RUNS_DIR + '/' + id + '.json'] = seedRun(id, { startedAt: 2000 + i, updatedAt: 2000 + i })
  }
  seed[RUNS_DIR + '/broken.json'] = '{ 坏'
  const { handlers } = env({ seed })
  await until(async () => (await call(handlers, 'vwf.runs.list', {})).runs.length === 20, '内存回载 20 条')
  const hist = await call(handlers, 'vwf.runs.history', {})
  assert.equal(hist.runs.length, 25, '磁盘全量 25 条（含未回载，跳过损坏文件）')
  assert.equal(hist.runs[0].id, 'seed-24', '最新在前')
  assert.equal(hist.runs[24].id, 'seed-00', '最旧在末')
  assert.equal(hist.runs[0].taskId, 'task-seed-24')
  // 历史 RPC 只读不水合：内存清单仍保持 20 条上限语义
  const list = await call(handlers, 'vwf.runs.list', {})
  assert.equal(list.runs.length, 20, 'history 不水合进内存')
})

test('#40 AC3：容量淘汰——超过保留上限后最旧记录被清理（启动淘汰 + 运行期淘汰）', async () => {
  const seed = {}
  for (let i = 0; i < 53; i++) {
    const id = 'seed-' + String(i).padStart(2, '0')
    seed[RUNS_DIR + '/' + id + '.json'] = seedRun(id, { startedAt: 1000 + i, updatedAt: 1000 + i })
  }
  const { events, fs } = env({ seed })
  await until(() => runFiles(fs).length <= 50, '启动淘汰到保留上限')
  assert.equal(runFiles(fs).length, 50, '磁盘条数收敛到上限 50')
  for (const gone of ['seed-00', 'seed-01', 'seed-02']) {
    assert.ok(!fs._files.has(RUNS_DIR + '/' + gone + '.json'), gone + ' 已被淘汰')
  }
  assert.ok(fs._files.has(RUNS_DIR + '/seed-52.json'), '最新记录保留')

  // 运行期：新 run 落盘再次触发淘汰，活跃 run 自身不被淘汰
  events.get('workflow/start')({ id: 'run-live', meta: { name: 'live' } })
  await until(() => runFiles(fs).length === 50 && !fs._files.has(RUNS_DIR + '/seed-03.json'), '运行期淘汰最旧')
  assert.ok(fs._files.has(RUNS_DIR + '/run-live.json'), '活跃 run 快照保留')
})

test('#40 AC5：损坏文件容错——坏文件跳过留痕，好记录照常回载', async () => {
  const seed = {
    [RUNS_DIR + '/good-1.json']: seedRun('good-1', { updatedAt: 3001 }),
    [RUNS_DIR + '/broken.json']: '{ 这不是 JSON',
    [RUNS_DIR + '/no-id.json']: JSON.stringify({ status: 'DONE' }),
  }
  const { handlers } = env({ seed })
  let s = null
  await until(async () => { s = await call(handlers, 'vwf.state', { runId: 'good-1' }); return s.found }, '好记录回载')
  assert.equal(s.state.status, 'DONE')
  assert.equal((await call(handlers, 'vwf.state', { runId: 'broken' })).found, false, '损坏记录不可读即未找到')
  const list = await call(handlers, 'vwf.runs.list', {})
  assert.deepEqual(list.runs.map(r => r.id), ['good-1'], '损坏文件不进入清单')
})

test('#40 AC4：落盘失败不影响运行本身——内存态不受损，恢复后按最新状态补写', async () => {
  const { events, handlers, fs } = env()
  const realWrite = fs.writeText.bind(fs)
  let fail = true
  fs.writeText = async (t, content, a2, b2, p) => {
    const path = (t && (t.displayPath || t.targetKey)) || ''
    if (fail && path.indexOf('/visual-workflow/runs/') >= 0) throw new Error('模拟磁盘写失败')
    return realWrite(t, content, a2, b2, p)
  }
  events.get('workflow/start')({ id: 'run-x', meta: { name: 'X' } })
  events.get('workflow/phase')({ id: 'run-x' }, '开发')
  events.get('workflow/end')({ id: 'run-x' }, { stopReason: 'completed' })
  await drain()
  assert.ok(!fs._files.has(RUNS_DIR + '/run-x.json'), '写失败未产生文件')
  const s = await call(handlers, 'vwf.state', { runId: 'run-x' })
  assert.equal(s.found, true, 'runs 内存态不受落盘失败影响')
  assert.equal(s.state.status, 'completed')
  assert.equal(s.state.phase, '开发')

  fail = false
  events.get('workflow/log')({ id: 'run-x' }, '恢复后一条日志')
  await drain()
  const rec = readRun(fs, 'run-x')
  assert.equal(rec.status, 'completed', '恢复后按最新内存态补写终态')
  assert.ok(rec.logs.includes('恢复后一条日志'))
})

test('#40：runId 特殊字符落盘文件名清洗', async () => {
  const { events, fs } = env()
  events.get('workflow/start')({ id: 'run x/y:z', meta: { name: 'w' } })
  await drain()
  assert.ok(fs._files.has(RUNS_DIR + '/run_x_y_z.json'), '非法文件名字符替换为下划线')
})

test('#40 评审修复：重启中断的 running 快照不永久占用同 taskId 互斥', async () => {
  const seed = {
    [RUNS_DIR + '/stuck-1.json']: seedRun('stuck-1', { status: 'running', phase: '开发', taskId: 'task-stuck', startedAt: 5000, updatedAt: 5000 }),
  }
  const engB = makeEngine('rb-')
  const b = env({ seed, extra: { workflowEngine: engB, agents: { requireInitiator: () => ({}), currentInitiator: () => null } } })
  const wfRun = b.definedTools.find(t => t.name === 'wf_run')
  let s = null
  await until(async () => { s = await call(b.handlers, 'vwf.state', { runId: 'stuck-1' }); return s.found }, '回载 stuck-1')
  assert.equal(s.state.status, 'running', '历史展示保留原状态')
  // 中断快照（进程死亡、无门禁语义）不得永久占用 taskId
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'task-stuck' })
  await until(() => engB.starts.length >= 1, '新启动被放行')
  b.events.get('workflow/start')({ id: 'rb-1', meta: { name: 'x' } })
  settleRun(engB, b.events, 'rb-1', 'DONE')
  const r1 = await p1
  assert.ok(r1.includes('"status":"DONE"'), r1)
})

test('#40 评审修复：回载窗口外的门禁保持互斥并可接管回写磁盘', async () => {
  const seed = {}
  for (let i = 0; i < 25; i++) {
    const id = 'gate-' + String(i).padStart(2, '0')
    seed[RUNS_DIR + '/' + id + '.json'] = seedRun(id, {
      status: 'AWAITING_HUMAN_b', phase: 'b',
      taskId: 'task-gate-' + String(i).padStart(2, '0'), workflowId: 'dev-workflow-2-0',
      startedAt: 7000 + i, updatedAt: 7000 + i,
    })
  }
  const engB = makeEngine('rb-')
  const b = env({ seed, extra: { workflowEngine: engB, agents: { requireInitiator: () => ({}), currentInitiator: () => null } } })
  const wfRun = b.definedTools.find(t => t.name === 'wf_run')
  // gate-00 最旧、在回载窗口外（幽灵门禁）：execute 先等回载完成再判定互斥
  const blocked = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'task-gate-00' })
  assert.ok(blocked.includes('串行互斥'), '幽灵门禁占用互斥：' + blocked)
  assert.ok(blocked.includes('gate-00'), '提示占用的 runId')
  // entry 续跑放行并接管；接管标记经按需水合回写磁盘
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'task-gate-00', entry: 'b', approved: true })
  await until(() => engB.starts.length >= 1, '续跑绕过互斥')
  b.events.get('workflow/start')({ id: 'rb-1', meta: { name: 'x' } })
  settleRun(engB, b.events, 'rb-1', 'DONE')
  await p2
  await drain()
  await until(() => { try { return readRun(b.fs, 'gate-00').supersededBy === 'rb-1' } catch (e) { return false } }, '接管标记回写磁盘')
})
