'use strict'
// LOC-036（WR-010）：探索覆盖度与定向补充规则——纯计算内核。
// 编译期由 generate.mjs 嵌入 wf-explore 运行时脚本；测试经 createRequire 直接引用。

const BROAD_MIN = 3
const BROAD_MAX = 5
const TARGETED_MIN = 1
const TARGETED_MAX = 5

const COVERAGE_HANDLED = new Set(['answered', 'unknown_with_evidence', 'unavailable_with_evidence'])
const COVERAGE_FAIL = new Set(['uncovered', 'missing_evidence', 'blocked'])

function normalizeWs(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ')
}

function taskSignature(brief) {
  return normalizeWs(brief && brief.focus) + '|' + normalizeWs(brief && brief.brief)
}

function uniqueStrings(items, label) {
  const seen = {}
  const dups = []
  for (const raw of items || []) {
    const id = String(raw == null ? '' : raw).trim()
    if (!id) continue
    if (seen[id]) dups.push(id)
    else seen[id] = true
  }
  return dups.length ? { ok: false, code: 'DUPLICATE_' + label, detail: '重复 ' + label + '：' + dups.join('、') } : { ok: true }
}

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, code: 'QUESTIONS_REQUIRED', detail: '必需问题清单 questions 不能为空' }
  }
  const dup = uniqueStrings(questions.map((q) => q && q.id), 'question_id')
  if (!dup.ok) return dup
  for (const q of questions) {
    if (!q || typeof q !== 'object') return { ok: false, code: 'QUESTION_INVALID', detail: 'questions 项必须是对象' }
    if (!String(q.id || '').trim()) return { ok: false, code: 'QUESTION_ID_EMPTY', detail: 'question_id 不能为空' }
  }
  return { ok: true, ids: questions.map((q) => String(q.id).trim()) }
}

function validateExpertBriefs(briefs, questionIds, roundType) {
  if (!Array.isArray(briefs)) {
    return { ok: false, code: 'BRIEFS_REQUIRED', detail: 'expert_briefs 必须是数组' }
  }
  const dup = uniqueStrings(briefs.map((b) => b && b.expert_id), 'expert_id')
  if (!dup.ok) return dup
  const sigs = {}
  const qset = new Set(questionIds || [])
  for (let i = 0; i < briefs.length; i++) {
    const b = briefs[i]
    if (!b || typeof b !== 'object') return { ok: false, code: 'BRIEF_INVALID', detail: 'expert_briefs[' + i + '] 必须是对象' }
    const expertId = String(b.expert_id || '').trim()
    if (!expertId) return { ok: false, code: 'EXPERT_ID_EMPTY', detail: 'expert_briefs[' + i + '].expert_id 不能为空' }
    if (!normalizeWs(b.focus)) return { ok: false, code: 'FOCUS_EMPTY', detail: expertId + ' 的 focus 不能为空' }
    if (!normalizeWs(b.brief)) return { ok: false, code: 'BRIEF_EMPTY', detail: expertId + ' 的 brief 不能为空' }
    const sig = taskSignature(b)
    if (sigs[sig]) return { ok: false, code: 'IDENTICAL_TASK', detail: '完全相同任务：' + expertId + ' 与 ' + sigs[sig] }
    sigs[sig] = expertId
    const qids = Array.isArray(b.question_ids) ? b.question_ids.map((x) => String(x).trim()).filter(Boolean) : []
    if (roundType === 'BROAD') {
      if (!qids.length) return { ok: false, code: 'QUESTION_IDS_REQUIRED', detail: expertId + ' 必须关联至少一个 question_id' }
      for (const qid of qids) {
        if (!qset.has(qid)) return { ok: false, code: 'UNKNOWN_QUESTION', detail: expertId + ' 关联未知 question_id：' + qid }
      }
    }
    if (roundType === 'TARGETED') {
      const targets = Array.isArray(b.research_targets) ? b.research_targets.map((x) => String(x).trim()).filter(Boolean) : []
      if (!targets.length) return { ok: false, code: 'RESEARCH_TARGETS_EMPTY', detail: expertId + ' 的 research_targets 不能为空' }
      for (const t of targets) {
        if (!qset.has(t)) return { ok: false, code: 'TARGET_NOT_IN_GAPS', detail: expertId + ' 的 research_target 未映射 open_gaps：' + t }
      }
    }
  }
  return { ok: true }
}

