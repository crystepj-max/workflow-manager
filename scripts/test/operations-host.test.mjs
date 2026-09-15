// 受管理外部操作账本 + execute-or-reconcile（LOC-032 / WR-012）验收
// 真实子进程 + 真实临时目录（每次 CLI 调用 = 独立进程 + 磁盘权威状态，恢复/重启语义
// 由调用形态天然覆盖）；崩溃注入经 registerProvider 注册进程内替身（模拟「外部已生效、
// 本地确认前中断」与「结果不确定且查询不可用」）。覆盖：
//   O1 同键同参数重放只确认不重执行（AC-02 前半 + AC-04）
//   O2 同槽不同目标/授权范围/参数拒绝（AC-02 后半）
//   O3 外部成功但本地确认前崩溃：恢复先查询原目标，不重复执行（AC-01）
//   O4 结果不确定且查询不可用 → 受阻不重发；确认未执行后可安全重试（AC-03）
//   O5 账本包含授权、操作、回读与恢复记录（AC-04）
//   O6 授权引用缺失 fail-closed；O7 capability_unavailable / 未知 provider
//   O8 非法操作形状拒绝；O9 三类操作形状共用语义（UAT-01）
//   O10 独立 reconcile 命令（只查询不执行）；O11 get/list 查询
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { operationsExecute, operationsGet, registerProvider } from '../operations-host.mjs'
import { compileBlueprint } from '../generate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const OPERATIONS_HOST = join(here, '..', 'operations-host.mjs')

const opsDir = () => mkdtempSync(join(tmpdir(), 'vwf-operations-'))

// 每次调用走真实 CLI 子进程：与产品运行形态一致（独立进程 + 磁盘权威）
function cli(cmd, input) {
  const stdout = execFileSync(process.execPath, [OPERATIONS_HOST, cmd, JSON.stringify(input)], { encoding: 'utf8' })
  return JSON.parse(stdout)
}

const REQ = (dir, extra = {}) => ({
  operations_dir: dir,
  run_id: 'run-1',
  logical_action: 'create-review',
  target: 'owner/repo#branch-dev',
  authorization_scope: 'pr:create:owner/repo',
  authorization_ref: 'approval-2026-09-14#1',
  params: { title: 'feat: x', base: 'main', head: 'branch-dev' },
  ...extra,
})

const readLedger = (dir, runId = 'run-1') =>
  JSON.parse(readFileSync(join(dir, encodeURIComponent(runId) + '.json'), 'utf8'))
const readProviderStore = (dir) =>
  JSON.parse(readFileSync(join(dir, 'provider-local-count.json'), 'utf8'))

// ── O1/O2/O5（CLI，local-count）─────────────────────────────────────────────
test('O1 同键同参数重放：返回同一结果，不重复执行（AC-02 前半）', () => {
  const dir = opsDir()
  const first = cli('execute', REQ(dir))
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.status, 'confirmed_success')
  assert.equal(first.executed, true)
  assert.equal(first.deduped, false)
  const second = cli('execute', REQ(dir))
  assert.equal(second.ok, true)
  assert.equal(second.status, 'confirmed_success')
  assert.equal(second.deduped, true, '第二次应只确认不执行')
  assert.equal(second.executed, false)
  assert.equal(second.reconciled, false)
  assert.deepEqual(second.remote_ref, first.remote_ref, '远端对象引用一致')
  assert.deepEqual(second.result, first.result, '返回原始结果')
  assert.equal(second.operation_id, first.operation_id, '同键同 operation_id（不因调用次数变化）')
  // 参数键序不同 = 同一规范参数（canonical JSON 摘要）
  const reordered = cli('execute', REQ(dir, { params: { base: 'main', head: 'branch-dev', title: 'feat: x' } }))
  assert.equal(reordered.deduped, true, '参数键序不同仍是同参数')
  const store = readProviderStore(dir)
  assert.equal(store.execute_calls_total, 1, '外部 execute 只真实发生一次')
  assert.equal(Object.keys(store.effects).length, 1, '只产生一个外部效果对象')
})

