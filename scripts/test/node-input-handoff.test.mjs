// LOC-024 显式交接节点输入与返工反馈（WR-001）行为测试
// 覆盖：节点 inputs 声明 → resolveInputs → resolved_inputs 清单（binding/producer/version_ref/value/artifact_ref）；
// AC-01 优化返工第二次执行收到唯一标记、评价契约引用与当前成果引用；
// AC-02 诊断修复收到对应 diagnosis 根因与证据；建设返工收到触发本次返工的 review/test 反馈；
// AC-03 缺必需引用时消费节点调用数为 0、错误含 node/binding/reason；可选输入未产生按声明处理；
// AC-04 两轮反馈只取本次流转版本；蓝图编辑（投影往返）与生成脚本均保留输入声明；legacy 输入模式显式标注。
//
// 跨任务夹具对齐（LOC-030）：诊断模板 `closeout` 节点按 blocked-lifecycle 规格 §接口与数据约定
// 「诊断正常回归 PASS 后 DELIVERED 必须有完成映射」新增必填 `completion_type`（const=DELIVERED）
// 与 completionPath。本套件的诊断夹具模拟该节点输出，必须显式给出该字段，否则 schema 校验失败
// 触发重试直至额度耗尽（旧表现 FAILED_AGENT_CAP，LOC-031 技术预算生效后为 WAITING_HUMAN）。
// 优化模板夹具的 completion_type=EVALUATION_PASSED 不受影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint, generateAll, projectToVwf } from '../generate.mjs'
import validatorCore from '../validate-core.cjs'
import { projectToBlueprint } from '../projection-core.cjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const tplDir = path.join(here, '../../templates')
const load = (id) => JSON.parse(readFileSync(path.join(tplDir, id + '.json'), 'utf8'))
const optimizeBp = load('wf-optimize')
const diagnoseBp = load('wf-diagnose')
const constructionBp = load('wf-construction-full-feature')

const runEngine = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}
const callsOf = (run, label) => run.agentCalls.filter((c) => c.label === label)

// LOC-026 起，verifyBranch 节点（建设 review/test、诊断 review/regression）的 output.schema.required
// 含 verified_branch / verified_head / candidate_sha256，运行时按 expectedBranch = A.work_branch ||
// ('dev2/' + (A.taskId || 'task')) 校验。以下夹具均是无 workspace 的旧形态：candOk 闸门不生效，
// 但 schema 必填仍要求显式给出，故统一按默认分支 dev2/task 补齐。
const DEV_BRANCH = 'dev2/task'
const CAND = 'handoff-candidate'

// ---------- 声明校验（编译期门） ----------

test('LOC-024 三个模板 inputs 声明通过校验，wf-explore 维持旧输入模式', () => {
  for (const bp of [optimizeBp, diagnoseBp, constructionBp]) {
    const v = validateBlueprint(bp)
    assert.equal(v.ok, true, bp.id + ': ' + JSON.stringify(v.errors))
  }
  const declaredIds = (bp) => bp.nodes.filter((n) => Array.isArray(n.inputs) && n.inputs.length).map((n) => n.id)
  assert.deepEqual(declaredIds(optimizeBp).sort(), ['closeout', 'execute'])
  assert.deepEqual(declaredIds(diagnoseBp).sort(), ['diagnose', 'fix'])
  assert.deepEqual(declaredIds(constructionBp).sort(), ['closeout', 'dev', 'review', 'test', 'uat'])
  const explore = load('wf-explore')
  assert.ok(explore.nodes.every((n) => n.inputs === undefined), 'wf-explore 未声明输入 = 旧输入模式')
  for (const bp of [optimizeBp, diagnoseBp, constructionBp]) {
    for (const n of bp.nodes) {
      if (!Array.isArray(n.inputs)) continue
      for (const b of n.inputs) {
        assert.equal(typeof b.required, 'boolean', n.id + '.' + b.name + ' required 须显式声明')
      }
    }
  }
})

