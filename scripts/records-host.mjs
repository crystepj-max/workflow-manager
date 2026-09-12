#!/usr/bin/env node
// Formal Records 宿主包装脚本（LOC-008 运行时集成）
// 供 host.js runNode 调用，桥接 vm 沙箱与 formal-records.mjs 内核（ESM + fs，无法在
// 沙箱内求值）。禁止平行实现 Store/覆盖判定——全部业务逻辑委托内核。
//
// 落盘组织随 #79 logical-runs：一逻辑运行一文件
//   <records_dir>/<encodeURIComponent(logical_run_id)>.json
// 每次调用是独立进程，权威状态始终在磁盘：产品 DSH 重启后按 logical_run_id 查询
// 天然生效（LOC-008 验收③），无需宿主内存回载。
//
// 用法：node scripts/records-host.mjs <commit|list|get> '<json>'
// 输出：stdout 一行 JSON；exit 0 = ok，1 = 业务错误，2 = 用法错误。
//
// commit 条目（按序追加，同一 Store 内结链）：
//   { type: 'node_result', record_id, provenance, body_value }        节点结果 → result 记录；
//     dependencies/based_on = 自身当前最新 Revision（重复完成自然形成 Revision 链）
//   { type: 'proof', record_id, provenance, body_value }              verifyBranch 强制签发
//     的 proof_decision；dependencies = 签发时 Store 内全部 node:/artifact: 记录的当前
//     Revision + 自身前一 Revision——目标 Revision 前进后旧 Proof 经 coverageStatus
//     判 not_covering_current（保留不删，标记 stale，LOC-008 验收①②）
//   { type: 'artifact', record_id, provenance, body_value, kind }     多格式产物（#69
//     record_id 约定不变），经 parseArtifactBody 定 body，链规则同 node_result

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const formalArtifacts = require('./formal-artifacts.cjs')

import {
  KIND,
  appendRecord,
  allRecords,
  coverageStatus,
  createStore,
  currentRevision,
  getRecord,
  listRevisions,
} from './formal-records.mjs'
import { assertIntegrationAllowed } from './workspace-isolation.mjs'

const FILE_SCHEMA = 1
const DEP_PREFIX = /^(node|artifact):/

function requireText(v, label) {
  if (typeof v !== 'string' || !/\S/.test(v)) throw new Error(`${label} 必须是非空字符串`)
  return v
}

function fileOf(recordsDir, logicalRunId) {
  return requireText(recordsDir, 'records_dir') + '/' + encodeURIComponent(String(logicalRunId)) + '.json'
}

// 磁盘 → 内核 Store（记录已冻结，直接挂载；追加路径仍走 appendRecord 全量校验）
function loadStore(recordsDir, logicalRunId) {
  const file = fileOf(recordsDir, logicalRunId)
  const store = createStore()
  const meta = { created_at: Date.now(), logical_run_ref: null }
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || data.logical_run_id !== String(logicalRunId)) {
      throw new Error('records 文件身份不符：' + file)
    }
    for (const rec of Array.isArray(data.records) ? data.records : []) {
      if (!rec || typeof rec.record_id !== 'string') continue
      if (!store.byId.has(rec.record_id)) store.byId.set(rec.record_id, new Map())
      store.byId.get(rec.record_id).set(rec.record_revision, rec)
      store.order.push({ record_id: rec.record_id, record_revision: rec.record_revision })
    }
    meta.created_at = data.created_at || meta.created_at
    meta.logical_run_ref = data.logical_run_ref || null
  }
  return { store, meta, file }
}

function saveStore(file, logicalRunId, store, meta) {
  const payload = {
    schema: FILE_SCHEMA,
    logical_run_id: String(logicalRunId),
    logical_run_ref: meta.logical_run_ref,
    created_at: meta.created_at,
    updated_at: Date.now(),
    record_count: store.order.length,
    records: allRecords(store),
  }
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
  renameSync(tmp, file)
}

function dependenciesOf(store, recordId, type) {
  const dependencies = []
  if (type === 'proof') {
    // 证明依赖：签发时刻 Store 内全部节点/产物记录的当前 Revision（直接依赖，
    // 不做传递闭包；跨段沿用——上一段完成的节点同样构成可失效的输入集）
    const seen = new Set()
    for (const ref of store.order) {
      if (ref.record_id === recordId || !DEP_PREFIX.test(ref.record_id) || seen.has(ref.record_id)) continue
      seen.add(ref.record_id)
      dependencies.push({ record_id: ref.record_id, record_revision: currentRevision(store, ref.record_id) })
    }
  }
  const prev = currentRevision(store, recordId)
  if (prev !== undefined) dependencies.push({ record_id: recordId, record_revision: prev })
  return { dependencies, prev }
}

