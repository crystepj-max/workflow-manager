// LOC-044 状态与恢复约定——纯计算内核（唯一实现）。
// 消费方：生成器 compileBlueprint 编译期内联；宿主经 dist loadDist 加载；测试直接 require。
// 纯计算：不访问文件、不调用 DSH、不修改调用方对象。
'use strict'

const CHECKPOINT_MARKER = '[pw-ckpt]'
const CHECKPOINT_END_ENTRY = '$end'

// 脚本权威终态集合：workflow/end 不得盖写已确定的终态（#80 PAUSED、LOC-030 BLOCKED 同理）
const TERMINAL_STATUS_RE = /^(DONE|STOPPED|WAITING_HUMAN|PAUSED|BLOCKED|AWAITING_HUMAN_.+|FAILED_AT_.+|FAILED_MAX_ROUNDS|FAILED_ITEM_CAP|FAILED_AGENT_CAP|TECHNICAL_FAILURE|ENDED_NO_SUCCESS_EDGE|ENDED_NO_FAILURE_EDGE|ENDED_NO_OUTCOME_EDGE|ROUTE_HALTED|ERROR)$/

function isHumanWaitStatus(status) {
  return status === 'WAITING_HUMAN' || String(status || '').indexOf('AWAITING_HUMAN_') === 0
}

function isTerminalStatus(status) {
  return TERMINAL_STATUS_RE.test(String(status || ''))
}

function canonicalStopFromResult(result) {
  const v = result && result.value
  const cand = v && typeof v === 'object' && typeof v.status === 'string' ? v.status : (typeof v === 'string' ? v : '')
  return TERMINAL_STATUS_RE.test(cand) ? cand : ''
}

function lifecycleForStatus(canon, stopReason) {
  if (canon === 'DONE') return 'COMPLETED'
  if (canon === 'STOPPED') return 'STOPPED'
  if (canon === 'BLOCKED') return 'BLOCKED'
  if (isHumanWaitStatus(canon)) return 'WAITING_HUMAN'
  if (canon || stopReason === 'cancelled' || stopReason === 'error') return 'FAILED'
  return null
}

function isParkedHumanDecision(rec) {
  return !!rec && (rec.status === 'WAITING_HUMAN' || (rec.status === 'completed' && !!rec.decision_id && !!rec.decision_package && typeof rec.decision_package === 'object'))
}

function buildCheckpointCompact(fields) {
  const f = fields || {}
  const out = {
    c: f.entry,
    r: f.results && typeof f.results === 'object' ? f.results : {},
    h: Array.isArray(f.history) ? f.history : [],
    rd: Number(f.round) || 0,
    fb: typeof f.feedback === 'string' ? f.feedback : '',
    bu: Number(f.budgetUsed) || 0,
    mr: Number(f.maxRounds) || 0,
    ds: Number(f.decisionSeq) || 0,
  }
  if (f.technicalBudget !== undefined && f.technicalBudget !== null) out.tb = f.technicalBudget
  return out
}

function parseCheckpointCompact(ck) {
  if (!ck || typeof ck !== 'object' || typeof ck.c !== 'string' || !ck.c || ck.c === CHECKPOINT_END_ENTRY) return null
  const parsed = {
    entry: ck.c,
    results: ck.r && typeof ck.r === 'object' ? ck.r : {},
    history: Array.isArray(ck.h) ? ck.h : [],
    round: Number(ck.rd) || 0,
    feedback: typeof ck.fb === 'string' ? ck.fb : '',
    budgetUsed: Number(ck.bu) || 0,
    maxRounds: Number(ck.mr) || 0,
    decisionSeq: Number(ck.ds) || 0,
    degraded: false,
  }
  if (ck.tb) parsed.technical_budget = ck.tb
  return parsed
}

function formatCheckpointLogLine(compact) {
  return CHECKPOINT_MARKER + JSON.stringify(compact)
}

function parseCheckpointLogLine(line) {
  const raw = String(line || '')
  const idx = raw.indexOf(CHECKPOINT_MARKER)
  if (idx < 0) return null
  try {
    return parseCheckpointCompact(JSON.parse(raw.slice(idx + CHECKPOINT_MARKER.length)))
  } catch (e) {
    return null
  }
}

