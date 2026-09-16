export function median(nums) {
  const sorted = [...nums].filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function countModelCalls(trials) {
  return trials.reduce((sum, t) => sum + (t.model_calls?.length ?? 0), 0)
}

export function savingsRate(baselineTrials, candidateTrials) {
  const b = countModelCalls(baselineTrials)
  const c = countModelCalls(candidateTrials)
  if (b === 0) return { applicable: false, rate: null, reason: 'baseline_calls_zero' }
  return { applicable: true, rate: 1 - c / b, baseline_calls: b, candidate_calls: c }
}

export function evaluateAdoption({ taskId, baselineTrials, candidateTrials, qualityGate }) {
  const executedBaseline = baselineTrials.filter((t) => t.status === 'COMPLETED')
  const executedCandidate = candidateTrials.filter((t) => t.status === 'COMPLETED')
  if (executedBaseline.length < 3 || executedCandidate.length < 3) {
    return {
      task_id: taskId,
      decision: 'INSUFFICIENT_EVIDENCE',
      reason: '缺少完整三次可比重复（真实样本未执行或未完成）',
    }
  }
  const baselineMedian = median(executedBaseline.map((t) => t.auto_wall_clock_ms))
  const candidateMedian = median(executedCandidate.map((t) => t.auto_wall_clock_ms))
  const savings = savingsRate(executedBaseline, executedCandidate)
  const qualityOk = qualityGate?.(executedBaseline, executedCandidate) ?? false
  const timeOk = candidateMedian !== null && baselineMedian !== null && candidateMedian <= baselineMedian
  const savingsOk = savings.applicable && savings.rate >= 0.2
  if (qualityOk && savingsOk && timeOk) {
    return { task_id: taskId, decision: 'ADOPT', savings, baselineMedian, candidateMedian }
  }
  return {
    task_id: taskId,
    decision: 'DO_NOT_ADOPT',
    savings,
    baselineMedian,
    candidateMedian,
    qualityOk,
    timeOk,
    savingsOk,
  }
}

export function summarizeExperimentStatus(trials) {
  const executed = trials.filter((t) => t.status === 'COMPLETED').length
  const notExecuted = trials.filter((t) => t.status === 'NOT_EXECUTED').length
  const failed = trials.filter((t) => t.status === 'FAILED').length
  if (executed === 0) return 'PREPARED'
  if (executed < trials.length) return 'PARTIAL'
  return 'COMPLETE_RESEARCH'
}
