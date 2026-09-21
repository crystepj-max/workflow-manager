import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTaskRegistry, listPlannedTrials, maxLogicalRuns } from '../benchmark/loc-045/lib/task-registry.mjs'
import { computeFreeze, writeFreezeManifest, loadFreezeManifest } from '../benchmark/loc-045/lib/freeze.mjs'
import { prepareExperiment, getExperimentSummary } from '../benchmark/loc-045/lib/runner.mjs'
import { verifyAllFixtures, allFixturesPass } from '../benchmark/loc-045/lib/quality.mjs'
import { buildResearchReport, writeResearchReport } from '../benchmark/loc-045/lib/report.mjs'
import { median, savingsRate, summarizeExperimentStatus } from '../benchmark/loc-045/lib/metrics.mjs'
import { runMechanicalPreflight, isC1Applicable } from '../benchmark/loc-045/lib/c1-preflight.mjs'
import { isC2Applicable, planSupplementRound } from '../benchmark/loc-045/lib/c2-supplement.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BENCH_ROOT = join(REPO_ROOT, 'scripts/benchmark/loc-045')

test('task registry lists 48 planned logical runs', () => {
  const registry = loadTaskRegistry(BENCH_ROOT)
  assert.equal(registry.tasks.length, 12)
  assert.equal(maxLogicalRuns(registry), 48)
  const trials = listPlannedTrials(registry)
  assert.equal(trials.length, 48)
  assert.equal(trials.filter((t) => t.arm === 'baseline').length, 36)
  assert.equal(trials.filter((t) => t.arm === 'c1').length, 9)
  assert.equal(trials.filter((t) => t.arm === 'c2').length, 3)
})

test('all 12 fixtures pass verify.mjs', () => {
  const registry = loadTaskRegistry(BENCH_ROOT)
  const results = verifyAllFixtures(registry, BENCH_ROOT)
  assert.equal(results.length, 12)
  assert.ok(allFixturesPass(results), JSON.stringify(results.filter((r) => !r.pass)))
})

test('freeze manifest captures digests', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'loc045-freeze-'))
  const freeze = computeFreeze({ benchRoot: BENCH_ROOT, repoRoot: REPO_ROOT })
  assert.ok(freeze.fixture_digests.B01)
  assert.ok(freeze.template_digests['wf-explore'])
  const path = writeFreezeManifest(tmp, freeze)
  const loaded = loadFreezeManifest(tmp)
  assert.equal(loaded.fixture_digests.B01, freeze.fixture_digests.B01)
  rmSync(tmp, { recursive: true, force: true })
})

test('prepare experiment creates NOT_EXECUTED trial records', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'loc045-prep-'))
  const benchTmp = join(tmp, 'bench')
  // use real bench root but isolated results/config so the repo stays clean
  const result = prepareExperiment({ benchRoot: BENCH_ROOT, resultsDir: join(tmp, 'results'), configRoot: join(tmp, 'config') })
  assert.equal(result.status, 'PREPARED')
  assert.equal(result.planned_runs, 48)
  const summary = getExperimentSummary(BENCH_ROOT)
  assert.ok(summary.planned_runs === 48)
  rmSync(tmp, { recursive: true, force: true })
})

test('research report status is PREPARED without real runs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'loc045-report-'))
  // 全部写入走临时目录：入库的冻结清单与占位记录是本实验的不可变基线，测试不得改写它们
  prepareExperiment({ benchRoot: BENCH_ROOT, resultsDir: join(tmp, 'results'), configRoot: join(tmp, 'config') })
  const report = buildResearchReport({ benchRoot: BENCH_ROOT })
  assert.equal(report.status, 'PREPARED')
  assert.equal(report.ac_mapping['AC-04'].met, true)
  assert.match(report.ac_mapping['AC-01'].note, /NOT_EXECUTED|未执行/)
  const { jsonPath } = writeResearchReport({ benchRoot: BENCH_ROOT, reportsDir: join(tmp, 'reports') })
  assert.ok(jsonPath.endsWith('research-report.json'))
  rmSync(tmp, { recursive: true, force: true })
})

test('metrics helpers', () => {
  assert.equal(median([1, 3, 2]), 2)
  const savings = savingsRate(
    [{ model_calls: [{}, {}, {}] }, { model_calls: [{}, {}] }],
    [{ model_calls: [{}] }],
  )
  assert.ok(savings.applicable)
  assert.ok(savings.rate > 0.5)
  assert.equal(summarizeExperimentStatus([{ status: 'NOT_EXECUTED' }]), 'PREPARED')
})

test('C1 mechanical preflight runs without model calls', async () => {
  const result = await runMechanicalPreflight(REPO_ROOT)
  assert.equal(result.mechanical, true)
  assert.equal(result.model_calls, 0)
  assert.ok(['PASS', 'BLOCKED'].includes(result.route))
  assert.ok(isC1Applicable('B01'))
  assert.ok(!isC1Applicable('O01'))
})

test('C2 supplement plan targets cost gap only', () => {
  assert.ok(isC2Applicable('X02'))
  const plan = planSupplementRound({
    research_targets: [{ question_id: 'cost', brief: '补成本' }],
  })
  assert.equal(plan.applicable, true)
  assert.deepEqual(plan.expert_briefs.map((e) => e.expert_id), ['cost'])
})
