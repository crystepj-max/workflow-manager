// #80 Pause / Interrupt / Guidance / Resume 单元测试（fake fs + fake 引擎）：
// Safe Pause 段取消 → PAUSED 翻译与检查点现场重建 / Interrupt 记 INTERRUPTED /
// Guidance 多轮提交与 baseline 配对修订（缺要点拒绝、业务结果保守标失效）/
// resume_paused 回填现场与 Guidance / 改基线恢复回跳基线节点 / 暂停升级中断 /
// 三态语义拒绝（WAITING_HUMAN 不可 pause、RUNNING 不可 guidance、重复 pause 拒绝）/
// 同 Logical Run 新段与旧记录接管 / 编译产物含节点检查点与 Guidance/基线注入行
// 保真边界：fake 引擎只建模 start/end + 事件时序，不建模 signal 与子代理中止
// （真实引擎经共享信号中止进行中子代理——signal 行为在产品模式 UAT 验证）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, makeFs, makeSubprocess, sandboxPolicy, USER_DIR, SKILL_ROOT } from './helpers/fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = DSH_HOME + '/visual-workflow/runs'
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')

const SPEC_BLUEPRINT = {
  id: 'logical-run-spec', displayName: '逻辑运行规格图', description: '', entry: 'explore',
  control: { maxRounds: 9 },
  bindings: { models: { explore: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p1', model: 'm1' } } },
  nodes: [
    { id: 'explore', profile: 'researcher', label: '探索', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
  ],
  edges: [
    { from: 'explore', to: 'closeout', outcome: 'PASS' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}

const call = async (handlers, method, args) => handlers.get(method)(args)
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)) }
const until = async (fn, label, ms = 4000) => {
  const t0 = Date.now()
  while (true) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || ''))
    await new Promise((r) => setTimeout(r, 5))
  }
}
const readLogical = (fs, id) => {
  const key = LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'
  const raw = fs._files.get(key)
  assert.ok(raw, '逻辑运行摘要应已落盘：' + key)
  return JSON.parse(raw)
}
const readRun = (fs, id) => JSON.parse(fs._files.get(RUNS_DIR + '/' + encodeURIComponent(id) + '.json'))

