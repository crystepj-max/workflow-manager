// ── #75 S-4：运行看板只读摘要投影内核（§6 八项中宿主可判定的部分）─────────────
// 纯函数：lr（逻辑运行记录）与引擎记录经参数注入，输入不可变；数据不可确定时
// 返回 null，不猜测。dist 侧分发（构建复制），不占动态载荷预算。
//
// 预算权威口径（设计 s4-run-dashboard-001 §3）：当前活跃段引擎记录的
// budgetUsed/maxRounds（无活跃段取最新段）；缺失即 null（缺失 ≠ 0），
// 不读当前模板 control.maxRounds 兜底（冻结快照 config 不含该字段，已核实）。
// 快照 revision 仅在唯一 active 时可信；最近事件只取真实入档记录
// （control_events 与带有效时间的业务结果），不用 updated_at 伪造。
const lifecycleMeta = {
  RUNNING: ['dashLifecycleRunning', null, false],
  WAITING_HUMAN: ['dashLifecycleWaitingHuman', 'dashNeedDecision', false],
  BLOCKED: ['dashLifecycleBlocked', 'dashNeedUnblock', false],
  PAUSED: ['dashLifecyclePaused', 'dashPausedResumable', false],
  COMPLETED: ['dashLifecycleCompleted', null, true],
  FAILED: ['dashLifecycleFailed', null, true],
  STOPPED: ['dashLifecycleStopped', null, true],
}
const eventMeta = {
  pause_requested: 'dashEventPause', paused: 'dashEventPause',
  interrupt_requested: 'dashEventInterrupt', interrupted: 'dashEventInterrupt',
  guidance: 'dashEventGuidance', human_decision_recorded: 'dashEventHumanDecision',
}
const eventKey = (type) => eventMeta[type] || (/^evaluation_baseline/.test(type) || type === 'baseline_change' ? 'dashEventBaseline' : type)

function dashboardProjectionOf(lr, getRun) {
  const missing = { lifecycle: null, lifecycle_key: null, lifecycle_hint_key: null, lifecycle_terminal: false, budget_used: null, budget_limit: null, snapshot_revision: null, last_outcome: null, last_event: null, summary_fields: [] }
  if (!lr || typeof lr !== 'object') return { ...missing }
  const out = { ...missing }
  out.lifecycle = (lr.lifecycle && typeof lr.lifecycle.state === 'string' && lr.lifecycle.state) ? lr.lifecycle.state : null
  const meta = lifecycleMeta[out.lifecycle]
  if (meta) [out.lifecycle_key, out.lifecycle_hint_key, out.lifecycle_terminal] = meta
  const active = (lr.snapshots || []).filter((s) => s && s.active === true)
  out.snapshot_revision = active.length === 1 && Number.isFinite(active[0].revision) ? active[0].revision : null
  const segs = (lr.segments || []).filter((s) => s && s.run_id != null)
  const actSegs = segs.filter((s) => s.active === true)
  // 预算权威段必须唯一可确定：多活跃段属异常记录，保守降级为未记录（不取最大 index 猜测）
  const seg = actSegs.length === 1 ? actSegs[0] : (actSegs.length === 0 && segs.length ? segs[segs.length - 1] : null)
  const run = seg ? getRun(seg.run_id) : null
  if (run && typeof run === 'object') {
    if (Number.isFinite(run.budgetUsed)) out.budget_used = run.budgetUsed
    if (Number.isFinite(run.maxRounds)) out.budget_limit = run.maxRounds
  }
  const outs = []
  for (const nodeId of Object.keys(lr.business_outcomes || {})) {
    const v = lr.business_outcomes[nodeId]
    if (!v || v.outcome === undefined || v.outcome === null || !Number.isFinite(v.at)) continue
    outs.push({ node: String(nodeId), outcome: v.outcome, at: v.at, segment: Number.isFinite(v.segment) ? v.segment : -1 })
  }
  if (outs.length) {
    outs.sort((a, b) => (b.at - a.at) || (b.segment - a.segment) || (a.node < b.node ? -1 : (a.node > b.node ? 1 : 0)))
    out.last_outcome = { node: outs[0].node, outcome: outs[0].outcome, at: outs[0].at }
  }
  const evs = []
  for (const e of lr.control_events || []) {
    if (e && typeof e.type === 'string' && e.type && Number.isFinite(e.at)) evs.push({ source: 'control', type: e.type, at: e.at })
  }
  if (out.last_outcome) evs.push({ source: 'node_outcome', type: null, at: out.last_outcome.at })
  if (evs.length) {
    evs.sort((a, b) => (b.at - a.at) || (a.source === b.source ? 0 : (a.source === 'control' ? -1 : 1)))
    out.last_event = { source: evs[0].source, type: evs[0].type, at: evs[0].at }
  }
  const ended = out.lifecycle_terminal
  const budget = out.budget_used === null && out.budget_limit === null
    ? null
    : `${out.budget_used === null ? '—' : out.budget_used} / ${out.budget_limit === null ? '—' : out.budget_limit}`
  const lastEvent = out.last_event && {
    key: out.last_event.source === 'node_outcome' ? 'dashEventNodeOutcome' : eventKey(out.last_event.type),
    at: out.last_event.at,
  }
  const lifecycleValue = out.lifecycle_key
    ? { key: out.lifecycle_key, hint: out.lifecycle_hint_key }
    : out.lifecycle
  out.summary_fields = [
    ['dashLifecycleLabel', lifecycleValue],
    ...(run && run.status === 'DONE' && out.lifecycle && !ended ? [['dashStateDesync', '']] : []),
    [ended ? 'dashCurrentNodeEnded' : 'dashCurrentNode', ended ? '' : (run && run.node ? String(run.node) : null)],
    ['dashLastOutcome', out.last_outcome ? `${out.last_outcome.node} · ${out.last_outcome.outcome}` : null],
    ['dashBudget', budget],
    ['dashSnapshot', Number.isFinite(out.snapshot_revision) ? `Rev ${out.snapshot_revision}` : null],
    ['dashLastEvent', lastEvent],
  ]
  return out
}

