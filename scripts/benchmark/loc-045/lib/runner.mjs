import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTaskRegistry, listPlannedTrials } from './task-registry.mjs'
import { computeFreeze, writeFreezeManifest, loadFreezeManifest } from './freeze.mjs'
import { emptyTrialRecord, writeTrialRecord, loadAllTrialRecords } from './trial-record.mjs'
import { summarizeExperimentStatus } from './metrics.mjs'

const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function prepareExperiment({ benchRoot = BENCH_ROOT, resultsDir, configRoot } = {}) {
  const registry = loadTaskRegistry(benchRoot)
  const freeze = computeFreeze({ benchRoot })
  const cfgRoot = configRoot ?? benchRoot
  writeFreezeManifest(cfgRoot, freeze)
  const outDir = resultsDir ?? join(benchRoot, 'results/prepared')
  mkdirSync(outDir, { recursive: true })
  const trials = listPlannedTrials(registry)
  for (const plan of trials) {
    const record = emptyTrialRecord({ ...plan, freeze })
    writeTrialRecord(outDir, record)
  }
  return {
    status: 'PREPARED',
    freeze_manifest: join(cfgRoot, 'config/freeze-manifest.json'),
    planned_runs: trials.length,
    results_dir: outDir,
    message: '实验准备完成：已生成冻结摘要与 NOT_EXECUTED 占位记录；未执行真实模型调用，不得宣称收益。',
  }
}

export function getExperimentSummary(benchRoot = BENCH_ROOT) {
  const registry = loadTaskRegistry(benchRoot)
  const freeze = loadFreezeManifest(benchRoot)
  const resultsDir = join(benchRoot, 'results/prepared')
  const trials = loadAllTrialRecords(resultsDir)
  return {
    registry_version: registry.version,
    freeze_present: Boolean(freeze),
    planned_runs: listPlannedTrials(registry).length,
    trial_records: trials.length,
    experiment_status: summarizeExperimentStatus(trials.length ? trials : listPlannedTrials(registry).map((p) => ({ status: 'NOT_EXECUTED' }))),
    arms: registry.arms,
  }
}
