// #75 S-4：运行看板只读摘要投影与行展示格式化纯函数单测
// 覆盖设计 T-S4 的宿主可判定负向项：预算缺失 ≠ 0、不跨段累加、旧检查点不覆盖、
// 快照 0/多 active 不取最大、Outcome 排序稳定且排除无效时间、无事件不用
// updated_at 伪造、旧记录全 null、输入不可变；以及客户端 Lifecycle/事件/预算映射。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const { dashboardProjectionOf } = require(join(here, '../../../scripts/dashboard-projection.cjs'))
assert.equal(typeof dashboardProjectionOf, 'function', '内核导出 dashboardProjectionOf 纯函数')

const deep = (x) => JSON.parse(JSON.stringify(x))
const field = (plan, key) => plan.summary_fields.find(([k]) => k === key)?.[1]

const lrBase = () => ({
  logical_run_id: 't1',
  lifecycle: { state: 'RUNNING', reason: null },
  terminal: false,
  completion: null,
  segments: [{ index: 1, run_id: 'run-1', active: true }],
  snapshots: [{ revision: 1, active: true }],
  node_attempts: [],
  business_outcomes: {},
  control_events: [],
  pause_resume: null,
})

test('完整投影：活跃段预算 / 唯一 active 快照 / 最近结果 / 最近事件', () => {
  const lr = lrBase()
  lr.business_outcomes = {
    evaluate: { outcome: 'OPTIMIZE', path: '$.route', segment: 1, snapshot_revision: 1, at: 1000 },
    closeout: { outcome: 'PASS', path: '$.verdict', segment: 1, snapshot_revision: 1, at: 2000 },
  }
  lr.control_events = [{ type: 'paused', at: 1500 }, { type: 'guidance', at: 2500 }]
  const run = { budgetUsed: 1, maxRounds: 3 }
  const plan = dashboardProjectionOf(lr, (rid) => (rid === 'run-1' ? run : null))
  assert.equal(plan.lifecycle, 'RUNNING')
  assert.equal(plan.snapshot_revision, 1)
  assert.deepEqual(plan.budget_used, 1)
  assert.deepEqual(plan.budget_limit, 3)
  assert.deepEqual(plan.last_outcome, { node: 'closeout', outcome: 'PASS', at: 2000 })
  assert.deepEqual(plan.last_event, { source: 'control', type: 'guidance', at: 2500 })
})

test('多活跃段属异常记录：预算保守降级为 null（不取最大 index 猜测）', () => {
  const lr = lrBase()
  lr.segments = [
    { index: 1, run_id: 'run-1', active: true },
    { index: 2, run_id: 'run-2', active: true },
  ]
  const runs = { 'run-1': { budgetUsed: 2, maxRounds: 3 }, 'run-2': { budgetUsed: 0, maxRounds: 3 } }
  const plan = dashboardProjectionOf(lr, (rid) => runs[rid])
  assert.equal(plan.budget_used, null)
  assert.equal(plan.budget_limit, null)
  // 快照与生命周期判定不受影响
  assert.equal(plan.lifecycle, 'RUNNING')
})

test('T-S4-04 跨段：预算取活跃段最新值，不跨段累加；快照取唯一 active', () => {
  const lr = lrBase()
  lr.segments = [
    { index: 1, run_id: 'run-1', active: false },
    { index: 2, run_id: 'run-2', active: true },
  ]
  lr.snapshots = [{ revision: 1, active: false }, { revision: 2, active: true }]
  const runs = { 'run-1': { budgetUsed: 2, maxRounds: 3 }, 'run-2': { budgetUsed: 2, maxRounds: 3 } }
  const plan = dashboardProjectionOf(lr, (rid) => runs[rid])
  assert.deepEqual(plan.budget_used, 2)
  assert.deepEqual(plan.budget_limit, 3)
  assert.equal(plan.snapshot_revision, 2)
})

test('T-S4-08/T-S4-09 预算缺失 ≠ 0：字段缺失为 null，旧检查点不参与', () => {
  const lr = lrBase()
  lr.pause_resume = { budgetUsed: 2, maxRounds: 3 }
  const plan = dashboardProjectionOf(lr, () => ({}))
  assert.equal(plan.budget_used, null, '引擎记录无字段 → null，不转 0')
  assert.equal(plan.budget_limit, null)
  assert.ok(!('budget' in plan) || plan.budget_used !== plan.pause_resume, '恢复检查点不进入投影')
})