// 静态反例母图：src →(FAST) consumer / src →(VIA) p1 →(DONE) consumer；
// consumer →(HANDOFF) late 在 consumer 之后（用于「生产节点后置」反例）。
const staticBase = {
  id: 'input-mini', displayName: '输入迷你图', entry: 'src',
  nodes: [
    { id: 'src', profile: 'dev', label: '来源', goal: 'g', output: { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['FAST', 'VIA'] } }, required: ['route'], additionalProperties: false } } },
    { id: 'p1', profile: 'dev', label: '生产', goal: 'g', output: { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['DONE', 'BLOCKED'] }, value: { type: 'string' } }, required: ['route', 'value'], additionalProperties: false }, files: { 'p1-report.md': 'markdown' } } },
    { id: 'consumer', profile: 'dev', label: '消费', goal: 'g', inputs: [], output: { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['DONE', 'HANDOFF'] } }, required: ['route'], additionalProperties: false } } },
    { id: 'late', profile: 'dev', label: '后置', goal: 'g', output: { outcomePath: '$.status', schema: { type: 'object', properties: { status: { type: 'string', enum: ['OK'] } }, required: ['status'], additionalProperties: false } } },
  ],
  edges: [
    { from: 'src', to: 'consumer', outcome: 'FAST' },
    { from: 'src', to: 'p1', outcome: 'VIA' },
    { from: 'p1', to: 'consumer', outcome: 'DONE' },
    { from: 'p1', to: '$end', outcome: 'BLOCKED' },
    { from: 'p1', to: 'p1', on: 'technical' },
    { from: 'consumer', to: '$end', outcome: 'DONE' },
    { from: 'consumer', to: 'late', outcome: 'HANDOFF' },
    { from: 'consumer', to: 'consumer', on: 'technical' },
    { from: 'late', to: '$end', outcome: 'OK' },
  ],
}

test('LOC-024 inputs 声明校验反例：非法选择器 / 缺 required / artifact 未声明或穿越 / 生产节点缺失或后置 / 绑定名重复 / fanout 禁止', () => {
  const mk = (inputs) => {
    const bp = JSON.parse(JSON.stringify(staticBase))
    bp.nodes[2].inputs = inputs
    return bp
  }
  const one = (bp, re) => {
    const v = validateBlueprint(bp)
    assert.equal(v.ok, false, '应拒绝：' + JSON.stringify(v.errors))
    const hit = v.errors.find((e) => re.test(e.message))
    assert.ok(hit, '应报错匹配 ' + re + '：' + JSON.stringify(v.errors))
  }

  one(mk([{ name: 'x', from: '$.eval(src)', required: true }]), /仅支持/)
  one(mk([{ name: 'x', from: '../../src/value', required: true }]), /仅支持/)
  one(mk([{ name: 'x', from: '$.results.p1.value' }]), /required 必须显式声明/)
  one(mk([{ name: 'x', from: '$.results.p1.value', required: true, artifact: 'ghost.md' }]), /artifact ghost\.md 未在生产节点 p1/)
  one(mk([{ name: 'x', from: '$.results.p1.value', required: true, artifact: '../escape.md' }]), /artifact 必须是|禁止绝对路径/)
  one(mk([{ name: 'x', from: '$.results.ghost.value', required: true }]), /生产节点 ghost 不存在/)
  one(mk([{ name: 'x', from: '$.results.late.value', required: true }]), /先于消费节点 consumer|先于消费节点/)
  one(mk([{ name: 'x', from: '$.results.p1.value', required: true }, { name: 'x', from: '$.results.p1.route', required: true }]), /绑定名重复/)
  one(mk([{ name: 'X', from: '$.results.p1.value', required: true }]), /snake_case/)
  // 合法引用：生产节点存在且沿结构边先于消费节点 + artifact 已在其 output.files 声明
  assert.equal(validateBlueprint(mk([{ name: 'x', from: '$.results.p1.value', required: true, artifact: 'p1-report.md' }])).ok, true)

  // fanout 节点禁止 inputs
  const fanBp = JSON.parse(readFileSync(path.join(here, 'fixtures/fanout-blueprint.json'), 'utf8'))
  const fan = fanBp.nodes.find((n) => n.kind === 'fanout')
  fan.inputs = [{ name: 'x', from: '$.task.taskId', required: true }]
  assert.ok(validateBlueprint(fanBp).errors.some((e) => /fanout 节点禁止 inputs/.test(e.message)))
})

// ---------- 输入解析运行时（mini 图） ----------

