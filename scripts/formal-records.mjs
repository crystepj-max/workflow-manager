// Formal Record / Revision / Provenance 内核（#78）
// 追加式 Store：无 update；覆盖判定只读 dependencies。
// 用法：import { createStore, appendRecord, coverageStatus, mapPortableHandoff } from './formal-records.mjs'

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecord } from './cwf-validate.mjs'

const require = createRequire(import.meta.url)
const formalArtifacts = require('./formal-artifacts.cjs')

export const KIND = {
  INPUT_BASELINE: 'input_baseline',
  RESULT: 'result',
  PROOF_DECISION: 'proof_decision',
}

export const MEDIA = {
  JSON: 'application/json',
  MARKDOWN: 'text/markdown',
  TEXT: 'text/plain',
  HTML: 'text/html',
  CANVAS: 'application/vnd.workflow.canvas+json',
  FLOWCHART: 'application/vnd.workflow.flowchart+json',
  DIAGRAM: 'application/vnd.workflow.diagram+json',
}

export const FILE_KINDS = formalArtifacts.FILE_KINDS
export const blueprintKindToMediaType = formalArtifacts.blueprintKindToMediaType
export const parseArtifactBody = formalArtifacts.parseArtifactBody
export const artifactRecordId = formalArtifacts.artifactRecordId
export const artifactFormatHint = formalArtifacts.artifactFormatHint

export const COVERING = 'covering'
export const NOT_COVERING_CURRENT = 'not_covering_current'
export const UNRELATED = 'unrelated'

export const PORTABLE_KIND = {
  requirements_baseline: KIND.INPUT_BASELINE,
  design_package: KIND.RESULT,
  dev_handoff: KIND.RESULT,
  review_proof: KIND.PROOF_DECISION,
  test_proof: KIND.PROOF_DECISION,
  acceptance_package: KIND.PROOF_DECISION,
  closeout_summary: KIND.RESULT,
}

export const PORTABLE_PREDECESSORS = {
  requirements_baseline: [],
  design_package: ['requirements_baseline'],
  dev_handoff: ['design_package'],
  review_proof: ['dev_handoff'],
  test_proof: ['dev_handoff'],
  acceptance_package: [
    'requirements_baseline',
    'design_package',
    'dev_handoff',
    'review_proof',
    'test_proof',
  ],
  closeout_summary: ['acceptance_package'],
}

const KINDS = new Set(Object.values(KIND))
const MEDIAS = new Set(Object.values(MEDIA))
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'design', 'formal-records', 'schema.json')

let cachedSchema

export function loadFormalRecordSchema() {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'))
  }
  return cachedSchema
}

export function validateFormalRecord(record) {
  return validateRecord(loadFormalRecordSchema(), record)
}

export function createStore() {
  return { byId: new Map(), order: [], control_log: [] }
}

export function toRef(record) {
  return { record_id: record.record_id, record_revision: record.record_revision }
}

export function currentRevision(store, recordId) {
  const revs = store.byId.get(recordId)
  if (!revs || revs.size === 0) return undefined
  return Math.max(...revs.keys())
}

export function getRecord(store, recordId, revision) {
  const revs = store.byId.get(recordId)
  if (!revs) return undefined
  const rev = revision === undefined ? currentRevision(store, recordId) : revision
  return revs.get(rev)
}

export function listRevisions(store, recordId) {
  const revs = store.byId.get(recordId)
  if (!revs) return []
  return [...revs.keys()].sort((a, b) => a - b).map(r => revs.get(r))
}

export function allRecords(store) {
  return store.order.map(ref => getRecord(store, ref.record_id, ref.record_revision))
}

export function appendRecord(store, input) {
  const frozen = buildRecord(store, input)
  return commitRecord(store, frozen)
}

function forkStore(store) {
  const byId = new Map()
  for (const [id, revs] of store.byId) byId.set(id, new Map(revs))
  return { byId, order: store.order.slice(), control_log: store.control_log }
}

