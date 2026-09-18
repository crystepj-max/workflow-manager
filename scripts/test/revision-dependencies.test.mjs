// LOC-034 精确依赖：revision-dependencies.mjs + records-host 集成验收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendRecord,
  coverageStatus,
  createStore,
  currentRevision,
  dependsOnStaleInputs,
  getRecord,
  KIND,
  NOT_COVERING_CURRENT,
  COVERING,
  staleProofsFor,
  toRef,
} from '../formal-records.mjs'
import {
  buildRecordDependencies,
  DEPENDENCY_COVERAGE,
  DEPENDENCY_ERROR,
  detectDependencyCycle,
  digest8,
  resolveInputDependencies,
  staleReasonChain,
} from '../revision-dependencies.mjs'
import { recordsCommit, recordsGet, recordsList } from '../records-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const RECORDS_HOST = join(here, '..', 'records-host.mjs')
const RUN = 'run-loc034'
const recordsDir = () => mkdtempSync(join(tmpdir(), 'loc034-'))

function prov(node, extra = {}) {
  return {
    logical_run_id: RUN,
    node,
    attempt: 1,
    snapshot_revision: '1',
    provider: 'p',
    model: 'm',
    produced_by: 'test',
    node_business_outcome: null,
    ...extra,
  }
}

function jsonBody(v) {
  return { media_type: 'application/json', value: v }
}

function append(store, input) {
  const body = input.body !== undefined ? input.body : jsonBody({ v: 1 })
  const nodeName = String(input.record_id || '').split(':').pop()
  const { provenance_extra, body: _b, ...rest } = input
  return appendRecord(store, {
    kind: KIND.RESULT,
    provenance: prov(nodeName, provenance_extra || {}),
    body,
    ...rest,
  })
}

function nodeId(name) {
  return 'node:' + RUN + ':' + name
}

function proofId(name) {
  return 'proof:' + RUN + ':' + name
}

function ri(producers, bodyByProducer) {
  const bodies = bodyByProducer || {}
  return {
    mode: 'declared',
    items: producers.map((p) => ({
      binding: 'from_' + p,
      producer: p,
      version_ref: 'tmp-exec:1:' + digest8(bodies[p] !== undefined ? bodies[p] : { v: 1 }),
    })),
  }
}

function cli(cmd, input) {
  let stdout
  try {
    stdout = execFileSync(process.execPath, [RECORDS_HOST, cmd, JSON.stringify(input)], { encoding: 'utf8' })
  } catch (e) {
    if (e.status === 1 && e.stdout) return JSON.parse(String(e.stdout))
    throw e
  }
  return JSON.parse(stdout)
}

test('AC-01 只重验真实下游：A2 后 B1/Proof1 stale，独立 C 仍有效', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 1 } }] })
  cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{
      type: 'node_result',
      record_id: nodeId('b'),
      provenance: prov('b'),
      body_value: { v: 1 },
      resolved_inputs: ri(['a']),
    }],
  })
  cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{
      type: 'proof',
      record_id: proofId('proof'),
      provenance: prov('proof'),
      body_value: { verdict: 'ok' },
      resolved_inputs: ri(['b']),
    }],
  })
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('c'), provenance: prov('c'), body_value: { v: 1 } }] })
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 2 } }] })
  const list = cli('list', { records_dir: dir, logical_run_id: RUN })
  const proofRow = list.coverage.find((c) => c.proof.record_id === proofId('proof') && c.target_record_id === nodeId('b'))
  assert.equal(proofRow.status, NOT_COVERING_CURRENT)
  assert.equal(proofRow.stale, true)
  const cProof = list.coverage.filter((c) => c.target_record_id === nodeId('c'))
  assert.equal(cProof.length, 0, 'Proof 不依赖 C')
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('c'), provenance: prov('c'), body_value: { v: 2 } }] })
  const list2 = cli('list', { records_dir: dir, logical_run_id: RUN })
  const afterC = list2.coverage.filter((c) => c.proof.record_id === proofId('proof') && c.target_record_id === nodeId('c'))
  assert.equal(afterC.length, 0, '更新 C 不新增 Proof 失效原因')
})

test('AC-02 历史 attempt 仍读旧版 Revision；新执行读新版', () => {
  const store = createStore()
  const a1 = append(store, { record_id: 'a' })
  append(store, { record_id: 'a', dependencies: [toRef(a1)], based_on: toRef(a1), body: jsonBody({ v: 2 }) })
  const oldAttempt = append(store, {
    record_id: 'attempt:' + RUN + ':old',
    dependencies: [{ record_id: 'a', record_revision: 1 }],
    based_on: toRef(a1),
    provenance_extra: { dependency_source: 'resolved_inputs', dependency_coverage: DEPENDENCY_COVERAGE.COMPLETE },
  })
  const newB = append(store, {
    record_id: 'b',
    dependencies: [{ record_id: 'a', record_revision: 2 }],
    based_on: { record_id: 'a', record_revision: 2 },
    provenance: prov('consumer'),
  })
  assert.equal(getRecord(store, oldAttempt.record_id, oldAttempt.record_revision).dependencies[0].record_revision, 1)
  assert.equal(getRecord(store, newB.record_id, newB.record_revision).dependencies[0].record_revision, 2)
})

