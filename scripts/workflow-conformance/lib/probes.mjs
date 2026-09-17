// LOC-042：七项历史探针（可迁移，无作者路径）
import { readFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { findRepoRoot } from './repo-root.mjs'
import { gapForProbe } from './known-gaps.mjs'

export async function loadRuntime(repoRoot) {
  const mod = (p) => import(pathToFileURL(join(repoRoot, p)).href)
  const { compileBlueprint } = await mod('scripts/generate.mjs')
  const { runGeneratedScript, makeAgentScript } = await mod('scripts/test/helpers/runtime-harness.mjs')
  const { loadHost } = await mod('packages/dsh-visual-workflow/tests/helpers/load-host.mjs')
  const { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } = await mod('packages/dsh-visual-workflow/tests/helpers/fake-services.mjs')
  const { recordsCommit, recordsList, recordsGet } = await mod('scripts/records-host.mjs')
  const bp = (id) => JSON.parse(readFileSync(join(repoRoot, 'templates', id + '.json'), 'utf8'))
  return {
    compileBlueprint, runGeneratedScript, makeAgentScript, loadHost,
    REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy,
    recordsCommit, recordsList, recordsGet, bp,
  }
}

export async function runAllProbes(repoRoot = findRepoRoot()) {
  const rt = await loadRuntime(repoRoot)
  const {
    compileBlueprint, runGeneratedScript, makeAgentScript, loadHost,
    REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy,
    recordsCommit, recordsList, recordsGet, bp,
  } = rt

  const optimize = bp('wf-optimize')
  const diagnose = bp('wf-diagnose')
  const explore = bp('wf-explore')
  const construction = bp('wf-construction-full-feature')

  async function run(b, table, args = {}) {
    return runGeneratedScript(compileBlueprint(b).script, { args, agent: makeAgentScript(table) })
  }

  async function settleInHost(b, value, id) {
    const input = structuredClone(b)
    input.id = 'review-probe'
    const compiled = compileBlueprint(input).script
    const seed = {
      [REPO + '/scripts/validate-core.cjs']: readFileSync(join(repoRoot, 'scripts/validate-core.cjs'), 'utf8'),
      [REPO + '/scripts/records-host.mjs']: readFileSync(join(repoRoot, 'scripts/records-host.mjs'), 'utf8'),
      [USER_DIR + '/' + input.id + '.json']: JSON.stringify(input),
      [SKILL_ROOT + '/' + input.id + '/script.mjs']: compiled,
    }
    const scratchBase = join(repoRoot, '.scratch')
    try { mkdirSync(scratchBase, { recursive: true }) } catch { /* ignore */ }
    const dir = mkdtempSync(join(existsSync(scratchBase) ? scratchBase : tmpdir(), 'wf-conformance-records-'))
    const commands = { commit: recordsCommit, list: recordsList, get: recordsGet }
    const fs = makeFs(seed)
    const subprocess = makeSubprocess({
      fs,
      compileScript: compiled,
      recordsHost: (cmd, arg) => commands[cmd]({ ...arg, records_dir: dir }),
    })
    const env = loadHost({
      fs, subprocess, sandboxPolicy,
      workflowEngine: {
        start: () => ({ id: 'engine-' + id, result: Promise.resolve({ stopReason: 'completed', value, agentsStarted: 0 }) }),
      },
      agents: { requireInitiator: () => ({}) },
    })
    const out = await env.definedTools.find((t) => t.name === 'wf_run').execute({ templateId: input.id, taskId: id })
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    const raw = fs._files.get(DSH_HOME + '/visual-workflow/logical-runs/' + id + '.json')
    if (!raw) throw new Error('未生成逻辑记录：' + JSON.stringify(out))
    return { logical: JSON.parse(raw), records: recordsList({ records_dir: dir, logical_run_id: id }), dir }
  }

  const probes = []
  const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

  // 1 technical-retry
  const technical = await run(optimize, { 目标确认: null })
  probes.push({
    id: 'technical-retry',
    status: technical.result.status,
    calls: technical.agentCalls.length,
    budgetUsed: technical.result.budgetUsed ?? null,
    gap: gapForProbe('technical-retry'),
  })

  // 2 recoverable-blocked
  const blocked = await run(diagnose, {
    缺陷诊断: { route: 'BLOCKED', root_cause: '', evidence: '测试环境暂时不可用', verified_head: 'head' },
  })
  const blockedHost = await settleInHost(diagnose, blocked.result, 'blocked-probe')
  probes.push({
    id: 'recoverable-blocked',
    engine_status: blocked.result.status,
    node_outcome: blocked.result.results?.diagnose?.route,
    lifecycle: blockedHost.logical.lifecycle,
    terminal: blockedHost.logical.terminal,
    gap: gapForProbe('recoverable-blocked'),
  })

  // 3 zero-experts
  const synthesis = { route: 'SYNTHESIS_READY', consensus: [], disagreements: [], evidence_map: '', open_gaps: [], synthesis_summary: '' }
  const evaluation = { verdict: 'PASS', completion_type: 'EVALUATION_PASSED', why: '示例评估', summary_for_human: '摘要', current_state: '现状' }
  const empty = await run(explore, {
    探索统筹: { route: 'PLAN_READY', round_type: 'BROAD', research_question: '问题', expert_briefs: [], plan_summary: '无专家' },
    综合分析: synthesis,
    结论评估: evaluation,
  })
  probes.push({
    id: 'zero-experts',
    status: empty.result.status,
    expert_calls: empty.agentCalls.filter((c) => c.label.startsWith('专家研究')).length,
    research: empty.result.results?.research,
    gap: gapForProbe('zero-experts'),
  })

  // 4 contradictory-verdict-and-head
  const contradictory = await run(construction, {
    实施前检查: { route: 'PASS', summary: '通过', blockers: '', baseline_version: 'V1' },
    开发: { route: 'READY', summary: '完成', self_check: 'done' },
    收敛审查: {
      route: 'APPROVE', verdict: 'REQUEST_CHANGES', summary: '阻断项未解决', blockers: '存在阻断项',
      verified_branch: 'dev-probe', verified_head: 'old-head', candidate_sha256: 'probe-cand',
    },
    测试: {
      route: 'PASS', result: 'FAILED', reason: '仍失败', evidence: '',
      verified_branch: 'dev-probe', verified_head: 'different-old-head', candidate_sha256: 'probe-cand',
    },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: '待验收', why: '准备完成', current_state: '待验收', details: '材料' },
  }, { taskId: 'contradiction', work_branch: 'dev-probe', source_revision: 'actual-head' })
  probes.push({
    id: 'contradictory-verdict-and-head',
    status: contradictory.result.status,
    reason: contradictory.result.reason,
    called: contradictory.agentCalls.map((c) => c.label),
    review: contradictory.result.results?.review,
    test: contradictory.result.results?.test,
    gap: gapForProbe('contradictory-verdict-and-head'),
  })

  // 5 contract-and-completion-drift
  const normal = {
    目标确认: { route: 'READY', summary: '冻结', contract_digest: 'contract-A' },
    执行: { route: 'READY', summary: '修改', changed: 'a.md' },
    评估: { route: 'PASS', summary: '通过', contract_digest: 'contract-B', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: '交付', followups: '' },
  }
  const drift = await run(optimize, normal)
  probes.push({
    id: 'contract-and-completion-drift',
    status: drift.result.status,
    contract_a: drift.result.results?.confirm?.contract_digest,
    contract_b: drift.result.results?.evaluate?.contract_digest,
    completion: drift.result.completion,
    decision: drift.result.control_event ?? null,
    gap: gapForProbe('contract-and-completion-drift'),
  })

  // 6 loop-attempt-loss
  let evalCount = 0
  let execCount = 0
  const loop = await run(optimize, {
    ...normal,
    执行: () => ({ route: 'READY', summary: '实现版本' + (++execCount), changed: 'a.md' }),
    评估: () => ({
      route: ++evalCount < 3 ? 'OPTIMIZE' : 'PASS',
      summary: '评估版本' + evalCount,
      contract_digest: 'contract-A',
      gaps: '',
    }),
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: '交付', followups: '' },
  })
  const loopHost = await settleInHost(optimize, loop.result, 'loop-probe')
  probes.push({
    id: 'loop-attempt-loss',
    actual_calls: loop.agentCalls.length,
    actual_evaluations: evalCount,
    retained_evaluation: loop.result.results?.evaluate,
    logical_attempts: loopHost.logical.node_attempts?.length,
    logical_evaluations: loopHost.logical.node_attempts?.filter((a) => a.node === 'evaluate').length,
    stored_evaluation_revisions: loopHost.records.records?.filter((r) => r.record_id.endsWith(':evaluate')).length,
    gap: gapForProbe('loop-attempt-loss'),
  })

  // 7 feedback-handoff
  let n = 0
  const feedbackAgent = makeAgentScript({
    目标确认: { route: 'READY', summary: '冻结', contract_digest: 'c1' },
    执行: { route: 'READY', summary: '执行', changed: 'a.md' },
    评估: () => ({ route: ++n === 1 ? 'OPTIMIZE' : 'PASS', summary: '评估', contract_digest: 'c1', gaps: 'ONLY_IN_EVALUATOR_RESULT_473' }),
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: '完成', followups: '' },
  })
  const feedbackRun = await runGeneratedScript(compileBlueprint(optimize).script, { args: {}, agent: feedbackAgent })
  const execCalls = feedbackRun.agentCalls.filter((x) => x.label === '执行')
  probes.push({
    id: 'feedback-handoff',
    execute_calls: execCalls.length,
    evaluation_gap_in_second_execute_prompt: execCalls[1]?.prompt.includes('ONLY_IN_EVALUATOR_RESULT_473') ?? false,
    explicit_evaluation_report_reference_in_second_execute_prompt: execCalls[1]?.prompt.includes('evaluation-report.md') ?? false,
    status: feedbackRun.result.status,
    gap: gapForProbe('feedback-handoff'),
  })

  return {
    baseline: baselineCommit,
    method: '真实编译器与宿主代码；代理、文件系统和引擎传输使用既有测试替身；不调用真实模型或外部服务',
    probes,
    executed_at: new Date().toISOString(),
  }
}

