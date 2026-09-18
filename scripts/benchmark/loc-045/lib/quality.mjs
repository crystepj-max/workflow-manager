import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function runFixtureVerifier(taskId, benchRoot = BENCH_ROOT, fixtureDir = `tasks/${taskId}`) {
  const taskRoot = join(benchRoot, fixtureDir)
  const script = join(taskRoot, 'verify.mjs')
  try {
    execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: taskRoot })
    return { task_id: taskId, pass: true, checks: ['fixture_verifier'] }
  } catch (e) {
    return {
      task_id: taskId,
      pass: false,
      checks: ['fixture_verifier'],
      error: String(e.stderr || e.message || e),
    }
  }
}

export function verifyAllFixtures(registry, benchRoot = BENCH_ROOT) {
  return registry.tasks.map((t) => runFixtureVerifier(t.id, benchRoot, t.fixture_dir))
}

export function allFixturesPass(results) {
  return results.every((r) => r.pass)
}