function countBoundary(count, min, max) {
  return count >= min && count <= max
}

function validateExplorePlan(plan, ctx) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, code: 'PLAN_INVALID', detail: '计划必须是对象' }
  }
  if (plan.route !== 'PLAN_READY') {
    return { ok: false, code: 'ROUTE_INVALID', detail: 'route 必须是 PLAN_READY' }
  }
  const roundType = String(plan.round_type || 'BROAD')
  const qv = validateQuestions(plan.questions)
  if (!qv.ok) return qv
  const briefs = plan.expert_briefs || []
  const count = briefs.length
  const rawGaps = (ctx && Array.isArray(ctx.open_gaps)) ? ctx.open_gaps.map((g) => {
    if (g && typeof g === 'object' && g.question_id) return String(g.question_id).trim()
    return String(g || '').trim()
  }).filter(Boolean) : []
  const gapIds = rawGaps.length ? rawGaps : qv.ids

  if (roundType === 'BROAD') {
    const quality = validateExpertBriefs(briefs, qv.ids, 'BROAD')
    if (!quality.ok) return { ok: false, kind: 'reject', ...quality }
    if (!countBoundary(count, BROAD_MIN, BROAD_MAX)) {
      return {
        ok: false,
        kind: 'boundary',
        code: 'PLAN_COUNT_BOUNDARY',
        detail: '首轮专家数 ' + count + ' 超出默认边界 ' + BROAD_MIN + '–' + BROAD_MAX,
        actual_count: count,
        round_type: roundType,
        bounds: { min: BROAD_MIN, max: BROAD_MAX },
      }
    }
    return { ok: true }
  }

  if (roundType === 'TARGETED') {
    const quality = validateExpertBriefs(briefs, gapIds, 'TARGETED')
    if (!quality.ok) return { ok: false, kind: 'reject', ...quality }
    if (!countBoundary(count, TARGETED_MIN, TARGETED_MAX)) {
      return {
        ok: false,
        kind: 'reject',
        code: 'TARGETED_COUNT_INVALID',
        detail: '定向补充专家数 ' + count + ' 必须在 ' + TARGETED_MIN + '–' + TARGETED_MAX,
      }
    }
    return { ok: true }
  }

  return { ok: false, code: 'ROUND_TYPE_INVALID', detail: 'round_type 必须是 BROAD 或 TARGETED' }
}

function assemblePlanBoundaryPackage(plan, detail) {
  const count = (plan && plan.expert_briefs) ? plan.expert_briefs.length : 0
  const roundType = plan && plan.round_type
  return {
    why: detail.detail || ('探索计划专家数为 ' + count + '，需人工判断是否例外放行'),
    current_state: JSON.stringify({ round_type: roundType, expert_count: count, bounds: detail.bounds, plan_summary: plan && plan.plan_summary }),
    options: [
      { id: 'APPROVE_EXCEPTION' },
      { id: 'MODIFY_PLAN' },
    ],
    subsequent_effects: {
      APPROVE_EXCEPTION: '记录人数例外并启动专家研究（保留原计划）',
      MODIFY_PLAN: '退回探索统筹修改计划后重新提交',
    },
    cost: '超出默认人数可能增加模型调用成本',
    benefit: '例外放行可覆盖特殊复杂度场景',
    risk: '人数过少降低视角多样性；人数过多增加预算与协调成本',
    recommendation: '仅在问题复杂度明确需要时例外放行，否则退回修改计划',
    explore_plan_boundary: {
      actual_count: count,
      round_type: roundType,
      bounds: detail.bounds,
      violations: [],
    },
  }
}

