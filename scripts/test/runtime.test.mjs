// 运行时排练厅场景套件（候选三）——第一、二层：框架级（微型图纸）+ 模板级回归（内置蓝图）。
// 契约：框架级场景与业务无关，验证「任何图纸运行要么走通、要么明确终止」；
// 模板级场景仅回归内置「开发工作流 2.0」，不属于框架契约。
// 所有场景断言返回体（接口）而非脚本字符串。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint, generateAll } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tplDir = path.join(here, '../../templates')
const tpl = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'))
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))

// 微型图纸（框架级）与内置蓝图（模板级）都应通过蓝图校验（夹具卫生）
import validatorCore from '../validate-core.cjs'
const { validateBlueprint, COND_RE } = validatorCore
test('夹具卫生：微型图纸与内置蓝图均通过蓝图校验（含走通性规则）', () => {
  assert.equal(validateBlueprint(mini).ok, true, JSON.stringify(validateBlueprint(mini).errors))
  assert.equal(validateBlueprint(tpl).ok, true, JSON.stringify(validateBlueprint(tpl).errors))
})

test('COND_RE 单一来源：内核正则与生成脚本内嵌正则逐字一致（候选二）', () => {
  const { script } = compileBlueprint(mini)
  const embedded = /function cond\(expr, res\) \{[\s\S]*?const m = (\/.*?\/)\.exec\(expr\)/.exec(script)
  assert.ok(embedded, '生成脚本应含内嵌条件正则')
  assert.equal(embedded[1].slice(1, -1), COND_RE.source, '内嵌正则与内核 COND_RE 必须一致（否则校验与运行时语义漂移）')
})

// ---------- 第一层 · 框架级场景（微型图纸 hello） ----------
const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}

test('F1 走通性-幸福路径：一路成功（人工门禁挂起后通过）→ DONE，出场顺序正确', async () => {
  const { result, agentCalls } = await runEngine(mini, {
    dispatch: { complete: true },
    work: { status: 'completed' },
    gate: { verdict: 'ok' },
  })
  assert.equal(result.status, 'AWAITING_HUMAN_gate') // 门禁节点按设计挂起
  assert.deepEqual(agentCalls.map((c) => c.label), ['dispatch', 'work', 'gate'])
  const r2 = await runEngine(mini, { finish: { done: true } }, {
    entry: 'gate', approved: true, startRound: 0, history: [], feedback: '',
  })
  assert.equal(r2.result.status, 'DONE')
  assert.deepEqual(r2.agentCalls.map((c) => c.label), ['finish'])
})

test('F2 走通性-失败出口：判定失败 + failure 边指向终点 → FAILED_AT_节点', async () => {
  const { result } = await runEngine(mini, { dispatch: { complete: false } })
  assert.equal(result.status, 'FAILED_AT_dispatch')
  assert.equal(result.result.complete, false)
})

test('F3 走通性-打回循环：failure 边打回 + 轮次递增 + 反馈传递 + 历史记录', async () => {
  const { result, agentCalls } = await runEngine(mini, {
    '/^dispatch( R\\d+)?$/': { complete: true },
    '/^work( R\\d+)?$/': { status: 'blocked' },
  })
  assert.equal(result.status, 'FAILED_MAX_ROUNDS') // maxRounds=2，两轮后超限
  assert.equal(result.rounds, 2)
  assert.equal(result.history.length, 1) // 第 2 轮超限时不追加（先超限检查后记录）
  assert.equal(result.history[0].verdict, 'REJECTED')
  assert.equal(result.history[0].stage, 'work')
  assert.deepEqual(agentCalls.map((c) => c.label), ['dispatch', 'work', 'dispatch R1', 'work R1'])
  // 反馈语义：传给 failure 边指向的下一节点（此处为打回循环头 dispatch R1）
  assert.ok(agentCalls[2].prompt.includes('work未通过 · 第 1 轮'), '打回反馈应传递到 failure 边指向的下一节点')
})

