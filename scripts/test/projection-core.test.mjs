import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectToVwf, projectToBlueprint } from '../projection-core.cjs'

function blueprint() {
  return {
    id: 'projection-fixture',
    displayName: '投影夹具',
    description: '字段往返夹具',
    entry: 'dev',
    control: { maxRounds: 7 },
    onMaxRounds: 'auto-reschedule',
    heteroCheck: true,
    bundleRoles: true,
    humanDecision: { maxRoundsReachedOptions: ['STOP', 'ADD_BUDGET'] },
    bindings: {
      models: {
        dev: { provider: 'kimi-coding', model: 'kimi-k2' },
      },
    },
    nodes: [
      {
        id: 'dev',
        profile: 'dev',
        label: '开发',
        goal: '完成实现',
        kind: 'worker',
        output: { schema: { required: ['verified_branch', 'verified_head'] } },
        verifyBranch: true,
      },
      {
        id: 'review',
        profile: 'review',
        goal: undefined,
        manualCheck: true,
      },
    ],
    edges: [
      { from: 'dev', to: 'review', on: 'success', when: '$.ok == true', result: 'PASS' },
      { from: 'review', to: 'dev', outcome: 'OPTIMIZE', countRound: false },
    ],
  }
}

test('投影内核：字段映射保留 verifyBranch、模型、业务边和 false 值', () => {
  const bp = blueprint()
  const before = structuredClone(bp)
  const dsl = projectToVwf(bp)

  assert.deepEqual(bp, before, '正向投影不得修改 Blueprint')
  assert.equal(dsl.name, '投影夹具')
  assert.equal(dsl.control.maxRounds, 7)
  assert.equal(dsl.nodes.find((n) => n.id === 'dev').verifyBranch, true)
  assert.deepEqual(dsl.nodes.find((n) => n.id === 'dev').model, { provider: 'kimi-coding', model: 'kimi-k2' })
  assert.equal(dsl.nodes.find((n) => n.id === 'review').goal, undefined)
  assert.equal(Object.hasOwn(dsl.nodes.find((n) => n.id === 'review'), 'goal'), false)
  assert.equal(dsl.edges[1].outcome, 'OPTIMIZE')
  assert.equal(dsl.edges[1].countRound, false)
  assert.equal(Object.hasOwn(dsl.edges[1], 'on'), false)
  assert.equal(dsl.bundleRoles, true)
})

test('投影内核：DSL 逆投影保持可保存字段且不制造未知字段', () => {
  const dsl = projectToVwf(blueprint())
  const before = structuredClone(dsl)
  const bp = projectToBlueprint(dsl)

  assert.deepEqual(dsl, before, '逆向投影不得修改 DSL')
  assert.equal(bp.displayName, '投影夹具')
  assert.equal(bp.nodes.find((n) => n.id === 'dev').verifyBranch, true)
  assert.deepEqual(bp.bindings.models.dev, { provider: 'kimi-coding', model: 'kimi-k2' })
  assert.equal(bp.edges[1].countRound, false)
  assert.equal(Object.hasOwn(bp.edges[1], 'on'), false)
  assert.equal(Object.hasOwn(bp.nodes.find((n) => n.id === 'review'), 'manualCheck'), true)
  assert.equal(Object.hasOwn(bp, 'name'), false)
  assert.equal(Object.hasOwn(bp.nodes.find((n) => n.id === 'dev'), 'model'), false)
})

test('投影内核：缺省控制字段使用稳定默认值', () => {
  const dsl = projectToVwf({
    id: 'minimal',
    displayName: '最小',
    entry: 'only',
    nodes: [{ id: 'only', profile: 'dev', label: '' }],
    edges: [],
  })
  assert.equal(dsl.description, '')
  assert.equal(dsl.control.maxRounds, 9)
  assert.equal(dsl.nodes[0].label, 'only')
  assert.equal(Object.hasOwn(dsl.nodes[0], 'goal'), false)
})
