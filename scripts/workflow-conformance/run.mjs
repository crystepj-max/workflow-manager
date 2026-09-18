#!/usr/bin/env node
// LOC-042 消费方契约与端到端验收入口
// 用法：
//   node scripts/workflow-conformance/run.mjs              # 完整机器层 + JSON 报告
//   node scripts/workflow-conformance/run.mjs --machine-only  # 仅机器层（release:verify 引用）
//   node scripts/workflow-conformance/run.mjs --json <path>   # 写入报告文件
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { findRepoRoot } from './lib/repo-root.mjs'
import { runAllProbes } from './lib/probes.mjs'
import { runNegativeCases } from './lib/negative-cases.mjs'
import { runConsumerChains } from './lib/consumer-chains.mjs'
import { validateAllFixtures } from './lib/fixtures.mjs'
import { buildLayeredReport } from './lib/layered-report.mjs'

const repoRoot = findRepoRoot()
const machineOnly = process.argv.includes('--machine-only')
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

async function main() {
  const head = git(['rev-parse', 'HEAD'])
  const branch = git(['branch', '--show-current'])

  const [probesResult, negativeResult, chainsResult, fixturesResult] = await Promise.all([
    runAllProbes(repoRoot),
    runNegativeCases(repoRoot),
    runConsumerChains(repoRoot),
    validateAllFixtures(),
  ])

  const report = buildLayeredReport({
    repoRoot,
    probesResult,
    negativeResult,
    chainsResult,
    fixturesResult,
    head,
    branch,
  })

  report.details = { probes: probesResult, negative: negativeResult, chains: chainsResult, fixtures: fixturesResult }

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n')

  const failures = []
  if (!negativeResult.cases.every((c) => c.pass)) failures.push('negative_cases')
  if (!chainsResult.chains.every((c) => c.pass)) failures.push('consumer_chains')
  if (!Object.values(fixturesResult).every((f) => f.pass)) failures.push('frozen_fixtures')

  if (!machineOnly) {
    console.log(JSON.stringify({ summary: report.summary, known_gaps: report.known_gaps_observed.length }, null, 2))
  }

  if (failures.length) {
    console.error('LOC-042 机器层失败：' + failures.join(', '))
    process.exit(1)
  }
  console.log('LOC-042 机器层 PASS（探针观测与 known_gaps 分列，不冒充产品全绿）')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
