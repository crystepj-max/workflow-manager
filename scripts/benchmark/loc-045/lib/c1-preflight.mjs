import { runPreflight } from '../../../ai-task-preflight-check.mjs'
import { join } from 'node:path'

/**
 * C1：将建设模板 preflight 模型调用替换为确定性资格检查。
 * 返回机械检查结果，不计为模型调用。
 */
export async function runMechanicalPreflight(repoRoot = process.cwd()) {
  const issue = join(repoRoot, 'docs/tasks/LOC-045-workflow-complexity-benchmark.md')
  const spec = join(repoRoot, 'docs/tasks/specs/LOC-045-workflow-complexity-benchmark/task-spec-V1.md')
  const result = await runPreflight(issue, spec, { runBaseline: 'V1' })
  return {
    route: result.ok ? 'PASS' : 'BLOCKED',
    mechanical: true,
    model_calls: 0,
    summary: result.ok ? '机械资格检查通过' : result.failures.join('; '),
    failures: result.failures,
    fields: result.fields,
  }
}

export function isC1Applicable(taskId) {
  return ['B01', 'B02', 'B03'].includes(taskId)
}
