// LOC-042：三类负例 + 控制夹具（坏样例红、修复控制绿）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from './repo-root.mjs'
import { loadRuntime } from './probes.mjs'

const miniBp = (inputs, consumerLabel = '消费') => ({
  id: 'conformance-negative-mini',
  displayName: '负例迷你图',
  entry: 'src',
  nodes: [
    {
      id: 'src', profile: 'dev', label: '来源', goal: 'g',
      output: {
        outcomePath: '$.route',
        schema: { type: 'object', properties: { route: { type: 'string', enum: ['GO', 'SKIP'] } }, required: ['route'], additionalProperties: false },
      },
    },
    {
      id: 'producer', profile: 'dev', label: '生产', goal: 'g',
      output: {
        outcomePath: '$.route',
        schema: {
          type: 'object',
          properties: { route: { type: 'string', enum: ['DONE'] }, digest: { type: 'string' }, payload: { type: 'string' } },
          required: ['route', 'digest', 'payload'],
          additionalProperties: false,
        },
        files: { 'producer-report.md': 'markdown' },
      },
    },
    {
      id: 'consumer', profile: 'dev', label: consumerLabel, goal: 'g', inputs,
      output: {
        outcomePath: '$.route',
        schema: { type: 'object', properties: { route: { type: 'string', enum: ['DONE'] } }, required: ['route'], additionalProperties: false },
      },
    },
  ],
  edges: [
    { from: 'src', to: 'producer', outcome: 'GO' },
    { from: 'src', to: 'consumer', outcome: 'SKIP' },
    { from: 'producer', to: 'consumer', outcome: 'DONE' },
    { from: 'consumer', to: '$end', outcome: 'DONE' },
    { from: 'consumer', to: 'consumer', on: 'technical' },
  ],
})

export async function runNegativeCases(repoRoot = findRepoRoot()) {
  const { compileBlueprint, runGeneratedScript, makeAgentScript } = await loadRuntime(repoRoot)
  const cases = []

  async function runMini(inputs, table, args = {}) {
    const bp = miniBp(inputs)
    const { script } = compileBlueprint(bp)
    return runGeneratedScript(script, { args, agent: makeAgentScript(table) })
  }

  // 负例 1：缺文件/缺生产（必需引用对应的生产节点未运行）
  const missingProducer = await runMini(
    [{ name: 'payload', from: '$.results.producer.payload', required: true, artifact: 'producer-report.md' }],
    { 来源: { route: 'SKIP' }, 消费: { route: 'DONE' } },
  )
  cases.push({
    id: 'negative-missing-artifact',
    wr: 'WR-008',
    interface: 'resolveInputs / artifact_ref',
    bad: true,
    status: missingProducer.result.status,
    node: missingProducer.result.node,
    binding: missingProducer.result.errors?.[0]?.binding,
    consumer_calls: missingProducer.agentCalls.filter((c) => c.label === '消费').length,
    pass: missingProducer.result.status === 'ERROR' && missingProducer.agentCalls.filter((c) => c.label === '消费').length === 0,
  })

  // 负例 2：旧输入版本（消费方应收到最新 producer 字段，非路由终态）
  const staleBp = miniBp([
    { name: 'digest', from: '$.results.producer.digest', required: true },
  ])
  let prodRound = 0
  const staleRun = await runGeneratedScript(compileBlueprint(staleBp).script, {
    args: {},
    agent: makeAgentScript({
      来源: { route: 'GO' },
      生产: () => ({ route: 'DONE', digest: 'digest-v' + (++prodRound), payload: 'P' + prodRound }),
      消费: { route: 'DONE' },
    }),
  })
  const resolved = staleRun.result.resolved_inputs?.consumer?.items?.find((i) => i.binding === 'digest')
  cases.push({
    id: 'negative-stale-input-version',
    wr: 'WR-001',
    interface: 'resolved_inputs.version_ref',
    bad: true,
    resolved_digest: resolved?.value,
    version_ref: resolved?.version_ref,
    pass: resolved?.value === 'digest-v1' && /^tmp-exec:\d+:[0-9a-f]{8}$/.test(resolved?.version_ref || ''),
  })

  // 负例 3：错误类型（schema 不匹配 → rejected，不得静默当 DONE）
  const wrongType = await runMini(
    [{ name: 'payload', from: '$.results.producer.payload', required: true }],
    { 来源: { route: 'GO' }, 生产: { route: 'DONE', digest: 42, payload: 'P' }, 消费: { route: 'DONE' } },
  )
  cases.push({
    id: 'negative-wrong-type',
    wr: 'WR-016',
    interface: 'runtime-harness validateResult / agent rejected',
    bad: true,
    producer_rejected: wrongType.agentCalls.find((c) => c.label === '生产')?.rejected,
    status: wrongType.result.status,
    pass: wrongType.agentCalls.find((c) => c.label === '生产')?.rejected === true,
  })

  // 控制：修复后转绿
  const control = await runMini(
    [{ name: 'payload', from: '$.results.producer.payload', required: true }],
    { 来源: { route: 'GO' }, 生产: { route: 'DONE', digest: 'ok', payload: 'P' }, 消费: { route: 'DONE' } },
  )
  cases.push({
    id: 'control-valid-handoff',
    wr: 'WR-001',
    interface: 'producer → consumer resolved_inputs',
    bad: false,
    status: control.result.status,
    consumer_received: control.result.resolved_inputs?.consumer?.items?.[0]?.value,
    pass: control.result.status === 'DONE' && control.result.resolved_inputs?.consumer?.items?.[0]?.value === 'P',
  })

  return { cases, executed_at: new Date().toISOString() }
}
