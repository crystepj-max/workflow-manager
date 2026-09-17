// LOC-043：按 Run / 节点 / attempt 关联的质量成本记录（可重建 metrics JSON + 人读摘要）
// 消费 LOC-029 attempt 事件、Formal Records 质量证据与显式价格配置；不猜测 token/价格。

export const SCHEMA = 1
export const UNAVAILABLE = 'unavailable'
export const PARTIAL = 'partial'

export const RETRY_KINDS = new Set(['normal', 'technical_retry', 'business_rework', 'unknown'])

const SENSITIVE_KEYS = /^(prompt|prompt_text|credentials|credential|api_key|authorization|password|secret|token|body|content|message|messages)$/i
const SENSITIVE_URL = /(api[_-]?key|token|secret|password)=/i

export function parseIsoMs(iso) {
  if (iso === undefined || iso === null || iso === '') return null
  const n = Date.parse(String(iso))
  return Number.isFinite(n) ? n : null
}

export function durationMs(startIso, endIso, status) {
  const s = parseIsoMs(startIso)
  const e = parseIsoMs(endIso)
  if (s === null) return { value: null, status: UNAVAILABLE }
  if (e === null || status === 'running' || status === 'partial') {
    return { value: null, status: 'partial' }
  }
  return { value: Math.max(0, e - s), status: 'available' }
}

/** 并行区间墙钟并集（毫秒） */
export function unionIntervalsMs(intervals) {
  const norm = (intervals || [])
    .map((iv) => {
      const s = Number(iv.start_ms)
      const e = Number(iv.end_ms)
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null
      return { start_ms: s, end_ms: e }
    })
    .filter(Boolean)
    .sort((a, b) => a.start_ms - b.start_ms)
  if (!norm.length) return 0
  let total = 0
  let cur = { ...norm[0] }
  for (let i = 1; i < norm.length; i++) {
    const iv = norm[i]
    if (iv.start_ms <= cur.end_ms) cur.end_ms = Math.max(cur.end_ms, iv.end_ms)
    else { total += cur.end_ms - cur.start_ms; cur = { ...iv } }
  }
  return total + (cur.end_ms - cur.start_ms)
}

export function sumDurations(items) {
  let sum = 0
  let partial = false
  for (const it of items || []) {
    const d = it.duration_ms
    if (!d || d.status === UNAVAILABLE) continue
    if (d.status === 'partial') { partial = true; continue }
    if (d.status === 'available' && Number.isFinite(d.value)) sum += d.value
  }
  return { value: sum, status: partial ? PARTIAL : 'available' }
}

/** 稳定 attempt 身份去重：同 attempt_id 取最新 revision（状态更新不增调用次数） */
export function dedupeAttempts(attempts) {
  const byId = new Map()
  for (const a of attempts || []) {
    const id = String(a.attempt_id || '')
    if (!id) continue
    const prev = byId.get(id)
    const rev = Number(a.record && a.record.record_revision) || 0
    const prevRev = prev ? Number(prev.record && prev.record.record_revision) || 0 : -1
    if (!prev || rev >= prevRev) byId.set(id, a)
  }
  return [...byId.values()].sort((x, y) => {
    const seg = (Number(x.segment) || 0) - (Number(y.segment) || 0)
    if (seg !== 0) return seg
    const ak = (s) => {
      const m = /^a(\d+)k(\d+)$/.exec(String(s.attempt_id || ''))
      return m ? Number(m[1]) * 10000 + Number(m[2]) : 0
    }
    return ak(x) - ak(y)
  })
}

export function modelKey(provider, model) {
  return String(provider || 'default') + '/' + String(model || 'default')
}