function extractCheckpointFromLogs(logs) {
  if (!logs || !Array.isArray(logs)) return null
  for (let i = logs.length - 1; i >= 0; i--) {
    const parsed = parseCheckpointLogLine(logs[i])
    if (parsed) return parsed
  }
  return { entry: null, results: {}, history: [], round: 0, feedback: '', budgetUsed: 0, maxRounds: 0, decisionSeq: 0, degraded: true }
}

function checkpointToResumeFields(ck) {
  const c = ck || {}
  return {
    entry: c.entry || undefined,
    results: c.results && typeof c.results === 'object' ? c.results : {},
    history: Array.isArray(c.history) ? c.history : [],
    startRound: Number(c.round) || 0,
    feedback: typeof c.feedback === 'string' ? c.feedback : '',
    budgetUsed: Number(c.budgetUsed) || 0,
    maxRounds: Number(c.maxRounds) || 0,
    decisionSeq: Number(c.decisionSeq) || 0,
    technical_budget: c.technical_budget || undefined,
  }
}

function buildHumanWaitResume(ctx) {
  const c = ctx || {}
  const resume = checkpointToResumeFields({
    entry: c.entry,
    results: c.results,
    history: c.history,
    round: c.round,
    feedback: c.feedback,
    budgetUsed: c.budgetUsed,
    maxRounds: c.maxRounds,
    decisionSeq: c.decisionSeq,
    technical_budget: c.technicalBudget,
  })
  resume.entry = c.entry
  resume.decision_id = c.decisionId
  resume.blocked_edge = c.blockedEdge || null
  return resume
}

function buildPauseResumePayload(ctx) {
  const c = ctx || {}
  const pr = c.pauseResume || null
  if (!pr) return null
  const args = checkpointToResumeFields({
    entry: pr.entry,
    results: pr.results,
    history: pr.history,
    round: pr.round,
    feedback: pr.feedback,
    budgetUsed: pr.budgetUsed,
    maxRounds: pr.maxRounds,
    decisionSeq: pr.decisionSeq,
    technical_budget: pr.technical_budget,
  })
  const applied = c.baselineAppliedUpto || 0
  const revisions = Array.isArray(c.baselineRevisions) ? c.baselineRevisions : []
  const pending = revisions.filter((r) => r.revision > applied)
  const lastRev = pending.length ? pending[pending.length - 1] : revisions[revisions.length - 1]
  if (lastRev) args.baseline_amendment = lastRev.text
  let rebaseBlocked = false
  if (pending.length) {
    if (c.rev1Entry) args.entry = c.rev1Entry
    else rebaseBlocked = true
  }
  const coach = (c.guidance || []).filter((g) => g.mode === 'coach' && g.text)
  if (coach.length) args.guidance_text = coach.map((g) => '- ' + g.text).join('\n')
  if (c.extraArgs && typeof c.extraArgs === 'object') Object.assign(args, c.extraArgs)
  return { args, pendingRebase: pending.length > 0, rebaseBlocked }
}

function buildBlockedRunBody(ctx) {
  const c = ctx || {}
  const term = c.termination || {}
  const b = {
    reason_code: term.reason_code,
    business_outcome: term.business_outcome,
    resumable: term.resumable === true,
    resume_node: term.resume_node,
    failed_node: c.failedNode || null,
    last_outcome: c.lastOutcome === undefined ? null : c.lastOutcome,
  }
  if (c.blockedExtra && typeof c.blockedExtra === 'object') Object.assign(b, c.blockedExtra)
  return {
    status: 'BLOCKED',
    taskId: c.taskId,
    round: c.round,
    results: c.results,
    history: c.history,
    completion: null,
    budgetUsed: c.budgetUsed,
    maxRounds: c.maxRounds,
    termination: term,
    blocked: b,
  }
}

module.exports = {
  CHECKPOINT_MARKER,
  CHECKPOINT_END_ENTRY,
  TERMINAL_STATUS_RE,
  isHumanWaitStatus,
  isTerminalStatus,
  canonicalStopFromResult,
  lifecycleForStatus,
  isParkedHumanDecision,
  buildCheckpointCompact,
  parseCheckpointCompact,
  formatCheckpointLogLine,
  parseCheckpointLogLine,
  extractCheckpointFromLogs,
  checkpointToResumeFields,
  buildHumanWaitResume,
  buildPauseResumePayload,
  buildBlockedRunBody,
}