test('O2 同槽不同目标/授权范围/参数拒绝（AC-02 后半）', () => {
  const dir = opsDir()
  assert.equal(cli('execute', REQ(dir)).ok, true)
  const diffTarget = cli('execute', REQ(dir, { target: 'owner/repo#other-branch' }))
  assert.equal(diffTarget.ok, false)
  assert.equal(diffTarget.code, 'OPERATION_IDENTITY_CONFLICT')
  const diffScope = cli('execute', REQ(dir, { authorization_scope: 'pr:create:other/repo' }))
  assert.equal(diffScope.ok, false)
  assert.equal(diffScope.code, 'OPERATION_IDENTITY_CONFLICT')
  const diffParams = cli('execute', REQ(dir, { params: { title: 'feat: y', base: 'main', head: 'branch-dev' } }))
  assert.equal(diffParams.ok, false)
  assert.equal(diffParams.code, 'OPERATION_PARAM_CONFLICT')
  const store = readProviderStore(dir)
  assert.equal(store.execute_calls_total, 1, '冲突请求不触发任何外部执行')
  const ledger = readLedger(dir)
  assert.equal(ledger.operations.length, 1, '冲突不新建操作槽')
  assert.equal(ledger.operations[0].status, 'confirmed_success')
})

test('O5 账本包含授权、操作、回读与恢复定位字段；重放零写入（AC-04）', () => {
  const dir = opsDir()
  cli('execute', REQ(dir))
  const before = readFileSync(join(dir, encodeURIComponent('run-1') + '.json'), 'utf8')
  cli('execute', REQ(dir))
  assert.equal(readFileSync(join(dir, encodeURIComponent('run-1') + '.json'), 'utf8'), before, '重放不改写账本（零写入）')
  const g = cli('get', { operations_dir: dir, run_id: 'run-1', logical_action: 'create-review' })
  assert.equal(g.found, true)
  const op = g.operation
  assert.equal(op.authorization_ref, 'approval-2026-09-14#1', '授权引用在账')
  assert.equal(op.authorization_scope, 'pr:create:owner/repo', '授权范围在账')
  assert.ok(op.operation_id.startsWith('op-'), '操作标识在账')
  assert.deepEqual(op.remote_ref, { system: 'local-count', id: 'lc-create-review-1', version: 1 }, '回读凭证（远端对象 ID/版本）在账')
  const kinds = op.events.map((e) => e.kind)
  for (const k of ['plan', 'authorize', 'execute_start', 'execute_result']) {
    assert.ok(kinds.includes(k), '事件流含 ' + k)
  }
})

// ── 崩溃替身（进程内注册）：外部效果先落日志，再模拟宿主中断 ────────────────
// journalFile 布局：{ execute_calls, reconcile_calls, effects: { key: { remote_ref } } }
function makeCrashy({ queryWorks }) {
  const journalOf = (dir) => join(dir, 'crashy-journal.json')
  const load = (dir) => {
    if (!existsSync(journalOf(dir))) return { execute_calls: 0, reconcile_calls: 0, effects: {} }
    return JSON.parse(readFileSync(journalOf(dir), 'utf8'))
  }
  const save = (dir, j) => writeFileSync(journalOf(dir), JSON.stringify(j, null, 2))
  return {
    id: 'crashy',
    execute(input) {
      const j = load(input.operations_dir)
      j.execute_calls += 1
      if (!j.effects[input.idempotency_key]) {
        j.effects[input.idempotency_key] = { remote_ref: { system: 'crashy', id: 'cr-' + j.execute_calls, version: 1 } }
      }
      save(input.operations_dir, j)
      throw new Error('CRASH_SIMULATED_AFTER_EFFECT（外部已生效、本地确认前中断）')
    },
    reconcile(input) {
      const j = load(input.operations_dir)
      j.reconcile_calls += 1
      save(input.operations_dir, j)
      if (!queryWorks) return { status: 'unknown', detail: '查询服务不可用（替身）' }
      const effect = j.effects[input.idempotency_key]
      return effect
        ? { status: 'confirmed_success', remote_ref: effect.remote_ref, result: { via: 'reconcile' } }
        : { status: 'confirmed_not_executed', detail: '无效果记录' }
    },
    _journalOf: journalOf,
    _load: load,
  }
}