test('AC-03 探索局部补充：E2 不影响 S；E1 更新使 S 失效', () => {
  const store = createStore()
  const e1 = append(store, { record_id: 'expert-a' })
  append(store, { record_id: 'expert-b' })
  const synth = append(store, {
    record_id: 'synth',
    dependencies: [toRef(e1)],
    provenance_extra: { dependency_source: 'resolved_inputs', dependency_coverage: DEPENDENCY_COVERAGE.COMPLETE },
  })
  append(store, { record_id: 'expert-a', body: jsonBody({ extra: true }) })
  assert.equal(dependsOnStaleInputs(store, synth), true)
  assert.deepEqual(staleProofsFor(store, 'expert-a').map((r) => r.record_id), [])
  assert.deepEqual(staleProofsFor(store, 'expert-b'), [])
})

test('AC-04 拒绝 missing/cross_run/nonformal/cycle；旧记录标 incomplete', () => {
  const store = createStore()
  assert.throws(
    () => buildRecordDependencies(store, {
      logical_run_id: RUN,
      record_id: proofId('p'),
      type: 'proof',
      resolved_inputs: { mode: 'declared', items: [{ binding: 'x', producer: 'ghost', version_ref: 'tmp-exec:1:00000000' }] },
    }),
    (e) => e.code === DEPENDENCY_ERROR.MISSING_REF,
  )
  append(store, { record_id: 'a' })
  assert.throws(
    () => buildRecordDependencies(store, {
      logical_run_id: RUN,
      record_id: proofId('p'),
      type: 'proof',
      resolved_inputs: {
        mode: 'declared',
        items: [{ binding: 'x', record_ref: { logical_run_id: 'other-run', record_id: 'a', record_revision: 1 }, version_ref: 'record:a@1' }],
      },
    }),
    (e) => e.code === DEPENDENCY_ERROR.CROSS_RUN_REF,
  )
  assert.throws(
    () => buildRecordDependencies(store, {
      logical_run_id: RUN,
      record_id: proofId('p'),
      type: 'proof',
      resolved_inputs: { mode: 'declared', items: [{ binding: 'tmp', version_ref: 'tmp-exec:9:12345678' }] },
    }),
    (e) => e.code === DEPENDENCY_ERROR.NONFORMAL_REF,
  )
  append(store, { record_id: nodeId('a') })
  const bBody = { v: 1 }
  append(store, {
    record_id: nodeId('b'),
    dependencies: [{ record_id: nodeId('a'), record_revision: 1 }],
    based_on: { record_id: nodeId('a'), record_revision: 1 },
    body: jsonBody(bBody),
  })
  if (!store.byId.has(nodeId('b'))) store.byId.set(nodeId('b'), new Map())
  const b1 = store.byId.get(nodeId('b')).get(1)
  store.byId.get(nodeId('b')).set(1, {
    ...b1,
    dependencies: [{ record_id: nodeId('a'), record_revision: 2 }],
  })
  assert.throws(
    () => buildRecordDependencies(store, {
      logical_run_id: RUN,
      record_id: nodeId('a'),
      type: 'node_result',
      resolved_inputs: {
        mode: 'declared',
        items: [{ binding: 'b', producer: 'b', version_ref: 'tmp-exec:1:' + digest8(bBody) }],
      },
    }),
    (e) => e.code === DEPENDENCY_ERROR.DEPENDENCY_CYCLE,
  )
  const dir = recordsDir()
  cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{ type: 'proof', record_id: proofId('legacy'), provenance: prov('legacy'), body_value: { v: 1 } }],
  })
  const get = cli('get', { records_dir: dir, logical_run_id: RUN, record_id: proofId('legacy') })
  assert.equal(get.dependency_coverage, DEPENDENCY_COVERAGE.INCOMPLETE)
})

test('staleReasonChain 给出最短上游原因', () => {
  const store = createStore()
  const a1 = append(store, { record_id: nodeId('a') })
  const b1 = append(store, {
    record_id: nodeId('b'),
    dependencies: [toRef(a1)],
    based_on: toRef(a1),
  })
  const proof = append(store, {
    record_id: proofId('p'),
    kind: KIND.PROOF_DECISION,
    dependencies: [toRef(b1)],
    based_on: toRef(b1),
    body: jsonBody({ ok: true }),
  })
  append(store, { record_id: nodeId('a'), dependencies: [toRef(a1)], based_on: toRef(a1) })
  const chain = staleReasonChain(store, proof)
  assert.equal(chain[chain.length - 1].record_id, nodeId('a'))
  assert.equal(chain[chain.length - 1].record_revision, 1)
  assert.equal(chain[chain.length - 1].current_revision, 2)
})