export function resolveUsage(raw) {
  if (!raw || typeof raw !== 'object') return { status: UNAVAILABLE, source: null, input_tokens: null, output_tokens: null }
  const src = raw.source ? String(raw.source) : 'provider'
  const inTok = Number.isFinite(Number(raw.input_tokens)) ? Number(raw.input_tokens) : null
  const outTok = Number.isFinite(Number(raw.output_tokens)) ? Number(raw.output_tokens) : null
  if (inTok === null && outTok === null) return { status: UNAVAILABLE, source: src, input_tokens: null, output_tokens: null }
  return { status: 'available', source: src, input_tokens: inTok, output_tokens: outTok }
}

export function resolveCost(usage, priceEntry) {
  if (!usage || usage.status !== 'available') return { status: UNAVAILABLE, currency: null, amount: null, source: null }
  if (!priceEntry || typeof priceEntry !== 'object') return { status: UNAVAILABLE, currency: null, amount: null, source: null }
  const inP = Number(priceEntry.input_per_1k)
  const outP = Number(priceEntry.output_per_1k)
  const currency = priceEntry.currency ? String(priceEntry.currency) : null
  const source = priceEntry.source ? String(priceEntry.source) : null
  const inTok = usage.input_tokens
  const outTok = usage.output_tokens
  let known = 0
  let missing = false
  if (inTok !== null) {
    if (Number.isFinite(inP)) known += (inTok / 1000) * inP
    else missing = true
  }
  if (outTok !== null) {
    if (Number.isFinite(outP)) known += (outTok / 1000) * outP
    else missing = true
  }
  if (!Number.isFinite(known) || (inTok === null && outTok === null)) {
    return { status: UNAVAILABLE, currency, amount: null, source }
  }
  if (missing) return { status: PARTIAL, currency, amount: known, source }
  return { status: 'available', currency, amount: known, source }
}

function normalizeRetryKind(v) {
  const k = String(v || 'unknown')
  return RETRY_KINDS.has(k) ? k : 'unknown'
}

export function attemptDetailFromBody(body, priceTable) {
  const v = body && body.value ? body.value : body
  if (!v || typeof v !== 'object') return null
  // records-host list 视图（attemptEntryOf）与 Store body 同形字段兼容
  if (!v.started_at && v.completed_at && !v.ended_at) v.ended_at = new Date(v.completed_at).toISOString()
  const dur = durationMs(v.started_at, v.ended_at, v.status)
  const usage = resolveUsage(v.usage)
  const pm = modelKey(v.provider, v.model)
  const prices = priceTable && priceTable.models ? priceTable.models : {}
  const cost = resolveCost(usage, Object.assign({}, prices[pm], {
    currency: priceTable && priceTable.currency,
    source: priceTable && priceTable.source,
  }))
  return {
    attempt_id: String(v.attempt_id || ''),
    node: String(v.node || ''),
    segment: Number(v.segment) || 0,
    round: Number(v.round) || 0,
    kind: String(v.kind || 'call'),
    status: String(v.status || 'unknown'),
    retry_kind: normalizeRetryKind(v.retry_kind),
    started_at: v.started_at || null,
    ended_at: v.ended_at || null,
    duration_ms: dur,
    provider: String(v.provider || 'default'),
    model: String(v.model || 'default'),
    usage,
    cost,
    outcome: v.outcome === undefined ? null : v.outcome,
    outcome_path: v.outcome_path || null,
    record_ref: body.record_ref || null,
    result_ref: v.result_ref || null,
  }
}

export function humanWaitDetail(wait) {
  const dur = durationMs(wait.started_at, wait.ended_at, wait.ended_at ? 'completed' : 'partial')
  return {
    started_at: wait.started_at || null,
    ended_at: wait.ended_at || null,
    duration_ms: dur,
    reason: wait.reason || 'unknown',
    node: wait.node || null,
  }
}

