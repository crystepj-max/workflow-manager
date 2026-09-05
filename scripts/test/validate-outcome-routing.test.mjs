import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint, deriveEntryCandidates } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const good = JSON.parse(readFileSync(path.join(here, '../../templates/dev-workflow-2-0.json'), 'utf8'))
const defaultWf = JSON.parse(readFileSync(path.join(here, '../../templates/default-workflow.json'), 'utf8'))
const hdGood = JSON.parse(readFileSync(path.join(here, 'fixtures/human-decision-blueprint.json'), 'utf8'))
const fanoutGood = JSON.parse(readFileSync(path.join(here, 'fixtures/fanout-blueprint.json'), 'utf8'))
const outcomeGood = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-evaluate-mini.json'), 'utf8'))

const clone = (bp) => JSON.parse(JSON.stringify(bp))
const expectOk = (bp, label) => {
  const r = validateBlueprint(bp)
  assert.equal(r.ok, true, (label || 'ok') + '：' + JSON.stringify(r.errors))
}
const expectReject = (bp, needle, label) => {
  const r = validateBlueprint(bp)
  assert.equal(r.ok, false, label + '：应拒绝')
  assert.ok(
    r.errors.some((e) => String(e.message).includes(needle) || String(e.fieldKey || '').includes(needle)),
    label + '：应含「' + needle + '」，实际 ' + JSON.stringify(r.errors),
  )
}

test('#126 旧蓝图零迁移：内置模板与既有 HD/fanout 夹具仍通过', () => {
  expectOk(good, 'dev-workflow-2-0')
  expectOk(defaultWf, 'default-workflow')
  expectOk(hdGood, 'human-decision-mini')
  expectOk(fanoutGood, 'fanout-example')
})

test('#126 L1 优化评估：三枚举三边 + 技术自环 + HD 出边合法', () => {
  expectOk(outcomeGood, 'outcome-evaluate-mini')
})

test('#126 L2 自定义 $.decision 合法', () => {
  const b = {
    id: 'desk-mini',
    displayName: '自定义决策',
    entry: 'start',
    nodes: [{
      id: 'start',
      profile: 'dispatcher',
      goal: '启动',
      output: {
        outcomePath: '$.go',
        schema: {
          type: 'object',
          properties: { go: { type: 'string', enum: ['NEXT'] } },
          required: ['go'],
          additionalProperties: false,
        },
      },
    }, {
      id: 'desk',
      profile: 'review',
      goal: '裁决',
      output: {
        outcomePath: '$.decision',
        schema: {
          type: 'object',
          properties: { decision: { type: 'string', enum: ['PUBLISH', 'REWRITE', 'LEGAL_REVIEW'] } },
          required: ['decision'],
          additionalProperties: false,
        },
      },
    }],
    edges: [
      { from: 'start', to: 'desk', outcome: 'NEXT' },
      { from: 'desk', to: '$end', outcome: 'PUBLISH' },
      { from: 'desk', to: 'desk', outcome: 'REWRITE' },
      { from: 'desk', to: '$human-decision', outcome: 'LEGAL_REVIEW' },
      { from: '$human-decision', to: '$end', outcome: 'USER_ACCEPTED' },
    ],
  }
  expectOk(b, 'custom-decision')
})

