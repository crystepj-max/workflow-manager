// 运行时排练厅（runtime harness）——候选三产物，契约见 CONTEXT.md「运行时排练厅」。
// 用途：把生成的 workflow 脚本当黑盒真实执行（stub agent/log/phase），断言返回体（接口）
// 而非字符串嗅探。演员表 = 剧本：按 agent 出场 label（精确或正则）提供台词，
// 台词可为静态值或函数；交作业（result）会按 opts.schema 验收（LOC-039 共享语义），
// 不合格返回 null（仿真真实引擎：带 schema 时 resolve 校验后对象、子代理失败 resolve null）。

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { legacyInstanceValid, instanceValid } = require('../../schema-protocol-core.cjs')

export function validateResult(schema, value, mode) {
  if (schema === undefined || schema === null || typeof schema !== 'object') return true
  const m = mode || 'legacy'
  return m === 'legacy' ? legacyInstanceValid(schema, value) : instanceValid(schema, value, m)
}

// ---------- 演员表（剧本） ----------
// 键：'精确label' 或 '/正则/'；值：静态结果 | (label, opts, index) => 结果。
// 出场记录挂在返回函数的 .calls 上（含 rejected 标志）。
export function makeAgentScript(table) {
  const exact = new Map()
  const patterns = []
  for (const [k, v] of Object.entries(table || {})) {
    if (k.length > 1 && k.startsWith('/') && k.endsWith('/')) patterns.push({ re: new RegExp(k.slice(1, -1)), v })
    else exact.set(k, v)
  }
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    const index = calls.length
    const hit = exact.has(label) ? { v: exact.get(label) } : patterns.find((p) => p.re.test(label))
    if (!hit) throw new Error('排练厅：剧本未覆盖演员 ' + JSON.stringify(label) + '（prompt 前 80 字：' + String(prompt).slice(0, 80) + '）')
    const value = typeof hit.v === 'function' ? await hit.v(label, opts, index) : hit.v
    const rejected = Boolean(opts.schema) && !validateResult(opts.schema, value)
    calls.push({ label, index, prompt: String(prompt), opts: { label, schema: opts.schema, cwd: opts.cwd, provider: opts.provider, model: opts.model }, result: value, rejected })
    return rejected ? null : value
  }
  agent.calls = calls
  return agent
}

// ---------- 执行入口 ----------
// run(script, { args, agent, mechanical }) → { result, agentCalls, mechanicalCalls, logs, phases }
// 把脚本包进 async IIFE，再注入真实脚本契约中的钩子全局与 args。
export async function runGeneratedScript(script, { args = {}, agent, mechanical } = {}) {
  const logs = []
  const phases = []
  const mechanicalCalls = []
  const noAgent = async () => { throw new Error('排练厅：脚本调用了 agent 但未提供演员表') }
  const defaultMechanical = async (id) => {
    if (id === 'construction-preflight') {
      return { route: 'PASS', summary: '排练厅默认机械通过', blockers: '', baseline_version: 'V1', mechanical: true, reasons: [] }
    }
    throw new Error('排练厅：脚本调用了 mechanical(' + id + ') 但未提供机械钩子')
  }
  const mechFn = mechanical || defaultMechanical
  const wrappedMechanical = async (id, ctx) => {
    const out = await mechFn(id, ctx)
    mechanicalCalls.push({ id, ctx, out })
    return out
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (thunk) => {
    try { return await thunk() } catch (e) { return null }
  }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item) => {
    let value = item
    try {
      for (const stage of stages) value = await stage(value)
      return value
    } catch (e) {
      return null
    }
  }))
  const fn = new Function('args', 'agent', 'mechanical', 'parallel', 'pipeline', 'log', 'phase',
    'return (async () => {\n' + script + '\n})()')
  const result = await fn(args, agent || noAgent, wrappedMechanical, parallel, pipeline, (m) => logs.push(String(m)), (t) => phases.push(String(t)))
  return { result, logs, phases, agentCalls: agent ? agent.calls : [], mechanicalCalls }
}
