#!/usr/bin/env node
// 受管理外部操作账本 + execute-or-reconcile 入口（LOC-032 / WR-012）
//
// 目标：已确认成功的受管理外部动作在重试与恢复中只被确认，不重复执行；
// 结果不确定时先核查。与 records-host.mjs 同模式：每次调用独立 Node 子进程，
// 权威状态始终在磁盘（<operations_dir>/<encodeURIComponent(run_id)>.json），
// 崩溃/重启后按 run_id 查询天然生效。
//
// 身份与键（规格 §9 接口约定）：
//   operation_id = hash(run_id + logical_action + target + authorization_scope)，
//   同一动作跨模型尝试（attempt）保持不变；同一 run 内同一 logical_action 只允许
//   一个操作槽——同槽不同 target/authorization_scope 拒绝（OPERATION_IDENTITY_CONFLICT），
//   同槽不同规范参数拒绝（OPERATION_PARAM_CONFLICT，规范参数另存 sha256 摘要）。
//
// 账本状态（entry.status，覆盖规格要求的计划/授权引用/执行中/已确认成功/已确认失败/结果未知）：
//   authorized → executing → confirmed_success | confirmed_failure | unknown
//   （planned 仅在事件流中记录：登记与授权在同一临界区完成）。执行前登记（executing
//   先落盘再调外部），外部成功后保存远端对象 ID/版本（remote_ref，回读凭证）；
//   崩溃后 executing/unknown 一律先 reconcile，查询结果只能为 confirmed_success /
//   confirmed_not_executed / unknown；unknown 禁止再次执行（NEEDS_RECONCILIATION
//   受阻），确认未执行后才允许安全重试。confirmed_failure 允许同键重试（幂等键防护）。
//
// 受管理操作形状（V1 覆盖现有交付所需三类）：create-review（创建 PR）、merge（合并）、
//   close-task（关闭任务）。其他逻辑动作名拒绝（INVALID_LOGICAL_ACTION）。
//
// Provider 契约（WR-014 交付适配器消费本接口；接口内部不推断用户授权）：
//   execute({ logical_action, target, params, idempotency_key, authorization_ref, operations_dir })
//     → { status:'confirmed_success', remote_ref, result } | { status:'confirmed_failure', error }
//       （执行中抛异常 = 结果不确定，按 unknown 记账）
//   reconcile({ logical_action, target, params_digest, idempotency_key, authorization_ref, operations_dir })
//     → { status:'confirmed_success', remote_ref?, result? }
//       | { status:'confirmed_not_executed', detail? } | { status:'unknown', detail? }
//   V1 只内置本地计数型适配器 local-count（幂等键去重 + 效果日志，供恢复验收）；
//   已声明但未接线的平台适配器（github 等）返回 capability_unavailable，不猜测、不降级。
//
// 结果约定：结构校验失败（缺字段/类型不符）以异常退出（exit 1 + stderr 语义见下）；
// 业务结果一律 exit 0 + stdout 一行 JSON——含受阻与冲突（ok:false + code）：
//   NEEDS_RECONCILIATION / OPERATION_IDENTITY_CONFLICT / OPERATION_PARAM_CONFLICT /
//   AUTHORIZATION_REQUIRED / capability_unavailable / invalid_provider /
//   INVALID_LOGICAL_ACTION / OPERATION_NOT_FOUND
// 用法：node scripts/operations-host.mjs <execute|reconcile|get|list> '<json>'
// 输出：stdout 一行 JSON；exit 0 = 业务结果（含 ok:false），1 = 命令内部异常，2 = 用法错误。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

const FILE_SCHEMA = 1

// V1 受管理操作形状（§9：创建 PR、合并、关闭任务）
export const MANAGED_ACTIONS = ['create-review', 'merge', 'close-task']

// 已声明但 V1 未接线的平台适配器：显式 capability_unavailable（§9：不支持的平台不猜测）
export const DECLARED_UNAVAILABLE_PROVIDERS = ['github']
const DEFAULT_PROVIDER = 'local-count'

const bizError = (code, error, extra) => ({ ok: false, code, error, ...(extra || {}) })