function logicalRunPayload(rec) {
  return {
    logical_run_id: rec.logical_run_id,
    isolation_guarantee: ['enforced', 'unavailable'].includes(rec.isolation_guarantee) ? rec.isolation_guarantee : 'unknown',
    isolation_probe: rec.isolation_probe || null,
    node_isolation: rec.node_isolation || {},
    isolation_history: rec.isolation_history || [],
    schema: 1,
    task_id: rec.task_id,
    template_id: rec.template_id,
    title: rec.title,
    derived_from: rec.derived_from,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    lifecycle: { state: rec.lifecycle.state, reason: rec.lifecycle.reason },
    terminal: rec.terminal === true,
    completion: rec.completion || null,
    segments: rec.segments.map((s) => {
      const out = { index: s.index, run_id: s.run_id, trigger: s.trigger, started_at: s.started_at, ended_at: s.ended_at, status: s.status, active: s.active === true }
      if (s.decision_id) out.decision_id = s.decision_id
      if (s.initiator) out.initiator = s.initiator
      return out
    }),
    snapshots: rec.snapshots,
    node_attempts: rec.node_attempts,
    business_outcomes: rec.business_outcomes,
    artifact_manifests: rec.artifact_manifests || {},
    guidance: rec.guidance || [],
    control_events: rec.control_events || [],
    baseline_revisions: rec.baseline_revisions || [],
    baseline_applied_upto: rec.baseline_applied_upto || 0,
    last_engine_error: rec.last_engine_error || null,
    pause_state: rec.pause_state || null,
    pause_resume: rec.pause_resume || null,
    // LOC-027：活动评价基线引用与历史版本（不可变副本审计链）
    evaluation_baseline: rec.evaluation_baseline || null,
    evaluation_baselines: rec.evaluation_baselines || [],
    formal_records: rec.formal_records || null,
    workspace: rec.workspace || null,
    human_decisions: rec.human_decisions || [],
    consumed_decisions: rec.consumed_decisions || {},
    human_waits: rec.human_waits || [],
  }
}

// 隔离路由建立前已失败的 Logical Run 仍可被用户查到；无引擎段、无节点执行。
function unstartedIsolationRuns(records) {
  return Array.from(records).filter((r) => !r.segments.length && r.isolation_guarantee === 'unavailable').map((r) => ({
    id: 'logical:' + r.logical_run_id, logical_run_id: r.logical_run_id,
    taskId: r.task_id, workflowId: r.template_id, name: r.title,
    status: r.lifecycle.state, logical_state: r.lifecycle.state,
    startedAt: r.created_at, segment: null, segment_count: 0, execution_not_started: true,
    isolation_guarantee: r.isolation_guarantee, isolation_probe: r.isolation_probe,
  }))
}

function runFromDisk(data, rec) {
  for (const k of Object.keys(rec)) if (data[k] !== undefined && data[k] !== null) rec[k] = data[k]
  rec.meta = { name: String((data.meta && data.meta.name) || ''), description: String((data.meta && data.meta.description) || '') }
  rec.status = typeof data.status === 'string' && data.status ? data.status : 'unknown'
  rec.logs = Array.isArray(rec.logs) ? rec.logs.map(String).slice(-50) : []
  rec.agents = Array.isArray(rec.agents) ? rec.agents.filter((a) => a && typeof a === 'object') : []
  rec.formalRecords = Array.isArray(rec.formalRecords) ? rec.formalRecords : []
  if (!['enforced', 'unavailable'].includes(rec.isolation_guarantee)) rec.isolation_guarantee = 'unknown'
  return rec
}

module.exports = { dashboardProjectionOf, logicalRunPayload, unstartedIsolationRuns, runFromDisk }
