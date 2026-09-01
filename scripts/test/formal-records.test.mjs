// #78 Formal Records 验收：不可覆盖 Revision、依赖覆盖、Fan-out、Decision/Guidance、Portable 映射
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KIND, MEDIA, COVERING, NOT_COVERING_CURRENT, UNRELATED,
  createStore, appendRecord, getRecord, listRevisions, currentRevision, allRecords, toRef,
  recordsFromNodeResult, appendDecisionRecord, appendGuidance, applyRuntimeControl,
  coverageStatus, coversRevision, dependsOnStaleInputs, staleProofsFor,
  mapPortableHandoff, portableRecordId, validateFormalRecord, loadFormalRecordSchema,
} from '../formal-records.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function prov(extra = {}) {
  return {
    logical_run_id: 'run-1',
    node: 'n1',
    attempt: 1,
    snapshot_revision: 'snap-1',
    provider: 'test-provider',
    model: 'test-model',
    produced_by: 'test:dev',
    node_business_outcome: { verdict: 'ok' },
    ...extra,
  }
}

function jsonBody(value) {
  return { media_type: MEDIA.JSON, value }
}

function append(store, rec) {
  return appendRecord(store, { provenance: prov(), body: jsonBody({}), kind: KIND.RESULT, ...rec })
}

test('A1 不可覆盖 Revision：同 id 新写入产生新 revision，旧版内容不变', () => {
  const store = createStore()
  const r1 = append(store, { record_id: 'impl', body: jsonBody({ sha: 'a' }) })
  assert.equal(r1.record_revision, 1)
  const r2 = append(store, { record_id: 'impl', body: jsonBody({ sha: 'b' }) })
  assert.equal(r2.record_revision, 2)
  const old = getRecord(store, 'impl', 1)
  assert.deepEqual(old.body.value, { sha: 'a' })
  assert.equal(getRecord(store, 'impl', 2).body.value.sha, 'b')
  assert.equal(currentRevision(store, 'impl'), 2)
  assert.equal(listRevisions(store, 'impl').length, 2)
  assert.throws(() => { old.body.value.sha = 'mutated' }, TypeError)
  assert.equal(getRecord(store, 'impl', 1).body.value.sha, 'a')
  assert.throws(() => appendRecord(store, {
    record_id: 'impl', record_revision: 3, kind: KIND.RESULT, body: jsonBody({}), provenance: prov(),
  }), /禁止指定 record_revision/)
})

test('A2 Node Result 可产生一条或多条 Record，Outcome 不迁入信封', () => {
  const store = createStore()
  const outcome = { status: 'completed', notes: 'custom-schema-field' }
  const one = recordsFromNodeResult(store, {
    outcome,
    provenance: prov({ node: 'writer' }),
    productions: [{ record_id: 'doc', kind: KIND.RESULT, body: jsonBody({ md: 'hello' }) }],
  })
  assert.equal(one.produced_records.length, 1)
  assert.equal(one.outcome.status, 'completed')
  assert.equal(one.produced_records[0].body.value.md, 'hello')
  assert.deepEqual(one.produced_records[0].provenance.node_business_outcome, outcome)
  assert.equal('status' in one.produced_records[0], false)

  const two = recordsFromNodeResult(store, {
    outcome: { pass: true },
    provenance: prov({ node: 'split' }),
    productions: [
      { record_id: 'art-a', kind: KIND.RESULT, body: jsonBody({ n: 1 }) },
      { record_id: 'art-b', kind: KIND.RESULT, body: jsonBody({ n: 2 }) },
    ],
  })
  assert.equal(two.produced_records.length, 2)
  assert.equal(two.outcome.pass, true)
  assert.deepEqual(two.produced_records[0].provenance.node_business_outcome, { pass: true })
})

