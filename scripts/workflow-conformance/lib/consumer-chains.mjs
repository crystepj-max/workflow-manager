// LOC-042：四模板生产→交接→存储→消费完整自动路径断言
import { findRepoRoot } from './repo-root.mjs'
import { loadRuntime } from './probes.mjs'

const DEV_BRANCH = 'dev2/conformance'
const CAND = 'conformance-candidate'

export async function runConsumerChains(repoRoot = findRepoRoot()) {
  const { compileBlueprint, runGeneratedScript, makeAgentScript, bp } = await loadRuntime(repoRoot)
  const chains = []

  async function runTemplate(templateId, table, args = {}) {
    const { script } = compileBlueprint(bp(templateId))
    return runGeneratedScript(script, { args, agent: makeAgentScript(table) })
  }

  // ── 建设：返工 + 人工等待 ──
  let devRound = 0
  let reviewRound = 0
  const construction = await runTemplate('wf-construction-full-feature', {
    实施前检查: { route: 'PASS', summary: '资格通过', blockers: '', baseline_version: 'V1' },
    开发: () => ({ route: 'READY', summary: '实现轮次' + (++devRound), self_check: 'ok' }),
    收敛审查: () => {
      reviewRound += 1
      if (reviewRound === 1) return { route: 'RETURN_DEV', verdict: 'REQUEST_CHANGES', summary: '需修改', blockers: '测试不足', verified_branch: DEV_BRANCH, verified_head: 'h1', candidate_sha256: CAND }
      return { route: 'APPROVE', verdict: 'APPROVE', summary: '通过', blockers: '', verified_branch: DEV_BRANCH, verified_head: 'h2', candidate_sha256: CAND }
    },
    测试: { route: 'PASS', result: 'PASSED', reason: '专项通过', evidence: '20/20', verified_branch: DEV_BRANCH, verified_head: 'h2', candidate_sha256: CAND },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: '待人工', why: '自动阶段完成', current_state: '等待验收', details: '不得代签' },
  }, { taskId: 'loc042-construction', work_branch: DEV_BRANCH })
  const consDevCalls = construction.agentCalls.filter((c) => c.label === '开发')
  chains.push({
    template: 'wf-construction-full-feature',
    fixture: 'construction',
    status: construction.result.status,
    scenarios: ['rework', 'human_wait'],
    assertions: {
      rework_dev_calls: consDevCalls.length === 2,
      review_return_dev: construction.result.results?.review?.route === 'RETURN_DEV' || construction.agentCalls.some((c) => c.label === '收敛审查' && c.result?.route === 'RETURN_DEV'),
      human_wait: construction.result.status === 'WAITING_HUMAN',
      uat_ready: construction.result.results?.uat?.route === 'READY_FOR_HUMAN',
      dev_resolved_inputs: Boolean(construction.result.resolved_inputs?.dev),
      test_received_review: construction.result.resolved_inputs?.test?.items?.some((i) => i.binding === 'review_report' || i.producer === 'review'),
    },
    pass: construction.result.status === 'WAITING_HUMAN' && consDevCalls.length === 2,
  })

  // ── 优化：返工反馈到执行 ──
  let optExec = 0
  let optEval = 0
  const optimize = await runTemplate('wf-optimize', {
    目标确认: { route: 'READY', summary: '契约', contract_digest: 'c-opt' },
    执行: () => ({ route: 'READY', summary: 'exec' + (++optExec), changed: 'doc.md' }),
    评估: () => {
      optEval += 1
      if (optEval === 1) return { route: 'OPTIMIZE', summary: '再优化', contract_digest: 'c-opt', gaps: 'GAP-LOC042' }
      return { route: 'PASS', summary: '满足', contract_digest: 'c-opt', gaps: '' }
    },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: '完成', followups: '' },
  })
  const execCalls = optimize.agentCalls.filter((c) => c.label === '执行')
  chains.push({
    template: 'wf-optimize',
    fixture: 'optimize',
    status: optimize.result.status,
    scenarios: ['rework'],
    assertions: {
      execute_calls: execCalls.length === 2,
      second_exec_has_gap: execCalls[1]?.prompt.includes('GAP-LOC042'),
      closeout_has_eval_pass: optimize.agentCalls.find((c) => c.label === '收口')?.prompt.includes('PASS'),
      resolved_execute_gaps: optimize.result.resolved_inputs?.execute?.items?.find((i) => i.binding === 'evaluation_gaps')?.value === 'GAP-LOC042',
    },
    pass: optimize.result.status === 'DONE' && execCalls.length === 2 && execCalls[1]?.prompt.includes('GAP-LOC042'),
  })

  // ── 诊断：受阻恢复路径（审核推翻根因 → 回诊断 → 再修复）──
  let diagRound = 0
  let reviewRoundDiag = 0
  const diagnose = await runTemplate('wf-diagnose', {
    缺陷诊断: () => {
      diagRound += 1
      return { route: 'DIAGNOSED', root_cause: diagRound === 1 ? '初判错误' : 'off-by-one', evidence: 'sum 漏末项', verified_head: 'vh' + diagRound }
    },
    修复: { route: 'FIXED', summary: '修复 sum', changed: 'sum-fixed.mjs' },
    审核: () => {
      reviewRoundDiag += 1
      if (reviewRoundDiag === 1) return { route: 'ROOT_CAUSE_REFUTED', verdict_reason: '根因被推翻', verified_branch: DEV_BRANCH, verified_head: 'vh1', candidate_sha256: CAND }
      return { route: 'APPROVE', verdict_reason: '审核通过', verified_branch: DEV_BRANCH, verified_head: 'vh2', candidate_sha256: CAND }
    },
    回归验证: { route: 'PASS', verdict_reason: '回归通过', regression_evidence: 'sum 10/0/7', verified_branch: DEV_BRANCH, verified_head: 'vh2', candidate_sha256: CAND },
    收口: { status: 'DELIVERED', completion_type: 'DELIVERED', summary: '交付', followups: '' },
  }, { taskId: 'loc042-diagnose', work_branch: DEV_BRANCH })
  chains.push({
    template: 'wf-diagnose',
    fixture: 'diagnose',
    status: diagnose.result.status,
    scenarios: ['blocked_recovery'],
    assertions: {
      root_cause_refuted: diagnose.agentCalls.some((c) => c.label === '审核' && c.result?.route === 'ROOT_CAUSE_REFUTED'),
      diagnose_reentry: diagRound >= 2,
      fix_received_diagnosis: diagnose.result.resolved_inputs?.fix?.items?.some((i) => i.producer === 'diagnose'),
      delivered: diagnose.result.status === 'DONE',
    },
    pass: diagnose.result.status === 'DONE' && diagRound >= 2,
  })

  // ── 探索：部分失败（INSUFFICIENT 合法完成 + 成本缺口保留）──
  const explore = await runTemplate('wf-explore', {
    探索统筹: {
      route: 'PLAN_READY', round_type: 'BROAD', research_question: 'A vs B',
      questions: [
        { id: 'q-decision', required: true, text: 'A 与 B 该选哪个' },
        { id: 'q-cost', required: true, text: '迁移成本是多少' },
      ],
      expert_briefs: [
        { expert_id: 'ops-a', focus: 'A', brief: '读 01', question_ids: ['q-decision'] },
        { expert_id: 'edge-b', focus: 'B', brief: '读 03', question_ids: ['q-decision'] },
        { expert_id: 'cost-gap', focus: '成本', brief: '读 06', question_ids: ['q-cost'] },
      ],
      plan_summary: '三专家',
    },
    '/专家研究/': (label, opts) => {
      const item = opts?.item || {}
      const id = item.expert_id || 'x'
      const isCost = id === 'cost-gap'
      return {
        expert_id: id,
        findings: isCost ? '无成本数据' : (id.startsWith('ops') ? '支持集中式 A' : '支持自治 B'),
        evidence: [isCost ? '06-cost-unknown.md' : (id.startsWith('ops') ? '01-support-a-ops.md' : '03-support-b-autonomy.md')],
        counter_evidence: isCost ? [] : (id.startsWith('ops') ? ['03-support-b-autonomy.md'] : ['01-support-a-ops.md']),
        assumptions: [],
        uncertainties: isCost ? ['成本未知'] : [],
        confidence: isCost ? 'low' : 'medium',
      }
    },
    综合分析: {
      route: 'SYNTHESIS_READY', consensus: ['部分支持A'], disagreements: ['B证据不足'], evidence_map: '01,03,06',
      coverage: [
        { question_id: 'q-decision', status: 'answered', evidence_refs: ['01-support-a-ops.md', '03-support-b-autonomy.md'] },
        { question_id: 'q-cost', status: 'unavailable_with_evidence', evidence_refs: ['06-cost-unknown.md'], reason: '成本数据客观不可得' },
      ],
      source_overlaps: [], research_failures: [],
      open_gaps: ['成本未知'], synthesis_summary: '部分完成',
    },
    结论评估: { verdict: 'INSUFFICIENT', completion_type: 'INSUFFICIENT', why: '成本缺口', summary_for_human: '需补充', current_state: '部分失败', open_gaps: ['成本未知'] },
  })
  chains.push({
    template: 'wf-explore',
    fixture: 'explore',
    status: explore.result.status,
    scenarios: ['partial_failure'],
    assertions: {
      insufficient_completion: explore.result.completion?.type === 'INSUFFICIENT',
      synthesis_open_gaps: explore.agentCalls.find((c) => c.label === '综合分析')?.result?.open_gaps?.includes('成本未知'),
      evaluate_verdict: explore.result.results?.evaluate?.verdict === 'INSUFFICIENT',
    },
    pass: explore.result.status === 'DONE' && explore.result.completion?.type === 'INSUFFICIENT',
  })

  return { chains, executed_at: new Date().toISOString() }
}
