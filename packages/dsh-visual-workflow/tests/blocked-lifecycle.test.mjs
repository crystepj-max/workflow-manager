// LOC-030 统一受阻、恢复与完成的生命周期语义（WR-009 V1）宿主层测试（fake fs + fake 引擎）：
// AC-01 业务受阻 → BLOCKED 非终态 + 同 Run 恢复（不新建假成功记录）
// AC-02 M2 额度耗尽原因码（AUTO_REWORK_EXHAUSTED）保真落档
// AC-03 DONE 无有效业务完成映射不记 COMPLETED；描述完成映射记 COMPLETED；历史 DONE 标记 legacy
// AC-04 NEEDS_REDEFINE 拒绝续跑（保留旧 Run、不同 Run 静默换版）
// 保真边界：脚本侧终止描述由真实编译器生成（scripts/test/blocked-lifecycle.test.mjs 覆盖），
// 此处用 fake 引擎注入等价 value，与生成脚本返回契约一致。
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

function engineEnv(eng) {
  const fs = makeFs({
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/logical-run-spec.json']: JSON.stringify(SPEC_BLUEPRINT, null, 2) + '\n',
    [SKILL_ROOT + '/logical-run-spec/script.mjs']: '//MOCK-SCRIPT',
  })
  const { handlers, definedTools, events } = loadHost({
    fs, subprocess: makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT' }), sandboxPolicy,
    agents: { requireInitiator: () => ({}), currentInitiator: () => null },
    workflowEngine: eng,
  })
  return { handlers, definedTools, events, fs }
}

async function runOnce(eng, events, wfRun, args) {
  const promise = wfRun.execute({ templateId: 'logical-run-spec', ...args })
  await until(() => eng.starts.length >= 1, '启动')
  const runId = 'run-' + eng.starts.length
  events.get('workflow/start')({ id: runId, meta: { name: 'x' } })
  return { promise, runId }
}

function settleRun(eng, events, runId, stopReason, value) {
  eng.end(runId, stopReason, value)
  events.get('workflow/end')({ id: runId }, { stopReason })
}

// 受阻终止 value（与生成脚本 finishRun 契约一致）
const blockedValue = (over = {}) => Object.assign({
  status: 'BLOCKED', taskId: 'issue-bl', round: 0, results: { explore: { verdict: 'BLOCKED' } }, history: [],
  completion: null,
  termination: { business_outcome: 'BLOCKED', lifecycle: 'BLOCKED', reason_code: 'BUSINESS_BLOCKED', resumable: true, resume_node: 'explore' },
  blocked: { reason_code: 'BUSINESS_BLOCKED', business_outcome: 'BLOCKED', resumable: true, resume_node: 'explore', failed_node: 'explore', last_outcome: { verdict: 'BLOCKED' } },
}, over)

test('AC-01：诊断受阻 → BLOCKED 非终态；entry 恢复同一 Run，不新建假成功记录', async () => {
  const eng = makeEngine()
  const { definedTools, events, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p1 = (await runOnce(eng, events, wfRun, { taskId: 'issue-bl' })).promise
  settleRun(eng, events, 'run-1', 'completed', blockedValue())
  const out1 = JSON.parse(await p1)
  await drain()

  // 回执一致解释：状态/终止描述/恢复入口
  assert.equal(out1.value.status, 'BLOCKED')
  assert.equal(out1.value.termination.reason_code, 'BUSINESS_BLOCKED')
  assert.equal(out1.value.blocked.resume_node, 'explore')
  const rec1 = readLogical(fs, 'issue-bl')
  assert.equal(rec1.lifecycle.state, 'BLOCKED', '受阻为 BLOCKED 生命周期')
  assert.equal(rec1.terminal, false, '受阻非终态（可恢复）')
  assert.equal(rec1.lifecycle.reason.code, 'BUSINESS_BLOCKED', '结构化原因码')
  assert.equal(rec1.completion, null, '受阻无完成映射')
  const runRec = JSON.parse(fs._files.get(RUNS_DIR + '/run-1.json'))
  assert.equal(runRec.status, 'BLOCKED', '运行卡片状态一致')
  assert.equal(JSON.parse(fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent('issue-bl') + '.json')).segments.length, 1)

  // 环境恢复后：同 taskId + entry=resume_node 续跑同一逻辑运行（不派生新运行）
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-bl', entry: 'explore', results: { explore: { verdict: 'BLOCKED' } } })
  await until(() => eng.starts.length >= 2, '恢复启动')
  assert.equal(eng.starts[1].args.entry, 'explore', '从受阻节点重跑（重检阻塞条件）')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'completed', {
    status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'ok' } }, history: [],
    completion: { type: 'EVALUATION_PASSED', node: 'closeout', path: '$.result' },
    termination: { business_outcome: 'PASS', lifecycle: 'COMPLETED', reason_code: 'COMPLETED', resumable: false, resume_node: 'closeout', completion_type: 'EVALUATION_PASSED' },
  })
  await p2
  await drain()
  const rec2 = readLogical(fs, 'issue-bl')
  assert.equal(rec2.segments.length, 2, '恢复追加为同 Run 第 2 段（不新建假成功记录）')
  assert.equal(rec2.segments[1].trigger, 'legacy_resume')
  assert.equal(rec2.lifecycle.state, 'COMPLETED')
  assert.equal(rec2.completion.type, 'EVALUATION_PASSED')
})