test('A3 依赖指向 record_id + revision，禁止悬挂引用', () => {
  const store = createStore()
  const r = append(store, { record_id: 'req', kind: KIND.INPUT_BASELINE })
  const d = append(store, {
    record_id: 'design',
    dependencies: [toRef(r)],
    based_on: toRef(r),
  })
  assert.deepEqual(d.dependencies, [{ record_id: 'req', record_revision: 1 }])
  assert.deepEqual(d.based_on, { record_id: 'req', record_revision: 1 })
  assert.throws(() => append(store, {
    record_id: 'ghost',
    dependencies: [{ record_id: 'req', record_revision: 99 }],
  }), /依赖不存在/)
  assert.throws(() => append(store, {
    record_id: 'bad-based',
    dependencies: [toRef(r)],
    based_on: { record_id: 'impl', record_revision: 1 },
  }), /based_on 必须是 dependencies 中的一项/)
})

test('A4/A5 Proof 覆盖当前目标；上游新 Revision 后旧 Proof 保留且 stale', () => {
  const store = createStore()
  const req = append(store, { record_id: 'R', kind: KIND.INPUT_BASELINE })
  const design = append(store, { record_id: 'D', dependencies: [toRef(req)], based_on: toRef(req) })
  const impl = append(store, { record_id: 'I', dependencies: [toRef(design)], based_on: toRef(design) })
  const review = append(store, {
    record_id: 'RV', kind: KIND.PROOF_DECISION,
    dependencies: [toRef(impl)], based_on: toRef(impl),
    body: jsonBody({ verdict: 'approve' }),
  })
  const testP = append(store, {
    record_id: 'T', kind: KIND.PROOF_DECISION,
    dependencies: [toRef(impl)], based_on: toRef(impl),
    body: jsonBody({ verdict: 'pass' }),
  })
  assert.equal(coverageStatus(store, review, 'I').status, COVERING)
  assert.equal(coversRevision(store, testP, toRef(impl)), true)

  const impl2 = append(store, { record_id: 'I', dependencies: [toRef(design)], based_on: toRef(design) })
  assert.equal(impl2.record_revision, 2)
  assert.equal(getRecord(store, 'RV', 1).body.value.verdict, 'approve')
  assert.equal(coverageStatus(store, review, 'I').status, NOT_COVERING_CURRENT)
  assert.equal(coverageStatus(store, review, 'I').stale, true)
  assert.equal(coversRevision(store, review, toRef(impl)), true)
  assert.equal(coversRevision(store, review, toRef(impl2)), false)
  const stale = staleProofsFor(store, 'I').map(r => r.record_id).sort()
  assert.deepEqual(stale, ['RV', 'T'])
})

test('A6 Fan-out 多依赖：只让依赖变化子集的下游 stale，兄弟不机械失效', () => {
  const store = createStore()
  const a1 = append(store, { record_id: 'expert-a' })
  const b1 = append(store, { record_id: 'expert-b' })
  const synth = append(store, {
    record_id: 'synth',
    dependencies: [toRef(a1), toRef(b1)],
  })
  const evalP = append(store, {
    record_id: 'eval', kind: KIND.PROOF_DECISION,
    dependencies: [toRef(a1), toRef(b1)],
  })
  assert.equal(dependsOnStaleInputs(store, synth), false)
  assert.equal(coverageStatus(store, evalP, 'expert-a').status, COVERING)
  assert.equal(coverageStatus(store, evalP, 'expert-b').status, COVERING)

  append(store, { record_id: 'expert-a', body: jsonBody({ extra: true }) })
  assert.equal(dependsOnStaleInputs(store, synth), true)
  assert.equal(coverageStatus(store, evalP, 'expert-a').status, NOT_COVERING_CURRENT)
  assert.equal(coverageStatus(store, evalP, 'expert-b').status, COVERING)
  assert.equal(getRecord(store, 'expert-b', 1).record_revision, 1)
  assert.equal(coverageStatus(store, evalP, 'expert-b').stale, false)
  assert.deepEqual(staleProofsFor(store, 'expert-a').map(r => r.record_id), ['eval'])
  assert.deepEqual(staleProofsFor(store, 'expert-b'), [])
  // 传递闭包不得把未列入 dependencies 的记录算作覆盖
  assert.equal(coverageStatus(store, evalP, 'synth').status, UNRELATED)
})

