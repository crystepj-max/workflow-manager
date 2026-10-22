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
  // 只归类明确的冻结请求、冻结成功与基线修订；失败、恢复和未知类型保留原标识。
  evaluation_baseline_freeze_requested: 'dashEventBaseline',
  evaluation_baseline_frozen: 'dashEventBaseline', baseline_change: 'dashEventBaseline',
}
const eventKey = (type) => Object.hasOwn(eventMeta, type) ? eventMeta[type] : type

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

module.exports = { dashboardProjectionOf }