test('O3 外部成功但本地确认前崩溃：恢复先查询原目标，不重复执行（AC-01）', () => {
  const dir = opsDir()
  const crashy = makeCrashy({ queryWorks: true })
  const unregister = registerProvider('crashy', crashy)
  try {
    const first = operationsExecute(REQ(dir, { provider: 'crashy' }))
    assert.equal(first.ok, false)
    assert.equal(first.code, 'NEEDS_RECONCILIATION', '执行中断按结果不确定受阻')
    assert.equal(first.status, 'unknown')
    // 外部效果已产生（替身日志），本地账本无确认
    let j = crashy._load(dir)
    assert.equal(j.execute_calls, 1)
    assert.equal(Object.keys(j.effects).length, 1, '外部对象已创建（崩溃前）')
    assert.equal(operationsGet({ operations_dir: dir, run_id: 'run-1', logical_action: 'create-review' }).operation.status, 'unknown')
    // 恢复执行：先 reconcile 原目标 → confirmed_success → 只确认不重发
    const recovery = operationsExecute(REQ(dir, { provider: 'crashy' }))
    assert.equal(recovery.ok, true, JSON.stringify(recovery))
    assert.equal(recovery.status, 'confirmed_success')
    assert.equal(recovery.reconciled, true, '经回读恢复')
    assert.equal(recovery.executed, false, '恢复不重新执行')
    assert.deepEqual(recovery.remote_ref, { system: 'crashy', id: 'cr-1', version: 1 }, '回读取得远端对象')
    j = crashy._load(dir)
    assert.equal(j.execute_calls, 1, '外部动作只执行一次（无第二个 PR/动作）')
    assert.equal(Object.keys(j.effects).length, 1, '未产生第二个外部对象')
    assert.equal(j.reconcile_calls >= 1, true, '恢复先查询原目标')
    const op = operationsGet({ operations_dir: dir, run_id: 'run-1', logical_action: 'create-review' }).operation
    assert.equal(op.status, 'confirmed_success')
    assert.equal(op.needs_reconciliation, false)
  } finally { unregister() }
})

test('O4a 结果不确定且查询不可用：待核查受阻，不再次执行（AC-03 前半）', () => {
  const dir = opsDir()
  const crashy = makeCrashy({ queryWorks: false })
  const unregister = registerProvider('crashy', crashy)
  try {
    const first = operationsExecute(REQ(dir, { provider: 'crashy' }))
    assert.equal(first.ok, false)
    assert.equal(first.code, 'NEEDS_RECONCILIATION')
    // 恢复尝试：查询仍不可用 → 继续受阻，绝不重发
    const retry = operationsExecute(REQ(dir, { provider: 'crashy' }))
    assert.equal(retry.ok, false)
    assert.equal(retry.code, 'NEEDS_RECONCILIATION')
    assert.equal(retry.blocked, true)
    const j = crashy._load(dir)
    assert.equal(j.execute_calls, 1, 'unknown 禁止重复执行')
    assert.equal(j.reconcile_calls, 1, '恢复走了核查而非重发')
    const op = operationsGet({ operations_dir: dir, run_id: 'run-1', logical_action: 'create-review' }).operation
    assert.equal(op.status, 'unknown')
    assert.equal(op.needs_reconciliation, true, '账本标记需核查')
  } finally { unregister() }
})