test('#126 L4 boolean 两边合法', () => {
  const b = {
    id: 'bool-mini',
    displayName: '布尔结果',
    entry: 'start',
    nodes: [{
      id: 'start',
      profile: 'dispatcher',
      goal: '启动',
      output: {
        outcomePath: '$.go',
        schema: {
          type: 'object',
          properties: { go: { type: 'string', enum: ['NEXT'] } },
          required: ['go'],
          additionalProperties: false,
        },
      },
    }, {
      id: 'gate',
      profile: 'review',
      goal: '开关',
      output: {
        outcomePath: '$.ok',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    }],
    edges: [
      { from: 'start', to: 'gate', outcome: 'NEXT' },
      { from: 'gate', to: '$end', outcome: true },
      { from: 'gate', to: 'gate', outcome: false },
    ],
  }
  expectOk(b, 'boolean-ok')
})

test('#126 工作流内新旧节点并存合法', () => {
  const b = {
    id: 'mixed-modes',
    displayName: '新旧并存',
    entry: 'legacy',
    nodes: [
      {
        id: 'legacy',
        profile: 'dispatcher',
        goal: '旧二态',
        output: {
          successCondition: '$.complete == true',
          schema: {
            type: 'object',
            properties: { complete: { type: 'boolean' } },
            required: ['complete'],
            additionalProperties: false,
          },
        },
      },
      {
        id: 'eval',
        profile: 'review',
        goal: '新三态',
        output: {
          outcomePath: '$.verdict',
          schema: {
            type: 'object',
            properties: { verdict: { type: 'string', enum: ['PASS', 'RETRY'] } },
            required: ['verdict'],
            additionalProperties: false,
          },
        },
      },
    ],
    edges: [
      { from: 'legacy', to: 'eval', on: 'success' },
      { from: 'legacy', to: '$end', on: 'failure' },
      { from: 'eval', to: '$end', outcome: 'PASS' },
      { from: 'eval', to: '$end', outcome: 'RETRY' },
    ],
  }
  expectOk(b, 'mixed-modes')
})

test('#126 同一节点禁止新旧混用', () => {
  const b = clone(outcomeGood)
  b.nodes.find((n) => n.id === 'evaluate').output.successCondition = '$.verdict == "PASS"'
  expectReject(b, 'outcomePath', 'mix-successCondition')

  const b2 = clone(outcomeGood)
  b2.edges.push({ from: 'evaluate', to: 'execute', on: 'success' })
  expectReject(b2, 'outcomePath', 'mix-success-edge')
})

test('#126 缺枚举边 / 多余边取值拒绝', () => {
  const missing = clone(outcomeGood)
  missing.edges = missing.edges.filter((e) => e.outcome !== 'CONFIRM')
  expectReject(missing, 'CONFIRM', 'missing-CONFIRM-edge')

  const extra = clone(outcomeGood)
  extra.edges.push({ from: 'evaluate', to: '$end', outcome: 'SKIP' })
  expectReject(extra, 'SKIP', 'extra-SKIP')
})

test('#126 自由 string 的 outcomePath 拒绝', () => {
  const b = clone(outcomeGood)
  b.nodes.find((n) => n.id === 'evaluate').output.schema.properties.verdict = { type: 'string' }
  expectReject(b, '可穷举', 'free-string')
})

test('#126 无入边的 HD 出边拒绝', () => {
  const b = {
    id: 'hd-orphan',
    displayName: '悬空 HD',
    entry: 'work',
    nodes: [{
      id: 'work',
      profile: 'dev',
      goal: '干活',
      output: {
        outcomePath: '$.status',
        schema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['DONE'] } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    }],
    edges: [
      { from: 'work', to: '$end', outcome: 'DONE' },
      { from: '$human-decision', to: '$end', outcome: 'USER_ACCEPTED' },
    ],
  }
  expectReject(b, '$human-decision', 'hd-no-in')
})

test('#126 有入边的 HD 缺出边拒绝', () => {
  const b = clone(outcomeGood)
  b.edges = b.edges.filter((e) => e.from !== '$human-decision')
  expectReject(b, '$human-decision', 'hd-no-out')
})

test('#126 无出口业务自环拒绝；有 PASS 出口的环合法', () => {
  const dead = {
    id: 'dead-loop',
    displayName: '无出口自环',
    entry: 'start',
    nodes: [{
      id: 'start',
      profile: 'dispatcher',
      goal: '启动',
      output: {
        outcomePath: '$.go',
        schema: {
          type: 'object',
          properties: { go: { type: 'string', enum: ['NEXT'] } },
          required: ['go'],
          additionalProperties: false,
        },
      },
    }, {
      id: 'n',
      profile: 'review',
      goal: '环',
      output: {
        outcomePath: '$.v',
        schema: {
          type: 'object',
          properties: { v: { type: 'string', enum: ['AGAIN'] } },
          required: ['v'],
          additionalProperties: false,
        },
      },
    }],
    edges: [
      { from: 'start', to: 'n', outcome: 'NEXT' },
      { from: 'n', to: 'n', outcome: 'AGAIN' },
      { from: 'n', to: '$end', on: 'technical' },
    ],
  }
  expectReject(dead, '出口', 'no-exit-loop')
})

test('#126 旧 success 环仍拒绝', () => {
  const b = clone(good)
  b.edges.push({ from: 'test', to: 'route', on: 'success' })
  expectReject(b, '环', 'legacy-success-cycle')
})

test('#126 countRound 不参与走通性：false 的环只要有出口就合法', () => {
  const b = clone(outcomeGood)
  const opt = b.edges.find((e) => e.outcome === 'OPTIMIZE')
  opt.countRound = false
  expectOk(b, 'countRound-false')
})

test('#126 completionPath：无结构边到 $end 拒绝；叶子非 string 拒绝', () => {
  const deadMap = clone(outcomeGood)
  delete deadMap.nodes.find((n) => n.id === 'evaluate').output.completionPath
  deadMap.nodes.find((n) => n.id === 'execute').output.completionPath = '$.status'
  expectReject(deadMap, 'completionPath', 'completion-not-terminal')

  const badType = clone(outcomeGood)
  badType.nodes.find((n) => n.id === 'evaluate').output.schema.properties.completion_type = { type: 'boolean' }
  expectReject(badType, 'string', 'completion-not-string')
})

test('#126 fanout 禁止 outcomePath / completionPath / outcome 边 / technical', () => {
  const cases = [
    ['outcomePath', (b) => { b.nodes[0].output.outcomePath = '$.value' }, 'outcomePath'],
    ['completionPath', (b) => {
      b.nodes[0].output.completionPath = '$.value'
      b.nodes[0].output.schema.properties.value = { type: 'string' }
    }, 'completionPath'],
    ['outcome 边', (b) => { b.edges.push({ from: 'fan', to: 'finish', outcome: 'X' }) }, 'fanout'],
    ['technical', (b) => { b.edges.push({ from: 'fan', to: 'fan', on: 'technical' }) }, 'fanout'],
  ]
  for (const [label, mutate, needle] of cases) {
    const b = clone(fanoutGood)
    mutate(b)
    expectReject(b, needle, 'fanout-' + label)
  }
})

test('#126 同一 outcome 取值两条出边拒绝', () => {
  const b = clone(outcomeGood)
  b.edges.push({ from: 'evaluate', to: 'execute', outcome: 'PASS' })
  expectReject(b, 'PASS', 'dup-outcome')
})

test('回退 outcome 不计入入口入边：建设主链唯一入口仍是 requirements', () => {
  const bp = JSON.parse(readFileSync(path.join(here, 'fixtures/construction-rollback-mini.json'), 'utf8'))
  const cands = deriveEntryCandidates(bp.nodes, bp.edges)
  assert.deepEqual(cands, ['requirements'], 'RETURN_* 不得把入口节点算成有入边：' + JSON.stringify(cands))
  expectOk(bp, 'construction-rollback-mini')
})