test('A7 Decision Record 不可覆盖；后续流转不得改写', () => {
  const store = createStore()
  const baseline = append(store, { record_id: 'bl', kind: KIND.INPUT_BASELINE })
  const dec = appendDecisionRecord(store, {
    record_id: 'decision-1',
    question: '选哪条路径',
    options: [{ name: 'A', tradeoffs: '快' }, { name: 'B', tradeoffs: '稳' }],
    chosen: 'A',
    rationale: '先交货',
    decided_by: 'crystepj-max',
    decided_at: '2026-09-01T05:00:00Z',
    dependencies: [toRef(baseline)],
    based_on: toRef(baseline),
    provenance: prov({ node: 'human-decision' }),
  })
  assert.equal(dec.kind, KIND.PROOF_DECISION)
  assert.equal(dec.body.value.decision.chosen, 'A')
  const snapshot = structuredClone(dec)
  applyRuntimeControl(store, { type: 'WAITING_HUMAN', reason: 'MAX_ROUNDS_REACHED' })
  appendDecisionRecord(store, {
    record_id: 'decision-1',
    question: '选哪条路径',
    options: [{ name: 'A', tradeoffs: '快' }, { name: 'B', tradeoffs: '稳' }],
    chosen: 'B',
    rationale: '改选',
    decided_by: 'crystepj-max',
    decided_at: '2026-09-01T06:00:00Z',
    dependencies: [toRef(baseline)],
    based_on: toRef(baseline),
    provenance: prov({ node: 'human-decision', attempt: 2 }),
  })
  assert.deepEqual(getRecord(store, 'decision-1', 1).body.value.decision, snapshot.body.value.decision)
  assert.equal(getRecord(store, 'decision-1', 2).body.value.decision.chosen, 'B')
})

test('A8 Guidance 与 Baseline：普通 Guidance 不改版本；改范围必须关联新 Baseline', () => {
  const store = createStore()
  const bl1 = append(store, { record_id: 'baseline', kind: KIND.INPUT_BASELINE, body: jsonBody({ goal: 'v1' }) })
  const keep = appendGuidance(store, {
    record_id: 'guide-note',
    text: '先按原范围做',
    changes_baseline: false,
    baseline: toRef(bl1),
    provenance: prov({ node: 'guidance' }),
  })
  assert.equal(keep.baseline.record_revision, 1)
  assert.equal(currentRevision(store, 'baseline'), 1)
  assert.deepEqual(keep.guidance.based_on, toRef(bl1))

  assert.throws(() => appendGuidance(store, {
    record_id: 'guide-bad',
    text: '扩大范围',
    changes_baseline: true,
    baseline: toRef(bl1),
    provenance: prov({ node: 'guidance' }),
  }), /必须关联新的 Baseline Revision/)

  const changed = appendGuidance(store, {
    record_id: 'guide-scope',
    text: '扩大范围',
    changes_baseline: true,
    baseline: toRef(bl1),
    new_baseline: { body: jsonBody({ goal: 'v2' }) },
    provenance: prov({ node: 'guidance' }),
  })
  assert.equal(changed.baseline.record_id, 'baseline')
  assert.equal(changed.baseline.record_revision, 2)
  assert.equal(changed.baseline.body.value.goal, 'v2')
  assert.deepEqual(changed.baseline.provenance.related_guidance, toRef(changed.guidance))
  assert.ok(changed.baseline.dependencies.some(d => d.record_id === 'guide-scope'))
  assert.ok(changed.baseline.dependencies.some(d => d.record_id === 'baseline' && d.record_revision === 1))
})

test('A9 每条 Record 可追溯 snapshot / provider+model / node+attempt / Outcome', () => {
  const store = createStore()
  const rec = appendRecord(store, {
    record_id: 'traced',
    kind: KIND.RESULT,
    body: jsonBody({ ok: true }),
    provenance: prov({
      logical_run_id: 'lr-9',
      node: 'implement',
      attempt: 3,
      snapshot_revision: 'snap-xyz',
      provider: 'openai',
      model: 'gpt-test',
      node_business_outcome: { outcome: 'handoff_ready' },
    }),
  })
  const p = rec.provenance
  assert.equal(p.snapshot_revision, 'snap-xyz')
  assert.equal(p.provider, 'openai')
  assert.equal(p.model, 'gpt-test')
  assert.equal(p.node, 'implement')
  assert.equal(p.attempt, 3)
  assert.deepEqual(p.node_business_outcome, { outcome: 'handoff_ready' })
  assert.equal(p.logical_run_id, 'lr-9')
  assert.equal(validateFormalRecord(rec).length, 0)
})