function buildRecord(store, input) {
  if (!input || typeof input !== 'object') throw new Error('appendRecord 需要记录对象')
  if (input.record_revision !== undefined) {
    throw new Error('禁止指定 record_revision：由 Store 追加分配')
  }
  const recordId = requireText(input.record_id, 'record_id')
  if (!KINDS.has(input.kind)) throw new Error(`非法 kind: ${input.kind}`)
  const body = normalizeBody(input.body)
  const dependencies = normalizeDeps(input.dependencies)
  for (const dep of dependencies) {
    if (!getRecord(store, dep.record_id, dep.record_revision)) {
      throw new Error(`依赖不存在: ${dep.record_id}@${dep.record_revision}`)
    }
  }
  let basedOn
  if (input.based_on !== undefined && input.based_on !== null) {
    basedOn = normalizeRef(input.based_on, 'based_on')
    if (!dependencies.some(d => refsEqual(d, basedOn))) {
      throw new Error('based_on 必须是 dependencies 中的一项')
    }
  }
  const provenance = normalizeProvenance(input.provenance)
  const nextRev = (currentRevision(store, recordId) || 0) + 1
  const record = {
    record_id: recordId,
    record_revision: nextRev,
    kind: input.kind,
    body,
    dependencies,
    provenance,
    created_at: input.created_at || new Date().toISOString(),
  }
  if (basedOn) record.based_on = basedOn

  const errors = validateFormalRecord(record)
  if (errors.length > 0) {
    throw new Error(`Formal Record 校验失败：${errors.join('；')}`)
  }
  return deepFreeze(structuredClone(record))
}

function commitRecord(store, frozen) {
  const recordId = frozen.record_id
  if (!store.byId.has(recordId)) store.byId.set(recordId, new Map())
  store.byId.get(recordId).set(frozen.record_revision, frozen)
  store.order.push(toRef(frozen))
  return frozen
}

export function recordsFromNodeResult(store, { outcome, productions, provenance }) {
  if (!Array.isArray(productions)) throw new Error('productions 必须是数组')
  const produced_records = productions.map(p => appendRecord(store, {
    ...p,
    provenance: {
      ...provenance,
      node_business_outcome: structuredClone(outcome),
    },
  }))
  return { outcome, produced_records }
}

export function ingestArtifactDeclarations(store, { runId, nodeId, artifacts, provenance, outcome }) {
  if (!runId || !nodeId) throw new Error('ingestArtifactDeclarations 需要 runId 与 nodeId')
  if (!Array.isArray(artifacts)) throw new Error('artifacts 必须是数组')
  const productions = artifacts.map((art) => {
    if (!art || typeof art.path !== 'string' || !art.path.trim()) {
      throw new Error('artifact.path 必填')
    }
    if (!FILE_KINDS.includes(art.kind)) throw new Error(`非法 artifact kind: ${art.kind}`)
    const recordId = artifactRecordId(runId, nodeId, art.path)
    const prev = currentRevision(store, recordId)
    const dependencies = []
    if (prev !== undefined) dependencies.push({ record_id: recordId, record_revision: prev })
    const input = {
      record_id: recordId,
      kind: KIND.RESULT,
      body: parseArtifactBody(art.kind, art.content),
      dependencies,
    }
    if (prev !== undefined) input.based_on = { record_id: recordId, record_revision: prev }
    return input
  })
  return recordsFromNodeResult(store, { outcome, productions, provenance })
}

export function appendDecisionRecord(store, input) {
  const d = input.decision || input
  for (const k of ['question', 'options', 'chosen', 'rationale', 'decided_by', 'decided_at']) {
    if (d[k] === undefined || d[k] === null || d[k] === '') {
      throw new Error(`Decision Record 缺少 ${k}`)
    }
  }
  if (!Array.isArray(d.options) || d.options.length < 1) {
    throw new Error('Decision Record options 至少一项')
  }
  return appendRecord(store, {
    record_id: requireText(input.record_id, 'record_id'),
    kind: KIND.PROOF_DECISION,
    body: {
      media_type: MEDIA.JSON,
      value: {
        decision: {
          question: d.question,
          options: d.options,
          chosen: d.chosen,
          rationale: d.rationale,
          decided_by: d.decided_by,
          decided_at: d.decided_at,
        },
      },
    },
    dependencies: input.dependencies,
    based_on: input.based_on,
    provenance: input.provenance,
  })
}

