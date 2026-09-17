// LOC-042：四模板消费方契约与代表性端到端验收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { runAllProbes, classifyProbeResult } from '../workflow-conformance/lib/probes.mjs'
import { runNegativeCases } from '../workflow-conformance/lib/negative-cases.mjs'
import { runConsumerChains } from '../workflow-conformance/lib/consumer-chains.mjs'
import { validateAllFixtures, loadManifest, fixtureRoot } from '../workflow-conformance/lib/fixtures.mjs'
import { KNOWN_GAPS } from '../workflow-conformance/lib/known-gaps.mjs'
import { buildLayeredReport } from '../workflow-conformance/lib/layered-report.mjs'
import { findRepoRoot } from '../workflow-conformance/lib/repo-root.mjs'

const repoRoot = findRepoRoot()
const here = dirname(fileURLToPath(import.meta.url))

test('AC-04 夹具清单冻结且路径可迁移（无作者绝对路径）', () => {
  const manifest = loadManifest()
  assert.equal(manifest.fixtures.construction.template, 'wf-construction-full-feature')
  assert.equal(manifest.fixtures.optimize.fact_count, 10)
  assert.ok(existsSync(join(fixtureRoot(), 'construction/cli.mjs')))
  assert.ok(existsSync(join(fixtureRoot(), 'explore/sources/06-cost-unknown.md')))
  const raw = readFileSync(join(fixtureRoot(), 'manifest.json'), 'utf8')
  assert.ok(!raw.includes('/Users/'), 'manifest 不得含作者路径')
})

test('AC-04 四固定夹具客观验收', async () => {
  const fixtures = await validateAllFixtures()
  for (const [id, result] of Object.entries(fixtures)) {
    assert.equal(result.pass, true, id + ': ' + JSON.stringify(result))
  }
  const opt = fixtures.optimize
  assert.ok(opt.reduction_ratio >= 0.2, '优化压缩率应 ≥20%')
})

test('AC-01 七历史探针可观测且映射 known_gaps', async () => {
  const result = await runAllProbes(repoRoot)
  assert.equal(result.probes.length, 7)
  for (const p of result.probes) {
    assert.ok(p.id, '探针须有 id')
    assert.ok(p.gap, p.id + ' 须映射 known_gaps')
    const cls = classifyProbeResult(p)
    assert.ok(['KNOWN_GAP', 'CONTROL_GREEN', 'UNMAPPED'].includes(cls.classification))
  }
  assert.equal(KNOWN_GAPS.length, 7)
})

test('AC-01 三类负例与控制夹具：坏样例红、控制绿', async () => {
  const { cases } = await runNegativeCases(repoRoot)
  assert.equal(cases.length, 4)
  const bad = cases.filter((c) => c.bad)
  const control = cases.find((c) => c.id === 'control-valid-handoff')
  assert.ok(bad.every((c) => c.pass), '负例须被观察：' + JSON.stringify(bad.filter((c) => !c.pass)))
  assert.equal(control.pass, true)
  for (const c of bad) {
    assert.ok(c.wr && c.interface, c.id + ' 须定位 WR 与接口')
  }
})

test('AC-02 四模板生产→消费链：返工/等待/恢复/部分失败', async () => {
  const { chains } = await runConsumerChains(repoRoot)
  assert.equal(chains.length, 4)
  for (const c of chains) {
    assert.equal(c.pass, true, c.template + ': ' + JSON.stringify(c))
    assert.ok(c.scenarios.length >= 1)
  }
  const scenarios = chains.flatMap((c) => c.scenarios)
  assert.ok(scenarios.includes('rework'))
  assert.ok(scenarios.includes('human_wait'))
  assert.ok(scenarios.includes('blocked_recovery'))
  assert.ok(scenarios.includes('partial_failure'))
})

test('AC-03 分层报告：自动/实装/模型/人工分列，未执行层无 PASS', async () => {
  const [probes, negative, chains, fixtures] = await Promise.all([
    runAllProbes(repoRoot),
    runNegativeCases(repoRoot),
    runConsumerChains(repoRoot),
    validateAllFixtures(),
  ])
  const report = buildLayeredReport({
    repoRoot,
    probesResult: probes,
    negativeResult: negative,
    chainsResult: chains,
    fixturesResult: fixtures,
    head: 'test-head',
    branch: 'dev-loc-042-r1',
  })
  const layers = Object.fromEntries(report.layers.map((l) => [l.layer, l.status]))
  assert.equal(layers.auto_contract, 'PASS')
  assert.equal(layers.real_dsh_e2e, 'UNVERIFIED')
  assert.equal(layers.real_model_behavior, 'UNVERIFIED')
  assert.ok(['BLOCKED', 'UNVERIFIED'].includes(layers.human_acceptance))
  assert.ok(layers.real_dsh_e2e !== 'PASS')
})

test('AC-04 CLI 入口可复跑', () => {
  const out = execFileSync(process.execPath, ['scripts/workflow-conformance/run.mjs', '--machine-only'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.ok(out.includes('PASS') || out.length === 0)
})