function requireText(v, label) {
  if (typeof v !== 'string' || !/\S/.test(v)) throw new Error(`${label} 必须是非空字符串`)
  return v
}

// 规范 JSON（键递归排序）：同参数的两次构造必须得到同一摘要
function canonicalJson(v) {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex')

// operation_id：run+logical_action+target+authorization_scope 派生，不因 attempt 变化
export function deriveOperationId(runId, logicalAction, target, authorizationScope) {
  return 'op-' + sha256Hex(canonicalJson([String(runId), String(logicalAction), String(target), String(authorizationScope)])).slice(0, 24)
}

export function digestParams(params) {
  return 'sha256-' + sha256Hex(canonicalJson(params === undefined || params === null ? {} : params))
}

function fileOf(operationsDir, runId) {
  return requireText(operationsDir, 'operations_dir') + '/' + encodeURIComponent(String(runId)) + '.json'
}

// 磁盘 → 账本（与 records-host 同口径：装载即冻结，追加后整体校验换入）
function loadLedger(operationsDir, runId) {
  const file = fileOf(operationsDir, runId)
  const ledger = { run_id: String(runId), created_at: Date.now(), updated_at: Date.now(), operations: [] }
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || data.run_id !== String(runId)) throw new Error('operations 账本身份不符：' + file)
    ledger.created_at = data.created_at || ledger.created_at
    ledger.updated_at = data.updated_at || ledger.updated_at
    ledger.operations = Array.isArray(data.operations) ? data.operations : []
  }
  return { ledger, file }
}

// 原子替换 + 磁盘互斥（与 records-host 同模式）：执行外部动作期间持有锁，并发同键
// 请求在锁上排队，进入后看到 confirmed_success 直接去重——这是「并发重试也不重复
// 执行」的落点。外部交付动作可能慢，等待/陈旧阈值比 records-host 放宽。
const LOCK_STALE_MS = 30 * 60 * 1000
const LOCK_WAIT_MS = 120 * 1000
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
      if (Date.now() > deadline) throw new Error('operations 账本锁等待超时（存在并发执行或残留锁）：' + lockFile)
      sleepSync(20)
      continue
    }
    try {
      return fn()
    } finally {
      try { closeSync(fd) } catch (e) { /* 锁句柄关闭失败不阻断释放 */ }
      try { unlinkSync(lockFile) } catch (e3) { /* 残留锁由 stale 收割兜底 */ }
    }
  }
}

function saveLedger(file, ledger) {
  ledger.updated_at = Date.now()
  const payload = {
    schema: FILE_SCHEMA,
    run_id: ledger.run_id,
    created_at: ledger.created_at,
    updated_at: ledger.updated_at,
    operation_count: ledger.operations.length,
    operations: ledger.operations,
  }
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + randomUUID().slice(0, 8) + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
  renameSync(tmp, file)
}

function eventOf(kind, detail) {
  return { at: new Date().toISOString(), kind, detail: detail === undefined ? null : detail }
}

// ── Provider 注册表 ─────────────────────────────────────────────────────────
// registerProvider 供交付适配器（WR-014）与测试替身注册；返回注销函数。
const providerRegistry = new Map()

export function registerProvider(id, impl) {
  providerRegistry.set(requireText(id, 'provider id'), impl)
  return () => { if (providerRegistry.get(id) === impl) providerRegistry.delete(id) }
}

export function resolveProvider(id) {
  const pid = requireText(id || DEFAULT_PROVIDER, 'provider')
  if (providerRegistry.has(pid)) return { ok: true, id: pid, provider: providerRegistry.get(pid) }
  if (DECLARED_UNAVAILABLE_PROVIDERS.indexOf(pid) >= 0) return { ok: false, id: pid, code: 'capability_unavailable' }
  return { ok: false, id: pid, code: 'invalid_provider' }
}