export function appendGuidance(store, input) {
  const baseline = normalizeRef(input.baseline, 'baseline')
  if (!getRecord(store, baseline.record_id, baseline.record_revision)) {
    throw new Error(`Guidance 所依赖的 Baseline 不存在: ${baseline.record_id}@${baseline.record_revision}`)
  }
  const changes = input.changes_baseline === true
  if (changes && (!input.new_baseline || !input.new_baseline.body)) {
    throw new Error('changes_baseline 必须关联新的 Baseline Revision（提供 new_baseline.body）')
  }
  const guidanceBuilt = buildRecord(store, {
    record_id: requireText(input.record_id, 'record_id'),
    kind: KIND.INPUT_BASELINE,
    body: {
      media_type: MEDIA.JSON,
      value: { text: input.text || '', changes_baseline: changes },
    },
    dependencies: [baseline],
    based_on: baseline,
    provenance: input.provenance,
  })
  if (!changes) {
    const guidance = commitRecord(store, guidanceBuilt)
    return { guidance, baseline: getRecord(store, baseline.record_id, baseline.record_revision) }
  }
  const nextId = input.new_baseline.record_id || baseline.record_id
  const tmp = forkStore(store)
  commitRecord(tmp, guidanceBuilt)
  const nextBuilt = buildRecord(tmp, {
    record_id: nextId,
    kind: KIND.INPUT_BASELINE,
    body: input.new_baseline.body,
    dependencies: [baseline, toRef(guidanceBuilt)],
    based_on: baseline,
    provenance: {
      ...input.provenance,
      related_guidance: toRef(guidanceBuilt),
    },
  })
  const guidance = commitRecord(store, guidanceBuilt)
  const next = commitRecord(store, nextBuilt)
  return { guidance, baseline: next }
}

export function applyRuntimeControl(store, event) {
  if (!event || typeof event !== 'object') throw new Error('控制事件必须是对象')
  const type = requireText(event.type, 'type')
  const entry = deepFreeze(structuredClone({
    at: event.at || new Date().toISOString(),
    type,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  }))
  store.control_log.push(entry)
  return entry
}

export function coverageStatus(store, proofRef, targetRecordId) {
  const proof = resolve(store, proofRef, 'proof')
  const current = currentRevision(store, targetRecordId)
  const target = current === undefined ? undefined : { record_id: targetRecordId, record_revision: current }
  const hits = (proof.dependencies || []).filter(d => d.record_id === targetRecordId)
  if (hits.length === 0) {
    return { status: UNRELATED, stale: false, proof, target }
  }
  if (current !== undefined && hits.some(d => d.record_revision === current)) {
    return { status: COVERING, stale: false, proof, target }
  }
  return { status: NOT_COVERING_CURRENT, stale: true, proof, target }
}

export function coversRevision(store, proofRef, targetRef) {
  const proof = resolve(store, proofRef, 'proof')
  const target = normalizeRef(targetRef, 'target')
  return proof.dependencies.some(d => refsEqual(d, target))
}

export function dependsOnStaleInputs(store, recordRef) {
  const rec = resolve(store, recordRef, 'record')
  return rec.dependencies.some(d => currentRevision(store, d.record_id) !== d.record_revision)
}

export function staleProofsFor(store, recordId) {
  return allRecords(store).filter(r =>
    r.kind === KIND.PROOF_DECISION
    && coverageStatus(store, r, recordId).status === NOT_COVERING_CURRENT,
  )
}

export function portableRecordId(runId, recordType) {
  return `portable:${runId}:${recordType}`
}

export function mapPortableHandoff(store, portable, extraProvenance = {}) {
  const type = portable && portable.record_type
  if (!PORTABLE_KIND[type]) throw new Error(`未知 portable record_type: ${type}`)
  const runId = portable.run && portable.run.run_id
  if (!runId) throw new Error('portable 缺少 run.run_id')
  const selfId = portableRecordId(runId, type)
  const dependencies = []
  for (const pred of PORTABLE_PREDECESSORS[type]) {
    const id = portableRecordId(runId, pred)
    const rev = currentRevision(store, id)
    if (rev !== undefined) dependencies.push({ record_id: id, record_revision: rev })
  }
  const prev = currentRevision(store, selfId)
  if (prev !== undefined) {
    const selfRef = { record_id: selfId, record_revision: prev }
    if (!dependencies.some(d => refsEqual(d, selfRef))) dependencies.push(selfRef)
  }
  const basedOn = prev !== undefined
    ? { record_id: selfId, record_revision: prev }
    : (dependencies[0] || undefined)
  const createdAt = portable.created_at && /^\d{4}-\d{2}-\d{2}T/.test(portable.created_at)
    ? portable.created_at
    : new Date().toISOString()
  const outcome = portable.payload && (
    portable.payload.outcome
    ?? portable.payload.verdict
    ?? portable.payload.decision
    ?? portable.payload.status
    ?? null
  )
  return appendRecord(store, {
    record_id: selfId,
    kind: PORTABLE_KIND[type],
    body: { media_type: MEDIA.JSON, value: portable.payload === undefined ? null : portable.payload },
    dependencies,
    based_on: basedOn,
    created_at: createdAt,
    provenance: {
      logical_run_id: extraProvenance.logical_run_id || runId,
      node: extraProvenance.node || portable.run.stage || type,
      attempt: extraProvenance.attempt || portable.run.attempt || 1,
      snapshot_revision: extraProvenance.snapshot_revision
        || portable.run.current_head
        || portable.run.base_commit
        || 'unspecified',
      provider: extraProvenance.provider || 'unknown',
      model: extraProvenance.model || 'unknown',
      produced_by: portable.produced_by || extraProvenance.produced_by || 'unknown',
      node_business_outcome: outcome,
      portable: {
        record_type: type,
        record_version: portable.record_version || 'unknown',
        run_id: runId,
        attempt: portable.run.attempt || 1,
        created_at: createdAt,
      },
    },
  })
}