test('AC-02：M2 额度耗尽受阻原因码（AUTO_REWORK_EXHAUSTED）保真落档', async () => {
  const eng = makeEngine()
  const { definedTools, events, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = (await runOnce(eng, events, wfRun, { taskId: 'issue-m2' })).promise
  settleRun(eng, events, 'run-1', 'completed', blockedValue({
    taskId: 'issue-m2',
    termination: { business_outcome: 'RETURN_DEV', lifecycle: 'BLOCKED', reason_code: 'AUTO_REWORK_EXHAUSTED', resumable: true, resume_node: 'dev' },
    blocked: { reason_code: 'AUTO_REWORK_EXHAUSTED', business_outcome: 'RETURN_DEV', resumable: true, resume_node: 'dev', failed_node: 'review', rounds_used: 3, max_rounds: 3, last_outcome: { route: 'RETURN_DEV' } },
  }))
  await p
  await drain()
  const rec = readLogical(fs, 'issue-m2')
  assert.equal(rec.lifecycle.state, 'BLOCKED')
  assert.equal(rec.terminal, false, '额度耗尽受阻非终态（可恢复，不冒充成功）')
  assert.equal(rec.lifecycle.reason.code, 'AUTO_REWORK_EXHAUSTED')
})

test('AC-03：DONE 但无有效业务完成映射 → 不记 COMPLETED（降级可恢复受阻）', async () => {
  const eng = makeEngine()
  const { definedTools, events, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = (await runOnce(eng, events, wfRun, { taskId: 'issue-nomap' })).promise
  settleRun(eng, events, 'run-1', 'completed', {
    status: 'DONE', results: {}, history: [], completion: null,
    termination: { business_outcome: 'DELIVERED', lifecycle: 'COMPLETED', reason_code: 'COMPLETED', resumable: false, resume_node: 'closeout' },
  })
  await p
  await drain()
  const rec = readLogical(fs, 'issue-nomap')
  assert.equal(rec.lifecycle.state, 'BLOCKED', '无有效完成映射不记 COMPLETED')
  assert.equal(rec.terminal, false)
  assert.equal(rec.lifecycle.reason.code, 'COMPLETION_MISSING')
})

test('AC-03：带完成映射的 DONE 记 COMPLETED；历史无描述 DONE 保留 legacy 标记', async () => {
  const eng = makeEngine()
  const { definedTools, events, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  // 新描述 + completionPath 实际值 → COMPLETED
  const p1 = (await runOnce(eng, events, wfRun, { taskId: 'issue-ok' })).promise
  settleRun(eng, events, 'run-1', 'completed', {
    status: 'DONE', results: { explore: { verdict: 'PASS' }, closeout: { result: 'EVALUATION_PASSED' } }, history: [],
    completion: { type: 'EVALUATION_PASSED', node: 'closeout', path: '$.result' },
    termination: { business_outcome: 'PASS', lifecycle: 'COMPLETED', reason_code: 'COMPLETED', resumable: false, resume_node: 'closeout', completion_type: 'PASS' },
  })
  await p1
  // 历史形态 DONE（无终止描述）→ 保留 COMPLETED 并标记 legacy 映射（不改写历史）
  const p2 = wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-legacy' })
  await until(() => eng.starts.length >= 2, 'legacy 启动')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'completed', { status: 'DONE', results: { explore: { verdict: 'PASS' } }, history: [] })
  await p2
  await drain()
  const ok = readLogical(fs, 'issue-ok')
  assert.equal(ok.lifecycle.state, 'COMPLETED')
  assert.equal(ok.completion.type, 'EVALUATION_PASSED', '完成类型与生命周期分离持久化')
  assert.equal(ok.lifecycle.reason, null, '描述驱动的 COMPLETED 无 legacy 标记')
  const legacy = readLogical(fs, 'issue-legacy')
  assert.equal(legacy.lifecycle.state, 'COMPLETED', '历史 DONE 不改写')
  assert.equal(legacy.lifecycle.reason.code, 'LEGACY', '历史 DONE 标记 legacy 映射（不冒充已验证完成）')
})

test('AC-04：NEEDS_REDEFINE 受阻拒绝续跑（保留旧 Run、不在同 Run 静默换版）', async () => {
  const eng = makeEngine()
  const { definedTools, events, fs } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p1 = (await runOnce(eng, events, wfRun, { taskId: 'issue-nr' })).promise
  settleRun(eng, events, 'run-1', 'completed', blockedValue({
    termination: { business_outcome: 'NEED_REDEFINE', lifecycle: 'BLOCKED', reason_code: 'NEEDS_REDEFINE', resumable: false, resume_node: 'explore' },
    blocked: { reason_code: 'NEEDS_REDEFINE', business_outcome: 'NEED_REDEFINE', resumable: false, resume_node: 'explore', failed_node: 'explore', last_outcome: null },
  }))
  await p1
  await drain()
  const err = await wfRun.execute({ templateId: 'logical-run-spec', taskId: 'issue-nr', entry: 'explore' })
  assert.ok(String(err).includes('NEEDS_REDEFINE'), '续跑被拒并指向重定义：' + err)
  assert.equal(eng.starts.length, 1, '拒绝路径不启动引擎')
  const rec = readLogical(fs, 'issue-nr')
  assert.equal(rec.lifecycle.state, 'BLOCKED', '旧 Run 保留受阻原样')
  assert.equal(rec.lifecycle.reason.code, 'NEEDS_REDEFINE')
})