function env({ seed = {}, extra = {} } = {}) {
  const base = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/logical-run-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [SKILL_ROOT + '/logical-run-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  Object.assign(base, seed)
  const fs = makeFs(base)
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' })
  const { handlers, definedTools, events, ctx } = loadHost({
    fs, subprocess: sub, sandboxPolicy,
    agents: { requireInitiator: () => ({}), currentInitiator: () => null },
    workflowEngine: extra.engine,
  })
  return { handlers, definedTools, events, ctx, fs }
}

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

// 结束一段执行：resolve 引擎 result + 投递 end 事件（真实事件语义）
function settle(eng, events, runId, stopReason, value) {
  eng.end(runId, stopReason, value)
  events.get('workflow/end')({ id: runId }, { stopReason: stopReason === 'completed' ? 'completed' : stopReason })
}
// 投递脚本检查点行（编译产物在节点路由后输出 [pw-ckpt] 日志）
function ckptLog(events, runId, next, results) {
  events.get('workflow/log')({ id: runId }, '[pw-ckpt]' + JSON.stringify({ c: next, r: results || {}, h: [], rd: 0, fb: '', bu: 0, mr: 9, ds: 0 }))
}

test('#80 Safe Pause：RUNNING 暂停 → 段取消翻译 PAUSED + 检查点现场 + Timeline', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ extra: { engine: eng } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const ctl = definedTools.find((t) => t.name === 'wf_control')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-pause' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  events.get('workflow/phase')({ id: 'run-1' }, '探索')
  ckptLog(events, 'run-1', 'closeout', { explore: { verdict: 'PASS' } })

  // pause：RUNNING 专属；下发后段以 cancelled 收束
  const r1 = JSON.parse(await ctl.execute({ action: 'pause', logical_run_id: 'issue-pause' }))
  assert.equal(r1.ok, true)
  assert.equal(r1.action, 'pause')
  assert.equal(r1.state, 'requested')
  // 重复 pause 被拒绝（已有待生效请求）
  const r1b = JSON.parse(await ctl.execute({ action: 'pause', logical_run_id: 'issue-pause' }))
  assert.equal(r1b.ok, false)

  settle(eng, events, 'run-1', 'cancelled', null)
  const out = JSON.parse(await p)
  await drain()
  assert.equal(out.paused, true)
  assert.equal(out.action, 'pause')
  assert.equal(out.checkpoint_entry, 'closeout')

  const rec = readLogical(fs, 'issue-pause')
  assert.equal(rec.lifecycle.state, 'PAUSED')
  assert.equal(rec.lifecycle.reason.code, 'USER_PAUSE')
  assert.equal(rec.pause_resume.entry, 'closeout')
  assert.equal(rec.pause_resume.results.explore.verdict, 'PASS')
  assert.equal(rec.pause_resume.degraded, false)
  assert.equal(rec.segments[0].status, 'CANCELLED_PAUSE')
  // 取消段内已完成节点照常入档（#79 逐节点语义不缺位）
  assert.equal(rec.business_outcomes.explore.outcome, 'PASS')
  assert.ok(rec.node_attempts.some((a) => a.node === 'explore' && a.segment === 1))
  const types = rec.control_events.map((e) => e.type)
  assert.ok(types.includes('pause_requested') && types.includes('paused'), '控制事件入 Timeline：' + types.join(','))
  // 持久化：磁盘摘要同为 PAUSED（刷新/重进不丢）
  assert.equal(readLogical(fs, 'issue-pause').lifecycle.state, 'PAUSED')
  const runRec = readRun(fs, 'run-1')
  assert.equal(runRec.status, 'PAUSED')
  assert.equal(runRec.reason, 'USER_PAUSE')
})

test('#80 暂停升级中断：等待检查点期间的 pause 可升级为立即 interrupt', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ extra: { engine: eng } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const ctl = definedTools.find((t) => t.name === 'wf_control')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-up' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  ckptLog(events, 'run-1', 'closeout', { explore: { verdict: 'PASS' } })
  assert.equal(JSON.parse(await ctl.execute({ action: 'pause', logical_run_id: 'issue-up' })).ok, true)
  const up = JSON.parse(await ctl.execute({ action: 'interrupt', logical_run_id: 'issue-up' }))
  assert.equal(up.ok, true)
  assert.equal(up.upgraded, true)
  settle(eng, events, 'run-1', 'cancelled', null)
  const out = JSON.parse(await p)
  await drain()
  assert.equal(out.action, 'interrupt')
  const rec = readLogical(fs, 'issue-up')
  assert.equal(rec.lifecycle.reason.code, 'USER_INTERRUPT')
  assert.equal(rec.node_attempts.filter((a) => a.outcome === 'INTERRUPTED').length, 1)
})

test('#80 Interrupt：进行中 Attempt 记 INTERRUPTED，不产生正式成功结果', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ extra: { engine: eng } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const ctl = definedTools.find((t) => t.name === 'wf_control')
  const p = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-int' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  ckptLog(events, 'run-1', 'closeout', { explore: { verdict: 'PASS' } })
  const r1 = JSON.parse(await ctl.execute({ action: 'interrupt', logical_run_id: 'issue-int' }))
  assert.equal(r1.ok, true)
  settle(eng, events, 'run-1', 'cancelled', null)
  const out = JSON.parse(await p)
  await drain()
  assert.equal(out.action, 'interrupt')
  const rec = readLogical(fs, 'issue-int')
  assert.equal(rec.lifecycle.state, 'PAUSED')
  assert.equal(rec.lifecycle.reason.code, 'USER_INTERRUPT')
  // 被中断 Attempt：INTERRUPTED 且不写入 business_outcomes（无正式成功结果）
  const interrupted = rec.node_attempts.filter((a) => a.outcome === 'INTERRUPTED')
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0].node, 'closeout')
  assert.ok(!rec.business_outcomes.closeout, '被中断节点不得产生正式业务结果')
  assert.ok(rec.control_events.some((e) => e.type === 'interrupted'))
})

