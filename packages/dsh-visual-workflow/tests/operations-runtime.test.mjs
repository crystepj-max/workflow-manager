// 受管理外部操作入口运行时集成（LOC-032 / WR-012）：宿主侧接线验收
// operations-host 进程边界用 makeSubprocess 回调替身，但回调内驱动真实的
// operations-host.mjs 命令函数（仅伪造进程边界，不伪造内核语义）。覆盖：
//   W1 vwf.operations.execute RPC 接线：本地计数适配器确认成功 + 同键重放只确认
//   W2 RPC 参数校验 fail-closed（缺 run_id / target / authorization_scope / authorization_ref）
//   W3 operations-host.mjs 未部署 → notFound 显式失败，不静默
//   W4 恢复语义经 RPC 透传：崩溃 → NEEDS_RECONCILIATION 受阻 → 回读恢复 confirmed_success
//   W5 get / list 接线 + 操作账本磁盘权威（进程外直读）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'
import { operationsExecute, operationsGet, operationsList, operationsReconcile, registerProvider } from '../../../scripts/operations-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const OPERATIONS_HOST_SRC = readFileSync(join(here, '..', '..', '..', 'scripts', 'operations-host.mjs'), 'utf8')

// operations-host 进程边界替身：把宿主给的 fake operations_dir 重映射到真实临时目录，
// 命令逻辑走真实 operations-host.mjs（磁盘权威，天然覆盖「重启后可查」）
const realOperationsHost = (dir) => (cmd, input) => {
  const COMMANDS = { execute: operationsExecute, reconcile: operationsReconcile, get: operationsGet, list: operationsList }
  return COMMANDS[cmd]({ ...input, operations_dir: dir })
}

function env({ operationsHost = null, deployed = true, seed = {} } = {}) {
  const base = deployed
    ? { [REPO + '/scripts/operations-host.mjs']: OPERATIONS_HOST_SRC, ...seed }
    : { ...seed }
  const fs = makeFs(base)
  const sub = makeSubprocess({ fs, operationsHost })
  const { handlers } = loadHost({
    fs, subprocess: sub, sandboxPolicy,
    agents: { requireInitiator: () => ({}) },
  })
  return { handlers, fs, sub }
}

const EXEC = (extra = {}) => ({
  run_id: 'task-op-1',
  logical_action: 'create-review',
  target: 'owner/repo#dev-branch',
  authorization_scope: 'pr:create:owner/repo',
  authorization_ref: 'approval-2026-09-14#1',
  params: { title: 'feat: op', base: 'main', head: 'dev-branch' },
  ...extra,
})

test('W1 vwf.operations.execute：确认成功 + 同键重放只确认不重复执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-operations-host-'))
  const { handlers } = env({ operationsHost: realOperationsHost(dir) })
  const first = await handlers.get('vwf.operations.execute')(EXEC())
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.status, 'confirmed_success')
  assert.equal(first.executed, true)
  assert.equal(first.deduped, false)
  assert.deepEqual(first.remote_ref, { system: 'local-count', id: 'lc-create-review-1', version: 1 })
  const second = await handlers.get('vwf.operations.execute')(EXEC())
  assert.equal(second.ok, true)
  assert.equal(second.deduped, true, '同键重放只确认')
  assert.equal(second.executed, false)
  assert.deepEqual(second.result, first.result, '返回原始结果')
  // 磁盘权威：进程外直读账本（重启后可查）
  const onDisk = JSON.parse(readFileSync(join(dir, 'task-op-1.json'), 'utf8'))
  assert.equal(onDisk.operations.length, 1)
  assert.equal(onDisk.operations[0].status, 'confirmed_success')
  assert.equal(onDisk.operations[0].authorization_ref, 'approval-2026-09-14#1', '授权引用入账')
  assert.ok(onDisk.operations[0].remote_ref, '回读凭证入账')
  const provider = JSON.parse(readFileSync(join(dir, 'provider-local-count.json'), 'utf8'))
  assert.equal(provider.execute_calls_total, 1, '外部动作只真实发生一次')
})

