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
// 用法：node scripts/records-host.mjs <commit|list|get|attempt|assertIntegration> '<json>'
// 输出：stdout 一行 JSON；exit 0 = ok，1 = 业务错误，2 = 用法错误。
//
// attempt 逐次提交（LOC-029）：{ logical_run_id, attempt_id, ev, segment, ... }
//   ev.a='s' 调用前持久化 attempt（running）；ev.a='e' 调用收束（completed/failed/
//   rejected/cancelled，完成且带结果时同时推进节点最新索引 Revision 与 Proof）；
//   ev.a='l' 无 agent 的逻辑步骤（折叠/聚合，同样推进索引）。close={segment,status}
//   把遗留 running 的 attempt 就地标记终态。全部写入走提交键幂等：同键同内容重放
//   返回同一 Revision，同键不同内容拒绝（COMMIT_KEY_CONFLICT）。
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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

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
// keys = 提交键索引（LOC-029）：{ 提交键 → { hash, record_id, record_revision } }，
// 支撑「相同键同内容重放返回同一 Revision，不同内容拒绝」的幂等语义。
function loadStore(recordsDir, logicalRunId) {
  const file = fileOf(recordsDir, logicalRunId)
  const store = createStore()
  const meta = { created_at: Date.now(), logical_run_ref: null }
  let keys = {}
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
    keys = data.commit_keys && typeof data.commit_keys === 'object' ? data.commit_keys : {}
  }
  return { store, meta, file, keys }
}

// 原子替换（LOC-029）：tmp 名含 pid/时间戳/随机段——不再共享单一 .tmp 抵抗并发；
// 跨进程互斥由 withLock（同目录排他锁文件）保证，锁内「装载→追加→换入」为临界区。
function saveStore(file, logicalRunId, store, meta, keys) {
  const payload = {
    schema: FILE_SCHEMA,
    logical_run_id: String(logicalRunId),
    logical_run_ref: meta.logical_run_ref,
    created_at: meta.created_at,
    updated_at: Date.now(),
    record_count: store.order.length,
    commit_keys: keys || {},
    records: allRecords(store),
  }
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + randomUUID().slice(0, 8) + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
  renameSync(tmp, file)
}

// 磁盘互斥（LOC-029）：openSync 'wx' 排他创建锁文件；持有者陈旧（超时未释放）可被
// 收割；等待有上界，超时 loud-fail（不静默并发写）。
const LOCK_STALE_MS = 60000
const LOCK_WAIT_MS = 15000
const sleepSync = (ms) => {
  const Shared = typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null
  if (Shared && typeof Atomics === 'object' && Atomics.wait) {
    Atomics.wait(new Int32Array(new Shared(4)), 0, 0, ms)
    return
  }
  const until = Date.now() + ms
  while (Date.now() < until) { /* 自旋兜底 */ }
}
function withLock(file, fn) {
  const lockFile = file + '.lock'
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    let fd = -1
    try {
      fd = openSync(lockFile, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let stale = false
      try { stale = Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS } catch (e2) { sleepSync(10); continue }
      if (stale) { try { unlinkSync(lockFile) } catch (e3) {} }
      if (Date.now() > deadline) throw new Error('records store 锁等待超时（存在并发写入或残留锁）：' + lockFile)
      sleepSync(20)
      continue
    }
    try {
      return fn()
    } finally {
      try { closeSync(fd) } catch (e) { /* 锁句柄关闭失败不阻断释放 */ }
      try { unlinkSync(lockFile) } catch (e) { /* 残留锁由 stale 收割兜底 */ }
    }
  }
}

const contentHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// 提交键内容指纹排除时间戳字段：同一事件的两次构造（重放）除落盘时刻外语义相同，
// 时间戳进指纹会把「同内容重放」误判为冲突（LOC-029 幂等语义）。
const attemptHash = (v) => {
  const { started_at, ended_at, ...rest } = v
  return contentHash(rest)
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
  const file = fileOf(records_dir, logical_run_id)
  return withLock(file, () => {
    const { store, meta, keys } = loadStore(records_dir, logical_run_id)
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
    saveStore(file, logical_run_id, store, meta, keys)
    return { ok: true, logical_run_id: String(logical_run_id), committed, record_count: store.order.length }
  })
}