test('O4b 确认未执行后可安全重试（AC-03 后半）', () => {
  const dir = opsDir()
  // flaky：首次执行在产生外部效果前中断；核查可确认「未执行」
  let attempts = 0
  const calls = { reconcile: 0 }
  const unregister = registerProvider('flaky', {
    execute() {
      attempts += 1
      if (attempts === 1) throw new Error('FLAKY_CRASH_BEFORE_EFFECT（外部未生效即中断）')
      return { status: 'confirmed_success', remote_ref: { system: 'flaky', id: 'fl-1', version: 1 }, result: { attempt: attempts } }
    },
    reconcile() {
      calls.reconcile += 1
      return attempts === 0 ? { status: 'unknown' } : { status: 'confirmed_not_executed', detail: '未产生外部对象' }
    },
  })
  try {
    const first = operationsExecute(REQ(dir, { provider: 'flaky' }))
    assert.equal(first.ok, false)
    assert.equal(first.code, 'NEEDS_RECONCILIATION')
    const second = operationsExecute(REQ(dir, { provider: 'flaky' }))
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(second.status, 'confirmed_success')
    assert.equal(second.executed, true, '确认未执行后安全重试真正执行')
    assert.equal(second.reconciled, false)
    assert.equal(calls.reconcile, 1, '重试前先核查')
    assert.equal(attempts, 2)
    const op = operationsGet({ operations_dir: dir, run_id: 'run-1', logical_action: 'create-review' }).operation
    assert.equal(op.status, 'confirmed_success')
    const kinds = op.events.map((e) => e.kind)
    assert.ok(kinds.includes('reconcile'), '核查结论入账（恢复记录）')
    assert.ok(kinds.filter((k) => k === 'execute_start').length === 2, '两次执行尝试都有登记')
  } finally { unregister() }
})

test('O5b 恢复路径账本含恢复记录（recover 事件）与回读凭证（AC-04）', () => {
  const dir = opsDir()
  const crashy = makeCrashy({ queryWorks: true })
  const unregister = registerProvider('crashy', crashy)
  try {
    operationsExecute(REQ(dir, { provider: 'crashy' }))
    operationsExecute(REQ(dir, { provider: 'crashy' }))
    const op = operationsGet({ operations_dir: dir, run_id: 'run-1', logical_action: 'create-review' }).operation
    const kinds = op.events.map((e) => e.kind)
    for (const k of ['plan', 'authorize', 'execute_start', 'execute_error', 'recover']) {
      assert.ok(kinds.includes(k), '账本事件含 ' + k + '（授权/操作/回读与恢复记录）')
    }
    const recover = op.events.find((e) => e.kind === 'recover')
    assert.deepEqual(recover.detail.remote_ref, { system: 'crashy', id: 'cr-1', version: 1 })
  } finally { unregister() }
})

// ── O6~O8（CLI fail-closed 边界）───────────────────────────────────────────
test('O6 缺授权引用 fail-closed：不建账、不外呼', () => {
  const dir = opsDir()
  const r = cli('execute', REQ(dir, { authorization_ref: '' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'AUTHORIZATION_REQUIRED')
  assert.equal(existsSync(join(dir, encodeURIComponent('run-1') + '.json')), false, '不留下任何操作槽')
  assert.equal(existsSync(join(dir, 'provider-local-count.json')), false, '不触发外部适配器')
})

test('O7 未接线平台返回 capability_unavailable；未知 provider 拒绝', () => {
  const dir = opsDir()
  const gh = cli('execute', REQ(dir, { provider: 'github' }))
  assert.equal(gh.ok, false)
  assert.equal(gh.code, 'capability_unavailable', '已声明未接线的平台显式返回 capability_unavailable')
  assert.equal(existsSync(join(dir, encodeURIComponent('run-1') + '.json')), false, '不可用能力不建操作槽')
  const unknown = cli('execute', REQ(dir, { provider: 'carrier-pigeon' }))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'invalid_provider')
})

test('O8 非法操作形状拒绝（V1 只覆盖 create-review/merge/close-task）', () => {
  const dir = opsDir()
  const r = cli('execute', REQ(dir, { logical_action: 'deploy-prod' }))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'INVALID_LOGICAL_ACTION')
  assert.equal(existsSync(join(dir, encodeURIComponent('run-1') + '.json')), false)
})

