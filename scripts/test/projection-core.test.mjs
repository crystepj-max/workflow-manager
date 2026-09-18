import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectToVwf, projectToBlueprint, effectiveHeteroMode, isKnownHeteroValue, heteroModeForEdit } from '../projection-core.cjs'

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

// —— LOC-021 异源档位三态：投影归一化与双向透传 ——
test('LOC-021 档位归一化：缺失/true→weak，false→off，strong→strong，非法→weak', () => {
  assert.equal(effectiveHeteroMode(undefined), 'weak')
  assert.equal(effectiveHeteroMode(null), 'weak')
  assert.equal(effectiveHeteroMode(true), 'weak')
  assert.equal(effectiveHeteroMode('weak'), 'weak')
  assert.equal(effectiveHeteroMode(false), 'off')
  assert.equal(effectiveHeteroMode('off'), 'off')
  assert.equal(effectiveHeteroMode('strong'), 'strong')
  assert.equal(effectiveHeteroMode('turbo'), 'weak')
  assert.equal(isKnownHeteroValue('weak'), true)
  assert.equal(isKnownHeteroValue('strong'), true)
  assert.equal(isKnownHeteroValue('off'), true)
  assert.equal(isKnownHeteroValue(true), true)
  assert.equal(isKnownHeteroValue(false), true)
  assert.equal(isKnownHeteroValue(undefined), true)
  assert.equal(isKnownHeteroValue('turbo'), false)
  assert.equal(heteroModeForEdit(true), 'weak')
  assert.equal(heteroModeForEdit(false), 'off')
  assert.equal(heteroModeForEdit('strong'), 'strong')
  assert.equal(heteroModeForEdit(undefined), undefined)
})

test('LOC-021 投影往返：三态档位在蓝图↔DSL 间不丢（weak/strong/off）', () => {
  for (const mode of ['weak', 'strong', 'off']) {
    const bp = { ...blueprint(), heteroCheck: mode }
    const dsl = projectToVwf(bp)
    assert.equal(dsl.heteroCheck, mode, '正向投影透传档位 ' + mode)
    const back = projectToBlueprint(dsl)
    assert.equal(back.heteroCheck, mode, '逆向投影透传档位 ' + mode)
  }
  // 旧布尔归一：true → weak、false → off（正向投影归一，逆向保持归一后字符串）
  assert.equal(projectToVwf({ ...blueprint(), heteroCheck: true }).heteroCheck, 'weak')
  assert.equal(projectToBlueprint(projectToVwf({ ...blueprint(), heteroCheck: true })).heteroCheck, 'weak')
  assert.equal(projectToVwf({ ...blueprint(), heteroCheck: false }).heteroCheck, 'off')
  // 缺失不制造字段：未声明档位的蓝图投影后不出现 heteroCheck 键
  const noMode = blueprint()
  delete noMode.heteroCheck
  assert.equal(Object.hasOwn(projectToVwf(noMode), 'heteroCheck'), false)
})