test('#80 Guidance：PAUSED 期间多轮 coach + baseline 配对修订（缺要点拒绝、业务结果标失效）', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs, handlers } = env({ extra: { engine: eng } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const ctl = definedTools.find((t) => t.name === 'wf_control')
  // 段 1：explore 产生业务结果后额度耗尽进 WAITING_HUMAN（业务结果保留）
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-g' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settle(eng, events, 'run-1', 'completed', {
    status: 'WAITING_HUMAN', node: 'explore', decision_id: 'd1', decision_package: {},
    results: { explore: { verdict: 'PASS' } },
    control_event: { node_id: 'explore', triggering_node_outcome: { verdict: 'PASS' } },
  })
  await p1
  await drain()
  // RUNNING 才能 Guidance？不——此段已 WAITING_HUMAN：guidance 必须拒绝（三态不混用）
  const gWrong = JSON.parse(await ctl.execute({ action: 'guidance', logical_run_id: 'issue-g', text: '早了', mode: 'coach' }))
  assert.equal(gWrong.ok, false)
  // pause 对 WAITING_HUMAN 同样拒绝
  const pWrong = JSON.parse(await ctl.execute({ action: 'pause', logical_run_id: 'issue-g' }))
  assert.equal(pWrong.ok, false)
  // HD 续跑 → RUNNING → 暂停
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-g', decision_id: 'd1', user_choice: 'ADD_BUDGET', blocked_edge: { from: 'explore', to: 'closeout', on: 'PASS' } })
  await until(() => eng.starts.length >= 2, 'HD 续跑启动')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  ckptLog(events, 'run-2', 'closeout', { explore: { verdict: 'PASS' } })
  assert.equal(JSON.parse(await ctl.execute({ action: 'pause', logical_run_id: 'issue-g' })).ok, true)
  settle(eng, events, 'run-2', 'cancelled', null)
  await p2
  await drain()
  // PAUSED 后 Guidance：coach 成功；baseline 缺 new_baseline 拒绝（不产生孤儿 Guidance）
  const g1 = JSON.parse(await ctl.execute({ action: 'guidance', logical_run_id: 'issue-g', text: '输出用中文', mode: 'coach' }))
  assert.equal(g1.ok, true)
  assert.equal(g1.guidance.seq, 1)
  const gBad = JSON.parse(await ctl.execute({ action: 'guidance', logical_run_id: 'issue-g', text: '改基线', mode: 'baseline' }))
  assert.equal(gBad.ok, false)
  const g2 = JSON.parse(await ctl.execute({ action: 'guidance', logical_run_id: 'issue-g', text: '扩大范围', mode: 'baseline', new_baseline: '范围增加 X 功能' }))
  assert.equal(g2.ok, true)
  assert.equal(g2.baseline_revisions, 1)
  const rec = readLogical(fs, 'issue-g')
  assert.equal(rec.guidance.length, 2)
  assert.equal(rec.baseline_revisions.length, 1)
  assert.equal(rec.baseline_revisions[0].guidance_seq, 2)
  // 实质基线变更：变更前业务结果保守标失效
  assert.equal(rec.business_outcomes.explore.stale, true)
  assert.equal(rec.business_outcomes.explore.stale_reason, 'BASELINE_CHANGE_R1')
  assert.ok(rec.control_events.some((e) => e.type === 'baseline_change'))
  // 恢复：存在待生效基线修订 → 回跳基线负责节点（Rev1 工作流入口 = explore）整体重跑，
  // 现场与全部 Guidance 与基线修订注入执行载荷；同 Logical Run 新段
  const p3 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-g', resume_paused: true })
  await until(() => eng.starts.length >= 3, '暂停恢复启动')
  const req3 = eng.starts[2]
  assert.equal(req3.args.entry, 'explore', '改基线恢复应回跳基线负责节点')
  assert.equal(req3.args.results.explore.verdict, 'PASS')
  assert.ok(String(req3.args.guidance_text).includes('输出用中文'))
  assert.equal(req3.args.baseline_amendment, '范围增加 X 功能')
  events.get('workflow/start')({ id: 'run-3', meta: { name: 'x' } })
  settle(eng, events, 'run-3', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } }, completion: { type: '正常完成', node: 'closeout', path: '' } })
  const out3 = JSON.parse(await p3)
  await drain()
  assert.equal(out3.stopReason, 'completed')
  const rec3 = readLogical(fs, 'issue-g')
  assert.equal(rec3.segments.length, 3)
  assert.equal(rec3.segments[2].trigger, 'pause_resume')
  assert.equal(rec3.lifecycle.state, 'COMPLETED')
  assert.equal(rec3.baseline_applied_upto, 1, '基线修订随本次恢复消费')
  assert.ok(rec3.control_events.some((e) => e.type === 'baseline_rebase'))
  // 变更前标失效的业务结果被重跑新结果覆盖恢复
  assert.equal(rec3.business_outcomes.explore.stale, undefined)
  assert.equal(rec3.business_outcomes.explore.outcome, 'PASS')
  // 旧 PAUSED run 记录被新段接管
  assert.equal(readRun(fs, 'run-2').supersededBy, 'run-3')
})

