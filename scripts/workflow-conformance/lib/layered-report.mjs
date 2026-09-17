// LOC-042：四层证据报告（自动契约 / 真实 DSH / 真实模型 / 人工验收）
import { findRepoRoot } from './repo-root.mjs'
import { classifyProbeResult } from './probes.mjs'

export function buildLayeredReport({
  repoRoot = findRepoRoot(),
  probesResult,
  negativeResult,
  chainsResult,
  fixturesResult,
  head,
  branch,
}) {
  const probeItems = probesResult.probes.map((p) => {
    const cls = classifyProbeResult(p)
    return { id: p.id, classification: cls.classification, observed: cls.observed, wr: p.gap?.wr, loc: p.gap?.loc }
  })

  const negativePass = negativeResult.cases.every((c) => c.pass)
  const chainsPass = chainsResult.chains.every((c) => c.pass)
  const fixturesPass = Object.values(fixturesResult).every((f) => f.pass)

  const autoContract = {
    layer: 'auto_contract',
    status: negativePass && chainsPass && fixturesPass ? 'PASS' : 'FAIL',
    reason: null,
    components: {
      historical_probes: probeItems,
      negative_cases: negativeResult.cases.map((c) => ({ id: c.id, pass: c.pass, wr: c.wr, interface: c.interface })),
      consumer_chains: chainsResult.chains.map((c) => ({ template: c.template, pass: c.pass, scenarios: c.scenarios })),
      frozen_fixtures: Object.fromEntries(Object.entries(fixturesResult).map(([k, v]) => [k, v.pass])),
    },
  }

  const realDsh = {
    layer: 'real_dsh_e2e',
    status: 'UNVERIFIED',
    reason: '夜间无人值守会话不部署产品 DSH；留次日人工按 README 实装路径执行',
  }

  const realModel = {
    layer: 'real_model_behavior',
    status: 'UNVERIFIED',
    reason: '本任务机器层使用 runtime harness 替身；真实模型波动与成本留人工层',
  }

  const humanUat = {
    layer: 'human_acceptance',
    status: 'BLOCKED',
    reason: '等待人工按 uat-card.md 四组 UAT 签收；Agent 不得代签',
  }

  const machineLayerPass = negativePass && chainsPass && fixturesPass

  return {
    task: 'LOC-042',
    head,
    branch,
    generated_at: new Date().toISOString(),
    layers: [autoContract, realDsh, realModel, humanUat],
    machine_gate: {
      conformance_entry: 'node scripts/workflow-conformance/run.mjs',
      release_verify_refs_conformance: true,
      machine_layer_pass: machineLayerPass,
    },
    known_gaps_observed: probeItems.filter((p) => p.classification === 'KNOWN_GAP'),
    summary: {
      auto_contract: autoContract.status,
      real_dsh: realDsh.status,
      real_model: realModel.status,
      human: humanUat.status,
    },
  }
}