test('F4 走通性-超限：上限来自图纸（2 轮），未配归因 → 归因演员不出场', async () => {
  const { result, agentCalls } = await runEngine(mini, {
    '/^dispatch( R\\d+)?$/': { complete: true },
    '/^work( R\\d+)?$/': { status: 'blocked' },
  })
  assert.equal(result.status, 'FAILED_MAX_ROUNDS')
  assert.equal(result.reschedule, undefined, 'onMaxRounds 缺省=return，无归因载荷')
  assert.ok(!agentCalls.some((c) => c.label === '超限归因'), '无 auto-reschedule 时归因演员不应出场')
})

test('F5 人工门禁通用语义：挂起 + 续跑载荷；通过 → 走成功边', async () => {
  const { result, agentCalls } = await runEngine(mini, {
    dispatch: { complete: true },
    work: { status: 'completed' },
    gate: { verdict: 'ok' },
  })
  assert.equal(result.status, 'AWAITING_HUMAN_gate')
  assert.deepEqual(result.resume, { entry: 'gate', approved: true, startRound: 0, history: [], feedback: '' })
  // 续跑：人工通过
  const r2 = await runEngine(mini, { finish: { done: true } }, {
    entry: 'gate', approved: true, startRound: result.resume.startRound, history: result.resume.history, feedback: '',
  })
  assert.equal(r2.result.status, 'DONE')
  assert.deepEqual(r2.agentCalls.map((c) => c.label), ['finish'])
})

test('F6 格式验收：作业不合格（违反 schema）→ 判失败 → 技术失败/打回路径', async () => {
  const { result, agentCalls } = await runEngine(mini, { dispatch: { foo: 1 } })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.equal(result.history[0].verdict, 'AGENT_FAILED')
  assert.equal(agentCalls[0].rejected, true, '演员交作业应被格式验收拒绝')
})

test('F7 入口与未知节点：args.entry 覆盖；未知入口 → ERROR', async () => {
  const a = await runEngine(mini, { finish: { done: true } }, { entry: 'finish' })
  assert.equal(a.result.status, 'DONE')
  assert.deepEqual(a.agentCalls.map((c) => c.label), ['finish'])
  const b = await runEngine(mini, {}, { entry: 'ghost' })
  assert.equal(b.result.status, 'ERROR')
})

test('F8 折叠通用语义：两路同路径条件分流节点零出场、按上游结果分流', async () => {
  const foldBp = {
    id: 'fold-test', displayName: '折叠测试', entry: 'start',
    nodes: [
      { id: 'start', profile: 'dispatcher', goal: 'x', output: { schema: { type: 'object', properties: { go: { type: 'boolean' } }, required: ['go'], additionalProperties: false }, successCondition: '$.go == true' } },
      { id: 'route', profile: 'dispatcher', goal: 'r' },
      { id: 'a', profile: 'dev', goal: 'a' },
      { id: 'b', profile: 'dev', goal: 'b' },
    ],
    edges: [
      { from: 'start', to: 'route', on: 'success' },
      { from: 'route', to: 'a', on: 'success', when: '$.go == true' },
      { from: 'route', to: 'b', on: 'success', when: '$.go == false' },
      { from: 'a', to: '$end', on: 'success' },
      { from: 'b', to: '$end', on: 'success' },
      { from: 'start', to: '$end', on: 'failure' },
    ],
  }
  const { script, folds } = compileBlueprint(foldBp)
  assert.deepEqual(Object.keys(folds), ['route'])
  const { result, agentCalls } = await runGeneratedScript(script, { agent: makeAgentScript({ start: { go: true }, a: {}, b: {} }) })
  assert.equal(result.status, 'DONE')
  assert.ok(!agentCalls.some((c) => c.label === 'route'), '折叠节点不应调用演员')
  assert.deepEqual(agentCalls.map((c) => c.label), ['start', 'a'], '按上游结果分流到 a（go=true）')
})