function researchFailures(researchAgg) {
  if (!researchAgg || typeof researchAgg !== 'object') return { failures: [], okItems: [] }
  const items = Array.isArray(researchAgg.items) ? researchAgg.items : []
  const failures = []
  const okItems = []
  items.forEach((item, index) => {
    if (item === null || item === undefined) failures.push({ index: index + 1, expert_id: null })
    else okItems.push(item)
  })
  return { failures, okItems, total: researchAgg.total || items.length, failedCount: researchAgg.failedCount || failures.length }
}

function requiredQuestionIds(questions) {
  if (!Array.isArray(questions)) return []
  return questions.filter((q) => q && q.required !== false).map((q) => String(q.id).trim()).filter(Boolean)
}

function coverageByQuestion(coverage) {
  const map = {}
  if (!Array.isArray(coverage)) return map
  for (const row of coverage) {
    if (!row || !row.question_id) continue
    map[String(row.question_id).trim()] = row
  }
  return map
}

function isQuestionHandled(row) {
  if (!row || typeof row !== 'object') return false
  const status = String(row.status || '').trim()
  if (COVERAGE_HANDLED.has(status)) {
    const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs.filter(Boolean) : []
    return refs.length > 0 || status !== 'answered' || refs.length >= 0
  }
  if (status === 'answered') {
    const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs.filter(Boolean) : []
    return refs.length > 0
  }
  if (status === 'unknown_with_evidence' || status === 'unavailable_with_evidence') {
    const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs.filter(Boolean) : []
    return refs.length > 0
  }
  return false
}

function validateExploreSynthesis(synth, ctx) {
  if (!synth || synth.route !== 'SYNTHESIS_READY') {
    return { ok: false, code: 'SYNTHESIS_ROUTE', detail: '综合分析 route 必须是 SYNTHESIS_READY' }
  }
  const questions = (ctx && ctx.questions) || []
  const required = requiredQuestionIds(questions)
  const covMap = coverageByQuestion(synth.coverage)
  const research = researchFailures(ctx && ctx.research)
  if (research.total > 0 && research.failedCount === research.total) {
    return { ok: false, code: 'ALL_RESEARCH_FAILED', detail: '全部专家研究失败，不得生成有效综合结论' }
  }
  const missing = []
  for (const qid of required) {
    const row = covMap[qid]
    if (!isQuestionHandled(row)) missing.push(qid)
  }
  if (missing.length) {
    return { ok: false, code: 'REQUIRED_UNCOVERED', detail: '必需问题未覆盖：' + missing.join('、'), uncovered: missing }
  }
  if (!Array.isArray(synth.research_failures)) {
    return { ok: false, code: 'FAILURES_INDEX_MISSING', detail: 'synthesis 必须包含 research_failures 清单' }
  }
  return { ok: true, research }
}

function validateExploreEvaluation(ev, ctx) {
  if (!ev || typeof ev !== 'object') return { ok: false, code: 'EVAL_INVALID', detail: '评估结果无效' }
  const verdict = String(ev.verdict || '')
  if (verdict === 'NEEDS_RESEARCH') {
    const targets = Array.isArray(ev.research_targets) ? ev.research_targets.map((x) => String(x).trim()).filter(Boolean) : []
    if (!targets.length) {
      return { ok: false, code: 'EMPTY_RESEARCH_TARGETS', detail: 'NEEDS_RESEARCH 必须提供非空 research_targets' }
    }
    if (ev.completion_type !== undefined && ev.completion_type !== null && String(ev.completion_type).trim()) {
      return { ok: false, code: 'NEEDS_RESEARCH_COMPLETION', detail: 'NEEDS_RESEARCH 不得填写 completion_type' }
    }
    return { ok: true }
  }
  if (verdict === 'PASS') {
    if (ev.completion_type !== 'EVALUATION_PASSED') {
      return { ok: false, code: 'PASS_COMPLETION', detail: 'PASS 必须对应 completion_type=EVALUATION_PASSED' }
    }
    const synth = ctx && ctx.synthesis
    const sv = validateExploreSynthesis(synth, ctx)
    if (!sv.ok) return sv
    return { ok: true }
  }
  if (verdict === 'INSUFFICIENT') {
    if (ev.completion_type !== 'INSUFFICIENT') {
      return { ok: false, code: 'INSUFFICIENT_COMPLETION', detail: 'INSUFFICIENT 必须对应 completion_type=INSUFFICIENT' }
    }
    return { ok: true }
  }
  return { ok: false, code: 'VERDICT_INVALID', detail: 'verdict 无效' }
}