export function extractQualityEvidence(records) {
  const human = []
  const tests = []
  const proofs = []
  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object') continue
    const kind = String(rec.kind || '')
    const val = rec.body && rec.body.value !== undefined ? rec.body.value : null
    const ref = { record_id: rec.record_id, record_revision: rec.record_revision }
    if (kind === 'proof_decision' && val && typeof val === 'object') {
      proofs.push({
        type: 'proof_decision',
        node: val.node || null,
        verified_branch: val.verified_branch || null,
        verified_head: val.verified_head || null,
        record: ref,
      })
      if (val.node && /review|test|accept/i.test(String(val.node))) {
        tests.push({ node: val.node, record: ref, verified_head: val.verified_head || null })
      }
    }
    if (val && typeof val === 'object' && val.user_choice && val.decision_id) {
      human.push({
        type: 'human_decision',
        decision_id: val.decision_id,
        user_choice: val.user_choice,
        node_id: val.node_id || null,
        record: ref,
      })
    }
  }
  return { human_decisions: human, test_proofs: tests, proof_decisions: proofs }
}

export function qualitySummary(evidence, attempts) {
  const completed = (attempts || []).filter((a) => a.status === 'completed')
  const withOutcome = completed.filter((a) => a.outcome !== null && a.outcome !== undefined)
  const passLike = withOutcome.filter((a) => /pass|accept|done|true/i.test(String(a.outcome)))
  const denom = withOutcome.length
  const num = passLike.length
  const rate = denom === 0
    ? { status: UNAVAILABLE, numerator: 0, denominator: 0, note: '无可用质量样本' }
    : { status: 'available', numerator: num, denominator: denom, note: null }
  return {
    acceptance_rate: rate,
    human_decisions: evidence.human_decisions,
    test_proofs: evidence.test_proofs,
    proof_decisions: evidence.proof_decisions,
    model_self_score_not_acceptance: true,
  }
}

export function buildRunMetrics(input) {
  const logicalRunId = String(input.logical_run_id || '')
  const templateId = input.template_id ? String(input.template_id) : null
  const priceTable = input.price_table || null
  const normalizedAttempts = (input.attempts || []).map((a) => {
    if (a && a.attempt_id) return a
    const v = a && a.body && a.body.value ? a.body.value : (a && a.body ? a.body : a)
    return Object.assign({}, a, { attempt_id: v && v.attempt_id, body: a && a.body ? a.body : { value: v } })
  })
  const rawAttempts = dedupeAttempts(normalizedAttempts)
  const attempts = []
  for (const a of rawAttempts) {
    const body = a.body || (a.attempt_id ? { value: a } : a)
    const detail = attemptDetailFromBody(body, priceTable)
    if (!detail) continue
    detail.record_ref = a.record || detail.record_ref
    attempts.push(detail)
  }
  const humanWaits = (input.human_waits || []).map(humanWaitDetail)
  const autoIntervals = attempts
    .filter((a) => a.duration_ms && a.duration_ms.status === 'available')
    .map((a) => ({
      start_ms: parseIsoMs(a.started_at),
      end_ms: parseIsoMs(a.ended_at),
    }))
  const autoWall = unionIntervalsMs(autoIntervals)
  const autoSum = sumDurations(attempts)
  const waitSum = sumDurations(humanWaits)
  const costs = attempts.map((a) => a.cost).filter((c) => c && c.status !== UNAVAILABLE)
  let costAgg = { status: UNAVAILABLE, currency: priceTable && priceTable.currency ? String(priceTable.currency) : null, amount: null, source: priceTable && priceTable.source ? String(priceTable.source) : null }
  if (costs.length) {
    const partial = costs.some((c) => c.status === PARTIAL)
    const total = costs.reduce((s, c) => s + (Number(c.amount) || 0), 0)
    const allAvail = costs.every((c) => c.status === 'available')
    costAgg = {
      status: allAvail && !partial ? 'available' : PARTIAL,
      currency: costs[0].currency || costAgg.currency,
      amount: total,
      source: costs[0].source || costAgg.source,
    }
  }
  const byRetry = { normal: 0, technical_retry: 0, business_rework: 0, unknown: 0 }
  for (const a of attempts) byRetry[a.retry_kind] = (byRetry[a.retry_kind] || 0) + 1
  const records = input.records || []
  const evidence = extractQualityEvidence(records)
  const quality = qualitySummary(evidence, attempts)
  return {
    schema: SCHEMA,
    logical_run_id: logicalRunId,
    template_id: templateId,
    generated_at: new Date().toISOString(),
    attempts,
    human_waits: humanWaits,
    aggregates: {
      attempt_count: attempts.length,
      retry_kind_counts: byRetry,
      auto_wall_clock_ms: { value: autoWall, status: autoWall > 0 || attempts.length === 0 ? 'available' : UNAVAILABLE },
      auto_call_sum_ms: autoSum,
      human_wait_ms: waitSum,
      known_cost: costAgg,
    },
    quality,
    evidence_notes: [],
  }
}

