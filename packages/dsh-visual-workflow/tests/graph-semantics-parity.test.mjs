// 图语义副本 parity 门禁（LOC-005）：把 COND_RE 单点门禁推广到 client/host
// 手工保有的校验内核图语义副本。以内核权威侧同函数喂同一输入断言一致，
// 副本漂移单字符即红（mutation 验证见各用例注释）。
//
// 覆盖四类副本（验收条件 §15）：
//   ① 蓝图摄入 —— client.ingestEditorJson vs 内核 projectToVwf
//   ② 结构边/回退边判定 —— client.isStructuralEdge/isRollbackEdge vs 内核同名函数
//   ③ entry 归一 —— client.deriveEntryCandidates vs 内核同名函数
//   ④ schema 模板推导 —— buildSchemaTemplate 经内核 validateBlueprint 接受
//      （schema-template.test.mjs 已覆盖，此处仅锁定「模板产物被内核接受」契约）
//
// 不统一 implementation（沙箱约束下 client 独立实现为 CONTEXT.md 已锁定决策），
// 本文件只做「统一验证」：不一致即红灯，不靠人事后发现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import validatorCore from '../../../scripts/validate-core.cjs'

const {
  validateBlueprint,
  isStructuralEdge,
  isRollbackEdge,
  deriveEntryCandidates,
  projectToVwf,
} = validatorCore

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')
// 与 schema-template.test.mjs 同形态：client.js 是动态闭包体，纯函数经顶层导出提取。
const plugin = new Function(src)()

const cIsStructural = plugin.isStructuralEdge
const cIsRollback = plugin.isRollbackEdge
const cDeriveEntry = plugin.deriveEntryCandidates
const cIngest = plugin.ingestEditorJson
const cBuildSchema = plugin.buildSchemaTemplate
assert.equal(typeof cIsStructural, 'function', 'client 顶层导出 isStructuralEdge')
assert.equal(typeof cIsRollback, 'function', 'client 顶层导出 isRollbackEdge')
assert.equal(typeof cDeriveEntry, 'function', 'client 顶层导出 deriveEntryCandidates')
assert.equal(typeof cIngest, 'function', 'client 顶层导出 ingestEditorJson')

// ② 结构边 / 回退边判定：副本 vs 内核同名函数
test('parity②：结构边/回退边判定与内核一致（全形态矩阵）', () => {
  const edges = [
    { from: 'a', to: 'b', on: 'success' },                          // 结构
    { from: 'a', to: 'b', on: 'failure' },                          // 非结构
    { from: 'a', to: 'b', on: 'technical' },                        // 非结构
    { from: 'a', to: 'b', outcome: 'PASS' },                        // 结构（outcome）
    { from: 'a', to: 'b', outcome: 'PASS', countRound: false },     // 结构 + 回退（countRound 声明）
    { from: 'a', to: 'b', outcome: 'PASS', countRound: true },      // 结构 + 回退
    { from: 'a', to: 'a', on: 'success' },                          // 自环 = 回退
    { from: 'a', to: 'b', on: 'success', countRound: false },       // success + countRound = 回退
    { from: 'a', to: 'b', outcome: '' },                            // 空 outcome 非结构
    { from: 'a', to: 'b', outcome: null },                          // null outcome 非结构
    { from: 'a', to: 'b' },                                         // 无 on/outcome 非结构
    { from: 'a', to: 'b', on: 'success', when: '$.ok == true' },    // 结构（when 不影响边型）
    null,                                                            // 空边
    { from: 'a' },                                                   // 缺 to
  ]
  for (const e of edges) {
    assert.equal(cIsStructural(e), isStructuralEdge(e), 'isStructuralEdge 漂移：' + JSON.stringify(e))
    assert.equal(cIsRollback(e), isRollbackEdge(e), 'isRollbackEdge 漂移：' + JSON.stringify(e))
  }
  // mutation 自检（一次并还原）：把 client 副本的 'success' 改成 'succes' 应致此用例变红
})

// ③ entry 归一：副本 vs 内核 deriveEntryCandidates
test('parity③：entry 候选归一与内核一致（含 HD/回退/自环旁路）', () => {
  const HD = validatorCore.HUMAN_DECISION_ID
  const nodes = (ids) => ids.map((id) => ({ id, profile: 'p', label: id }))
  const cases = [
    { nodes: nodes(['a', 'b']), edges: [{ from: 'a', to: 'b', on: 'success' }] },              // entry=a
    { nodes: nodes(['a', 'b', 'c']), edges: [{ from: 'a', to: 'b', on: 'success' }, { from: 'b', to: 'c', on: 'success' }] }, // a→b→c
    { nodes: nodes(['a', 'b']), edges: [{ from: 'a', to: 'b', outcome: 'OK', countRound: false }] }, // 回退边不算入边 → a、b 均候选
    { nodes: nodes(['a', 'b']), edges: [{ from: 'b', to: 'b', on: 'success' }] },              // 自环不算入边
    { nodes: nodes(['a', 'b']), edges: [{ from: HD, to: 'b', on: 'success' }] },               // HD 出边算 b 的入边
    { nodes: nodes(['a', 'b']), edges: [{ from: 'a', to: HD, on: 'success' }, { from: HD, to: 'b', on: 'success' }] }, // a→HD→b：b 有入边
    { nodes: nodes(['a', 'b']), edges: [{ from: 'a', to: 'b', on: 'failure' }] },              // failure 非结构入边 → 双候选
    { nodes: nodes(['a']), edges: [{ from: 'a', to: '$end', on: 'success' }] },                // 终点边不入候选
    { nodes: nodes(['a', 'b']), edges: [{ from: 'ghost', to: 'b', on: 'success' }] },          // 来源不在节点集 → 不算 b 入边
  ]
  for (const c of cases) {
    const want = deriveEntryCandidates(c.nodes, c.edges)
    const got = cDeriveEntry({ nodes: c.nodes, edges: c.edges })
    assert.deepEqual(got, want, 'deriveEntryCandidates 漂移：' + JSON.stringify(c.edges))
  }
  // mutation 自检：改 client 副本的 isRollbackEdge 调用或 incoming 判定应致此用例变红
})