export function classifyProbeResult(probe) {
  const gap = probe.gap
  if (!gap) return { observed: 'unknown', classification: 'UNMAPPED' }

  if (gap.fixed_by) {
    if (probe.id === 'technical-retry') {
      const fixed = probe.calls <= 3 && probe.status !== 'FAILED_AGENT_CAP'
      return { observed: fixed ? 'fixed' : 'still_failing', classification: fixed ? 'CONTROL_GREEN' : 'KNOWN_GAP' }
    }
    if (probe.id === 'contradictory-verdict-and-head') {
      const fixed = probe.reason === 'CONTRACT_INCONSISTENT' || probe.status === 'FAILED_AT_review' || probe.status === 'FAILED_AT_test'
      return { observed: fixed ? 'fixed' : 'still_failing', classification: fixed ? 'CONTROL_GREEN' : 'KNOWN_GAP' }
    }
    if (probe.id === 'feedback-handoff') {
      const fixed = probe.evaluation_gap_in_second_execute_prompt && probe.explicit_evaluation_report_reference_in_second_execute_prompt
      return { observed: fixed ? 'fixed' : 'still_failing', classification: fixed ? 'CONTROL_GREEN' : 'KNOWN_GAP' }
    }
  }

  return { observed: 'still_failing', classification: 'KNOWN_GAP' }
}