const miniBp = (inputs) => ({
  id: 'input-mini', displayName: '输入迷你图', entry: 'src',
  nodes: [
    { id: 'src', profile: 'dev', label: '来源', goal: 'g', output: { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['FAST', 'VIA'] } }, required: ['route'], additionalProperties: false } } },
    { id: 'p1', profile: 'dev', label: '生产', goal: 'g', output: { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['DONE', 'BLOCKED'] }, value: { type: 'string' } }, required: ['route', 'value'], additionalProperties: false } } },
    { id: 'consumer', profile: 'dev', label: '消费', goal: 'g', inputs, output: { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['DONE'] } }, required: ['route'], additionalProperties: false } } },
  ],
  edges: [
    { from: 'src', to: 'consumer', outcome: 'FAST' },
    { from: 'src', to: 'p1', outcome: 'VIA' },
    { from: 'p1', to: 'consumer', outcome: 'DONE' },
    { from: 'p1', to: '$end', outcome: 'BLOCKED' },
    { from: 'p1', to: 'p1', on: 'technical' },
    { from: 'consumer', to: '$end', outcome: 'DONE' },
    { from: 'consumer', to: 'consumer', on: 'technical' },
  ],
})

test('AC-03 缺必需引用：消费节点调用数为 0，错误含 node/binding/reason', async () => {
  const bp = miniBp([{ name: 'must', from: '$.results.p1.value', required: true }])
  assert.equal(validateBlueprint(bp).ok, true)
  // FAST 路径：p1 从未产出 → 必需引用缺失
  const fast = await runEngine(bp, { 来源: { route: 'FAST' } })
  assert.equal(fast.result.status, 'ERROR')
  assert.equal(fast.result.reason, 'INPUT_RESOLUTION_FAILED')
  assert.equal(fast.result.node, 'consumer')
  assert.equal(fast.result.errors.length, 1)
  assert.equal(fast.result.errors[0].node, 'consumer')
  assert.equal(fast.result.errors[0].binding, 'must')
  assert.ok(/生产节点 p1 尚无/.test(fast.result.errors[0].reason), JSON.stringify(fast.result.errors))
  assert.equal(callsOf(fast, '消费').length, 0, '缺必需引用时消费节点调用数必须为 0')
  // 生产者已运行但字段缺失 → 同样拦截，不静默退默认值或旧轮结果
  const missingField = miniBp([{ name: 'must', from: '$.results.p1.missing', required: true }])
  const r2 = await runEngine(missingField, { 来源: { route: 'VIA' }, 生产: { route: 'DONE', value: 'V' } })
  assert.equal(r2.result.status, 'ERROR')
  assert.ok(/缺少字段 missing/.test(r2.result.errors[0].reason), JSON.stringify(r2.result.errors))
  assert.equal(callsOf(r2, '消费').length, 0)
})

test('AC-03 可选输入未产生按声明处理：无 default 不注入、有 default 注入并标注首次运行默认值', async () => {
  const bp = miniBp([
    { name: 'opt_absent', from: '$.results.p1.value', required: false },
    { name: 'opt_default', from: '$.results.p1.value', required: false, default: 'DECL-DEFAULT' },
    { name: 'task_default', from: '$.task.note', required: false, default: 'TASK-DEFAULT' },
  ])
  assert.equal(validateBlueprint(bp).ok, true)
  const r = await runEngine(bp, { 来源: { route: 'FAST' }, 消费: { route: 'DONE' } })
  assert.equal(r.result.status, 'DONE', JSON.stringify(r.result))
  const prompt = callsOf(r, '消费')[0].prompt
  assert.ok(!prompt.includes('opt_absent'), '可选且无 default 未产生时不得注入')
  assert.ok(prompt.includes('opt_default') && prompt.includes('DECL-DEFAULT'))
  assert.ok(prompt.includes('首次运行默认值'), '默认值注入须显式标注')
  assert.ok(prompt.includes('task_default') && prompt.includes('TASK-DEFAULT'))
  const res = r.result.resolved_inputs.consumer
  assert.equal(res.mode, 'declared')
  assert.ok(res.items.every((it) => it.source === 'first_run_default'))
})