// ── 内置本地计数型适配器（本地假适配器 + 恢复验收替身，§9）──────────────────
// 状态文件 <operations_dir>/provider-local-count.json：effects 以幂等键去重，
// execute_calls_total 记录 execute 真实被调次数——账本防重是否生效以此为准。
const localCount = (() => {
  const storeFile = (operationsDir) => requireText(operationsDir, 'operations_dir') + '/provider-local-count.json'
  const emptyStore = () => ({ effects: {}, execute_calls_total: 0, reconcile_calls_total: 0, replays: 0 })
  function load(operationsDir) {
    const file = storeFile(operationsDir)
    if (!existsSync(file)) return { file, store: emptyStore() }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { file, store: { ...emptyStore(), ...data, effects: data.effects && typeof data.effects === 'object' ? data.effects : {} } }
  }
  function save(file, store) {
    const tmp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
    renameSync(tmp, file)
  }
  return {
    id: 'local-count',
    supports_idempotency_key: true,
    execute(input) {
      const { operations_dir, logical_action, target, params, idempotency_key } = input || {}
      mkdirSync(operations_dir, { recursive: true })
      const { file, store } = load(operations_dir)
      store.execute_calls_total += 1
      const existing = store.effects[idempotency_key]
      if (existing) {
        // 幂等键命中：返回既有效果，不产生第二个外部对象
        store.replays += 1
        save(file, store)
        return { status: 'confirmed_success', remote_ref: existing.remote_ref, result: existing.result, replayed: true }
      }
      const n = Object.keys(store.effects).length + 1
      const remote_ref = { system: 'local-count', id: 'lc-' + logical_action + '-' + n, version: 1 }
      const result = { logical_action, target, params: params ?? null }
      store.effects[idempotency_key] = { logical_action, target, remote_ref, result, created_at: new Date().toISOString() }
      save(file, store)
      return { status: 'confirmed_success', remote_ref, result }
    },
    reconcile(input) {
      // 核查永不抛出：查不到 = confirmed_not_executed；日志不可读 = unknown（保守受阻）
      try {
        const { operations_dir, idempotency_key } = input || {}
        const { file, store } = load(operations_dir)
        store.reconcile_calls_total += 1
        save(file, store)
        const effect = store.effects[idempotency_key]
        if (effect) return { status: 'confirmed_success', remote_ref: effect.remote_ref, result: effect.result }
        return { status: 'confirmed_not_executed', detail: 'local-count 无此幂等键的效果记录' }
      } catch (e) {
        return { status: 'unknown', detail: '效果日志不可读：' + String((e && e.message) || e) }
      }
    },
  }
})()
registerProvider('local-count', localCount)

// ── 输入校验 ────────────────────────────────────────────────────────────────
function validateIdentity(input) {
  const runId = requireText(input.run_id, 'run_id')
  const action = requireText(input.logical_action, 'logical_action')
  if (MANAGED_ACTIONS.indexOf(action) < 0) {
    return bizError('INVALID_LOGICAL_ACTION', '未知受管理操作形状 ' + JSON.stringify(action) + '（V1 允许：' + MANAGED_ACTIONS.join(' / ') + '）')
  }
  const target = requireText(input.target, 'target')
  const scope = requireText(input.authorization_scope, 'authorization_scope')
  if (input.params !== undefined && input.params !== null && (typeof input.params !== 'object' || Array.isArray(input.params))) {
    throw new Error('params 必须是对象（规范参数）')
  }
  const params = input.params ?? {}
  return { runId, action, target, scope, params }
}

// 同槽（run+logical_action）身份/参数一致性核对：防「同键不同目标/参数」
function identityConflict(entry, identity) {
  if (entry.target !== identity.target || entry.authorization_scope !== identity.scope) {
    return bizError('OPERATION_IDENTITY_CONFLICT',
      '操作 ' + entry.operation_id + ' 已绑定 target=' + JSON.stringify(entry.target) + ' authorization_scope=' + JSON.stringify(entry.authorization_scope) + '，拒绝改绑 ' + JSON.stringify(identity.target) + '/' + JSON.stringify(identity.scope) + '（同键不同目标/授权范围）',
      { operation_id: entry.operation_id })
  }
  const digest = digestParams(identity.params)
  if (entry.params_digest !== digest) {
    return bizError('OPERATION_PARAM_CONFLICT',
      '操作 ' + entry.operation_id + ' 已登记规范参数摘要 ' + entry.params_digest + '，与本次 ' + digest + ' 不一致（同键不同参数）',
      { operation_id: entry.operation_id })
  }
  return null
}

