// 运行时排练厅（runtime harness）——候选三产物，契约见 CONTEXT.md「运行时排练厅」。
// 用途：把生成的 workflow 脚本当黑盒真实执行（stub agent/log/phase），断言返回体（接口）
// 而非字符串嗅探。演员表 = 剧本：按 agent 出场 label（精确或正则）提供台词，
// 台词可为静态值或函数；交作业（result）会按 opts.schema（8 关键字子集）验收，
// 不合格返回 null（仿真真实引擎：带 schema 时 resolve 校验后对象、子代理失败 resolve null）。

// ---------- schema 验收器（8 关键字子集：type/oneOf/properties/required/
// additionalProperties/items/enum/const；注解字段忽略） ----------
function typeOk(t, v) {
  switch (t) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'array': return Array.isArray(v)
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number'
    case 'integer': return Number.isInteger(v)
    case 'boolean': return typeof v === 'boolean'
    case 'null': return v === null
    default: return true
  }
}

export function validateResult(schema, value) {
  if (schema === undefined || schema === null || typeof schema !== 'object') return true
  if (schema.oneOf !== undefined) {
    let n = 0
    for (const alt of schema.oneOf) if (validateResult(alt, value)) n++
    return n === 1
  }
  if (schema.const !== undefined) return value === schema.const
  if (schema.enum !== undefined) return schema.enum.includes(value)
  const t = schema.type
  if (Array.isArray(t)) { if (!t.some((x) => typeOk(x, value))) return false }
  else if (typeof t === 'string' && t !== 'object' && t !== 'array') { if (!typeOk(t, value)) return false }
  if (t === 'object' || (Array.isArray(t) && t.includes('object'))) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    if (schema.properties) {
      for (const k of schema.required || []) if (!(k in value)) return false
      for (const [k, v] of Object.entries(value)) {
        const ps = schema.properties[k]
        if (ps === undefined) { if (schema.additionalProperties === false) return false; continue }
        if (!validateResult(ps, v)) return false
      }
    }
  } else if (t === 'array' || (Array.isArray(t) && t.includes('array'))) {
    if (!Array.isArray(value)) return false
    if (schema.items) for (const v of value) if (!validateResult(schema.items, v)) return false
  }
  return true
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
    calls.push({ label, index, prompt: String(prompt), opts: { label, schema: opts.schema }, result: value, rejected })
    return rejected ? null : value
  }
  agent.calls = calls
  return agent
}

// ---------- 执行入口 ----------
// run(script, { args, agent }) → { result, agentCalls, logs, phases }
// 把脚本包进 async IIFE，再注入真实脚本契约中的五个钩子全局与 args。
export async function runGeneratedScript(script, { args = {}, agent } = {}) {
  const logs = []
  const phases = []
  const noAgent = async () => { throw new Error('排练厅：脚本调用了 agent 但未提供演员表') }
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
  const fn = new Function('args', 'agent', 'parallel', 'pipeline', 'log', 'phase',
    'return (async () => {\n' + script + '\n})()')
  const result = await fn(args, agent || noAgent, parallel, pipeline, (m) => logs.push(String(m)), (t) => phases.push(String(t)))
  return { result, logs, phases, agentCalls: agent ? agent.calls : [] }
}