test('LOC-024 解析清单：binding/producer/version_ref/value 齐全且不可变；input_mode 三态显式标注', async () => {
  const bp = miniBp([{ name: 'must', from: '$.results.p1.value', required: true }])
  const r = await runEngine(bp, { 来源: { route: 'VIA' }, 生产: { route: 'DONE', value: 'P1-VALUE' }, 消费: { route: 'DONE' } })
  assert.equal(r.result.status, 'DONE')
  assert.equal(r.result.input_mode, 'mixed', '部分节点声明 → mixed')
  const res = r.result.resolved_inputs.consumer
  assert.equal(res.mode, 'declared')
  assert.equal(res.items.length, 1)
  const it = res.items[0]
  assert.equal(it.binding, 'must')
  assert.equal(it.producer, 'p1')
  assert.equal(it.source, 'producer_result')
  assert.equal(it.value, 'P1-VALUE')
  assert.match(it.version_ref, /^tmp-exec:\d+:[0-9a-f]{8}$/)
  assert.ok(Object.isFrozen(it) && Object.isFrozen(res.items), 'resolved_inputs 条目须不可变')
  assert.equal(r.result.resolved_inputs.src.mode, 'legacy', '未声明节点显式标注旧输入模式')
  // 纯 legacy 图（整体未声明 inputs）
  const legacyBp = { id: 'legacy-mini', displayName: 'L', entry: 'n1', nodes: [{ id: 'n1', profile: 'dev', label: 'N', goal: 'g' }], edges: [{ from: 'n1', to: '$end', on: 'success' }] }
  const legacy = await runEngine(legacyBp, { N: { done: true } })
  assert.equal(legacy.result.status, 'DONE')
  assert.equal(legacy.result.input_mode, 'legacy')
  assert.equal(legacy.result.resolved_inputs.n1.mode, 'legacy')
})

test('LOC-024 任务输入选择器 $.task：required 缺失拦截、命中注入 value 与来源标注', async () => {
  const bp = miniBp([{ name: 'note', from: '$.task.note', required: true }])
  assert.equal(validateBlueprint(bp).ok, true)
  const miss = await runEngine(bp, { 来源: { route: 'FAST' } })
  assert.equal(miss.result.status, 'ERROR')
  assert.equal(miss.result.errors[0].binding, 'note')
  assert.ok(/任务输入缺少 note/.test(miss.result.errors[0].reason))
  assert.equal(callsOf(miss, '消费').length, 0)
  const hit = await runEngine(bp, { 来源: { route: 'FAST' }, 消费: { route: 'DONE' } }, { note: 'REQ-42' })
  const it = hit.result.resolved_inputs.consumer.items[0]
  assert.equal(it.value, 'REQ-42')
  assert.equal(it.producer, null)
  assert.equal(it.source, 'task_input')
  assert.ok(hit.agentCalls.find((c) => c.label === '消费').prompt.includes('REQ-42'))
})

// ---------- AC-01：优化模板返工交接 ----------