// ① 蓝图摄入：client.ingestEditorJson vs 内核 projectToVwf（同一 Blueprint 输入）
test('parity①：蓝图摄入与内核投影一致（含 bindings/models、可选键保留）', () => {
  const bp = {
    id: 'parity-ingest',
    displayName: '摄入对拍',
    description: '含模型绑定与可选键',
    entry: 'dev',
    control: { maxRounds: 5 },
    heteroCheck: true,
    bundleRoles: true,
    onMaxRounds: 'auto-reschedule',
    humanDecision: { maxRoundsReachedOptions: ['STOP', 'ADD_BUDGET'] },
    bindings: { models: { dev: { provider: 'p', model: 'm' } } },
    nodes: [
      { id: 'dev', profile: 'dev', label: '开发', goal: '实现', kind: 'worker', verifyBranch: true, output: { schema: { required: ['verified_branch'] } } },
      { id: 'review', profile: 'review', label: '审查', goal: '审', manualCheck: true },
    ],
    edges: [
      { from: 'dev', to: 'review', on: 'success', when: '$.ok == true', result: 'PASS' },
      { from: 'review', to: 'dev', outcome: 'OPTIMIZE', countRound: false },
    ],
  }
  const clientOut = cIngest(bp)
  const kernelOut = projectToVwf(bp)
  // 对拍的是图语义公共面：id/name/description/entry/control/可选键 + 逐节点/逐边的语义键。
  // client 摄入保留与内核相同的结构面；bindings 折叠进 node.model 的语义必须与内核一致。
  assert.deepEqual(clientOut, kernelOut, 'ingestEditorJson 与 projectToVwf 已漂移，请同步两侧图语义摄入口径')
  // mutation 自检：改 client 摄入的 model 折叠条件或可选键透传（heteroCheck/bundleRoles/humanDecision）应致此用例变红
})

test('parity①边界：摄入副本对「非 Blueprint」早退原样返回', () => {
  // 与内核 projectToVwf 行为对称：非 Blueprint 直接原样透传，不投影、不报错。
  const nonBlueprints = [
    null,
    'x',
    { id: 'no-nodes' },                                  // 缺 nodes/edges
    { id: 'n', nodes: [], edges: 'not-array' },          // edges 非数组
    { id: 'n', nodes: [], edges: [] },                   // 无 displayName 无 bindings → 早退原样
  ]
  for (const raw of nonBlueprints) {
    assert.deepEqual(cIngest(raw), raw, '非 Blueprint 输入应原样透传：' + JSON.stringify(raw))
  }
  // mutation 自检：去掉 displayName/bindings 任一前置判断应致此用例变红
})

// ④ schema 模板推导：生成产物必须被内核接受（锁定「模板⇄校验」口径一致）
test('parity④：schema 模板推导产物被内核 validateBlueprint 接受', () => {
  const mkNode = (id, c) => ({
    id, profile: 'p', label: id, goal: 'g',
    output: c.successCondition ? { schema: cBuildSchema(c), successCondition: c.successCondition } : { schema: cBuildSchema(c) },
    verifyBranch: c.verifyBranch,
  })
  const cases = [
    // 无成功条件：单节点成功到终点即可
    { nodes: [mkNode('n1', { kind: 'worker' })], edges: [{ from: 'n1', to: '$end', on: 'success' }] },
    // 有成功条件：须补 failure 出边（内核口径）
    { nodes: [mkNode('n1', { kind: 'worker', successCondition: '$.result == "PASSED"' })], edges: [{ from: 'n1', to: '$end', on: 'success' }, { from: 'n1', to: 'n1', on: 'failure' }] },
    { nodes: [mkNode('n1', { kind: 'worker', successCondition: '$.a.b == 3.14' })], edges: [{ from: 'n1', to: '$end', on: 'success' }, { from: 'n1', to: 'n1', on: 'failure' }] },
    { nodes: [mkNode('n1', { kind: 'worker', verifyBranch: true, successCondition: '$.ok == true' })], edges: [{ from: 'n1', to: '$end', on: 'success' }, { from: 'n1', to: 'n1', on: 'failure' }] },
  ]
  for (const c of cases) {
    const r = validateBlueprint({
      id: 'schema-parity',
      displayName: 's',
      entry: c.nodes[0].id,
      nodes: c.nodes,
      edges: c.edges,
    })
    assert.equal(r.ok, true, JSON.stringify(c.nodes[0].output) + ' → ' + JSON.stringify(r.errors))
  }
  // mutation 自检：改模板推导的类型映射（boolean/string/number）或 required 装配应致此用例变红
})
