// LOC-034 精确依赖：从 resolved_inputs / 显式引用组装 dependencies，拒绝不可靠引用，
// 标注 dependency_coverage，计算 stale 原因链。覆盖判定仍委托 formal-records.mjs。

import { currentRevision, getRecord, listRevisions, coverageStatus, COVERING, NOT_COVERING_CURRENT } from './formal-records.mjs'

export const DEPENDENCY_COVERAGE = {
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
}

export const DEPENDENCY_ERROR = {
  MISSING_REF: 'missing_ref',
  CROSS_RUN_REF: 'cross_run_ref',
  NONFORMAL_REF: 'nonformal_ref',
  DEPENDENCY_CYCLE: 'dependency_cycle',
}

const TMP_EXEC = /^tmp-exec:\d+:[0-9a-f]{8}$/
const FORMAL_RECORD_ID = /^(node|artifact|proof|portable|attempt):/

export function nodeRecordId(logicalRunId, nodeId) {
  return 'node:' + String(logicalRunId) + ':' + String(nodeId)
}

function normalizeRef(ref, label) {
  if (!ref || typeof ref !== 'object') throw new Error(label + ' 必须是 { logical_run_id?, record_id, record_revision }')
  const record_id = typeof ref.record_id === 'string' ? ref.record_id : ''
  const record_revision = ref.record_revision
  if (!record_id || !Number.isInteger(record_revision) || record_revision < 1) {
    throw new Error(label + ' 的 record_id / record_revision 非法')
  }
  return {
    logical_run_id: ref.logical_run_id === undefined || ref.logical_run_id === null ? null : String(ref.logical_run_id),
    record_id,
    record_revision,
  }
}

function depKey(ref) {
  return ref.record_id + '@' + ref.record_revision
}

function refsEqual(a, b) {
  return a.record_id === b.record_id && a.record_revision === b.record_revision
}

function isFormalRecordId(recordId) {
  return FORMAL_RECORD_ID.test(String(recordId || ''))
}

function isTmpExecRef(versionRef) {
  return TMP_EXEC.test(String(versionRef || ''))
}

function pushUnique(deps, ref) {
  if (!deps.some((d) => refsEqual(d, ref))) deps.push(ref)
}

function validateSameRun(logicalRunId, ref, path) {
  if (ref.logical_run_id !== null && ref.logical_run_id !== String(logicalRunId)) {
    return { code: DEPENDENCY_ERROR.CROSS_RUN_REF, path, message: '跨 Run 引用不受支持：' + ref.record_id + '@' + ref.record_revision }
  }
  return null
}

function validateExists(store, ref, path) {
  if (!getRecord(store, ref.record_id, ref.record_revision)) {
    return { code: DEPENDENCY_ERROR.MISSING_REF, path, message: '依赖不存在：' + ref.record_id + '@' + ref.record_revision }
  }
  return null
}

export function resolveFormalRef(store, logicalRunId, rawRef, path) {
  const ref = normalizeRef(rawRef, path)
  const runErr = validateSameRun(logicalRunId, ref, path)
  if (runErr) return { error: runErr }
  const existsErr = validateExists(store, ref, path)
  if (existsErr) return { error: existsErr }
  return { ref: { record_id: ref.record_id, record_revision: ref.record_revision } }
}

export function digest8(v) {
  const s = typeof v === 'string' ? v : (v === undefined ? 'undefined' : JSON.stringify(v))
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return ('00000000' + h.toString(16)).slice(-8)
}

function revisionForProducerVersionRef(store, logicalRunId, producer, versionRef) {
  const record_id = nodeRecordId(logicalRunId, producer)
  const parts = String(versionRef || '').split(':')
  if (parts[0] !== 'tmp-exec' || parts.length < 3) return undefined
  const expectedDigest = parts[2]
  for (const rec of listRevisions(store, record_id)) {
    if (!rec || !rec.body) continue
    if (digest8(rec.body.value) === expectedDigest) return rec.record_revision
  }
  return undefined
}

export function resolveProducerRef(store, logicalRunId, producer, path, versionRef) {
  const record_id = nodeRecordId(logicalRunId, producer)
  const pinned = versionRef ? revisionForProducerVersionRef(store, logicalRunId, producer, versionRef) : undefined
  const record_revision = pinned !== undefined ? pinned : currentRevision(store, record_id)
  if (record_revision === undefined) {
    return { error: { code: DEPENDENCY_ERROR.MISSING_REF, path, message: '生产节点 ' + producer + ' 尚无正式 Record（' + record_id + '）' } }
  }
  if (versionRef && isTmpExecRef(versionRef) && pinned === undefined) {
    return { error: { code: DEPENDENCY_ERROR.MISSING_REF, path, message: '无法钉住版本引用 ' + versionRef + '（生产节点 ' + producer + '）' } }
  }
  return { ref: { record_id, record_revision } }
}