// ── O9 三类操作形状共用语义（UAT-01）───────────────────────────────────────
test('O9 create-review / merge / close-task 三形状同键防重各自独立', () => {
  const dir = opsDir()
  for (const action of ['create-review', 'merge', 'close-task']) {
    const first = cli('execute', REQ(dir, { logical_action: action, target: 'owner/repo#' + action }))
    assert.equal(first.ok, true, action + ' 首次执行')
    assert.equal(first.status, 'confirmed_success')
    const again = cli('execute', REQ(dir, { logical_action: action, target: 'owner/repo#' + action }))
    assert.equal(again.deduped, true, action + ' 重放只确认')
    assert.ok(first.operation_id.startsWith('op-'))
  }
  const store = readProviderStore(dir)
  assert.equal(store.execute_calls_total, 3, '三个动作各执行一次')
  assert.equal(Object.keys(store.effects).length, 3, '三个外部对象（每形状一个）')
})

// ── O10/O11 查询命令 ────────────────────────────────────────────────────────
test('O10 独立 reconcile 只查询不执行：未执行可安全重试、不可核查则受阻', () => {
  const dir = opsDir()
  const missing = cli('reconcile', { operations_dir: dir, run_id: 'run-1', logical_action: 'merge' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'OPERATION_NOT_FOUND')
  // 已确认成功的槽：reconcile 复核仍确认成功，不产生新执行
  cli('execute', REQ(dir, { logical_action: 'merge', target: 'owner/repo#pr-1' }))
  const checked = cli('reconcile', { operations_dir: dir, run_id: 'run-1', logical_action: 'merge' })
  assert.equal(checked.ok, true)
  assert.equal(checked.status, 'confirmed_success')
  assert.equal(readProviderStore(dir).execute_calls_total, 1, 'reconcile 不触发执行')
})

test('O11 list 汇总 run 内全部操作槽', () => {
  const dir = opsDir()
  cli('execute', REQ(dir, { logical_action: 'merge', target: 'owner/repo#pr-1' }))
  const l = cli('list', { operations_dir: dir, run_id: 'run-1' })
  assert.equal(l.ok, true)
  assert.equal(l.count, 1)
  assert.equal(l.operations[0].logical_action, 'merge')
  assert.equal(l.operations[0].status, 'confirmed_success')
  assert.equal(l.operations[0].authorization_ref, 'approval-2026-09-14#1')
})

// ── O12 生成器：closeout 节点注入恢复防重规则（WR-012 行为层）───────────────
const seedBp = JSON.parse(readFileSync(join(here, '..', '..', 'templates', 'custom-seeds', 'dev-workflow-2-0.json'), 'utf8'))
const fanoutBp = JSON.parse(readFileSync(join(here, 'fixtures', 'fanout-blueprint.json'), 'utf8'))

test('O12 生成器：closeout 节点注入恢复/重试防重规则，非 closeout 蓝图不受影响', () => {
  const { script } = compileBlueprint(seedBp)
  assert.ok(script.includes('function managedOpsStep(id)'), '编译脚本应携带 managedOpsStep')
  assert.ok(script.includes('+ managedOpsStep(id)'), 'closeout 蓝图在节点提示词拼接防重规则')
  assert.ok(script.includes('恢复/重试防重（WR-012）'), '规则文本随 closeout 蓝图注入')
  const { script: fanoutScript } = compileBlueprint(fanoutBp)
  assert.ok(!fanoutScript.includes('managedOpsStep'), '无 closeout 节点的蓝图零注入（fanout 夹具仅 dev/review）')
  assert.ok(!fanoutScript.includes('恢复/重试防重（WR-012）'), '无 closeout 节点的蓝图产物不含规则文本')
})