test('F9 走通性-死胡同兜底：判定失败且无 failure 边 → 明确终止不卡死', async () => {
  // 注意：此图纸违反走通性校验规则（有 successCondition 无 failure 边），
  // 专测运行时兜底——compileDsh 不做校验，直接编译执行
  const deadBp = {
    id: 'dead-test', displayName: '死胡同测试', entry: 's',
    nodes: [{ id: 's', profile: 'dispatcher', goal: 'x', output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, successCondition: '$.ok == true' } }],
    edges: [{ from: 's', to: '$end', on: 'success' }],
  }
  const { result } = await runEngine(deadBp, { s: { ok: false } })
  assert.equal(result.status, 'ENDED_NO_FAILURE_EDGE')
})

test('F10 机制可参数化：startRound/history/feedback 续跑参数生效', async () => {
  const { result, agentCalls } = await runEngine(mini, {
    '/^work( R\\d+)?$/': { status: 'completed' },
    '/^gate( R\\d+)?$/': { verdict: 'ok' },
  }, { entry: 'work', startRound: 1, history: [{ round: 1, stage: 'work', verdict: 'REJECTED', reason: 'x' }], feedback: '请重做' })
  assert.equal(result.status, 'AWAITING_HUMAN_gate')
  assert.equal(agentCalls[0].label, 'work R1', 'startRound=1 时轮次后缀生效')
  assert.ok(agentCalls[0].prompt.includes('请重做'), '反馈应注入下一轮台词')
})

// ---------- 第二层 · 模板级回归（内置蓝图 dev-workflow-2-0，非框架契约） ----------
const { files } = generateAll(tplDir)
const tplScript = files.get('dev-workflow-2-0/script.mjs')
const runTpl = (table, args = {}) => {
  const agent = makeAgentScript(table)
  return runGeneratedScript(tplScript, { args, agent })
}
const VERIFIED = { verified_branch: 'dev2/task', verified_head: 'abc123' }

test('T1 模板回归-幸福路径：门禁挂起后通过 → DONE；分流零出场（折叠）；文件契约与角色台词注入', async () => {
  const { result, agentCalls } = await runTpl({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    审核: { verdict: 'APPROVE', summary: 's', ...VERIFIED },
    人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
  })
  assert.equal(result.status, 'AWAITING_HUMAN_accept', '门禁节点按设计挂起')
  assert.deepEqual(agentCalls.map((c) => c.label), ['调度', '开发', '测试', '审核', '人工验收'], '分流节点应被折叠，零出场')
  const dispatchPrompt = agentCalls[0].prompt
  assert.ok(dispatchPrompt.includes('【本节点应产出文件】') && dispatchPrompt.includes('dispatch-result.json'), '文件契约注入')
  assert.ok(dispatchPrompt.includes('【角色定义】') && dispatchPrompt.includes('dsh/roles/dispatcher.md'), '角色台词注入')
  // 人工通过 → 收口 → DONE
  const r2 = await runTpl({ 收口: { status: 'done', summary: 's' } }, {
    entry: 'accept', approved: true, startRound: 0, history: result.history, feedback: '',
  })
  assert.equal(r2.result.status, 'DONE')
  assert.deepEqual(r2.agentCalls.map((c) => c.label), ['收口'])
})

test('T2 模板回归-三要素缺失：dispatch 判定失败 → FAILED_AT_dispatch', async () => {
  const { result } = await runTpl({ 调度: { complete: false, missing: ['objective'], need_integration_test: false, reason: '缺目标' } })
  assert.equal(result.status, 'FAILED_AT_dispatch')
  assert.equal(result.result.missing[0], 'objective')
})