function resolveInputItem(store, logicalRunId, item, index, { requireFormal }) {
  const path = 'resolved_inputs.items[' + index + ']'
  if (!item || typeof item !== 'object') {
    return { error: { code: DEPENDENCY_ERROR.MISSING_REF, path, message: '输入项非法' } }
  }
  if (item.source === 'first_run_default' || item.version_ref === 'first-run-default') {
    return { skip: true }
  }
  if (item.record_ref) {
    return resolveFormalRef(store, logicalRunId, item.record_ref, path + '.record_ref')
  }
  if (item.producer) {
    return resolveProducerRef(store, logicalRunId, item.producer, path, item.version_ref)
  }
  if (requireFormal && (isTmpExecRef(item.version_ref) || String(item.version_ref || '').startsWith('tmp-exec:'))) {
    return { error: { code: DEPENDENCY_ERROR.NONFORMAL_REF, path, message: '正式 Proof 不可依赖临时执行引用：' + item.version_ref } }
  }
  return { skip: true }
}

export function resolveInputDependencies(store, logicalRunId, resolvedInputs, opts = {}) {
  const requireFormal = opts.requireFormal === true
  const deps = []
  const errors = []
  const items = resolvedInputs && Array.isArray(resolvedInputs.items) ? resolvedInputs.items : []
  for (let i = 0; i < items.length; i++) {
    const r = resolveInputItem(store, logicalRunId, items[i], i, { requireFormal })
    if (r.error) errors.push(r.error)
    else if (r.ref) pushUnique(deps, r.ref)
  }
  const explicit = Array.isArray(opts.explicitRefs) ? opts.explicitRefs : []
  for (let i = 0; i < explicit.length; i++) {
    const r = resolveFormalRef(store, logicalRunId, explicit[i], 'explicit_refs[' + i + ']')
    if (r.error) errors.push(r.error)
    else pushUnique(deps, r.ref)
  }
  return { dependencies: deps, errors }
}

export function detectDependencyCycle(store, recordId, dependencies) {
  const prev = currentRevision(store, recordId)
  const nextRev = prev === undefined ? 1 : prev + 1
  const start = { record_id: recordId, record_revision: nextRev }
  const initialDeps = dependencies.filter((d) => !(d.record_id === recordId && d.record_revision === prev))

  function refKey(ref) { return ref.record_id + '@' + ref.record_revision }

  function depsAt(ref) {
    const rec = getRecord(store, ref.record_id, ref.record_revision)
    if (!rec) return []
    return (rec.dependencies || []).filter((d) => !(d.record_id === ref.record_id && d.record_revision === ref.record_revision))
  }

  function walk(ref, stack) {
    const key = refKey(ref)
    if (stack.has(key)) return true
    stack.add(key)
    const deps = ref.record_id === recordId && ref.record_revision === nextRev
      ? initialDeps
      : depsAt(ref)
    for (const dep of deps) {
      if (walk(dep, stack)) return true
    }
    stack.delete(key)
    return false
  }

  return walk(start, new Set())
}

export function buildRecordDependencies(store, input) {
  const {
    logical_run_id: logicalRunId,
    record_id: recordId,
    type,
    resolved_inputs: resolvedInputs,
    explicit_refs: explicitRefs,
  } = input || {}
  if (!logicalRunId || !recordId) throw new Error('buildRecordDependencies 需要 logical_run_id 与 record_id')
  const prev = currentRevision(store, recordId)
  const isProof = type === 'proof'
  const mode = resolvedInputs && resolvedInputs.mode ? resolvedInputs.mode : 'legacy'
  const { dependencies: inputDeps, errors } = resolveInputDependencies(store, logicalRunId, resolvedInputs, {
    requireFormal: isProof,
    explicitRefs,
  })
  if (errors.length) {
    const err = new Error(errors.map((e) => e.path + ': ' + e.message).join('；'))
    err.code = errors[0].code
    err.errors = errors
    throw err
  }
  const dependencies = inputDeps.slice()
  if (prev !== undefined) pushUnique(dependencies, { record_id: recordId, record_revision: prev })
  if (detectDependencyCycle(store, recordId, dependencies)) {
    const err = new Error('依赖环：' + recordId)
    err.code = DEPENDENCY_ERROR.DEPENDENCY_CYCLE
    err.errors = [{ code: DEPENDENCY_ERROR.DEPENDENCY_CYCLE, path: recordId, message: '检测到循环依赖' }]
    throw err
  }
  const dependency_source = mode === 'legacy' && inputDeps.length === 0 ? 'legacy' : 'resolved_inputs'
  const dependency_coverage = dependencyCoverageFor({
    type,
    mode,
    inputDeps,
    dependency_source,
  })
  return {
    dependencies,
    prev,
    dependency_source,
    dependency_coverage,
    provenance_extra: {
      input_mode: mode,
      dependency_source,
      dependency_coverage,
      ...(resolvedInputs ? { resolved_inputs_snapshot: structuredClone(resolvedInputs) } : {}),
    },
  }
}