test('recordsCommit 原子拒绝：错误输入不留半条有效依赖', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 1 } }] })
  const bad = cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{
      type: 'proof',
      record_id: proofId('bad'),
      provenance: prov('bad'),
      body_value: { v: 1 },
      resolved_inputs: { mode: 'declared', items: [{ binding: 'x', producer: 'missing', version_ref: 'tmp-exec:1:00000000' }] },
    }],
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /missing|不存在/)
  const list = cli('list', { records_dir: dir, logical_run_id: RUN })
  assert.equal(list.records.filter((r) => r.record_id === proofId('bad')).length, 0)
})

test('resolveInputDependencies 恢复后依赖集合不扩大', () => {
  const store = createStore()
  append(store, { record_id: nodeId('a') })
  append(store, { record_id: nodeId('b') })
  const inputs = { mode: 'declared', items: [{ binding: 'from_a', producer: 'a', version_ref: 'tmp-exec:1:' + digest8({ v: 1 }) }] }
  const first = resolveInputDependencies(store, RUN, inputs, { requireFormal: true })
  append(store, { record_id: nodeId('c') })
  const second = resolveInputDependencies(store, RUN, inputs, { requireFormal: true })
  assert.deepEqual(first.dependencies, second.dependencies)
  assert.equal(first.dependencies.length, 1)
})

test('recordsGet 重启后仍可查询 pinned Revision 与 coverage', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 1 } }] })
  cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{
      type: 'node_result',
      record_id: nodeId('b'),
      provenance: prov('b'),
      body_value: { v: 1 },
      resolved_inputs: ri(['a']),
    }],
  })
  const get = recordsGet({ records_dir: dir, logical_run_id: RUN, record_id: nodeId('b') })
  assert.equal(get.found, true)
  assert.equal(get.revisions[0].dependencies[0].record_revision, 1)
  assert.equal(get.dependency_coverage, DEPENDENCY_COVERAGE.COMPLETE)
})

test('first_run_default 不解析 producer 依赖', () => {
  const store = createStore()
  const { dependencies, errors } = resolveInputDependencies(store, RUN, {
    mode: 'declared',
    items: [{ binding: 'fb', producer: 'review', source: 'first_run_default', version_ref: 'first-run-default', value: '默认' }],
  })
  assert.equal(errors.length, 0)
  assert.equal(dependencies.length, 0)
})

test('返工链 dev@2 消费 review@1 不判 dependency_cycle', () => {
  const store = createStore()
  const devBody = { impl: 1 }
  const revBody = { verdict: 'REQUEST_CHANGES' }
  const dev1 = append(store, { record_id: nodeId('dev'), body: jsonBody(devBody) })
  append(store, {
    record_id: nodeId('review'),
    dependencies: [toRef(dev1)],
    based_on: toRef(dev1),
    body: jsonBody(revBody),
  })
  const built = buildRecordDependencies(store, {
    logical_run_id: RUN,
    record_id: nodeId('dev'),
    type: 'node_result',
    resolved_inputs: {
      mode: 'declared',
      items: [{ binding: 'from_review', producer: 'review', version_ref: 'tmp-exec:1:' + digest8(revBody) }],
    },
  })
  assert.ok(built.dependencies.some((d) => d.record_id === nodeId('review') && d.record_revision === 1))
})

test('version_ref digest 钉住消费 Revision（A2 已存在仍依赖 A1）', () => {
  const dir = recordsDir()
  const aBody1 = { v: 1 }
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: aBody1 }] })
  const bCommit = cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{
      type: 'node_result',
      record_id: nodeId('b'),
      provenance: prov('b'),
      body_value: { v: 1 },
      resolved_inputs: ri(['a'], { a: aBody1 }),
    }],
  })
  assert.equal(bCommit.ok, true)
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 2 } }] })
  const get = recordsGet({ records_dir: dir, logical_run_id: RUN, record_id: nodeId('b') })
  assert.equal(get.revisions[0].dependencies.find((d) => d.record_id === nodeId('a')).record_revision, 1)
})

test('dependency_coverage 等溯源字段落盘并可读', () => {
  const dir = recordsDir()
  cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{ type: 'proof', record_id: proofId('legacy'), provenance: prov('legacy'), body_value: { v: 1 } }],
  })
  const get = recordsGet({ records_dir: dir, logical_run_id: RUN, record_id: proofId('legacy') })
  assert.equal(get.dependency_coverage, DEPENDENCY_COVERAGE.INCOMPLETE)
  assert.equal(get.revisions[0].provenance.dependency_coverage, DEPENDENCY_COVERAGE.INCOMPLETE)
})

test('普通 node 结果暴露 stale 与原因链', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 1 } }] })
  cli('commit', {
    records_dir: dir,
    logical_run_id: RUN,
    entries: [{
      type: 'node_result',
      record_id: nodeId('b'),
      provenance: prov('b'),
      body_value: { v: 1 },
      resolved_inputs: ri(['a']),
    }],
  })
  cli('commit', { records_dir: dir, logical_run_id: RUN, entries: [{ type: 'node_result', record_id: nodeId('a'), provenance: prov('a'), body_value: { v: 2 } }] })
  const get = recordsGet({ records_dir: dir, logical_run_id: RUN, record_id: nodeId('b') })
  assert.equal(get.stale, true)
  assert.ok(Array.isArray(get.stale_reason_chain) && get.stale_reason_chain.length > 0)
})
