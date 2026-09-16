/**
 * C2：X02 定向补充——首轮三视角不变，补充轮仅调成本视角。
 * 本模块描述候选差异；真实执行由探索模板 + 隔离配置完成。
 */
export const C2_CONFIG = {
  task_id: 'X02',
  broad_experts: ['feature', 'operations', 'cost'],
  targeted_experts: ['cost'],
  failure_injection: {
    question_id: 'cost',
    first_round_response: 'TEMP_UNAVAILABLE',
    supplement_round_response: 'RESTORED',
  },
  preserve_conclusions: ['feature', 'operations'],
}

export function isC2Applicable(taskId) {
  return taskId === 'X02'
}

export function planSupplementRound(evaluation) {
  const gaps = evaluation?.research_targets ?? []
  const costGap = gaps.find((g) => g.question_id === 'cost' || g.focus === 'cost')
  if (!costGap) return { applicable: false, reason: 'no_cost_gap' }
  return {
    applicable: true,
    round_type: 'TARGETED',
    expert_briefs: [{ expert_id: 'cost', focus: '成本视角补充', brief: costGap.brief ?? '补充成本视角' }],
    preserved: C2_CONFIG.preserve_conclusions,
  }
}