function budgetExhaustedOutcome(evalOutcome, synth, plan) {
  const open = []
  if (synth && Array.isArray(synth.open_gaps)) {
    for (const g of synth.open_gaps) {
      if (g && typeof g === 'object' && g.question_id) open.push(String(g.question_id))
      else if (typeof g === 'string' && g.trim()) open.push(g.trim())
    }
  }
  if (evalOutcome && Array.isArray(evalOutcome.open_gaps)) {
    for (const g of evalOutcome.open_gaps) {
      if (g && typeof g === 'object' && g.question_id) open.push(String(g.question_id))
      else if (typeof g === 'string' && g.trim()) open.push(g.trim())
    }
  }
  const unresolved = Array.from(new Set(open.filter(Boolean)))
  return {
    evaluator_decision: evalOutcome,
    effective_verdict: 'INSUFFICIENT',
    system_completion: 'INSUFFICIENT',
    budget_exhausted: true,
    reason: 'budget_exhausted',
    unresolved_gaps: unresolved,
    why: (evalOutcome && evalOutcome.why) || '补充研究额度耗尽，仍有未闭合缺口',
    summary_for_human: (evalOutcome && evalOutcome.summary_for_human) || '自动补充研究已用尽，系统收口为证据不足',
    current_state: (evalOutcome && evalOutcome.current_state) || JSON.stringify({ unresolved_gaps: unresolved }),
    completion_type: 'INSUFFICIENT',
    verdict: 'INSUFFICIENT',
  }
}

function runtimeSource() {
  const body = module.exports.__exploreCoverageRuntimeBody
  return body || ''
}

module.exports = {
  BROAD_MIN,
  BROAD_MAX,
  TARGETED_MIN,
  TARGETED_MAX,
  normalizeWs,
  taskSignature,
  validateExplorePlan,
  assemblePlanBoundaryPackage,
  researchFailures,
  requiredQuestionIds,
  validateExploreSynthesis,
  validateExploreEvaluation,
  budgetExhaustedOutcome,
  runtimeSource,
}