export function rebuildAggregate(metrics) {
  if (!metrics || typeof metrics !== 'object') return null
  return buildRunMetrics({
    logical_run_id: metrics.logical_run_id,
    template_id: metrics.template_id,
    attempts: (metrics.attempts || []).map((a) => ({ body: { value: a }, record: a.record_ref })),
    human_waits: metrics.human_waits || [],
    records: metrics._records || [],
    price_table: metrics._price_table || null,
  })
}

const TEMPLATE_IDS = [
  'wf-optimize',
  'wf-explore',
  'wf-diagnose',
  'wf-construction-full-feature',
]

export function compareTemplates(runs) {
  const byTpl = new Map()
  for (const r of runs || []) {
    const tid = r.template_id ? String(r.template_id) : 'unknown'
    byTpl.set(tid, r)
  }
  const rows = []
  for (const tid of TEMPLATE_IDS) {
    const m = byTpl.get(tid)
    if (!m) {
      rows.push({ template_id: tid, status: 'no_data', note: '无样本记录' })
      continue
    }
    const n = m.aggregates && m.aggregates.attempt_count ? m.aggregates.attempt_count : 0
    const insufficient = n < 1
    rows.push({
      template_id: tid,
      status: insufficient ? 'insufficient_sample' : 'available',
      attempt_count: n,
      auto_wall_clock_ms: m.aggregates && m.aggregates.auto_wall_clock_ms,
      auto_call_sum_ms: m.aggregates && m.aggregates.auto_call_sum_ms,
      human_wait_ms: m.aggregates && m.aggregates.human_wait_ms,
      known_cost: m.aggregates && m.aggregates.known_cost,
      quality: m.quality,
      note: insufficient ? '样本不足，不作排名' : null,
    })
  }
  return {
    schema: SCHEMA,
    compared_at: new Date().toISOString(),
    templates: rows,
    ranking: null,
    disclaimer: '本报告仅呈现可核实数字；无样本或证据不足时不推断哪种模板更好。',
  }
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.test(String(key || ''))
}

export function redactValue(key, value, depth = 0) {
  if (depth > 8) return '[truncated]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return '[redacted]'
    if (SENSITIVE_URL.test(value)) return '[redacted-url]'
    if (value.length > 500) return value.slice(0, 200) + '…[truncated]'
    return value
  }
  if (Array.isArray(value)) return value.map((v, i) => redactValue(String(i), v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      if (isSensitiveKey(k)) { out[k] = '[redacted]'; continue }
      out[k] = redactValue(k, value[k], depth + 1)
    }
    return out
  }
  return value
}

export function exportDefaultMetrics(metrics) {
  const base = buildRunMetrics(metrics._raw || metrics)
  const exported = redactValue('root', JSON.parse(JSON.stringify(base)))
  exported.privacy = { default_export: true, redacted: true, denied_fields: ['prompt', 'credentials', 'api_key', 'full_message_body'] }
  return exported
}