export function dependencyCoverageFor({ type, mode, inputDeps, dependency_source }) {
  if (type === 'artifact') {
    return inputDeps.length > 0 || dependency_source === 'resolved_inputs'
      ? DEPENDENCY_COVERAGE.COMPLETE
      : DEPENDENCY_COVERAGE.INCOMPLETE
  }
  if (type === 'proof') {
    if (dependency_source === 'legacy' && inputDeps.length === 0) return DEPENDENCY_COVERAGE.INCOMPLETE
    if (mode === 'legacy') return DEPENDENCY_COVERAGE.INCOMPLETE
    return inputDeps.length > 0 ? DEPENDENCY_COVERAGE.COMPLETE : DEPENDENCY_COVERAGE.INCOMPLETE
  }
  if (mode === 'declared') {
    return inputDeps.length > 0 ? DEPENDENCY_COVERAGE.COMPLETE : DEPENDENCY_COVERAGE.INCOMPLETE
  }
  return DEPENDENCY_COVERAGE.COMPLETE
}

export function annotateRecordCoverage(record) {
  if (!record || typeof record !== 'object') return DEPENDENCY_COVERAGE.INCOMPLETE
  const prov = record.provenance || {}
  if (prov.dependency_coverage) return prov.dependency_coverage
  const external = (record.dependencies || []).filter((d) => d.record_id !== record.record_id)
  if (record.kind === 'proof_decision') {
    return external.length > 0 ? DEPENDENCY_COVERAGE.COMPLETE : DEPENDENCY_COVERAGE.INCOMPLETE
  }
  if (prov.dependency_source === 'legacy' && external.length === 0 && prov.input_mode === 'declared') {
    return DEPENDENCY_COVERAGE.INCOMPLETE
  }
  return DEPENDENCY_COVERAGE.COMPLETE
}

export function staleReasonChain(store, recordRef) {
  const ref = typeof recordRef === 'object' && recordRef.record_id && recordRef.record_revision
    ? recordRef
    : normalizeRef(recordRef, 'record')
  function walk(currentRef, path) {
    const rec = getRecord(store, currentRef.record_id, currentRef.record_revision)
    if (!rec) return null
    for (const d of rec.dependencies) {
      if (d.record_id === currentRef.record_id) continue
      const nextPath = path.concat([{
        record_id: d.record_id,
        record_revision: d.record_revision,
        current_revision: currentRevision(store, d.record_id),
      }])
      if (currentRevision(store, d.record_id) !== d.record_revision) return nextPath
      const deeper = walk(d, nextPath)
      if (deeper) return deeper
    }
    return null
  }
  return walk(ref, []) || []
}

export function canIssueCoveringProof(record) {
  return annotateRecordCoverage(record) === DEPENDENCY_COVERAGE.COMPLETE
}

export function dependsOnStaleInputsDeep(store, recordRef) {
  const ref = typeof recordRef === 'object' && recordRef.record_id ? recordRef : normalizeRef(recordRef, 'record')
  const rec = getRecord(store, ref.record_id, ref.record_revision)
  if (!rec) return false
  for (const d of rec.dependencies) {
    if (d.record_id === ref.record_id) continue
    if (currentRevision(store, d.record_id) !== d.record_revision) return true
    if (dependsOnStaleInputsDeep(store, d)) return true
  }
  return false
}

export function coverageStatusDeep(store, proofRef, targetRecordId) {
  const base = coverageStatus(store, proofRef, targetRecordId)
  if (base.status === COVERING && dependsOnStaleInputsDeep(store, base.proof)) {
    return { ...base, status: NOT_COVERING_CURRENT, stale: true, stale_reason: 'transitive_stale_inputs' }
  }
  return base
}