const blockedResult = (entry, detail) => ({
  ok: false,
  code: 'NEEDS_RECONCILIATION',
  blocked: true,
  status: 'unknown',
  operation_id: entry.operation_id,
  run_id: entry.run_id,
  logical_action: entry.logical_action,
  target: entry.target,
  error: '外部动作结果不确定且当前无法核查（' + (detail || 'unknown') + '）：已停止自动重试，需先核查目标 ' + JSON.stringify(entry.target) + ' 的实际状态，确认前不得再次执行',
})

// reconcile 出发：确认成功 → 记回读并按已确认收束（不执行）；确认未执行 → 回到 authorized 可安全重试
function reconcileEntry(entry, provider, operationsDir) {
  let outcome
  try {
    outcome = provider.reconcile({
      logical_action: entry.logical_action,
      target: entry.target,
      params_digest: entry.params_digest,
      idempotency_key: entry.idempotency_key,
      authorization_ref: entry.authorization_ref,
      operations_dir: operationsDir,
    })
  } catch (e) {
    outcome = { status: 'unknown', detail: 'reconcile 异常：' + String((e && e.message) || e) }
  }
  const status = outcome && outcome.status
  if (status === 'confirmed_success') {
    entry.status = 'confirmed_success'
    entry.needs_reconciliation = false
    entry.remote_ref = outcome.remote_ref ?? entry.remote_ref ?? null
    entry.result = outcome.result !== undefined ? outcome.result : (entry.remote_ref ? { remote_ref: entry.remote_ref } : null)
    entry.events.push(eventOf('recover', { via: 'reconcile', remote_ref: entry.remote_ref }))
    return { recovered: true }
  }
  if (status === 'confirmed_not_executed') {
    entry.status = 'authorized'
    entry.needs_reconciliation = false
    entry.events.push(eventOf('reconcile', { outcome: 'confirmed_not_executed', detail: outcome.detail ?? null }))
    return { recovered: false, retry_safe: true }
  }
  entry.status = 'unknown'
  entry.needs_reconciliation = true
  entry.events.push(eventOf('reconcile', { outcome: 'unknown', detail: (outcome && outcome.detail) ?? (status === 'unknown' ? null : 'provider 契约外返回：' + String(status)) }))
  return { recovered: false, retry_safe: false, detail: (outcome && outcome.detail) ?? null }
}

// 执行段两相：begin 只改内存（调用方先落盘），finish 调外部并记账。这样
// 「executing（执行前登记）」在进入 provider.execute 前已持久化——进程级崩溃
// （SIGKILL/断电）也会留下 in-flight 痕迹，恢复按 executing 先核查，不盲目重发。
function beginExecute(entry) {
  entry.status = 'executing'
  entry.needs_reconciliation = false
  entry.events.push(eventOf('execute_start', { provider: entry.provider }))
}

function finishExecute(entry, provider, identity, operationsDir) {
  try {
    const outcome = provider.execute({
      logical_action: entry.logical_action,
      target: entry.target,
      params: identity.params,
      idempotency_key: entry.idempotency_key,
      authorization_ref: entry.authorization_ref,
      operations_dir: operationsDir,
    })
    const status = outcome && outcome.status
    if (status === 'confirmed_success') {
      entry.status = 'confirmed_success'
      entry.result = outcome.result !== undefined ? outcome.result : null
      entry.remote_ref = outcome.remote_ref ?? null
      entry.events.push(eventOf('execute_result', { status: 'confirmed_success', remote_ref: entry.remote_ref, replayed: outcome.replayed === true }))
      return { ok: true, status: 'confirmed_success', executed: true, deduped: false, reconciled: false }
    }
    if (status === 'confirmed_failure') {
      entry.status = 'confirmed_failure'
      entry.events.push(eventOf('execute_result', { status: 'confirmed_failure', error: outcome.error ?? null }))
      return { ok: true, status: 'confirmed_failure', executed: true, deduped: false, reconciled: false, error: outcome.error ?? null }
    }
    entry.status = 'unknown'
    entry.needs_reconciliation = true
    const detail = 'provider 契约外返回：' + String(status)
    entry.events.push(eventOf('execute_error', { detail }))
    return { blocked: true, detail }
  } catch (e) {
    entry.status = 'unknown'
    entry.needs_reconciliation = true
    const detail = String((e && e.message) || e)
    entry.events.push(eventOf('execute_error', { detail }))
    return { blocked: true, detail }
  }
}