test('T-S4-09 反例：新段预算缺失时不得继承旧段数值', () => {
  const lr = lrBase()
  lr.segments = [
    { index: 1, run_id: 'run-1', active: false },
    { index: 2, run_id: 'run-2', active: true },
  ]
  const runs = { 'run-1': { budgetUsed: 2, maxRounds: 3 }, 'run-2': {} }
  const plan = dashboardProjectionOf(lr, (rid) => runs[rid])
  assert.equal(plan.budget_used, null)
  assert.equal(plan.budget_limit, null)
})

test('T-S4-10 快照 0 个或多个 active：不任意取最大 revision', () => {
  const lr0 = lrBase()
  lr0.snapshots = []
  assert.equal(dashboardProjectionOf(lr0, () => ({})).snapshot_revision, null)
  const lr2 = lrBase()
  lr2.snapshots = [{ revision: 1, active: true }, { revision: 3, active: true }]
  assert.equal(dashboardProjectionOf(lr2, () => ({})).snapshot_revision, null)
})

test('T-S4-11 Outcome 排序：at 降序、无效时间排除、同刻按段与节点稳定排序', () => {
  const lr = lrBase()
  lr.business_outcomes = {
    a_node: { outcome: 'PASS', at: 2000 },
    b_node: { outcome: 'PASS', at: 'bad' },
    c_node: { outcome: 'OPTIMIZE', at: 3000, segment: 2 },
    d_node: { outcome: 'CONFIRM', at: 3000, segment: 1 },
  }
  const plan = dashboardProjectionOf(lr, () => ({}))
  assert.equal(plan.last_outcome.node, 'c_node')
  assert.equal(plan.last_outcome.outcome, 'OPTIMIZE')
})

test('T-S4-12 无 control_events：不用 updated_at 伪造；带时间的业务结果可作为最近事件', () => {
  const lr = lrBase()
  lr.updated_at = 9999
  const plan = dashboardProjectionOf(lr, () => ({}))
  assert.equal(plan.last_event, null)
  lr.business_outcomes = { evaluate: { outcome: 'PASS', at: 5000 } }
  const plan2 = dashboardProjectionOf(lr, () => ({}))
  assert.equal(plan2.last_event.source, 'node_outcome')
  assert.equal(plan2.last_event.at, 5000)
})

test('T-S4-06 旧记录 / T-S4-07 详情缺失：lr 缺失全 null，输入不可变', () => {
  const plan = dashboardProjectionOf(null, () => null)
  assert.deepEqual(plan, { lifecycle: null, lifecycle_key: null, lifecycle_hint_key: null, lifecycle_terminal: false, budget_used: null, budget_limit: null, snapshot_revision: null, last_outcome: null, last_event: null, summary_fields: [] })
  const lr = lrBase()
  lr.business_outcomes = { e: { outcome: 'PASS', at: 1 } }
  lr.control_events = [{ type: 'paused', at: 2 }]
  const snapshot = deep(lr)
  dashboardProjectionOf(lr, () => null)
  assert.deepEqual(lr, snapshot, '输入逻辑运行记录不可变')
})

// ── 展示字段映射在 dist 外的纯投影中完成，动态客户端只做通用字段渲染 ──
test('Lifecycle / Completion Type 保持独立；终态不伪造当前节点', () => {
  const lr = lrBase()
  lr.lifecycle.state = 'WAITING_HUMAN'
  lr.completion = { type: 'EVALUATION_PASSED' }
  const plan = dashboardProjectionOf(lr, () => ({ node: 'review', status: 'DONE' }))
  assert.equal(plan.lifecycle, 'WAITING_HUMAN')
  assert.equal(plan.lifecycle_key, 'dashLifecycleWaitingHuman')
  assert.equal(plan.lifecycle_hint_key, 'dashNeedDecision')
  assert.equal(plan.lifecycle_terminal, false)
  assert.deepEqual(field(plan, 'dashLifecycleLabel'), { key: 'dashLifecycleWaitingHuman', hint: 'dashNeedDecision' })
  assert.equal(field(plan, 'dashCurrentNode'), 'review')
  assert.equal(field(plan, 'dashStateDesync'), '')

  lr.lifecycle.state = 'COMPLETED'
  const ended = dashboardProjectionOf(lr, () => ({ node: 'closeout' }))
  assert.equal(ended.lifecycle_terminal, true)
  assert.equal(field(ended, 'dashCurrentNodeEnded'), '')
  assert.equal(ended.lifecycle_key, 'dashLifecycleCompleted')
})