test('#80 状态语义拒绝：resume_paused 仅用于 PAUSED；缺检查点诚实降级', async () => {
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ extra: { engine: eng } })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  // 无任何逻辑运行：resume_paused 明确报错
  const err1 = await wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-none', resume_paused: true })
  assert.ok(String(err1).includes('没有可恢复的逻辑运行'))
  // 正常运行到 WAITING_HUMAN（无检查点行）：resume_paused 须提示改用 entry
  const p1 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-deg' })
  await until(() => eng.starts.length >= 1, '启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settle(eng, events, 'run-1', 'completed', { status: 'WAITING_HUMAN', node: 'explore', decision_id: 'd1', decision_package: {}, results: {}, control_event: {} })
  await p1
  await drain()
  const ctl = definedTools.find((t) => t.name === 'wf_control')
  // WAITING_HUMAN 不可 pause（走 HD 流程），故造 PAUSED 降级现场：HD 续跑后直接取消前不投检查点
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-deg', decision_id: 'd1', user_choice: 'ADD_BUDGET', blocked_edge: { from: 'explore', to: 'closeout', on: 'PASS' } })
  await until(() => eng.starts.length >= 2, '续跑')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  assert.equal(JSON.parse(await ctl.execute({ action: 'pause', logical_run_id: 'issue-deg' })).ok, true)
  settle(eng, events, 'run-2', 'cancelled', null)
  await p2
  await drain()
  const rec = readLogical(fs, 'issue-deg')
  assert.equal(rec.pause_resume.degraded, true)
  const err2 = await wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-deg', resume_paused: true })
  assert.ok(String(err2).includes('entry'), '降级现场要求人工指定入口：' + err2)
})

test('#80 编译产物：节点检查点行 + Guidance/基线修订注入行存在', async () => {
  // 直接调用真编译器（宿主测试环境的编译通道是 mock，不反映生成脚本）
  const { compileBlueprint } = await import(join(here, '..', '..', '..', 'scripts', 'generate.mjs'))
  const { script } = compileBlueprint(JSON.parse(JSON.stringify(SPEC_BLUEPRINT)))
  assert.ok(script.includes('[pw-ckpt]'), '脚本应输出节点检查点行')
  assert.ok(script.includes('function pwCk('), '脚本应定义检查点函数')
  assert.ok(script.includes('A.guidance_text'), 'runtimeCtx 应注入用户指导')
  assert.ok(script.includes('A.baseline_amendment'), 'issueBlock 应注入基线修订')
})