test('A10 Runtime 控制状态不得回写 Outcome 或 Record', () => {
  const store = createStore()
  const rec = append(store, {
    record_id: 'eval-out',
    kind: KIND.PROOF_DECISION,
    body: jsonBody({ outcome: 'NEEDS_RESEARCH' }),
    provenance: prov({ node_business_outcome: 'NEEDS_RESEARCH' }),
  })
  const before = JSON.stringify(allRecords(store))
  const outcomeBefore = rec.provenance.node_business_outcome
  applyRuntimeControl(store, { type: 'WAITING_HUMAN', reason: 'MAX_ROUNDS_REACHED' })
  applyRuntimeControl(store, { type: 'RUNNING' })
  assert.equal(JSON.stringify(allRecords(store)), before)
  assert.equal(getRecord(store, 'eval-out', 1).provenance.node_business_outcome, outcomeBefore)
  assert.equal(getRecord(store, 'eval-out', 1).body.value.outcome, 'NEEDS_RESEARCH')
  assert.equal(store.control_log.length, 2)
  assert.equal(store.control_log[0].reason, 'MAX_ROUNDS_REACHED')
})

test('A11 覆盖判定只读结构化依赖，不解析 Markdown/自由文本', () => {
  const store = createStore()
  const impl1 = append(store, { record_id: 'code', body: jsonBody({ n: 1 }) })
  append(store, { record_id: 'code', body: jsonBody({ n: 2 }) })
  const proof = append(store, {
    record_id: 'review',
    kind: KIND.PROOF_DECISION,
    dependencies: [toRef(impl1)],
    based_on: toRef(impl1),
    body: {
      media_type: MEDIA.MARKDOWN,
      value: '本审核覆盖 code@2（最新实现）。depends on record_id=code revision=2',
    },
  })
  assert.equal(coverageStatus(store, proof, 'code').status, NOT_COVERING_CURRENT)
  assert.equal(coversRevision(store, proof, { record_id: 'code', record_revision: 2 }), false)
  assert.equal(coversRevision(store, proof, toRef(impl1)), true)
})

test('A12 Markdown / Text / JSON 载体可保存与读取', () => {
  const store = createStore()
  const md = appendRecord(store, {
    record_id: 'md', kind: KIND.RESULT,
    body: { media_type: MEDIA.MARKDOWN, value: '# 标题\n\n正文' },
    provenance: prov(),
  })
  const txt = appendRecord(store, {
    record_id: 'txt', kind: KIND.RESULT,
    body: { media_type: MEDIA.TEXT, value: 'plain text' },
    provenance: prov(),
  })
  const js = appendRecord(store, {
    record_id: 'js', kind: KIND.RESULT,
    body: { media_type: MEDIA.JSON, value: { a: 1, nested: { b: true } } },
    provenance: prov(),
  })
  assert.equal(getRecord(store, 'md', 1).body.media_type, MEDIA.MARKDOWN)
  assert.equal(getRecord(store, 'md', 1).body.value, '# 标题\n\n正文')
  assert.equal(getRecord(store, 'txt', 1).body.value, 'plain text')
  assert.deepEqual(getRecord(store, 'js', 1).body.value, { a: 1, nested: { b: true } })
  for (const r of [md, txt, js]) assert.equal(validateFormalRecord(r).length, 0)
})