// ── 逐次 attempt 提交（LOC-029）──────────────────────────────────────────
// 每次真实节点调用一条独立执行记录：record_id = attempt:<logical_run_id>:<attempt_id>，
// start(end/l 逻辑步骤) 事件在同一条记录上追加 Revision（running → 终态），依据 = 提交键。
//   - 稳定提交键去重：同键同内容重放返回同一 Revision（deduped:true，零写入）；
//     同键不同内容拒绝（ok:false COMMIT_KEY_CONFLICT）——断线重放由查询提交键决定。
//   - 完成事件（status=completed 且携带结果，fanout item 除外）与逻辑步骤事件同时
//     追加节点最新索引 Revision（node:<lr>:<node>，节点最新结果只是索引）；
//     verifyBranch 携带 w 时按段末扫描同形强制签发 Proof。
//   - close：把指定 segment 内遗留 running 状态的 attempt 就地标记终态（中断收尾）。
function attemptBody(attemptId, ev, segment, ctx) {
  const phase = ev.a
  const status = phase === 's' ? 'running' : (phase === 'l' ? 'completed' : String(ev.s || 'failed'))
  const v = {
    schema: 1,
    attempt_id: String(attemptId),
    kind: String(ev.t || 'call'),
    node: String(ev.n),
    round: Number(ev.r) || 0,
    segment: Number(segment) || 0,
    status,
    snapshot_revision: String(ctx.snapshot_revision || 'unspecified'),
    provider: String(ctx.provider || 'default'),
    model: String(ctx.model || 'default'),
  }
  if (ev.i !== undefined) v.item_index = ev.i
  if (ev.m !== undefined) v.item = ev.m
  if (phase === 's') v.started_at = new Date().toISOString()
  else v.ended_at = new Date().toISOString()
  if (ev.x !== undefined) v.error = String(ev.x)
  if (ev.q !== undefined) v.result = ev.q
  if (ev.o !== undefined) v.outcome = ev.o
  if (ev.u !== undefined) v.outcome_path = String(ev.u)
  return v
}

function attemptEntryOf(value, recordRef) {
  return {
    attempt_id: value.attempt_id,
    node: value.node,
    kind: value.kind,
    status: value.status,
    round: value.round,
    segment: value.segment,
    snapshot_revision: value.snapshot_revision,
    provider: value.provider,
    model: value.model,
    outcome: value.outcome === undefined ? null : value.outcome,
    outcome_path: value.outcome_path || null,
    completed_at: Date.parse(value.ended_at || value.started_at || '') || Date.now(),
    record: recordRef,
  }
}

