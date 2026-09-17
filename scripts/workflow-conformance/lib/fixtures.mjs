import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/conformance')

export function fixtureRoot() {
  return FIXTURE_ROOT
}

export function loadManifest() {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))
}

function codePoints(s) {
  return [...s].length
}

export function validateConstructionFixture() {
  const dir = join(FIXTURE_ROOT, 'construction')
  const out = execFileSync(process.execPath, [join(dir, 'cli.mjs'), '--version'], { encoding: 'utf8' }).trim()
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const help = execFileSync(process.execPath, [join(dir, 'cli.mjs'), '--help'], { encoding: 'utf8' })
  return {
    id: 'construction',
    version_output: out,
    expected_version: pkg.version,
    help_ok: help.includes('--version'),
    pass: out === pkg.version && help.includes('--version'),
  }
}

export function validateOptimizeFixture() {
  const src = readFileSync(join(FIXTURE_ROOT, 'optimize/source-document.md'), 'utf8')
  const facts = [...src.matchAll(/^\d+\.\s.+$/gm)].map((m) => m[0])
  const optimized = readFileSync(join(FIXTURE_ROOT, 'optimize/optimized-document.md'), 'utf8')
  const optFacts = [...optimized.matchAll(/^\d+\.\s.+$/gm)].map((m) => m[0])
  const srcLen = codePoints(src)
  const optLen = codePoints(optimized)
  const reduction = (srcLen - optLen) / srcLen
  const factsPreserved = facts.length === 10 && facts.every((f, i) => optFacts[i] === f)
  return {
    id: 'optimize',
    source_codepoints: srcLen,
    optimized_codepoints: optLen,
    reduction_ratio: reduction,
    facts_count: facts.length,
    facts_preserved: factsPreserved,
    pass: facts.length === 10 && factsPreserved && reduction >= 0.2,
  }
}

export function validateDiagnoseFixture() {
  const load = async (name) => (await import(join(FIXTURE_ROOT, 'diagnose', name))).sum
  return (async () => {
    const buggy = await load('sum-buggy.mjs')
    const fixed = await load('sum-fixed.mjs')
    return {
      id: 'diagnose',
      buggy_235: buggy([2, 3, 5]),
      fixed_235: fixed([2, 3, 5]),
      fixed_empty: fixed([]),
      fixed_single: fixed([7]),
      pass: buggy([2, 3, 5]) === 5 && fixed([2, 3, 5]) === 10 && fixed([]) === 0 && fixed([7]) === 7,
    }
  })()
}

export function validateExploreFixture() {
  const sourcesDir = join(FIXTURE_ROOT, 'explore/sources')
  const files = ['01-support-a-ops.md', '02-support-a-scale.md', '03-support-b-autonomy.md', '04-support-b-latency.md', '05-shared-source-vendor.md', '06-cost-unknown.md']
  const present = files.every((f) => existsSync(join(sourcesDir, f)))
  const question = readFileSync(join(FIXTURE_ROOT, 'explore/research-question.md'), 'utf8')
  return {
    id: 'explore',
    source_files: files.length,
    all_present: present,
    question_ok: question.includes('A') && question.includes('B'),
    pass: present && files.length === 6 && question.includes('成本未知'),
  }
}

export async function validateAllFixtures() {
  const [diagnose] = await Promise.all([validateDiagnoseFixture()])
  return {
    construction: validateConstructionFixture(),
    optimize: validateOptimizeFixture(),
    diagnose,
    explore: validateExploreFixture(),
  }
}