test('AC-01 优化首轮正常；OPTIMIZE 唯一标记/契约引用/当前成果引用按本次流转注入第二次执行', async () => {
  let execs = 0
  let evals = 0
  const run = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'CONTRACT-C1' },
    执行: () => { execs += 1; return { route: 'READY', summary: '改动V' + execs, changed: 'a.md' } },
    评估: () => {
      evals += 1
      if (evals === 1) return { route: 'OPTIMIZE', summary: 'EVAL-S-ROUND1', contract_digest: 'CONTRACT-C1', gaps: 'GAP-AAA' }
      if (evals === 2) return { route: 'OPTIMIZE', summary: 'EVAL-S-ROUND2', contract_digest: 'CONTRACT-C1', gaps: 'GAP-BBB' }
      return { route: 'PASS', summary: '满足判据', contract_digest: 'CONTRACT-C1', gaps: '' }
    },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  })
  assert.equal(run.result.status, 'DONE', JSON.stringify(run.result))
  assert.equal(run.result.budgetUsed, 2)
  const execCalls = callsOf(run, '执行')
  assert.equal(execCalls.length, 3)
  // 首轮：评价反馈尚未产生 → 按声明走首次运行默认值，不得出现任何评估轮内容
  assert.ok(execCalls[0].prompt.includes('首次运行默认值'))
  assert.ok(execCalls[0].prompt.includes('evaluation_gaps'))
  assert.ok(!execCalls[0].prompt.includes('GAP-AAA') && !execCalls[0].prompt.includes('OPTIMIZE'))
  // 第一次返工：收到该轮唯一标记 + 评价契约引用 + 当前成果引用
  assert.ok(execCalls[1].prompt.includes('GAP-AAA') && execCalls[1].prompt.includes('EVAL-S-ROUND1'))
  assert.ok(execCalls[1].prompt.includes('evaluation-contract.md'), '评价契约以文件引用交付')
  assert.ok(execCalls[1].prompt.includes('execute-report.md'), '当前成果以文件引用交付')
  assert.ok(execCalls[1].prompt.includes('生产节点 evaluate') && execCalls[1].prompt.includes('tmp-exec:'))
  assert.ok(!execCalls[1].prompt.includes('首次运行默认值'), '真实输入已产生时不得再走默认值')
  assert.ok(!execCalls[1].prompt.includes('GAP-BBB'))
  // 第二次返工：只收第二轮，不得回退第一轮旧结果
  assert.ok(execCalls[2].prompt.includes('GAP-BBB') && execCalls[2].prompt.includes('EVAL-S-ROUND2'))
  assert.ok(!execCalls[2].prompt.includes('GAP-AAA') && !execCalls[2].prompt.includes('EVAL-S-ROUND1'))
  // resolved_inputs 清单（最新一次执行视角）
  const items = run.result.resolved_inputs.execute.items
  const gaps = items.find((i) => i.binding === 'evaluation_gaps')
  assert.equal(gaps.producer, 'evaluate')
  assert.equal(gaps.source, 'producer_result')
  assert.equal(gaps.value, 'GAP-BBB')
  assert.match(gaps.version_ref, /^tmp-exec:\d+:[0-9a-f]{8}$/)
  const deliverable = items.find((i) => i.binding === 'current_deliverable')
  assert.equal(deliverable.producer, 'execute')
  assert.equal(deliverable.value, 'a.md', '当前成果引用绑定的是上一轮执行的 changed 字段')
  assert.ok(deliverable.artifact_ref.endsWith('/execute-report.md'))
  const contract = items.find((i) => i.binding === 'evaluation_contract')
  assert.equal(contract.producer, 'confirm')
  assert.ok(contract.artifact_ref.endsWith('/evaluation-contract.md'))
  // 收口收到评估裁决与两份报告引用
  const closePrompt = callsOf(run, '收口')[0].prompt
  assert.ok(closePrompt.includes('evaluation-report.md') && closePrompt.includes('execute-report.md'))
  assert.ok(closePrompt.includes('PASS'))
})

// ---------- AC-02：诊断与建设返工交接 ----------

test('AC-02 诊断修复收到对应 diagnosis 的根因与证据；FIX_ISSUES 返工收到触发该轮的审核反馈', async () => {
  let fixes = 0
  let reviews = 0
  const run = await runEngine(diagnoseBp, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: 'ROOT-CAUSE-1', evidence: 'EVID-1', verified_head: 'h1' },
    修复: () => { fixes += 1; return { route: 'FIXED', summary: '第' + fixes + '次修复', changed: 'a.js' } },
    审核: () => {
      reviews += 1
      if (reviews === 1) return { route: 'FIX_ISSUES', verdict_reason: 'REVIEW-FIX-R1', verified_branch: DEV_BRANCH, verified_head: 'review-h1', candidate_sha256: CAND }
      return { route: 'APPROVE', verdict_reason: '通过', verified_branch: DEV_BRANCH, verified_head: 'review-h2', candidate_sha256: CAND }
    },
    回归验证: { route: 'PASS', verdict_reason: '缺陷不复现', regression_evidence: '测试绿', verified_branch: DEV_BRANCH, verified_head: 'regression-h1', candidate_sha256: CAND },
    收口: { status: 'DELIVERED', completion_type: 'DELIVERED', summary: 'done', followups: '' },
  })
  assert.equal(run.result.status, 'DONE')
  const fixCalls = callsOf(run, '修复')
  assert.equal(fixCalls.length, 2)
  assert.ok(fixCalls[0].prompt.includes('ROOT-CAUSE-1') && fixCalls[0].prompt.includes('EVID-1'))
  assert.ok(fixCalls[0].prompt.includes('diagnosis-report.md'))
  assert.ok(fixCalls[0].prompt.includes('首次运行默认值'), '首轮修复的 review/regression 反馈按声明走默认值')
  assert.ok(fixCalls[1].prompt.includes('REVIEW-FIX-R1'), '返工修复必须收到触发本轮的审核反馈')
  assert.ok(!fixCalls[1].prompt.includes('尚无审核反馈'))
})