test('T3 模板回归-分流免测：need_integration_test=false 直送审核（测试零出场）', async () => {
  const { result, agentCalls } = await runTpl({
    调度: { complete: true, missing: [], need_integration_test: false, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    审核: { verdict: 'APPROVE', summary: 's', ...VERIFIED },
    人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
  })
  assert.equal(result.status, 'AWAITING_HUMAN_accept')
  assert.ok(!agentCalls.some((c) => c.label.startsWith('测试')), '免测时测试演员零出场')
  assert.deepEqual(agentCalls.map((c) => c.label), ['调度', '开发', '审核', '人工验收'])
})

test('T4 模板回归-测试打回：FAILED → 打回开发（轮次+1、反馈、历史）→ 次轮通过', async () => {
  const { result, agentCalls } = await runTpl({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    '开发 R1': { status: 'completed', summary: 's2', self_verify: 'v' },
    测试: { result: 'FAILED', reason: '挂了', evidence: 'e', ...VERIFIED },
    '测试 R1': { result: 'PASSED', reason: '好了', evidence: 'e', ...VERIFIED },
    审核: { verdict: 'APPROVE', summary: 's', ...VERIFIED },
    '审核 R1': { verdict: 'APPROVE', summary: 's', ...VERIFIED },
    人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
    '人工验收 R1': { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
  })
  assert.equal(result.status, 'AWAITING_HUMAN_accept')
  const devR1 = agentCalls.find((c) => c.label === '开发 R1')
  assert.ok(devR1 && devR1.prompt.includes('测试未通过'), '打回反馈应传入打回目标（开发 R1）台词')
  assert.ok(result.history.some((h) => h.stage === 'test' && h.verdict === 'REJECTED'), '历史应记录测试打回')
  assert.equal(result.round, 1, '打回后轮次应为 1')
})

test('T5 模板回归-可信度闸门：验证节点交错分支 → 立即 TECHNICAL_FAILURE', async () => {
  const { result } = await runTpl({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: 'main', verified_head: '' },
  })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.ok(result.detail.includes('结论校验失败') && result.detail.includes('verified_branch'), '闸门失败原因应可读')
})

test('T6 模板回归-9 轮超限归因：FAILED_MAX_ROUNDS + 归因演员出场一次 + reschedule 载荷', async () => {
  const { result, agentCalls } = await runTpl({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    '/^开发( R\\d+)?$/': { status: 'completed', summary: 's', self_verify: 'v' },
    '/^测试( R\\d+)?$/': { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    '/^审核( R\\d+)?$/': { verdict: 'REQUEST_CHANGES', summary: '要改', ...VERIFIED },
    超限归因: { reason: '卡在审核', reschedule: { attribution: '审核过严', split: ['x'], human_action: '放宽' } },
  })
  assert.equal(result.status, 'FAILED_MAX_ROUNDS')
  assert.equal(result.rounds, 9)
  assert.equal(result.reschedule.attribution, '审核过严')
  const attribution = agentCalls.filter((c) => c.label === '超限归因')
  assert.equal(attribution.length, 1, '归因演员应恰好出场一次')
  assert.equal(result.history.length, 8, '第 9 轮打回后先超限检查、不追加历史（9 轮上限语义）')
})

test('T7 模板回归-受阻语义（Q12 修正后）：dev 交 blocked → FAILED_AT_dev（failure 边兜底）', async () => {
  const { result } = await runTpl({
    调度: { complete: true, missing: [], need_integration_test: false, reason: 'ok' },
    开发: { status: 'blocked', summary: '依赖缺失', self_verify: 'v' },
  })
  assert.equal(result.status, 'FAILED_AT_dev')
  assert.equal(result.result.status, 'blocked')
})

test('Q7 引擎侧：蓝图自定上限 5 → 编译产物 MAX_ROUNDS=5（业务规则可配置生效）', () => {
  const { script } = compileBlueprint({ ...mini, control: { maxRounds: 5 } })
  assert.ok(script.includes('const MAX_ROUNDS = 5'), '上限 5 编译进产物')
  const { script: s9 } = compileBlueprint({ ...mini, onMaxRounds: 'auto-reschedule' })
  assert.ok(s9.includes('超限归因'), 'onMaxRounds=auto-reschedule 注入归因')
})