// 供 generate.mjs 嵌入：函数体与导出实现同源（读取本文件时剥离尾部导出）
module.exports.__exploreCoverageRuntimeBody = [
  'const __EC_BROAD_MIN = 3',
  'const __EC_BROAD_MAX = 5',
  'const __EC_TARGETED_MIN = 1',
  'const __EC_TARGETED_MAX = 5',
  'const __EC_HANDLED = { answered:1, unknown_with_evidence:1, unavailable_with_evidence:1 }',
  'function __ecNorm(v) { return String(v == null ? "" : v).trim().replace(/\\s+/g, " ") }',
  'function __ecSig(b) { return __ecNorm(b && b.focus) + "|" + __ecNorm(b && b.brief) }',
  'function __ecDup(items, label) { const seen = {}; const dups = []; for (const raw of items || []) { const id = String(raw == null ? "" : raw).trim(); if (!id) continue; if (seen[id]) dups.push(id); else seen[id] = true } return dups.length ? { ok:false, code:"DUPLICATE_" + label, detail:"重复 " + label + "：" + dups.join("、") } : { ok:true } }',
  'function __ecValidateQuestions(questions) { if (!Array.isArray(questions) || !questions.length) return { ok:false, code:"QUESTIONS_REQUIRED", detail:"必需问题清单 questions 不能为空" }; const dup = __ecDup(questions.map(function (q) { return q && q.id }), "question_id"); if (!dup.ok) return dup; for (const q of questions) { if (!q || typeof q !== "object") return { ok:false, code:"QUESTION_INVALID", detail:"questions 项必须是对象" }; if (!String(q.id || "").trim()) return { ok:false, code:"QUESTION_ID_EMPTY", detail:"question_id 不能为空" } } return { ok:true, ids: questions.map(function (q) { return String(q.id).trim() }) } }',
  'function __ecValidateBriefs(briefs, questionIds, roundType) { if (!Array.isArray(briefs)) return { ok:false, code:"BRIEFS_REQUIRED", detail:"expert_briefs 必须是数组" }; const dup = __ecDup(briefs.map(function (b) { return b && b.expert_id }), "expert_id"); if (!dup.ok) return dup; const sigs = {}; const qset = {}; (questionIds || []).forEach(function (q) { qset[q] = true }); for (let i = 0; i < briefs.length; i++) { const b = briefs[i]; if (!b || typeof b !== "object") return { ok:false, code:"BRIEF_INVALID", detail:"expert_briefs[" + i + "] 必须是对象" }; const expertId = String(b.expert_id || "").trim(); if (!expertId) return { ok:false, code:"EXPERT_ID_EMPTY", detail:"expert_briefs[" + i + "].expert_id 不能为空" }; if (!__ecNorm(b.focus)) return { ok:false, code:"FOCUS_EMPTY", detail:expertId + " 的 focus 不能为空" }; if (!__ecNorm(b.brief)) return { ok:false, code:"BRIEF_EMPTY", detail:expertId + " 的 brief 不能为空" }; const sig = __ecSig(b); if (sigs[sig]) return { ok:false, code:"IDENTICAL_TASK", detail:"完全相同任务：" + expertId + " 与 " + sigs[sig] }; sigs[sig] = expertId; const qids = Array.isArray(b.question_ids) ? b.question_ids.map(function (x) { return String(x).trim() }).filter(Boolean) : []; if (roundType === "BROAD") { if (!qids.length) return { ok:false, code:"QUESTION_IDS_REQUIRED", detail:expertId + " 必须关联至少一个 question_id" }; for (const qid of qids) { if (!qset[qid]) return { ok:false, code:"UNKNOWN_QUESTION", detail:expertId + " 关联未知 question_id：" + qid } } } if (roundType === "TARGETED") { const targets = Array.isArray(b.research_targets) ? b.research_targets.map(function (x) { return String(x).trim() }).filter(Boolean) : []; if (!targets.length) return { ok:false, code:"RESEARCH_TARGETS_EMPTY", detail:expertId + " 的 research_targets 不能为空" }; for (const t of targets) { if (!qset[t]) return { ok:false, code:"TARGET_NOT_IN_GAPS", detail:expertId + " 的 research_target 未映射 open_gaps：" + t } } } } return { ok:true } }',
  'function __ecCountBoundary(count, min, max) { return count >= min && count <= max }',
  'function __ecValidatePlan(plan, ctx) { if (!plan || typeof plan !== "object") return { ok:false, code:"PLAN_INVALID", detail:"计划必须是对象" }; if (plan.route !== "PLAN_READY") return { ok:false, code:"ROUTE_INVALID", detail:"route 必须是 PLAN_READY" }; const roundType = String(plan.round_type || "BROAD"); const qv = __ecValidateQuestions(plan.questions); if (!qv.ok) return qv; const briefs = plan.expert_briefs || []; const count = briefs.length; const rawGaps = (ctx && Array.isArray(ctx.open_gaps)) ? ctx.open_gaps.map(function (g) { if (g && typeof g === "object" && g.question_id) return String(g.question_id).trim(); return String(g || "").trim() }).filter(Boolean) : []; const gapIds = rawGaps.length ? rawGaps : qv.ids; if (roundType === "BROAD") { const quality = __ecValidateBriefs(briefs, qv.ids, "BROAD"); if (!quality.ok) return Object.assign({ kind:"reject" }, quality); if (!__ecCountBoundary(count, __EC_BROAD_MIN, __EC_BROAD_MAX)) return { ok:false, kind:"boundary", code:"PLAN_COUNT_BOUNDARY", detail:"首轮专家数 " + count + " 超出默认边界 " + __EC_BROAD_MIN + "–" + __EC_BROAD_MAX, actual_count:count, round_type:roundType, bounds:{ min:__EC_BROAD_MIN, max:__EC_BROAD_MAX } }; return { ok:true } } if (roundType === "TARGETED") { const quality = __ecValidateBriefs(briefs, gapIds, "TARGETED"); if (!quality.ok) return Object.assign({ kind:"reject" }, quality); if (!__ecCountBoundary(count, __EC_TARGETED_MIN, __EC_TARGETED_MAX)) return { ok:false, kind:"reject", code:"TARGETED_COUNT_INVALID", detail:"定向补充专家数 " + count + " 必须在 " + __EC_TARGETED_MIN + "–" + __EC_TARGETED_MAX }; return { ok:true } } return { ok:false, code:"ROUND_TYPE_INVALID", detail:"round_type 必须是 BROAD 或 TARGETED" } }',
  'function __ecPlanBoundaryPkg(plan, detail) { const count = (plan && plan.expert_briefs) ? plan.expert_briefs.length : 0; const roundType = plan && plan.round_type; return { why: detail.detail || ("探索计划专家数为 " + count + "，需人工判断是否例外放行"), current_state: JSON.stringify({ round_type: roundType, expert_count: count, bounds: detail.bounds, plan_summary: plan && plan.plan_summary }), options: [{ id:"APPROVE_EXCEPTION" }, { id:"MODIFY_PLAN" }], subsequent_effects: { APPROVE_EXCEPTION:"记录人数例外并启动专家研究（保留原计划）", MODIFY_PLAN:"退回探索统筹修改计划后重新提交" }, cost:"超出默认人数可能增加模型调用成本", benefit:"例外放行可覆盖特殊复杂度场景", risk:"人数过少降低视角多样性；人数过多增加预算与协调成本", recommendation:"仅在问题复杂度明确需要时例外放行，否则退回修改计划", explore_plan_boundary:{ actual_count:count, round_type:roundType, bounds:detail.bounds, violations:[] } } }',
  'function __ecResearchFailures(researchAgg) { if (!researchAgg || typeof researchAgg !== "object") return { failures:[], okItems:[] }; const items = Array.isArray(researchAgg.items) ? researchAgg.items : []; const failures = []; const okItems = []; items.forEach(function (item, index) { if (item === null || item === undefined) failures.push({ index:index + 1, expert_id:null }); else okItems.push(item) }); return { failures:failures, okItems:okItems, total:researchAgg.total || items.length, failedCount:researchAgg.failedCount || failures.length } }',
  'function __ecRequiredIds(questions) { if (!Array.isArray(questions)) return []; return questions.filter(function (q) { return q && q.required !== false }).map(function (q) { return String(q.id).trim() }).filter(Boolean) }',
  'function __ecCovMap(coverage) { const map = {}; if (!Array.isArray(coverage)) return map; for (const row of coverage) { if (!row || !row.question_id) continue; map[String(row.question_id).trim()] = row } return map }',
  'function __ecHandled(row) { if (!row || typeof row !== "object") return false; const status = String(row.status || "").trim(); if (status === "answered") { const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs.filter(Boolean) : []; return refs.length > 0 } if (status === "unknown_with_evidence" || status === "unavailable_with_evidence") { const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs.filter(Boolean) : []; return refs.length > 0 } return false }',
  'function __ecValidateSynth(synth, ctx) { if (!synth || synth.route !== "SYNTHESIS_READY") return { ok:false, code:"SYNTHESIS_ROUTE", detail:"综合分析 route 必须是 SYNTHESIS_READY" }; const required = __ecRequiredIds(ctx && ctx.questions); const covMap = __ecCovMap(synth.coverage); const research = __ecResearchFailures(ctx && ctx.research); if (research.total > 0 && research.failedCount === research.total) return { ok:false, code:"ALL_RESEARCH_FAILED", detail:"全部专家研究失败，不得生成有效综合结论" }; const missing = []; for (const qid of required) { if (!__ecHandled(covMap[qid])) missing.push(qid) } if (missing.length) return { ok:false, code:"REQUIRED_UNCOVERED", detail:"必需问题未覆盖：" + missing.join("、"), uncovered:missing }; if (!Array.isArray(synth.research_failures)) return { ok:false, code:"FAILURES_INDEX_MISSING", detail:"synthesis 必须包含 research_failures 清单" }; return { ok:true, research:research } }',
  'function __ecValidateEval(ev, ctx) { if (!ev || typeof ev !== "object") return { ok:false, code:"EVAL_INVALID", detail:"评估结果无效" }; const verdict = String(ev.verdict || ""); if (verdict === "NEEDS_RESEARCH") { const targets = Array.isArray(ev.research_targets) ? ev.research_targets.map(function (x) { return String(x).trim() }).filter(Boolean) : []; if (!targets.length) return { ok:false, code:"EMPTY_RESEARCH_TARGETS", detail:"NEEDS_RESEARCH 必须提供非空 research_targets" }; if (ev.completion_type !== undefined && ev.completion_type !== null && String(ev.completion_type).trim()) return { ok:false, code:"NEEDS_RESEARCH_COMPLETION", detail:"NEEDS_RESEARCH 不得填写 completion_type" }; return { ok:true } } if (verdict === "PASS") { if (ev.completion_type !== "EVALUATION_PASSED") return { ok:false, code:"PASS_COMPLETION", detail:"PASS 必须对应 completion_type=EVALUATION_PASSED" }; const sv = __ecValidateSynth(ctx && ctx.synthesis, ctx); if (!sv.ok) return sv; return { ok:true } } if (verdict === "INSUFFICIENT") { if (ev.completion_type !== "INSUFFICIENT") return { ok:false, code:"INSUFFICIENT_COMPLETION", detail:"INSUFFICIENT 必须对应 completion_type=INSUFFICIENT" }; return { ok:true } } return { ok:false, code:"VERDICT_INVALID", detail:"verdict 无效" } }',
  'function __ecBudgetExhausted(evalOutcome, synth) { const open = []; if (synth && Array.isArray(synth.open_gaps)) synth.open_gaps.forEach(function (g) { if (g && typeof g === "object" && g.question_id) open.push(String(g.question_id)); else if (typeof g === "string" && g.trim()) open.push(g.trim()) }); if (evalOutcome && Array.isArray(evalOutcome.open_gaps)) evalOutcome.open_gaps.forEach(function (g) { if (g && typeof g === "object" && g.question_id) open.push(String(g.question_id)); else if (typeof g === "string" && g.trim()) open.push(g.trim()) }); const unresolved = []; const seen = {}; open.forEach(function (g) { if (g && !seen[g]) { seen[g] = true; unresolved.push(g) } }); return { evaluator_decision: evalOutcome, effective_verdict:"INSUFFICIENT", system_completion:"INSUFFICIENT", budget_exhausted:true, reason:"budget_exhausted", unresolved_gaps:unresolved, why:(evalOutcome && evalOutcome.why) || "补充研究额度耗尽，仍有未闭合缺口", summary_for_human:(evalOutcome && evalOutcome.summary_for_human) || "自动补充研究已用尽，系统收口为证据不足", current_state:(evalOutcome && evalOutcome.current_state) || JSON.stringify({ unresolved_gaps:unresolved }), completion_type:"INSUFFICIENT", verdict:"INSUFFICIENT" } }',
  'function __ecExploreCtx() { const plan = results.orchestrate || {}; const synth = results.synthesize || {}; const openGaps = synth.open_gaps || (results.evaluate && results.evaluate.open_gaps) || []; return { questions: plan.questions || [], research: results.research, synthesis: synth, open_gaps: openGaps } }',
].join('\n')