test('AC-02 证据推翻根因回诊断：重诊收到触发返工的反证；未产生的反证维度按声明走默认值', async () => {
  let reviews = 0
  let diagnoses = 0
  const run = await runEngine(diagnoseBp, {
    缺陷诊断: () => {
      diagnoses += 1
      return { route: 'DIAGNOSED', root_cause: 'ROOT-' + diagnoses, evidence: 'E-' + diagnoses, verified_head: 'h' + diagnoses }
    },
    审核: () => {
      reviews += 1
      if (reviews === 1) return { route: 'ROOT_CAUSE_REFUTED', verdict_reason: 'REFUTE-R1', verified_branch: DEV_BRANCH, verified_head: 'review-h1', candidate_sha256: CAND }
      return { route: 'APPROVE', verdict_reason: '通过', verified_branch: DEV_BRANCH, verified_head: 'review-h2', candidate_sha256: CAND }
    },
    修复: { route: 'FIXED', summary: '按新根因修复', changed: 'b.js' },
    回归验证: { route: 'PASS', verdict_reason: '缺陷不复现', regression_evidence: '测试绿', verified_branch: DEV_BRANCH, verified_head: 'regression-h1', candidate_sha256: CAND },
    收口: { status: 'DELIVERED', completion_type: 'DELIVERED', summary: 'done', followups: '' },
  })
  assert.equal(run.result.status, 'DONE')
  const diagCalls = callsOf(run, '缺陷诊断')
  assert.equal(diagCalls.length, 2)
  assert.ok(diagCalls[0].prompt.includes('首次运行默认值'))
  assert.ok(diagCalls[1].prompt.includes('REFUTE-R1'), '重诊必须收到审核反证')
  assert.ok(diagCalls[1].prompt.includes('（首次诊断：尚无回归反证）'))
})

test('AC-02/AC-04 建设返工：dev 收到触发本轮的 review/test 反馈；两轮审查并存时只取本次流转版本', async () => {
  let devs = 0
  let reviews = 0
  let tests = 0
  const run = await runEngine(constructionBp, {
    实施前检查: { route: 'PASS', summary: '基线就绪', blockers: '', baseline_version: 'V1' },
    开发: () => { devs += 1; return { route: 'READY', summary: '实现S' + devs, self_check: '自检' + devs } },
    收敛审查: () => {
      reviews += 1
      if (reviews === 1) return { route: 'RETURN_DEV', verdict: 'REQUEST_CHANGES', summary: '审查S1', blockers: 'REVIEW-R1-BLOCKERS', verified_branch: 'wb', verified_head: 'hh1', candidate_sha256: CAND }
      return { route: 'APPROVE', verdict: 'APPROVE', summary: '审查S2-APPROVE', blockers: '无', verified_branch: 'wb', verified_head: 'hh2', candidate_sha256: CAND }
    },
    测试: () => {
      tests += 1
      if (tests === 1) return { route: 'RETURN_DEV', result: 'FAILED', reason: 'TEST-R1-REASON', evidence: 'TEST-R1-EVID', verified_branch: 'wb', verified_head: 'hh3', candidate_sha256: CAND }
      return { route: 'PASS', result: 'PASSED', reason: '通过', evidence: 'TEST-R2-EVID', verified_branch: 'wb', verified_head: 'hh4', candidate_sha256: CAND }
    },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 'S4H', why: 'W', current_state: 'C', details: 'D' },
  }, { work_branch: 'wb' })
  assert.equal(run.result.status, 'WAITING_HUMAN', JSON.stringify(run.result))
  const devCalls = callsOf(run, '开发')
  assert.equal(devCalls.length, 3)
  // 首轮：preflight 真实基线 + review/test 首次默认值
  assert.ok(devCalls[0].prompt.includes('V1') && devCalls[0].prompt.includes('preflight-report.md'))
  assert.ok(devCalls[0].prompt.includes('首次运行默认值'))
  // 第一轮返工（review RETURN_DEV 触发）：收到该轮 review 反馈，test 仍默认
  assert.ok(devCalls[1].prompt.includes('REVIEW-R1-BLOCKERS'))
  assert.ok(devCalls[1].prompt.includes('（首轮开发：尚无测试反馈）'))
  // 第二轮返工（test RETURN_DEV 触发）：收到该轮 test 反馈；两轮 review 并存时只取本次流转对应的最新轮
  assert.ok(devCalls[2].prompt.includes('TEST-R1-REASON') && devCalls[2].prompt.includes('TEST-R1-EVID'))
  assert.ok(devCalls[2].prompt.includes('test-report.md'))
  assert.ok(!devCalls[2].prompt.includes('REVIEW-R1-BLOCKERS'), '上一轮已被替换的审查反馈不得回流')
  assert.ok(devCalls[2].prompt.includes('审查S2-APPROVE'))
  // review / test / uat 消费上游声明
  const reviewCalls = callsOf(run, '收敛审查')
  assert.ok(reviewCalls[0].prompt.includes('实现S1') && reviewCalls[0].prompt.includes('dev-report.md'))
  const testCalls = callsOf(run, '测试')
  assert.ok(testCalls[0].prompt.includes('审查S2-APPROVE') && testCalls[0].prompt.includes('review-report.md'))
  const uatPrompt = callsOf(run, 'UAT 准备')[0].prompt
  assert.ok(uatPrompt.includes('TEST-R2-EVID') && uatPrompt.includes('test-report.md'))
})

