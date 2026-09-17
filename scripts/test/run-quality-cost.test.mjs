// LOC-043：质量成本记录 — 契约 docs/tasks/specs/LOC-043-run-quality-cost/task-spec-V1.md §15
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCHEMA,
  UNAVAILABLE,
  PARTIAL,
  unionIntervalsMs,
  dedupeAttempts,
  buildRunMetrics,
  rebuildAggregate,
  compareTemplates,
  exportDefaultMetrics,
  formatHumanReport,
  resolveCost,
} from '../run-quality-cost.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const prices = JSON.parse(readFileSync(join(here, 'fixtures/run-quality-cost/prices.json'), 'utf8'))

function att(id, node, seg, opts = {}) {
  const started = opts.started_at || '2026-09-16T10:00:00.000Z'
  const ended = opts.ended_at !== undefined ? opts.ended_at : '2026-09-16T10:00:30.000Z'
  return {
    attempt_id: id,
    node,
    segment: seg,
    round: opts.round || 0,
    kind: 'call',
    status: opts.status || 'completed',
    retry_kind: opts.retry_kind || 'normal',
    provider: 'p1',
    model: 'm1',
    started_at: started,
    ended_at: ended,
    outcome: opts.outcome,
    usage: opts.usage,
    record: { record_id: 'attempt:run:' + id, record_revision: opts.revision || 1 },
  }
}

test('AC-01：8 次调用样例展示时间/状态，区分业务返工、技术重试与人工等待', () => {
  const attempts = [
    att('a1k1', 'dev', 1, { retry_kind: 'normal' }),
    att('a1k2', 'review', 1, { retry_kind: 'normal', outcome: 'REJECT' }),
    att('a1k3', 'dev', 1, { retry_kind: 'business_rework' }),
    att('a1k4', 'review', 1, { retry_kind: 'normal', outcome: 'REJECT' }),
    att('a1k5', 'dev', 1, { retry_kind: 'business_rework' }),
    att('a1k6', 'review', 1, { retry_kind: 'normal', outcome: 'PASS' }),
    att('a1k7', 'test', 1, { retry_kind: 'technical_retry' }),
    att('a1k8', 'closeout', 1, { retry_kind: 'normal', outcome: 'done' }),
  ]
  const human_waits = [
    { started_at: '2026-09-16T10:05:00.000Z', ended_at: '2026-09-16T10:10:00.000Z', reason: 'WAITING_HUMAN', node: 'review' },
  ]
  const m = buildRunMetrics({
    logical_run_id: 'opt-sample',
    template_id: 'wf-optimize',
    attempts: attempts.map((a) => ({ body: { value: a }, record: a.record })),
    human_waits,
    price_table: prices,
    records: [],
  })
  assert.equal(m.schema, SCHEMA)
  assert.equal(m.attempts.length, 8)
  assert.equal(m.aggregates.retry_kind_counts.business_rework, 2)
  assert.equal(m.aggregates.retry_kind_counts.technical_retry, 1)
  assert.equal(m.human_waits.length, 1)
  assert.equal(m.human_waits[0].duration_ms.status, 'available')
  assert.equal(m.human_waits[0].duration_ms.value, 300000)
  // 并行墙钟：8×30s 同起点若完全并行并集仍为 30s；本夹具各 attempt 同区间 → 并集 30s
  assert.equal(m.aggregates.auto_wall_clock_ms.value, 30000)
  assert.equal(m.aggregates.auto_call_sum_ms.value, 240000)
  const report = formatHumanReport(m)
  assert.ok(report.includes('技术重试 1'))
  assert.ok(report.includes('业务返工 2'))
})

test('AC-02：缺 usage/price、cancel、崩溃与重放去重', () => {
  const attempts = [
    att('a1k1', 'dev', 1, { usage: { input_tokens: 100, output_tokens: 50, source: 'provider' } }),
    att('a1k2', 'dev', 1, { usage: null, retry_kind: 'technical_retry' }),
    att('a1k3', 'review', 1, { status: 'cancelled', ended_at: '2026-09-16T10:00:15.000Z' }),
    att('a1k4', 'gate', 1, { status: 'interrupted', ended_at: '2026-09-16T10:00:20.000Z' }),
    att('a1k5', 'closeout', 1, { status: 'running', ended_at: null }),
    att('a1k1', 'dev', 1, { usage: { input_tokens: 100, output_tokens: 50, source: 'provider' }, revision: 99 }),
  ]
  const deduped = dedupeAttempts(attempts)
  assert.equal(deduped.length, 5, '重放同 attempt_id 不增调用次数')
  const m1 = buildRunMetrics({
    logical_run_id: 'edge',
    attempts: deduped.map((a) => ({ body: { value: a }, record: a.record })),
    price_table: prices,
    records: [],
  })
  assert.equal(m1.attempts.length, 5)
  const withUsage = m1.attempts.find((a) => a.attempt_id === 'a1k1')
  assert.equal(withUsage.cost.status, 'available')
  const noUsage = m1.attempts.find((a) => a.attempt_id === 'a1k2')
  assert.equal(noUsage.usage.status, UNAVAILABLE)
  assert.equal(noUsage.cost.status, UNAVAILABLE)
  const partial = m1.attempts.find((a) => a.attempt_id === 'a1k5')
  assert.equal(partial.duration_ms.status, 'partial')
  const m2 = rebuildAggregate({ ...m1, _price_table: prices, _records: [] })
  assert.equal(m2.aggregates.attempt_count, m1.aggregates.attempt_count)
  assert.equal(m2.aggregates.known_cost.amount, m1.aggregates.known_cost.amount)
})