test('A13 Portable 七类可映射；刷新产生新 Revision；历史标识可追溯', () => {
  const store = createStore()
  const types = [
    'requirements_baseline', 'design_package', 'dev_handoff',
    'review_proof', 'test_proof', 'acceptance_package', 'closeout_summary',
  ]
  const payloads = {
    requirements_baseline: { outcome: 'baseline_ready', status: 'draft', goal: 'g' },
    design_package: { outcome: 'package_ready' },
    dev_handoff: { outcome: 'handoff_ready' },
    review_proof: { verdict: 'approve' },
    test_proof: { verdict: 'pass' },
    acceptance_package: { decision: 'accept', status: 'decided' },
    closeout_summary: { outcome: 'delivered' },
  }
  const mapped = {}
  for (const type of types) {
    mapped[type] = mapPortableHandoff(store, {
      record_type: type,
      record_version: 'v0.1.8',
      created_at: '2026-09-01T05:00:00Z',
      produced_by: 'cwf:example',
      run: {
        run_id: 'cwf-78-map',
        stage: type === 'acceptance_package' ? 'human_acceptance' : type.replace(/_.*/, ''),
        attempt: 1,
        current_head: 'abc',
      },
      payload: payloads[type],
    })
    assert.equal(mapped[type].record_id, portableRecordId('cwf-78-map', type))
    assert.equal(mapped[type].record_revision, 1)
    assert.equal(mapped[type].provenance.portable.record_type, type)
    assert.equal(mapped[type].provenance.portable.run_id, 'cwf-78-map')
    assert.equal(validateFormalRecord(mapped[type]).length, 0)
    if (type !== 'requirements_baseline') {
      assert.ok(mapped[type].dependencies.length >= 1, `${type} 应有前驱`)
    }
  }
  assert.equal(mapped.review_proof.kind, KIND.PROOF_DECISION)
  assert.ok(mapped.review_proof.dependencies.some(d => d.record_id === portableRecordId('cwf-78-map', 'dev_handoff')))
  assert.equal(coverageStatus(store, mapped.review_proof, portableRecordId('cwf-78-map', 'dev_handoff')).status, COVERING)

  const confirmed = mapPortableHandoff(store, {
    record_type: 'requirements_baseline',
    record_version: 'v0.1.8',
    created_at: '2026-09-01T05:10:00Z',
    produced_by: 'cwf:example',
    run: { run_id: 'cwf-78-map', stage: 'requirements', attempt: 1, current_head: 'abc' },
    payload: { outcome: 'baseline_ready', status: 'confirmed', goal: 'g' },
  })
  assert.equal(confirmed.record_revision, 2)
  assert.equal(getRecord(store, portableRecordId('cwf-78-map', 'requirements_baseline'), 1).body.value.status, 'draft')
  assert.equal(confirmed.body.value.status, 'confirmed')
  assert.ok(confirmed.dependencies.some(d => d.record_id === confirmed.record_id && d.record_revision === 1))
  assert.equal(
    coverageStatus(store, mapped.design_package, portableRecordId('cwf-78-map', 'requirements_baseline')).status,
    NOT_COVERING_CURRENT,
  )
})

test('schema 可加载；夹具拒绝未知 kind 与额外信封字段', () => {
  const schema = loadFormalRecordSchema()
  assert.equal(schema.title.includes('Formal Record'), true)
  const store = createStore()
  const rec = appendRecord(store, {
    record_id: 'ok', kind: KIND.RESULT, body: jsonBody({}), provenance: prov(),
  })
  const extra = { ...JSON.parse(JSON.stringify(rec)), extra_field: true }
  assert.ok(validateFormalRecord(extra).some(e => e.includes('额外属性')))
  assert.throws(() => appendRecord(store, {
    record_id: 'bad-kind', kind: 'review', body: jsonBody({}), provenance: prov(),
  }), /非法 kind/)
})

test('仓库内 Portable 示例外壳可映射（不要求本测试解析 payload 文本）', () => {
  const example = JSON.parse(readFileSync(
    join(repo, 'docs/design/construction-workflow/examples/01-requirements-baseline.json'),
    'utf-8',
  ))
  const store = createStore()
  const rec = mapPortableHandoff(store, example)
  assert.equal(rec.kind, KIND.INPUT_BASELINE)
  assert.equal(rec.provenance.portable.record_type, 'requirements_baseline')
  assert.equal(rec.body.value.status, 'confirmed')
})