export function recordsCommit(input) {
  const { records_dir, logical_run_id, entries } = input || {}
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('commit 需要 entries 数组')
  mkdirSync(records_dir, { recursive: true })
  const { store, meta, file } = loadStore(records_dir, logical_run_id)
  if (input.logical_run_ref && typeof input.logical_run_ref === 'object') {
    // 与运行摘要互相引用（#79）：Store 侧内嵌摘要引用快照，由宿主提交时刷新
    meta.logical_run_ref = { ...input.logical_run_ref, refreshed_at: new Date().toISOString() }
  }
  const committed = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') throw new Error('entry 必须是对象')
    const type = e.type
    if (type !== 'node_result' && type !== 'proof' && type !== 'artifact') {
      throw new Error('非法 entry.type: ' + String(type) + '（允许 node_result / proof / artifact）')
    }
    const recordId = requireText(e.record_id, 'entry.record_id')
    const { dependencies, prev } = dependenciesOf(store, recordId, type)
    const body = type === 'artifact'
      ? formalArtifacts.parseArtifactBody(requireText(e.kind, 'entry.kind'), e.body_value)
      : { media_type: 'application/json', value: e.body_value === undefined ? null : e.body_value }
    const provenance = { ...(e.provenance || {}) }
    if (provenance.node_business_outcome === undefined) provenance.node_business_outcome = null
    const record = appendRecord(store, {
      record_id: recordId,
      kind: type === 'proof' ? KIND.PROOF_DECISION : KIND.RESULT,
      body,
      dependencies,
      ...(prev !== undefined ? { based_on: { record_id: recordId, record_revision: prev } } : {}),
      provenance,
    })
    committed.push({ record_id: record.record_id, record_revision: record.record_revision, kind: record.kind })
  }
  saveStore(file, logical_run_id, store, meta)
  return { ok: true, logical_run_id: String(logical_run_id), committed, record_count: store.order.length }
}

export function recordsList(input) {
  const { records_dir, logical_run_id } = input || {}
  const file = fileOf(records_dir, logical_run_id)
  if (!existsSync(file)) {
    return { ok: true, found: false, logical_run_id: String(logical_run_id), record_count: 0, records: [], coverage: [] }
  }
  const { store, meta } = loadStore(records_dir, logical_run_id)
  const records = allRecords(store)
  const coverage = []
  for (const proof of records) {
    if (proof.kind !== KIND.PROOF_DECISION) continue
    const seen = new Set()
    for (const d of proof.dependencies) {
      if (seen.has(d.record_id)) continue
      seen.add(d.record_id)
      const cs = coverageStatus(store, proof, d.record_id)
      coverage.push({
        proof: { record_id: proof.record_id, record_revision: proof.record_revision },
        target_record_id: d.record_id,
        status: cs.status,
        stale: cs.stale,
      })
    }
  }
  return {
    ok: true,
    found: true,
    logical_run_id: String(logical_run_id),
    logical_run_ref: meta.logical_run_ref,
    record_count: records.length,
    records,
    coverage,
  }
}

export function recordsGet(input) {
  const { records_dir, logical_run_id, record_id } = input || {}
  requireText(record_id, 'record_id')
  const file = fileOf(records_dir, logical_run_id)
  if (!existsSync(file)) return { ok: true, found: false, record_id, revisions: [], coverage: [] }
  const { store } = loadStore(records_dir, logical_run_id)
  const revisions = listRevisions(store, record_id)
  if (!revisions.length) return { ok: true, found: false, record_id, revisions: [], coverage: [] }
  const coverage = allRecords(store)
    .filter((r) => r.kind === KIND.PROOF_DECISION && r.dependencies.some((d) => d.record_id === record_id))
    .map((proof) => {
      const cs = coverageStatus(store, proof, record_id)
      return {
        proof: { record_id: proof.record_id, record_revision: proof.record_revision },
        status: cs.status,
        stale: cs.stale,
      }
    })
  return {
    ok: true,
    found: true,
    record_id,
    current_revision: currentRevision(store, record_id),
    revisions,
    coverage,
  }
}

export function recordsAssertIntegration(input) {
  // LOC-017 集成闸门放行判定：全部业务逻辑委托内核 assertIntegrationAllowed
  //（Proof 全覆盖当前 Revision 才放行），本命令只做 Store 装载与 Proof 解析。
  const { records_dir, logical_run_id, target_record_id, proofs, target_advanced } = input || {}
  if (!existsSync(fileOf(records_dir, logical_run_id))) {
    return { ok: false, error: 'Formal Records Store 不存在: ' + String(logical_run_id), stale: [] }
  }
  const { store } = loadStore(records_dir, logical_run_id)
  const refs = []
  for (const p of Array.isArray(proofs) ? proofs : []) {
    if (!p || typeof p.record_id !== 'string') throw new Error('proofs 项必须含 record_id')
    const rec = getRecord(store, p.record_id, p.record_revision)
    if (!rec) throw new Error(`Proof 不存在: ${p.record_id}@${p.record_revision}`)
    refs.push(rec)
  }
  try {
    const res = assertIntegrationAllowed({
      checkpoint: { target_advanced: target_advanced === true },
      formalStore: store,
      targetRecordId: requireText(target_record_id, 'target_record_id'),
      proofs: refs,
    })
    return {
      ok: true,
      proofs_state: res.proofs_state,
      checked: refs.map((r) => ({ record_id: r.record_id, record_revision: r.record_revision })),
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), stale: Array.isArray(e.stale) ? e.stale : [] }
  }
}

const COMMANDS = { commit: recordsCommit, list: recordsList, get: recordsGet, assertIntegration: recordsAssertIntegration }

// CLI 判定不比对 import.meta.url（安装位可能经符号链接，路径恒等守卫会静默跳过 main）
if (process.argv.length >= 2 && /records-host\.mjs$/.test(String(process.argv[1] || ''))) {
  const cmd = process.argv[2]
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.error('用法: node scripts/records-host.mjs <commit|list|get> \'<json>\'')
    process.exit(2)
  }
  let input = {}
  try {
    input = process.argv[3] ? JSON.parse(process.argv[3]) : {}
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: '输入 JSON 不可解析：' + e.message }))
    process.exit(1)
  }
  try {
    console.log(JSON.stringify(fn(input)))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    process.exit(1)
  }
}