export function formatHumanReport(metrics) {
  const m = metrics.aggregates ? metrics : buildRunMetrics(metrics._raw || metrics)
  const lines = []
  lines.push('# Run 质量成本摘要')
  lines.push('')
  lines.push('- Run: ' + (m.logical_run_id || '—'))
  lines.push('- 模板: ' + (m.template_id || '—'))
  lines.push('- 调用次数: ' + (m.aggregates.attempt_count || 0))
  const rk = m.aggregates.retry_kind_counts || {}
  lines.push('- 分类: 普通 ' + (rk.normal || 0) + ' · 技术重试 ' + (rk.technical_retry || 0) + ' · 业务返工 ' + (rk.business_rework || 0) + ' · 未知 ' + (rk.unknown || 0))
  const wall = m.aggregates.auto_wall_clock_ms
  lines.push('- 自动墙钟: ' + (wall && wall.status === 'available' ? wall.value + ' ms' : wall && wall.status === 'partial' ? '部分（含未结束）' : UNAVAILABLE))
  const sum = m.aggregates.auto_call_sum_ms
  lines.push('- 累计调用耗时: ' + (sum && sum.status === 'available' ? sum.value + ' ms' : sum && sum.status === PARTIAL ? '部分合计 ' + sum.value + ' ms' : UNAVAILABLE))
  const hw = m.aggregates.human_wait_ms
  lines.push('- 人工等待: ' + (hw && hw.status === 'available' ? hw.value + ' ms' : hw && hw.status === PARTIAL ? '部分 ' + hw.value + ' ms' : '0 ms'))
  const cost = m.aggregates.known_cost
  if (!cost || cost.status === UNAVAILABLE) lines.push('- 已知成本: ' + UNAVAILABLE)
  else lines.push('- 已知成本: ' + cost.amount + ' ' + (cost.currency || '') + (cost.status === PARTIAL ? '（部分合计）' : ''))
  const rate = m.quality && m.quality.acceptance_rate
  if (rate && rate.status === 'available') {
    lines.push('- 质量通过率: ' + rate.numerator + '/' + rate.denominator + '（仅含明确 outcome 证据）')
  } else {
    lines.push('- 质量通过率: ' + UNAVAILABLE + (rate && rate.note ? '（' + rate.note + '）' : ''))
  }
  lines.push('')
  lines.push('## Attempt 明细')
  for (const a of m.attempts || []) {
    lines.push('- ' + a.attempt_id + ' · ' + a.node + ' · ' + a.status + ' · ' + a.retry_kind
      + ' · ' + (a.duration_ms && a.duration_ms.status === 'available' ? a.duration_ms.value + 'ms' : a.duration_ms && a.duration_ms.status === 'partial' ? 'partial' : UNAVAILABLE)
      + ' · usage=' + (a.usage && a.usage.status) + ' · cost=' + (a.cost && a.cost.status))
  }
  if ((m.human_waits || []).length) {
    lines.push('')
    lines.push('## 人工等待区间')
    for (const w of m.human_waits) {
      lines.push('- ' + (w.reason || '—') + ' · ' + (w.duration_ms && w.duration_ms.status === 'available' ? w.duration_ms.value + 'ms' : 'partial'))
    }
  }
  return lines.join('\n')
}

const CLI_COMMANDS = {
  build: (input) => ({ ok: true, metrics: buildRunMetrics(input) }),
  compare: (input) => ({ ok: true, comparison: compareTemplates(input.runs || []) }),
  export: (input) => ({ ok: true, metrics: exportDefaultMetrics(input) }),
  report: (input) => ({ ok: true, report: formatHumanReport(input.metrics || buildRunMetrics(input)) }),
}

if (process.argv.length >= 2 && /run-quality-cost\.mjs$/.test(String(process.argv[1] || ''))) {
  const cmd = process.argv[2]
  const fn = CLI_COMMANDS[cmd]
  if (!fn) {
    console.error('用法: node scripts/run-quality-cost.mjs <build|compare|export|report> \'<json>\'')
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
