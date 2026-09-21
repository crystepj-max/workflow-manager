import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTaskRegistry, listPlannedTrials } from './task-registry.mjs'
import { loadFreezeManifest } from './freeze.mjs'
import { loadAllTrialRecords } from './trial-record.mjs'
import { summarizeExperimentStatus, evaluateAdoption, savingsRate } from './metrics.mjs'
import { verifyAllFixtures, allFixturesPass } from './quality.mjs'
import { isC1Applicable } from './c1-preflight.mjs'
import { isC2Applicable, C2_CONFIG } from './c2-supplement.mjs'

const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function buildResearchReport({ benchRoot = BENCH_ROOT, resultsDir } = {}) {
  const registry = loadTaskRegistry(benchRoot)
  const freeze = loadFreezeManifest(benchRoot)
  const outDir = resultsDir ?? join(benchRoot, 'results/prepared')
  const trials = loadAllTrialRecords(outDir)
  const fixtureChecks = verifyAllFixtures(registry, benchRoot)
  const status = summarizeExperimentStatus(
    trials.length ? trials : listPlannedTrials(registry).map(() => ({ status: 'NOT_EXECUTED' })),
  )

  const c1Tasks = registry.tasks.filter((t) => isC1Applicable(t.id)).map((t) => t.id)
  const c2Tasks = registry.tasks.filter((t) => isC2Applicable(t.id)).map((t) => t.id)

  const recommendations = []
  for (const arm of ['c1', 'c2']) {
    const armMeta = registry.arms[arm]
    if (!armMeta) continue
    const applicable = arm === 'c1' ? c1Tasks : c2Tasks
    const baselineTrials = trials.filter((t) => t.arm === 'baseline' && applicable.includes(t.task_id))
    const candidateTrials = trials.filter((t) => t.arm === arm)
    const savings = savingsRate(baselineTrials, candidateTrials)
    for (const taskId of applicable) {
      recommendations.push(
        evaluateAdoption({
          taskId,
          baselineTrials: baselineTrials.filter((t) => t.task_id === taskId),
          candidateTrials: candidateTrials.filter((t) => t.task_id === taskId),
          qualityGate: () => false,
        }),
      )
    }
    recommendations.push({
      arm,
      label: armMeta.label,
      applicable_tasks: applicable,
      uncovered: registry.tasks.filter((t) => !applicable.includes(t.id)).map((t) => t.id),
      savings_summary: savings,
      decision: status === 'PREPARED' ? 'PENDING_REAL_EXECUTION' : savings.applicable && savings.rate >= 0.2 ? 'MEETS_THRESHOLD' : 'DO_NOT_ADOPT_OR_INSUFFICIENT',
      note: status === 'PREPARED'
        ? '仅实验准备：无真实模型样本，不得宣称收益'
        : null,
    })
  }

  return {
    title: 'LOC-045 工作流复杂度基准研究报告',
    status,
    generated_at: new Date().toISOString(),
    experiment_status_meaning: {
      PREPARED: '仅实验准备；夹具/配置/占位记录就绪，无真实模型执行',
      PARTIAL: '部分真实样本或等待人工',
      COMPLETE_RESEARCH: '满足真实执行与证据要求并形成结论',
    },
    ac_mapping: {
      'AC-01': {
        met: fixtureChecks.length === 12 && allFixturesPass(fixtureChecks),
        note: status === 'PREPARED'
          ? '12 项夹具与验收判据已就绪；3×重复原始记录为 NOT_EXECUTED 占位，未执行真实模型'
          : '需 36 个基准真实逻辑运行记录',
      },
      'AC-02': {
        met: false,
        note: '候选对照需真实执行后比较质量/证据/调用/耗时/人工/费用',
      },
      'AC-03': {
        met: recommendations.length > 0,
        note: '建议框架已生成；真实结论待样本完成后复核',
      },
      'AC-04': {
        met: true,
        note: '实验配置隔离于 scripts/benchmark/loc-045/；生产 templates/ 未被覆盖',
      },
    },
    freeze: freeze ? { frozen_at: freeze.frozen_at, task_registry_digest: freeze.task_registry_digest } : null,
    fixture_verification: fixtureChecks,
    planned_runs: listPlannedTrials(registry).length,
    trial_record_count: trials.length,
    recommendations,
    c2_config: C2_CONFIG,
    not_executed: trials.filter((t) => t.status === 'NOT_EXECUTED').map((t) => t.trial_id),
    rerun_commands: [
      'node scripts/benchmark/loc-045/bin/loc-045-freeze.mjs',
      'node scripts/benchmark/loc-045/bin/loc-045-prepare.mjs',
      'node scripts/benchmark/loc-045/bin/loc-045-report.mjs',
    ],
  }
}

export function writeResearchReport(opts = {}) {
  const benchRoot = opts.benchRoot ?? BENCH_ROOT
  const report = buildResearchReport({ benchRoot, ...opts })
  const dir = opts.reportsDir ?? join(benchRoot, 'reports')
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'research-report.json')
  const mdPath = join(dir, 'research-report.md')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  writeFileSync(mdPath, formatReportMarkdown(report), 'utf8')
  return { jsonPath, mdPath, report }
}

function formatReportMarkdown(report) {
  const lines = [
    `# ${report.title}`,
    '',
    `**实验状态**：\`${report.status}\`（${report.experiment_status_meaning[report.status]}）`,
    '',
    `生成时间：${report.generated_at}`,
    '',
    '## 验收条件映射',
    '',
  ]
  for (const [ac, info] of Object.entries(report.ac_mapping)) {
    lines.push(`- **${ac}**：${info.met ? '结构就绪' : '待真实执行'} — ${info.note}`)
  }
  lines.push('', '## 候选建议（框架）', '')
  for (const rec of report.recommendations) {
    lines.push(`- ${JSON.stringify(rec)}`)
  }
  lines.push('', '## 复跑命令', '')
  for (const cmd of report.rerun_commands) {
    lines.push(`\`${cmd}\``)
  }
  lines.push('', '---', '', '*本报告不将降低关口或降低质量当作收益；无真实模型样本时不得宣称调用节省。*')
  return lines.join('\n') + '\n'
}