function resolve(store, refOrRecord, label) {
  if (refOrRecord && refOrRecord.dependencies && refOrRecord.record_id) return refOrRecord
  const ref = normalizeRef(refOrRecord, label)
  const rec = getRecord(store, ref.record_id, ref.record_revision)
  if (!rec) throw new Error(`${label} 不存在: ${ref.record_id}@${ref.record_revision}`)
  return rec
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object') throw new Error('body 必须是对象')
  if (!MEDIAS.has(body.media_type)) throw new Error(`非法 media_type: ${body.media_type}`)
  return { media_type: body.media_type, value: structuredClone(body.value) }
}

function normalizeDeps(deps) {
  if (deps === undefined || deps === null) return []
  if (!Array.isArray(deps)) throw new Error('dependencies 必须是数组')
  return deps.map((d, i) => normalizeRef(d, `dependencies[${i}]`))
}

function normalizeRef(ref, label) {
  if (!ref || typeof ref !== 'object') throw new Error(`${label} 必须是 { record_id, record_revision }`)
  const record_id = requireText(ref.record_id, `${label}.record_id`)
  const record_revision = ref.record_revision
  if (!Number.isInteger(record_revision) || record_revision < 1) {
    throw new Error(`${label}.record_revision 必须是正整数`)
  }
  return { record_id, record_revision }
}

function normalizeProvenance(p) {
  if (!p || typeof p !== 'object') throw new Error('provenance 必填')
  const out = {
    logical_run_id: requireText(p.logical_run_id, 'provenance.logical_run_id'),
    node: requireText(p.node, 'provenance.node'),
    attempt: p.attempt,
    snapshot_revision: requireText(p.snapshot_revision, 'provenance.snapshot_revision'),
    provider: requireText(p.provider, 'provenance.provider'),
    model: requireText(p.model, 'provenance.model'),
    produced_by: requireText(p.produced_by, 'provenance.produced_by'),
    node_business_outcome: structuredClone(p.node_business_outcome),
  }
  if (!Number.isInteger(out.attempt) || out.attempt < 1) {
    throw new Error('provenance.attempt 必须是正整数')
  }
  if (p.lifecycle_event) out.lifecycle_event = requireText(p.lifecycle_event, 'provenance.lifecycle_event')
  if (p.related_decision) out.related_decision = normalizeRef(p.related_decision, 'related_decision')
  if (p.related_guidance) out.related_guidance = normalizeRef(p.related_guidance, 'related_guidance')
  if (p.portable) {
    out.portable = {
      record_type: requireText(p.portable.record_type, 'portable.record_type'),
      record_version: requireText(p.portable.record_version, 'portable.record_version'),
      run_id: requireText(p.portable.run_id, 'portable.run_id'),
      attempt: p.portable.attempt,
      created_at: requireText(p.portable.created_at, 'portable.created_at'),
    }
    if (!Number.isInteger(out.portable.attempt) || out.portable.attempt < 1) {
      throw new Error('portable.attempt 必须是正整数')
    }
  }
  return out
}

function requireText(v, label) {
  if (typeof v !== 'string' || !/\S/.test(v)) throw new Error(`${label} 必须是非空字符串`)
  return v
}

function refsEqual(a, b) {
  return a.record_id === b.record_id && a.record_revision === b.record_revision
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else {
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}