test('AC-02：缺 price 表时成本 unavailable，已知部分标 partial', () => {
  const c = resolveCost({ status: 'available', input_tokens: 1000, output_tokens: null, source: 'p' }, null)
  assert.equal(c.status, UNAVAILABLE)
  const c2 = resolveCost({ status: 'available', input_tokens: 1000, output_tokens: 500, source: 'p' }, { input_per_1k: 0.01, currency: 'USD' })
  assert.equal(c2.status, PARTIAL)
})

test('AC-03：质量证据可追溯；默认导出不含凭据与提示全文', () => {
  const records = [
    {
      record_id: 'proof:run:review',
      record_revision: 1,
      kind: 'proof_decision',
      body: { value: { node: 'review', verified_branch: 'dev-loc-043-r1', verified_head: 'abc123' } },
    },
    {
      record_id: 'hd:run:1',
      record_revision: 1,
      kind: 'result',
      body: {
        value: {
          decision_id: 'd-1',
          user_choice: 'USER_ACCEPTED',
          node_id: 'review',
          prompt: 'SECRET PROMPT TEXT',
          credentials: { api_key: 'sk-test' },
        },
      },
    },
  ]
  const m = buildRunMetrics({
    logical_run_id: 'qual',
    attempts: [att('a1k1', 'review', 1, { outcome: 'PASS' })].map((a) => ({ body: { value: a }, record: a.record })),
    records,
    price_table: prices,
  })
  assert.equal(m.quality.human_decisions.length, 1)
  assert.equal(m.quality.human_decisions[0].user_choice, 'USER_ACCEPTED')
  assert.equal(m.quality.proof_decisions[0].verified_head, 'abc123')
  assert.equal(m.quality.model_self_score_not_acceptance, true)
  const exp = exportDefaultMetrics({ _raw: { logical_run_id: 'qual', attempts: m.attempts.map((a) => ({ body: { value: a } })), records, price_table: prices } })
  const json = JSON.stringify(exp)
  assert.ok(!json.includes('SECRET PROMPT'))
  assert.ok(!json.includes('sk-test'))
  assert.equal(exp.privacy.redacted, true)
})

test('AC-04：四模板对比，无样本与样本不足显式呈现', () => {
  const full = buildRunMetrics({
    logical_run_id: 't1',
    template_id: 'wf-optimize',
    attempts: [att('a1k1', 'dev', 1)].map((a) => ({ body: { value: a }, record: a.record })),
    price_table: prices,
  })
  const cmp = compareTemplates([
    full,
    buildRunMetrics({ logical_run_id: 't2', template_id: 'wf-explore', attempts: [], price_table: prices }),
    buildRunMetrics({ logical_run_id: 't3', template_id: 'wf-diagnose', attempts: [att('a1k1', 'x', 1)].map((a) => ({ body: { value: a }, record: a.record })), price_table: prices }),
  ])
  assert.equal(cmp.templates.length, 4)
  assert.equal(cmp.ranking, null)
  const opt = cmp.templates.find((t) => t.template_id === 'wf-optimize')
  const constr = cmp.templates.find((t) => t.template_id === 'wf-construction-full-feature')
  assert.equal(opt.status, 'available')
  assert.equal(constr.status, 'no_data')
  assert.ok(cmp.disclaimer.includes('不推断'))
})

test('unionIntervalsMs：并行区间不重复算墙钟', () => {
  assert.equal(unionIntervalsMs([
    { start_ms: 0, end_ms: 100 },
    { start_ms: 50, end_ms: 150 },
  ]), 150)
  assert.equal(unionIntervalsMs([
    { start_ms: 0, end_ms: 100 },
    { start_ms: 200, end_ms: 300 },
  ]), 200)
})