export function recordsAttempt(input) {
  const { records_dir, logical_run_id, attempt_id, ev, segment, snapshot_revision, provider, model, workspace, close } = input || {}
  requireText(records_dir, 'records_dir')
  requireText(logical_run_id, 'logical_run_id')
  mkdirSync(records_dir, { recursive: true })
  const file = fileOf(records_dir, logical_run_id)
  return withLock(file, () => {
    const { store, meta, keys } = loadStore(records_dir, logical_run_id)
    if (input.logical_run_ref && typeof input.logical_run_ref === 'object') {
      meta.logical_run_ref = { ...input.logical_run_ref, refreshed_at: new Date().toISOString() }
    }
    const attemptPrefix = 'attempt:' + logical_run_id + ':'
    if (close && typeof close === 'object') {
      // 中断/收尾兜底：该 segment 遗留 running 的 attempt 就地标记终态（幂等，按键防重）
      const seg = Number(close.segment) || 0
      const status = requireText(close.status || 'interrupted', 'close.status')
      const closed = []
      for (const ref of store.order.slice()) {
        if (!String(ref.record_id).startsWith(attemptPrefix)) continue
        const cur = getRecord(store, ref.record_id)
        const v = cur && cur.body && cur.body.value
        if (!v || v.status !== 'running') continue
        if (seg && Number(v.segment) > seg) continue
        const ck = 'close:' + ref.record_id + ':' + cur.record_revision
        if (keys[ck]) continue
        const record = appendRecord(store, {
          record_id: ref.record_id,
          kind: KIND.RESULT,
          body: { media_type: 'application/json', value: { ...v, status, ended_at: new Date().toISOString() } },
          dependencies: [{ record_id: ref.record_id, record_revision: cur.record_revision }],
          based_on: { record_id: ref.record_id, record_revision: cur.record_revision },
          provenance: cur.provenance,
        })
        keys[ck] = { hash: attemptHash(record.body.value), record_id: ref.record_id, record_revision: record.record_revision }
        closed.push({ attempt_id: v.attempt_id, record_id: ref.record_id, record_revision: record.record_revision, status })
      }
      saveStore(file, logical_run_id, store, meta, keys)
      return { ok: true, logical_run_id: String(logical_run_id), closed, record_count: store.order.length }
    }
    if (!ev || typeof ev !== 'object' || !ev.a) throw new Error('attempt 需要 ev 事件对象（a=s|e|l）')
    if (['s', 'e', 'l'].indexOf(ev.a) < 0) throw new Error('非法 ev.a: ' + String(ev.a) + '（允许 s / e / l）')
    const node = requireText(ev.n, 'ev.n')
    const aid = requireText(attempt_id, 'attempt_id')
    const ctx = { snapshot_revision, provider, model }
    const bodyValue = attemptBody(aid, ev, segment, ctx)
    const key = ev.a + ':' + aid
    const hash = attemptHash(bodyValue)
    if (keys[key]) {
      if (keys[key].hash === hash) {
        // 已确认提交的原样重放：返回同一 Revision 的完整条目，不产生新记录
        const ref = { record_id: keys[key].record_id, record_revision: keys[key].record_revision }
        const rec = getRecord(store, ref.record_id, ref.record_revision)
        const v = rec && rec.body && rec.body.value
        return {
          ok: true,
          deduped: true,
          logical_run_id: String(logical_run_id),
          attempt: v ? attemptEntryOf(v, ref) : ref,
          committed: [],
          record_count: store.order.length,
        }
      }
      throw new Error('COMMIT_KEY_CONFLICT: 提交键 ' + key + ' 已确认但内容不同——拒绝覆盖既有证据')
    }
    const recordId = attemptPrefix + aid
    const prev = currentRevision(store, recordId)
    const provenance = {
      logical_run_id: String(logical_run_id),
      node,
      attempt: Math.max(1, Number(segment) || 1),
      snapshot_revision: String(snapshot_revision || 'unspecified'),
      provider: String(provider || 'default'),
      model: String(model || 'default'),
      produced_by: 'vwf:runtime:attempt',
      node_business_outcome: ev.o === undefined ? null : ev.o,
    }
    const record = appendRecord(store, {
      record_id: recordId,
      kind: KIND.RESULT,
      body: { media_type: 'application/json', value: bodyValue },
      dependencies: prev !== undefined ? [{ record_id: recordId, record_revision: prev }] : [],
      ...(prev !== undefined ? { based_on: { record_id: recordId, record_revision: prev } } : {}),
      provenance,
    })
    keys[key] = { hash, record_id: recordId, record_revision: record.record_revision }
    const committed = [{ record_id: recordId, record_revision: record.record_revision, kind: 'result' }]
    // 节点最新索引推进：完成事件（item 除外）与逻辑步骤事件 → node:<lr>:<node> 新 Revision
    const publishes = (ev.a === 'e' && bodyValue.status === 'completed' && ev.q !== undefined && ev.t !== 'item')
      || ev.a === 'l'
    if (publishes) {
      const nodeId = 'node:' + logical_run_id + ':' + node
      const deps = dependenciesOf(store, nodeId, 'node_result')
      const nodeRecord = appendRecord(store, {
        record_id: nodeId,
        kind: KIND.RESULT,
        body: { media_type: 'application/json', value: ev.q === undefined ? null : ev.q },
        dependencies: deps.dependencies,
        ...(deps.prev !== undefined ? { based_on: { record_id: nodeId, record_revision: deps.prev } } : {}),
        provenance: { ...provenance, produced_by: 'vwf:runtime' },
      })
      keys['rc:' + aid] = { hash: contentHash(nodeRecord.body.value), record_id: nodeId, record_revision: nodeRecord.record_revision }
      committed.push({ record_id: nodeId, record_revision: nodeRecord.record_revision, kind: 'result' })
      if (ev.w && typeof ev.w === 'object') {
        // verifyBranch 强制 Proof：依赖 = 签发时刻全部节点记录当前 Revision（与段末扫描同形）
        const proofId = 'proof:' + logical_run_id + ':' + node
        const pd = dependenciesOf(store, proofId, 'proof')
        const proofRecord = appendRecord(store, {
          record_id: proofId,
          kind: KIND.PROOF_DECISION,
          body: {
            media_type: 'application/json',
            value: {
              node,
              verified_branch: ev.w.b === undefined ? null : ev.w.b,
              verified_head: ev.w.h === undefined ? null : ev.w.h,
              workspace: workspace || null,
            },
          },
          dependencies: pd.dependencies,
          ...(pd.prev !== undefined ? { based_on: { record_id: proofId, record_revision: pd.prev } } : {}),
          provenance: { ...provenance, produced_by: 'vwf:runtime' },
        })
        keys['pf:' + aid] = { hash: contentHash(proofRecord.body.value), record_id: proofId, record_revision: proofRecord.record_revision }
        committed.push({ record_id: proofId, record_revision: proofRecord.record_revision, kind: 'proof_decision' })
      }
    }
    saveStore(file, logical_run_id, store, meta, keys)
    return {
      ok: true,
      logical_run_id: String(logical_run_id),
      committed,
      attempt: attemptEntryOf(bodyValue, { record_id: recordId, record_revision: record.record_revision }),
      record_count: store.order.length,
    }
  })
}