// ---------- AC-04：版本选择 + 编辑/投影/生成保留 ----------

test('AC-04 投影往返与生成脚本保留 inputs 声明（蓝图编辑不丢字段）', () => {
  for (const bp of [optimizeBp, diagnoseBp, constructionBp]) {
    const dsl = projectToVwf(bp)
    const back = projectToBlueprint(dsl)
    for (const n of bp.nodes) {
      const backNode = back.nodes.find((x) => x.id === n.id)
      const dslNode = dsl.nodes.find((x) => x.id === n.id)
      if (!Array.isArray(n.inputs)) {
        assert.equal(backNode.inputs, undefined, bp.id + ':' + n.id + ' 未声明不得伪造')
        continue
      }
      assert.deepEqual(dslNode.inputs, n.inputs, bp.id + ':' + n.id + ' DSL 投影须携带 inputs')
      assert.deepEqual(backNode.inputs, n.inputs, bp.id + ':' + n.id + ' 往返须保留 inputs')
      const { script } = compileBlueprint(bp)
      assert.ok(script.includes(JSON.stringify(n.inputs)), bp.id + ':' + n.id + ' 声明须进编译产物')
    }
  }
  // generateAll 产物（vwf-dsl.json）同样保留
  const { files } = generateAll(tplDir)
  const dsl = JSON.parse(files.get('wf-optimize/vwf-dsl.json'))
  assert.deepEqual(dsl.nodes.find((n) => n.id === 'execute').inputs, optimizeBp.nodes.find((n) => n.id === 'execute').inputs)
})

test('AC-04 全 declared 图 input_mode=declared；version_ref 携带执行序号与内容摘要', async () => {
  const bp = miniBp([
    { name: 'from_p1', from: '$.results.p1.value', required: true },
    { name: 'from_src', from: '$.results.src.route', required: true },
  ])
  bp.nodes[0].inputs = [{ name: 'self_route', from: '$.task.route', required: false, default: 'BOOT' }]
  bp.nodes[1].inputs = [{ name: 'from_src', from: '$.results.src.route', required: true }]
  assert.equal(validateBlueprint(bp).ok, true, JSON.stringify(validateBlueprint(bp).errors))
  const r = await runEngine(bp, { 来源: { route: 'VIA' }, 生产: { route: 'DONE', value: 'V1' }, 消费: { route: 'DONE' } })
  assert.equal(r.result.status, 'DONE')
  assert.equal(r.result.input_mode, 'declared', '全部 worker 节点声明 → declared')
  const items = r.result.resolved_inputs.consumer.items
  assert.equal(items.find((i) => i.binding === 'from_src').value, 'VIA')
  const ref = items.find((i) => i.binding === 'from_p1').version_ref
  assert.match(ref, /^tmp-exec:\d+:[0-9a-f]{8}$/)
  // 相同内容 → 相同摘要；不同内容 → 不同摘要（版本引用可区分两轮成果）
  const digestOf = (refStr) => refStr.split(':')[2]
  const r2 = await runEngine(bp, { 来源: { route: 'VIA' }, 生产: { route: 'DONE', value: 'V2' }, 消费: { route: 'DONE' } })
  const ref2 = r2.result.resolved_inputs.consumer.items.find((i) => i.binding === 'from_p1').version_ref
  assert.equal(digestOf(ref).length, 8)
  assert.notEqual(digestOf(ref), digestOf(ref2), '不同内容须产生不同内容摘要')
})