test('W2 vwf.operations.* 参数校验 fail-closed', async () => {
  const { handlers } = env({})
  assert.equal((await handlers.get('vwf.operations.execute')({})).ok, false)
  assert.equal((await handlers.get('vwf.operations.execute')({ run_id: 't' })).ok, false)
  assert.equal((await handlers.get('vwf.operations.execute')({ run_id: 't', logical_action: 'merge' })).ok, false)
  assert.equal((await handlers.get('vwf.operations.execute')({ run_id: 't', logical_action: 'merge', target: 'x' })).ok, false)
  assert.equal((await handlers.get('vwf.operations.execute')({ run_id: 't', logical_action: 'merge', target: 'x', authorization_scope: 's' })).ok, false, '缺授权引用拒绝')
  assert.equal((await handlers.get('vwf.operations.reconcile')({})).ok, false)
  assert.equal((await handlers.get('vwf.operations.get')({ run_id: 't' })).ok, false)
  assert.equal((await handlers.get('vwf.operations.list')({})).ok, false)
})

test('W3 operations-host.mjs 未部署：notFound 显式失败，不静默', async () => {
  const { handlers } = env({ deployed: false }) // 不种子 operations-host.mjs
  const r = await handlers.get('vwf.operations.execute')(EXEC())
  assert.equal(r.ok, false)
  assert.equal(r.notFound, true)
})

test('W4 恢复语义经 RPC 透传：崩溃受阻 NEEDS_RECONCILIATION → 回读恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-operations-host-'))
  // 崩溃替身：外部效果先落日志，再模拟宿主在确认前中断；核查可确认成功
  let effects = 0
  let executeCalls = 0
  let reconcileCalls = 0
  const unregister = registerProvider('crashy-rpc', {
    execute() {
      executeCalls += 1
      effects += 1
      throw new Error('CRASH_SIMULATED（外部已生效、本地确认前中断）')
    },
    reconcile(input) {
      reconcileCalls += 1
      return effects > 0
        ? { status: 'confirmed_success', remote_ref: { system: 'crashy-rpc', id: 'cr-1', version: 1 }, result: { via: 'reconcile' } }
        : { status: 'confirmed_not_executed' }
    },
  })
  try {
    const { handlers } = env({ operationsHost: realOperationsHost(dir) })
    const crashed = await handlers.get('vwf.operations.execute')(EXEC({ provider: 'crashy-rpc' }))
    assert.equal(crashed.ok, false)
    assert.equal(crashed.code, 'NEEDS_RECONCILIATION', '受阻码透传')
    assert.equal(crashed.blocked, true)
    assert.equal(crashed.status, 'unknown')
    assert.ok(/需核查|不得再次执行/.test(crashed.error), '受阻说明可读：' + crashed.error)
    // 恢复：先核查原目标 → 确认成功 → 不重复执行
    const recovery = await handlers.get('vwf.operations.execute')(EXEC({ provider: 'crashy-rpc' }))
    assert.equal(recovery.ok, true, JSON.stringify(recovery))
    assert.equal(recovery.status, 'confirmed_success')
    assert.equal(recovery.reconciled, true)
    assert.equal(recovery.executed, false)
    assert.equal(executeCalls, 1, '外部动作只执行一次（不重复创建）')
    assert.equal(effects, 1, '无第二个外部对象')
    assert.equal(reconcileCalls, 1, '恢复先查询原目标')
    const l = await handlers.get('vwf.operations.list')({ run_id: 'task-op-1' })
    assert.equal(l.ok, true)
    assert.equal(l.count, 1)
    assert.equal(l.operations[0].status, 'confirmed_success')
  } finally { unregister() }
})

test('W5 vwf.operations.get / reconcile / list 接线', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-operations-host-'))
  const { handlers } = env({ operationsHost: realOperationsHost(dir) })
  const miss = await handlers.get('vwf.operations.get')({ run_id: 'task-op-2', logical_action: 'merge' })
  assert.equal(miss.ok, true)
  assert.equal(miss.found, false)
  await handlers.get('vwf.operations.execute')(EXEC({ run_id: 'task-op-2', logical_action: 'merge', target: 'owner/repo#pr-1', params: {} }))
  const got = await handlers.get('vwf.operations.get')({ run_id: 'task-op-2', logical_action: 'merge' })
  assert.equal(got.found, true)
  assert.equal(got.status, 'confirmed_success')
  const l = await handlers.get('vwf.operations.list')({ run_id: 'task-op-2' })
  assert.equal(l.count, 1)
  assert.equal(l.operations[0].logical_action, 'merge')
})