export function recordsList(input) {
  const { records_dir, logical_run_id } = input || {}
  const file = fileOf(records_dir, logical_run_id)
  if (!existsSync(file)) {
    return { ok: true, found: false, logical_run_id: String(logical_run_id), record_count: 0, records: [], attempts: [], entries: [], bos: {}, coverage: [] }
  }
  const { store, meta } = loadStore(records_dir, logical_run_id)
  const records = allRecords(store)
  // 逐次 attempt 视图（LOC-029 稳定查询接口）：按 Run 全量，支持 node / attempt_id 过滤；
  // 同一 attempt 多 Revision 时取最新（如 running → completed / interrupted）。
  // segment 过滤（段收尾回填专用）：entries = 可直接入档 node_attempts 的条目，
  // bos = 节点最新业务结果索引增量（completed 且非 item 的最新 attempt 胜出）。
  const attempts = []
  const entries = []
  const bos = {}
  const seenAttempt = new Set()
  const found = []
  const attemptPrefix = 'attempt:' + String(logical_run_id) + ':'
  const segFilter = input.segment === undefined || input.segment === null ? null : Number(input.segment)
  for (let i = store.order.length - 1; i >= 0; i--) {
    const ref = store.order[i]
    if (!String(ref.record_id).startsWith(attemptPrefix) || seenAttempt.has(ref.record_id)) continue
    seenAttempt.add(ref.record_id)
    const rec = getRecord(store, ref.record_id, ref.record_revision)
    const v = rec && rec.body && rec.body.value
    if (!v) continue
    if (input.attempt_id !== undefined && String(input.attempt_id) !== v.attempt_id) continue
    if (input.node !== undefined && String(input.node) !== v.node) continue
    if (segFilter !== null && Number(v.segment) !== segFilter) continue
    found.push({ v, ref })
  }
  // 调用序正序：段内按 attempt 序号排序；「最新索引」由最后一次赋值自然胜出
  found.sort((a, b) => (a.v.segment - b.v.segment) || (attK(a.v.attempt_id) - attK(b.v.attempt_id)))
  for (const { v, ref } of found) {
    const item = attemptEntryOf(v, { record_id: ref.record_id, record_revision: ref.record_revision })
    attempts.push(item)
    if (segFilter !== null && v.status !== 'running') {
      entries.push({
        node: v.node, segment: v.segment, snapshot_revision: v.snapshot_revision,
        provider: v.provider, model: v.model,
        outcome: v.outcome === undefined ? null : v.outcome, completed_at: item.completed_at,
        attempt_id: v.attempt_id, kind: v.kind, status: v.status,
        record: { record_id: ref.record_id, record_revision: ref.record_revision },
      })
      if (v.status === 'completed' && v.outcome !== undefined && v.outcome !== null && v.kind !== 'item') {
        bos[v.node] = { outcome: v.outcome, path: v.outcome_path || null, segment: v.segment, snapshot_revision: v.snapshot_revision, at: item.completed_at }
      }
    }
  }
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
    attempts,
    entries,
    bos,
    coverage,
  }
}

// attempt_id 'a<segment>k<ordinal>' 中的序号取数值：段内按调用发生序排序（k≥10 的
// 字典序会乱序，必须按数值比较）
function attK(attemptId) {
  const m = /^a\d+k(\d+)$/.exec(String(attemptId || ''))
  return m ? Number(m[1]) : 0
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

const COMMANDS = { commit: recordsCommit, list: recordsList, get: recordsGet, attempt: recordsAttempt, assertIntegration: recordsAssertIntegration }

// CLI 判定不比对 import.meta.url（安装位可能经符号链接，路径恒等守卫会静默跳过 main）
if (process.argv.length >= 2 && /records-host\.mjs$/.test(String(process.argv[1] || ''))) {
  const cmd = process.argv[2]
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.error('用法: node scripts/records-host.mjs <commit|list|get|attempt|assertIntegration> \'<json>\'')
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
