// Logical Run 运行时集成（#79）：编译脚本对 model_overrides 的真实合并行为。
// 快照修订只允许换 Provider/Model（R3）——覆盖经 args 注入后在脚本内合并进
// MODELS，agent 调用实际收到覆盖后的 provider/model；未覆盖节点沿用蓝图绑定。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const SPEC_BLUEPRINT = {
  id: 'logical-run-spec', displayName: '逻辑运行规格图', description: '', entry: 'explore',
  control: { maxRounds: 9 },
  bindings: { models: { explore: { provider: 'p1', model: 'm1' }, review: { provider: 'p1', model: 'm1' } } },
  nodes: [
    { id: 'explore', profile: 'researcher', label: '探索', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'review', profile: 'review', label: '审核', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
  ],
  edges: [
    { from: 'explore', to: 'review', outcome: 'PASS' },
    { from: 'review', to: '$end', on: 'success' },
  ],
}

test('#79 编译脚本：model_overrides 按节点合并进 agent 调用（未覆盖节点沿用绑定）', async () => {
  const script = compileBlueprint(SPEC_BLUEPRINT).script
  const agent = makeAgentScript({
    探索: { verdict: 'PASS' },
    审核: { result: 'ok' },
  })
  const { result } = await runGeneratedScript(script, {
    args: { taskId: 'issue-mo', model_overrides: { explore: { provider: 'p2', model: 'm2' } } },
    agent,
  })
  assert.equal(result.status, 'DONE')
  const exploreCall = agent.calls.find((c) => c.label === '探索')
  const reviewCall = agent.calls.find((c) => c.label === '审核')
  assert.equal(exploreCall.opts.provider, 'vwf-node-isolated:test-route-explore', '覆盖后的模型仍经宿主隔离路由调用')
  assert.equal(exploreCall.opts.model, 'm2', '被覆盖节点实际使用 Rev2 模型')
  assert.equal(reviewCall.opts.provider, 'vwf-node-isolated:test-route-review', '未覆盖模型也不能绕过隔离路由')
  assert.equal(reviewCall.opts.model, 'm1', '未覆盖节点沿用蓝图模型')
})

test('#79 编译脚本：$default 覆盖作用于未显式覆盖的绑定节点', async () => {
  const script = compileBlueprint(SPEC_BLUEPRINT).script
  const agent = makeAgentScript({ 探索: { verdict: 'PASS' }, 审核: { result: 'ok' } })
  const { result } = await runGeneratedScript(script, {
    args: { taskId: 'issue-mo', model_overrides: { $default: { provider: 'pd', model: 'md' }, explore: { provider: 'p2' } } },
    agent,
  })
  assert.equal(result.status, 'DONE')
  const exploreCall = agent.calls.find((c) => c.label === '探索')
  const reviewCall = agent.calls.find((c) => c.label === '审核')
  assert.equal(exploreCall.opts.provider, 'vwf-node-isolated:test-route-explore')
  assert.equal(exploreCall.opts.model, 'm1', '显式节点覆盖保留旧模型')
  assert.equal(reviewCall.opts.provider, 'vwf-node-isolated:test-route-review')
  assert.equal(reviewCall.opts.model, 'md', '$default 作用于未显式覆盖节点')
})

test('#79 编译脚本：无 model_overrides 时行为与既有完全一致', async () => {
  const script = compileBlueprint(SPEC_BLUEPRINT).script
  const agent = makeAgentScript({ 探索: { verdict: 'PASS' }, 审核: { result: 'ok' } })
  const { result } = await runGeneratedScript(script, { args: { taskId: 'issue-mo' }, agent })
  assert.equal(result.status, 'DONE')
  for (const c of agent.calls) {
    assert.match(c.opts.provider, /^vwf-node-isolated:/, '没有覆盖时也始终使用宿主隔离路由')
    assert.equal(c.opts.model, 'm1')
  }
})