test('事件类型映射：已知生产者归类，未知类型保留原始标识', () => {
  for (const [type, key] of [
    ['paused', 'dashEventPause'], ['pause_requested', 'dashEventPause'],
    ['interrupt_requested', 'dashEventInterrupt'], ['interrupted', 'dashEventInterrupt'],
    ['guidance', 'dashEventGuidance'], ['human_decision_recorded', 'dashEventHumanDecision'],
    ['something_new', 'something_new'],
  ]) {
    const lr = lrBase()
    lr.control_events = [{ type, at: 2000 }]
    assert.deepEqual(field(dashboardProjectionOf(lr, () => ({})), 'dashLastEvent'), { key, at: 2000 })
  }
  const lr = lrBase()
  lr.business_outcomes = { review: { outcome: 'PASS', at: 3000 } }
  assert.deepEqual(field(dashboardProjectionOf(lr, () => ({})), 'dashLastEvent'), { key: 'dashEventNodeOutcome', at: 3000 })
})

// WFM-463：白名单对应宿主真实生产者；恢复事件的 terminal 不保证成功，
// 冻结失败 / 摘要不符 / 核验冲突 / 闸门阻断均不得被归成成功冻结文案。
for (const [type, data, key] of [
  ['evaluation_baseline_freeze_requested', { version: 1, claimed_digest: 'claimed' }, 'dashEventBaseline'],
  ['evaluation_baseline_frozen', { version: 1, digest: 'verified', artifact_path: 'v1/contract.md' }, 'dashEventBaseline'],
  ['baseline_change', { revision: 2, guidance_seq: 1 }, 'dashEventBaseline'],
  ['baseline_rebase', { revision: 2, entry: 'confirm' }, 'baseline_rebase'],
  ['evaluation_baseline_resumed', { version: 1, terminal: 'FAILED' }, 'evaluation_baseline_resumed'],
  ['evaluation_baseline_freeze_failed', { version: 1, code: 'FILE_MISSING' }, 'evaluation_baseline_freeze_failed'],
  ['evaluation_baseline_digest_mismatch', { version: 1, code: 'FROZEN', claimed: 'claimed', actual: 'verified' }, 'evaluation_baseline_digest_mismatch'],
  ['evaluation_baseline_conflict', { version: 1, code: 'SOURCE_REWRITTEN' }, 'evaluation_baseline_conflict'],
  ['evaluation_baseline_gate', { decision: 'blocked', code: 'EVALUATION_BASELINE_RESUME_LOST', version: 1 }, 'evaluation_baseline_gate'],
]) {
  test(`WFM-463 实际评价基线事件投影：${type}（与 Lifecycle / Completion 独立）`, () => {
    for (const state of ['RUNNING', 'BLOCKED', 'FAILED', 'COMPLETED']) {
      const lr = lrBase()
      lr.lifecycle.state = state
      lr.completion = { type: 'EVALUATION_PASSED' }
      lr.control_events = [{ type, at: 2000, ...data }]
      const plan = dashboardProjectionOf(lr, () => ({}))
      assert.deepEqual(plan.last_event, { source: 'control', type, at: 2000 })
      assert.deepEqual(field(plan, 'dashLastEvent'), { key, at: 2000 })
      assert.equal(plan.lifecycle, state)
    }
  })
}

test('WFM-463 未识别评价基线事件和原型名称保留原类型，不按前缀推断成功', () => {
  for (const type of [
    'evaluation_baseline', 'evaluation_baseline_unknown', 'evaluation_baseline_frozen_extra',
    'evaluation_baseline_freeze_requested_v2', 'baseline_change_failed',
    'constructor', 'toString', '__proto__',
  ]) {
    const lr = lrBase()
    lr.control_events = [{ type, at: 2000 }]
    const plan = dashboardProjectionOf(lr, () => ({}))
    assert.deepEqual(field(plan, 'dashLastEvent'), { key: type, at: 2000 })
  }
})

test('摘要预算格式：缺失 ≠ 0，单边缺失保留另一边', () => {
  const lr = lrBase()
  assert.equal(field(dashboardProjectionOf(lr, () => ({})), 'dashBudget'), null)
  assert.equal(field(dashboardProjectionOf(lr, () => ({ budgetUsed: 1 })), 'dashBudget'), '1 / —')
  assert.equal(field(dashboardProjectionOf(lr, () => ({ budgetUsed: 0, maxRounds: 3 })), 'dashBudget'), '0 / 3')
})