// ── execute-or-reconcile 主入口 ─────────────────────────────────────────────
export function operationsExecute(input) {
  const { operations_dir } = input || {}
  const identity = validateIdentity(input || {})
  if (identity.ok === false) return identity
  // 无授权引用不进入任何外部调用（fail-closed；接口内部不推断用户授权）
  if (typeof (input || {}).authorization_ref !== 'string' || !/\S/.test(input.authorization_ref)) {
    return bizError('AUTHORIZATION_REQUIRED', '缺少 authorization_ref：无授权引用不调用外部动作（接口内部不推断用户授权）')
  }
  const authorizationRef = input.authorization_ref
  const resolved = resolveProvider((input || {}).provider)
  if (!resolved.ok) {
    if (resolved.code === 'capability_unavailable') {
      return bizError('capability_unavailable', 'provider ' + JSON.stringify(resolved.id) + ' 未接线（V1 仅内置 local-count）；不猜测、不降级，请改用已接线适配器或先完成接线')
    }
    return bizError('invalid_provider', '未知 provider ' + JSON.stringify(resolved.id))
  }
  mkdirSync(operations_dir, { recursive: true })
  const { ledger, file } = loadLedger(operations_dir, identity.runId)
  return withLock(file, () => {
    let entry = ledger.operations.find((e) => e && e.run_id === identity.runId && e.logical_action === identity.action) || null
    const fresh = !entry
    if (fresh) {
      const operationId = deriveOperationId(identity.runId, identity.action, identity.target, identity.scope)
      entry = {
        operation_id: operationId,
        run_id: identity.runId,
        logical_action: identity.action,
        target: identity.target,
        authorization_scope: identity.scope,
        authorization_ref: authorizationRef,
        params_digest: digestParams(identity.params),
        provider: resolved.id,
        idempotency_key: 'vwf-' + operationId,
        status: 'planned',
        needs_reconciliation: false,
        result: null,
        remote_ref: null,
        events: [
          eventOf('plan', { target: identity.target, authorization_scope: identity.scope, provider: resolved.id }),
          eventOf('authorize', { authorization_ref: authorizationRef }),
        ],
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      entry.status = 'authorized'
      ledger.operations.push(entry)
    } else {
      const conflict = identityConflict(entry, identity)
      if (conflict) return conflict
      if (entry.authorization_ref !== authorizationRef) {
        // 授权引用更新不改变身份（scope 才是身份组件），如实记账不推断
        entry.events.push(eventOf('authorization_ref_updated', { from: entry.authorization_ref, to: authorizationRef }))
        entry.authorization_ref = authorizationRef
      }
    }
    if (!fresh && entry.status === 'confirmed_success') {
      // 已确认成功：只确认，不重复执行（同键同参数重放零写入）
      return {
        ok: true, status: 'confirmed_success', deduped: true, executed: false, reconciled: false,
        operation_id: entry.operation_id, result: entry.result, remote_ref: entry.remote_ref,
        idempotency_key: entry.idempotency_key, entry,
      }
    }
    if (!fresh && (entry.status === 'executing' || entry.status === 'unknown')) {
      // 崩溃/中断恢复：先核查原目标，禁止直接重发
      const r = reconcileEntry(entry, resolved.provider, operations_dir)
      if (r.recovered) {
        saveLedger(file, ledger)
        return {
          ok: true, status: 'confirmed_success', deduped: true, executed: false, reconciled: true,
          operation_id: entry.operation_id, result: entry.result, remote_ref: entry.remote_ref,
          idempotency_key: entry.idempotency_key, entry,
        }
      }
      saveLedger(file, ledger)
      if (!r.retry_safe) return blockedResult(entry, r.detail)
      // confirmed_not_executed：确认未执行，安全重试 → 落入下方执行段
    }
    beginExecute(entry)
    saveLedger(file, ledger) // 执行前登记（§9）：executing 先落盘再调外部
    const r = finishExecute(entry, resolved.provider, identity, operations_dir)
    saveLedger(file, ledger)
    if (r.blocked) return blockedResult(entry, r.detail)
    return {
      ...r,
      operation_id: entry.operation_id,
      run_id: entry.run_id,
      logical_action: entry.logical_action,
      remote_ref: entry.remote_ref,
      result: entry.result,
      idempotency_key: entry.idempotency_key,
      entry,
    }
  })
}

// ── 独立核查入口（只查询，不执行）───────────────────────────────────────────
export function operationsReconcile(input) {
  const { operations_dir } = input || {}
  const runId = requireText((input || {}).run_id, 'run_id')
  const action = requireText((input || {}).logical_action, 'logical_action')
  if (MANAGED_ACTIONS.indexOf(action) < 0) {
    return bizError('INVALID_LOGICAL_ACTION', '未知受管理操作形状 ' + JSON.stringify(action))
  }
  mkdirSync(operations_dir, { recursive: true })
  const { ledger, file } = loadLedger(operations_dir, runId)
  return withLock(file, () => {
    const entry = ledger.operations.find((e) => e && e.run_id === runId && e.logical_action === action)
    if (!entry) {
      return bizError('OPERATION_NOT_FOUND', 'run ' + JSON.stringify(runId) + ' 无 ' + JSON.stringify(action) + ' 操作记录')
    }
    const resolved = resolveProvider(entry.provider)
    if (!resolved.ok) {
      return bizError('capability_unavailable', '登记的 provider ' + JSON.stringify(entry.provider) + ' 当前不可用，无法核查')
    }
    const r = reconcileEntry(entry, resolved.provider, operations_dir)
    saveLedger(file, ledger)
    if (r.recovered) {
      return { ok: true, status: 'confirmed_success', reconciled: true, operation_id: entry.operation_id, result: entry.result, remote_ref: entry.remote_ref, entry }
    }
    if (r.retry_safe) {
      return { ok: true, status: 'confirmed_not_executed', operation_id: entry.operation_id, error: null, message: '确认未执行：同键请求可安全重试', entry }
    }
    return blockedResult(entry, r.detail)
  })
}

export function operationsGet(input) {
  const { operations_dir } = input || {}
  const runId = requireText((input || {}).run_id, 'run_id')
  const action = requireText((input || {}).logical_action, 'logical_action')
  const { ledger } = loadLedger(operations_dir, runId)
  const entry = ledger.operations.find((e) => e && e.logical_action === action)
  return entry
    ? { ok: true, found: true, operation_id: entry.operation_id, status: entry.status, operation: entry }
    : { ok: true, found: false, operation: null }
}

export function operationsList(input) {
  const { operations_dir } = input || {}
  const runId = requireText((input || {}).run_id, 'run_id')
  const { ledger } = loadLedger(operations_dir, runId)
  return {
    ok: true,
    run_id: String(runId),
    count: ledger.operations.length,
    operations: ledger.operations.map((e) => ({
      operation_id: e.operation_id,
      logical_action: e.logical_action,
      target: e.target,
      authorization_scope: e.authorization_scope,
      authorization_ref: e.authorization_ref,
      status: e.status,
      needs_reconciliation: e.needs_reconciliation === true,
      provider: e.provider,
      remote_ref: e.remote_ref,
      updated_at: e.updated_at,
    })),
  }
}

const COMMANDS = { execute: operationsExecute, reconcile: operationsReconcile, get: operationsGet, list: operationsList }

// CLI 判定与 records-host 同口径（安装位可能经符号链接，不比对 import.meta.url）
if (process.argv.length >= 2 && /operations-host\.mjs$/.test(String(process.argv[1] || ''))) {
  const cmd = process.argv[2]
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.error('用法: node scripts/operations-host.mjs <execute|reconcile|get|list> \'<json>\'')
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
    console.log(JSON.stringify({ ok: false, code: e && e.code, error: String((e && e.message) || e) }))
    process.exit(1)
  }
}
