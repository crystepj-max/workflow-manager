import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestDirectory, sha256File } from './digest.mjs'
import { loadTaskRegistry } from './task-registry.mjs'

const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(BENCH_ROOT, '../../..')

export function computeFreeze({ benchRoot = BENCH_ROOT, repoRoot = REPO_ROOT } = {}) {
  const registry = loadTaskRegistry(benchRoot)
  const fixture_digests = {}
  for (const task of registry.tasks) {
    const dir = join(benchRoot, task.fixture_dir)
    fixture_digests[task.id] = digestDirectory(dir)
  }
  const template_digests = {}
  for (const name of ['wf-construction-full-feature', 'wf-optimize', 'wf-diagnose', 'wf-explore']) {
    const p = join(repoRoot, 'templates', `${name}.json`)
    template_digests[name] = sha256File(p)
  }
  const script_digest = sha256File(join(repoRoot, 'scripts/generate.mjs'))
  const baseline_digest = sha256File(join(repoRoot, 'docs/tasks/specs/LOC-045-workflow-complexity-benchmark/benchmark-plan-V1.md'))
  const configPath = join(benchRoot, 'config/experiment.json')
  const experiment = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {}
  return {
    frozen_at: new Date().toISOString(),
    repo_head: null,
    fixture_digests,
    template_digests,
    script_digest,
    baseline_digest,
    model_settings: experiment.model_settings ?? {
      model_config_ref: 'GLM-5.3-Flash',
      budget_authorization_ref: '100000000 tokens',
      budget_enforcement: 'per-run token check',
      profile_frozen: false,
      note: 'Profile 引用在真实实验开工时按环境凭据落定',
    },
    task_registry_digest: sha256File(join(benchRoot, 'tasks.json')),
  }
}

export function writeFreezeManifest(benchRoot = BENCH_ROOT, freeze) {
  const dir = join(benchRoot, 'config')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'freeze-manifest.json')
  writeFileSync(path, JSON.stringify(freeze, null, 2) + '\n', 'utf8')
  return path
}

export function loadFreezeManifest(benchRoot = BENCH_ROOT) {
  const path = join(benchRoot, 'config/freeze-manifest.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}
