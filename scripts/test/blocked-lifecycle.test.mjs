// LOC-030 统一受阻、恢复与完成的生命周期语义（WR-009 V1）编译/模板层测试
// M2 额度耗尽 → BLOCKED(AUTO_REWORK_EXHAUSTED) / NEED_REDEFINE 不可原样恢复描述 /
// REJECT 重置额度 / 四模板终止表与生成 Skill 恢复入口说明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint, skillWrap } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))

// M2 形态微型蓝图：开发 → 审查，RETURN_DEV 计返工额度，耗尽即受阻（M2）
const m2bp = {
  id: 'm2-blocked-spec', displayName: 'M2 受阻规格', description: '', entry: 'dev',
  control: { maxRounds: 2, maxRoundsExhausted: 'BLOCKED' },
  heteroCheck: 'off',
  bindings: { models: { dev: { provider: 'p', model: 'm' }, review: { provider: 'p', model: 'm' } } },
  nodes: [
    { id: 'dev', profile: 'dev', label: '开发', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY', 'NEED_REDEFINE'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
    { id: 'review', profile: 'review', label: '审查', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['APPROVE', 'RETURN_DEV'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
  ],
  edges: [
    { from: 'dev', to: 'review', outcome: 'READY' },
    { from: 'dev', to: '$end', outcome: 'NEED_REDEFINE' },
    { from: 'review', to: '$end', outcome: 'APPROVE' },
    { from: 'review', to: 'dev', outcome: 'RETURN_DEV', countRound: true },
  ],
}

const runBp = (bp, table, args = {}) => {
  const { script } = compileBlueprint(bp)
  return runGeneratedScript(script, { args, agent: makeAgentScript(table) })
}

test('LOC-030 蓝图校验：M2 受阻规格通过校验（control.maxRoundsExhausted 合法）', () => {
  const v = validateBlueprint(m2bp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})

test('AC-02：M2 自动返工额度耗尽 → BLOCKED/AUTO_REWORK_EXHAUSTED（非终态，可从 dev 恢复）', async () => {
  let reviews = 0
  const { result } = await runBp(m2bp, {
    开发: { route: 'READY' },
    审查: () => {
      reviews += 1
      return { route: 'RETURN_DEV' }
    },
  })
  assert.equal(result.status, 'BLOCKED', '额度耗尽以 BLOCKED 收束，不冒充成功也不挂人工决策')
  assert.equal(reviews, 3, '第 2 轮耗尽后第 3 次仍失败 → 受阻（maxRounds=2）')
  assert.equal(result.termination.lifecycle, 'BLOCKED')
  assert.equal(result.termination.reason_code, 'AUTO_REWORK_EXHAUSTED')
  assert.equal(result.termination.resumable, true)
  assert.equal(result.termination.resume_node, 'dev', '恢复入口 = 返工目标节点')
  assert.equal(result.blocked.reason_code, 'AUTO_REWORK_EXHAUSTED')
  assert.equal(result.blocked.rounds_used, 2, '已返工轮次入档')
  assert.equal(result.blocked.max_rounds, 2)
  assert.equal(result.blocked.failed_node, 'review', '失败节点入档')
  assert.equal(result.blocked.last_outcome.route, 'RETURN_DEV', '未解决问题（审查原结果）原样保留')
})

test('AC-02：人工 REJECT 后新一轮交付重置自动返工额度', async () => {
  // 走 $human-decision REJECT 出边：额度用满被打回后，人工退回重置 budgetUsed
  const bp = {
    id: 'reject-reset-spec', displayName: 'REJECT 重置规格', description: '', entry: 'plan',
    control: { maxRounds: 2, maxRoundsExhausted: 'BLOCKED' },
    heteroCheck: 'off',
    bindings: { models: { plan: { provider: 'p', model: 'm' }, dev: { provider: 'p', model: 'm' }, review: { provider: 'p', model: 'm' } } },
    nodes: [
      { id: 'plan', profile: 'requirements', label: '计划', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
      { id: 'dev', profile: 'dev', label: '开发', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
      { id: 'review', profile: 'review', label: '审查', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['APPROVE', 'RETURN_DEV', 'ESCALATE'] } }, required: ['route'], additionalProperties: false }, outcomePath: '$.route' } },
    ],
    edges: [
      { from: 'plan', to: 'dev', outcome: 'READY' },
      { from: 'dev', to: 'review', outcome: 'READY' },
      { from: 'review', to: '$end', outcome: 'APPROVE' },
      { from: 'review', to: 'dev', outcome: 'RETURN_DEV', countRound: true },
      { from: 'review', to: '$human-decision', outcome: 'ESCALATE' },
      { from: '$human-decision', to: 'dev', outcome: 'REJECT' },
    ],
  }
  assert.equal(validateBlueprint(bp).ok, true, JSON.stringify(validateBlueprint(bp).errors))
  const first = await runBp(bp, {
    计划: { route: 'READY' },
    开发: { route: 'READY' },
    审查: { route: 'ESCALATE' },
  })
  assert.equal(first.result.status, 'WAITING_HUMAN')
  assert.ok(first.result.decision_id)
  // 人工退回：budgetUsed 由 args 续传 2（耗尽态），REJECT 后必须重置为 0
  const resumed = await runBp(bp, {
    开发: { route: 'READY' },
    审查: { route: 'APPROVE' },
  }, {
    decision_id: first.result.decision_id,
    user_choice: 'REJECT',
    results: first.result.results,
    budgetUsed: 2,
    history: first.result.history,
  })
  assert.equal(resumed.result.status, 'DONE')
  assert.equal(resumed.result.budgetUsed, 0, 'REJECT 后额度已重置（新一轮交付）')
  assert.ok(resumed.result.history.some((h) => h.outcome === 'APPROVE' && !h.halted), '退回后审查通过正常收束')
})

test('NEED_REDEFINE：终止描述标记不可原样恢复（resumable=false，保留旧 Run）', async () => {
  const { result } = await runBp(m2bp, {
    开发: { route: 'NEED_REDEFINE' },
  })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.termination, {
    business_outcome: 'NEED_REDEFINE', lifecycle: 'BLOCKED', reason_code: 'NEEDS_REDEFINE',
    resumable: false, resume_node: 'dev',
  })
})

test('四模板终止表：每个 outcome→$end 都有终止描述；M2 开关仅建设模板', async () => {
  for (const id of ['wf-construction-full-feature', 'wf-diagnose', 'wf-explore', 'wf-optimize']) {
    const bp = JSON.parse(readFileSync(path.join(here, '../../templates/' + id + '.json'), 'utf8'))
    const { script } = compileBlueprint(bp)
    const line = script.split('\n').find((l) => l.startsWith('const TERMINATIONS = '))
    const terminations = JSON.parse(line.slice('const TERMINATIONS = '.length))
    const ends = bp.edges.filter((e) => e.to === '$end' && e.outcome !== undefined && e.outcome !== null && e.outcome !== '')
    assert.ok(ends.length, id + ' 应有 outcome → $end 边')
    for (const e of ends) {
      assert.ok(terminations[e.from] && terminations[e.from][e.outcome], id + ' 缺终止描述：' + e.from + ' → ' + e.outcome)
    }
    const m2 = !!(bp.control && bp.control.maxRoundsExhausted === 'BLOCKED')
    assert.equal(script.includes('MAX_ROUNDS_EXHAUSTED_BLOCKED = true'), m2, id + ' M2 开关=' + m2)
  }
  // 诊断收口必须有完成映射（AC-03：合法 PASS 后 DELIVERED 必须有完成映射）
  const diagnose = JSON.parse(readFileSync(path.join(here, '../../templates/wf-diagnose.json'), 'utf8'))
  const closeout = diagnose.nodes.find((n) => n.id === 'closeout')
  assert.equal(closeout.output.completionPath, '$.completion_type')
  assert.equal(closeout.output.schema.properties.completion_type.const, 'DELIVERED')
})

test('生成 Skill runbook：BLOCKED 恢复入口与完成类型说明（AC-04 一致解释）', () => {
  const bp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-diagnose.json'), 'utf8'))
  const skill = skillWrap(bp)
  assert.ok(skill.includes('`BLOCKED`（统一受阻生命周期）'), 'runbook 应说明统一受阻语义')
  assert.ok(skill.includes('entry=<termination.resume_node>'), 'runbook 应指向恢复入口')
  assert.ok(skill.includes('NEEDS_REDEFINE'), 'runbook 应说明基线重定义边界')
  assert.ok(skill.includes('AUTO_REWORK_EXHAUSTED'), 'runbook 应说明 M2 额度耗尽受阻')
  assert.ok(skill.includes('INSUFFICIENT'), 'runbook 应说明探索证据不足的合法完成')
})
