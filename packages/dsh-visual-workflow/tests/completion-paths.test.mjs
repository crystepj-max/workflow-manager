// WFM-83：公开编辑模型的多层映射、schema 保真和投影契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import core from '../../../scripts/validate-core.cjs'
const ui = new Function(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'))()
const clone = (v) => JSON.parse(JSON.stringify(v))
const seed = () => ({ id: 'closeout', profile: 'closeout', goal: '输出完成原因', output: {
  outcomePath: '$.result.decision', completionPath: '$.result.completion', files: { 'report.md': 'markdown' },
  schema: { type: 'object', additionalProperties: false, required: ['result', 'summary'], properties: {
    summary: { type: 'string' },
    result: { type: 'object', required: ['decision', 'completion', 'evidence'], properties: {
      decision: { type: 'string', enum: ['DONE'], description: '去向', minLength: 1 },
      completion: { type: 'string', const: 'DELIVERED', description: '完成原因' },
      evidence: { type: 'string' },
    } },
  } },
} })

test('WFM-83 多层字段按内核路径语法回显，候选值读取当前节点 schema', () => {
  assert.equal(ui.routingNameOf('$.result.decision'), 'result.decision')
  assert.equal(ui.normalizeRoutingName(' $.result.1decision '), 'result.1decision')
  assert.deepEqual(ui.routingValuesOf(seed()), ['DONE'])
  assert.deepEqual(ui.routingValuesOf(seed(), 'completionPath'), ['DELIVERED'])
  assert.deepEqual(ui.routingCandidates(seed().output.schema), ['result.decision', 'result.completion'])
})

test('WFM-83 改取值不降层，保留注释/约束/其它字段且不修改入参', () => {
  for (const field of ['outcomePath', 'completionPath']) {
    const n = seed(), before = clone(n)
    const path = n.output[field]
    const out = ui.applyRoutingWrite(n, ui.routingNameOf(path), ['DONE', 'CUSTOM'], field)
    assert.equal(out[field], path)
    const leaf = core.schemaLeafAt(out.schema, core.parseJsonPath(path))
    assert.deepEqual(leaf.enum, ['DONE', 'CUSTOM'])
    assert.ok(leaf.description)
    assert.equal(leaf.const, undefined, '编辑取值时清理原 const，避免自相矛盾')
    assert.deepEqual(out.files, n.output.files)
    assert.deepEqual(out.schema.properties.summary, n.output.schema.properties.summary)
    assert.deepEqual(n, before)
  }
})

test('WFM-83 显式改路径清理旧叶子和 required，保留兄弟字段并支持单层往返', () => {
  const n = seed()
  const moved = ui.applyRoutingWrite(n, 'final.reason', ['CUSTOM'], 'completionPath')
  assert.equal(moved.completionPath, '$.final.reason')
  assert.equal(moved.schema.properties.result.properties.completion, undefined)
  assert.deepEqual(moved.schema.properties.result.required, ['decision', 'evidence'])
  assert.deepEqual(moved.schema.properties.final.required, ['reason'])
  assert.ok(moved.schema.properties.result.properties.decision)
  const flat = ui.applyRoutingWrite({ output: moved }, 'completion_type', ['CUSTOM'], 'completionPath')
  assert.equal(flat.schema.properties.final, undefined, '空路径容器被清理')
  assert.ok(!flat.schema.required.includes('final'), '空容器的 required 同步清理')
  assert.equal(flat.completionPath, '$.completion_type')
})

const mappingGroup = (label, properties) => ({
  type: 'object', description: label, additionalProperties: false, minProperties: 1,
  required: Object.keys(properties), properties,
})
for (const field of ['outcomePath', 'completionPath']) {
  for (const values of [undefined, ['CUSTOM']]) {
    for (const [previous, name, preserved] of [
      ['final.reason', 'final.note', ['final']],
      ['final.details.reason', 'final.note', ['final']],
      ['final.details.branch.reason', 'final.details.note', ['final', 'final.details']],
      ['final.left.reason', 'final.right.note', ['final']],
    ]) {
      test(`WFM-83 R2 ${field} ${previous} → ${name}，${values ? '改候选' : '仅改名'}保留全部公共祖先约束`, () => {
        const n = seed()
        const source = { type: 'string', enum: ['DONE'], description: '字段说明', minLength: 1 }
        n.output[field] = '$.' + previous
        const parts = previous.split('.')
        let branch = source
        for (let i = parts.length - 1; i > 0; i--) branch = mappingGroup(parts.slice(0, i).join('.'), { [parts[i]]: branch })
        n.output.schema.properties.final = branch
        n.output.schema.required.push('final')
        const before = clone(n)
        const moved = ui.applyRoutingWrite(n, name, values, field)
        assert.equal(moved[field], '$.' + name)
        assert.deepEqual(core.schemaLeafAt(moved.schema, name.split('.')), { ...source, enum: values || source.enum })
        assert.equal(core.schemaLeafAt(moved.schema, previous.split('.')), null, '旧叶子已迁走')
        for (const path of preserved) {
          const { properties, required, ...metadata } = core.schemaLeafAt(before.output.schema, path.split('.'))
          const { properties: actualProperties, required: actualRequired, ...actualMetadata } = core.schemaLeafAt(moved.schema, path.split('.'))
          assert.deepEqual(actualMetadata, metadata, path + ' 的说明与封闭对象等约束完整保留')
          assert.deepEqual(actualRequired, Object.keys(actualProperties), path + ' 只要求迁移后的实际子字段')
        }
        const shared = preserved.at(-1)
        const abandoned = previous.split('.').slice(0, -1).join('.')
        if (abandoned !== shared) assert.equal(core.schemaLeafAt(moved.schema, abandoned.split('.')), null, '真正离开的空分组被清理')
        assert.deepEqual(moved.schema.required, before.output.schema.required, '公共根分组仍必填且不换序')
        assert.deepEqual(moved.schema.properties.result, before.output.schema.properties.result, '其它业务分组不变')
        assert.deepEqual(moved.files, before.output.files)
        assert.deepEqual(n, before, '迁移不改写原入参')
      })
    }
  }
}

test('WFM-83 R2 已有目标叶子与同路径写入各自保留元数据；无效修改返回原 output', () => {
  for (const field of ['outcomePath', 'completionPath']) {
    const n = seed()
    n.output[field] = '$.final.reason'
    n.output.schema.properties.final = mappingGroup('收口分组', {
      reason: { type: 'string', enum: ['DONE'], description: '旧字段', minLength: 1 },
      note: { type: 'string', enum: ['TARGET'], description: '目标字段', minLength: 2 },
    })
    n.output.schema.required.push('final')
    const before = clone(n)
    const moved = ui.applyRoutingWrite(n, 'final.note', undefined, field)
    assert.deepEqual(moved.schema.properties.final, { ...before.output.schema.properties.final, required: ['note'], properties: { note: before.output.schema.properties.final.properties.note } })
    const same = ui.applyRoutingWrite(n, 'final.reason', undefined, field)
    assert.deepEqual(same, before.output, '同路径不删叶子或元数据')
    for (const invalid of ['final', 'final.reason.child', 'result']) {
      assert.equal(ui.applyRoutingWrite(n, invalid, undefined, field), n.output, invalid + ' 原对象退回')
      assert.equal(ui.applyRoutingWrite(n, invalid, ['CUSTOM'], field), n.output, invalid + ' 原对象退回')
    }
    assert.deepEqual(n, before)
  }
})

test('WFM-83 A1 两种映射拒绝移到旧路径父级，重输原路径仍完整保真', () => {
  for (const field of ['outcomePath', 'completionPath']) {
    const n = seed(), before = clone(n)
    for (const values of [undefined, ['DONE']]) {
      const rejected = ui.applyRoutingWrite(n, 'result', values, field)
      assert.deepEqual(rejected, before.output, field + ' 父路径修改不应用')
      const restored = ui.applyRoutingWrite({ output: rejected }, ui.routingNameOf(n.output[field]), undefined, field)
      assert.deepEqual(restored, before.output, '重新选择原叶子保留注释、约束、候选值和兄弟字段')
    }
    assert.deepEqual(n, before, '拒绝修改不改变入参')
  }
})

test('WFM-83 A1 对象数组终点及穿过标量的路径不能破坏 schema', () => {
  const targets = [
    ['container', { type: 'object', properties: { evidence: { type: 'string' } } }],
    ['container', { properties: { evidence: { type: 'string' } } }],
    ['container', { type: 'array', items: { type: 'string' } }],
    ['container', { items: { type: 'string' } }],
    ['container', { type: 'object' }],
    ['container', { type: 'array' }],
    ['result.decision.note', null],
    ['container.note', { type: 'number' }],
    ['container.note', { type: 'boolean' }],
    ['container.note', { enum: ['A', 'B'] }],
  ]
  for (const field of ['outcomePath', 'completionPath']) {
    for (const [path, target] of targets) {
      const n = seed()
      if (target) n.output.schema.properties.container = target
      const before = clone(n)
      for (const values of [undefined, ['DONE']]) {
        assert.deepEqual(ui.applyRoutingWrite(n, path, values, field), before.output, field + ' 拒绝 ' + path + ' ' + JSON.stringify(target))
      }
      assert.deepEqual(n, before)
    }
  }
})

test('WFM-83 A1 给已映射的对象数组或非枚举数值加取值不能将其收成 string', () => {
  for (const field of ['outcomePath', 'completionPath']) {
    for (const target of [{ type: 'object', properties: {} }, { type: 'array', items: { type: 'string' } }, { type: 'number' }]) {
      const n = seed()
      n.output[field] = '$.container'
      n.output.schema.properties.container = target
      const before = clone(n)
      assert.deepEqual(ui.applyRoutingWrite(n, 'container', ['DONE'], field), before.output)
      assert.deepEqual(n, before)
    }
  }
})

test('WFM-83 A1 完成路径不能穿过现有业务文本字段，旧完成叶子不丢失', () => {
  const n = seed(), before = clone(n)
  const out = ui.applyRoutingWrite(n, 'result.decision.note', undefined, 'completionPath')
  assert.deepEqual(out, before.output)
  assert.deepEqual(n, before)
})

test('WFM-83 A2 带元数据的空容器递归清理及 required 同步，业务兄弟与元数据保留', () => {
  for (const field of ['outcomePath', 'completionPath']) {
    for (const metadata of [{ additionalProperties: false }, { description: '结果分组' }, { additionalProperties: false, description: '结果分组' }]) {
      for (const keepSibling of [false, true]) {
        const n = seed()
        n.output[field] = '$.final.details.reason'
        n.output.schema.required.push('final')
        n.output.schema.properties.final = { type: 'object', ...metadata, required: ['details'], properties: {
          details: { type: 'object', ...metadata, required: ['reason'], properties: {
            reason: { type: 'string', enum: ['DONE'], description: '原因', minLength: 1 },
          } },
        } }
        if (keepSibling) {
          n.output.schema.properties.final.properties.evidence = { type: 'string', description: '必须输出的证据' }
          n.output.schema.properties.final.required.push('evidence')
        }
        const before = clone(n)
        const moved = ui.applyRoutingWrite(n, 'completion_type', undefined, field)
        assert.deepEqual(moved.schema.properties.completion_type, before.output.schema.properties.final.properties.details.properties.reason)
        assert.deepEqual(moved.schema.properties.result, before.output.schema.properties.result, '未迁移的业务分组完整保留')
        if (keepSibling) {
          assert.deepEqual(moved.schema.properties.final, { type: 'object', ...metadata, required: ['evidence'], properties: { evidence: before.output.schema.properties.final.properties.evidence } })
          assert.ok(moved.schema.required.includes('final'), '还有业务字段的父级仍必填')
        } else {
          assert.equal(moved.schema.properties.final, undefined, '全部空父级递归删除')
          assert.ok(!moved.schema.required.includes('final'), '空父级的 required 同步删除')
        }
        assert.ok(moved.schema.required.includes('result'))
        assert.ok(moved.schema.required.includes('summary'))
        assert.deepEqual(n, before)
      }
    }
  }
})

test('WFM-83 A2 数组 items 还有业务兄弟时保留，迁出最后叶子后才清理数组及 required', () => {
  for (const keepSibling of [false, true]) {
    const n = seed()
    n.output.completionPath = '$.final.reason'
    n.output.schema.required.push('final')
    n.output.schema.properties.final = { type: 'array', minItems: 1, description: '收口结果', items: {
      type: 'object', additionalProperties: false, required: ['reason'], properties: {
        reason: { type: 'string', const: 'DELIVERED' },
      },
    } }
    if (keepSibling) {
      n.output.schema.properties.final.items.properties.evidence = { type: 'string' }
      n.output.schema.properties.final.items.required.push('evidence')
    }
    const before = clone(n)
    const moved = ui.applyRoutingWrite(n, 'completion_type', undefined, 'completionPath')
    if (keepSibling) {
      assert.deepEqual(moved.schema.properties.final, { type: 'array', minItems: 1, description: '收口结果', items: {
        type: 'object', additionalProperties: false, required: ['evidence'], properties: { evidence: { type: 'string' } },
      } })
      assert.ok(moved.schema.required.includes('final'))
    } else {
      assert.equal(moved.schema.properties.final, undefined)
      assert.ok(!moved.schema.required.includes('final'))
    }
    assert.deepEqual(moved.schema.properties.result, before.output.schema.properties.result)
    assert.deepEqual(n, before)
  }
})

test('WFM-83 A2 多份 schema 的容器不能因第一份变空而丢掉其它业务字段', () => {
  const n = seed()
  n.output.completionPath = '$.final.reason'
  n.output.schema.required.push('final')
  n.output.schema.properties.final = [
    { type: 'object', description: '映射所在 schema', required: ['reason'], properties: { reason: { type: 'string', const: 'DELIVERED' } } },
    { type: 'object', required: ['evidence'], properties: { evidence: { type: 'string' } } },
  ]
  const before = clone(n)
  const moved = ui.applyRoutingWrite(n, 'completion_type', undefined, 'completionPath')
  assert.deepEqual(moved.schema.properties.final, [
    { type: 'object', description: '映射所在 schema', required: [], properties: {} },
    before.output.schema.properties.final[1],
  ])
  assert.ok(moved.schema.required.includes('final'))
  assert.deepEqual(n, before)
})

test('WFM-83 共用字段改映射不删除另一映射仍使用的属性', () => {
  const n = seed()
  n.output.completionPath = n.output.outcomePath
  const moved = ui.applyRoutingWrite(n, 'done', ['CUSTOM'], 'completionPath')
  assert.equal(moved.outcomePath, '$.result.decision')
  assert.deepEqual(core.schemaLeafAt(moved.schema, ['result', 'decision']), n.output.schema.properties.result.properties.decision)
  assert.equal(moved.completionPath, '$.done')
  assert.ok(moved.schema.properties.result.required.includes('decision'))
})

test('WFM-83 只声明完成字段保留已有 schema；未声明候选的 string 由内核接受', () => {
  const n = seed()
  delete n.output.completionPath
  n.output.schema.properties.summary.description = '自由文本完成原因'
  const out = ui.applyRoutingWrite(n, 'summary', undefined, 'completionPath')
  assert.equal(out.completionPath, '$.summary')
  assert.deepEqual(out.schema, n.output.schema)
  const bp = { id: 'nested-mapping', displayName: '多层映射', entry: n.id, control: { maxRounds: 3 }, nodes: [{ ...n, output: out }], edges: [{ from: n.id, to: '$end', outcome: 'DONE' }] }
  assert.equal(core.validateBlueprint(bp).ok, true, JSON.stringify(core.validateBlueprint(bp).errors))
  const roundtrip = core.projectToBlueprint(core.projectToVwf(bp))
  assert.deepEqual(roundtrip.nodes[0].output, out)
})


test('WFM-83 两种多层声明经蓝图与 DSL 双向保真，候选读取与校验内核一致', () => {
  const n = seed()
  n.output.outcomePath = '  $.result.decision  '
  n.output.completionPath = '  $.result.completion  '
  const bp = { id: 'nested-roundtrip', displayName: '双映射往返', entry: n.id, control: { maxRounds: 3 }, nodes: [n], edges: [{ from: n.id, to: '$end', outcome: 'DONE' }] }
  const v = core.validateBlueprint(bp)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.deepEqual(core.projectToBlueprint(core.projectToVwf(bp)).nodes[0].output, n.output)
  for (const field of ['outcomePath', 'completionPath']) {
    const written = ui.applyRoutingWrite(n, ui.routingNameOf(n.output[field]), ['DONE'], field)
    assert.equal(written[field], n.output[field], '只改取值时声明路径逐字保留')
  }
  for (const leaf of [
    { oneOf: [{ enum: ['A', 'B'] }, { const: 'C' }] },
    { enum: ['B'], const: 'A' }, { type: 'boolean' }, { enum: [] }, { type: 'string' },
  ]) {
    const expected = core.enumerableValues(leaf)
    assert.deepEqual(ui.enumerableValues(leaf), expected && expected.map(String), '界面数据读取与真实内核相同')
  }
})

test('WFM-83 编辑已有错误 required 不抛异常，沿用旧编辑器的数组修复口径', () => {
  const node = seed()
  node.output.schema.required = 'result'
  const out = ui.applyRoutingWrite(node, 'result.decision', ['DONE'])
  assert.deepEqual(out.schema.required, ['result'])
  assert.deepEqual(out.schema.properties.result.properties.decision.enum, ['DONE'])
})
