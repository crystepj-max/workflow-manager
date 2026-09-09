// Blueprint ↔ VWF DSL 形态投影内核——唯一实现。
// 消费方：生成器（scripts/generate.mjs）直接 import；校验内核（scripts/validate-core.cjs）
// 只转发导出；宿主 vwf 插件经 dist 加载，其加载器预解析 validate-core 声明的本文件引用。
// 纯计算：不访问文件、不调用 DSH、不执行业务校验；Host 的加载与输入适配留在 Host。
// 逐键条件装配：DSL 经 lossless-JSON RPC 传输，undefined 键会被拒绝；projectToVwf 与
// projectToBlueprint 必须互逆，否则内置模板在编辑器另存后会丢字段（verifyBranch 曾因此被丢掉）。

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child)
    return out
  }
  return value
}

function isDefined(value) {
  return value !== undefined
}

function projectToVwf(bp) {
  const models = (bp.bindings && bp.bindings.models) || {}
  const out = {
    id: bp.id,
    name: bp.displayName,
    description: bp.description || '',
    entry: bp.entry,
    control: { maxRounds: (bp.control && bp.control.maxRounds) || 9 },
    nodes: bp.nodes.map((n) => {
      const node = { id: n.id, profile: n.profile, label: n.label || n.id }
      if (n.goal !== undefined && n.goal !== null) node.goal = cloneValue(n.goal)
      if (isDefined(n.kind)) node.kind = cloneValue(n.kind)
      if (isDefined(n.items)) node.items = cloneValue(n.items)
      if (isDefined(n.failOn)) node.failOn = cloneValue(n.failOn)
      if (n.output) node.output = cloneValue(n.output)
      if (n.manualCheck) node.manualCheck = true
      if (n.verifyBranch) node.verifyBranch = true
      if (models[n.id]) node.model = cloneValue(models[n.id])
      return node
    }),
    edges: bp.edges.map((e) => {
      const edge = { from: e.from, to: e.to }
      if (isDefined(e.on)) edge.on = cloneValue(e.on)
      if (isDefined(e.when)) edge.when = cloneValue(e.when)
      if (isDefined(e.result)) edge.result = cloneValue(e.result)
      if (isDefined(e.outcome)) edge.outcome = cloneValue(e.outcome)
      if (isDefined(e.countRound)) edge.countRound = cloneValue(e.countRound)
      return edge
    }),
  }
  if (isDefined(bp.onMaxRounds)) out.onMaxRounds = cloneValue(bp.onMaxRounds)
  if (bp.heteroCheck) out.heteroCheck = true
  if (bp.bundleRoles) out.bundleRoles = true
  if (isDefined(bp.humanDecision)) out.humanDecision = cloneValue(bp.humanDecision)
  return out
}

function projectToBlueprint(dsl) {
  const models = {}
  const nodes = (dsl.nodes || []).map((n) => {
    const node = { id: n.id, profile: n.profile, label: n.label || n.id, goal: n.goal || '' }
    if (isDefined(n.kind)) node.kind = cloneValue(n.kind)
    if (isDefined(n.items)) node.items = cloneValue(n.items)
    if (isDefined(n.failOn)) node.failOn = cloneValue(n.failOn)
    if (n.output) node.output = cloneValue(n.output)
    if (n.manualCheck) node.manualCheck = true
    if (n.verifyBranch) node.verifyBranch = true
    if (n.model && typeof n.model === 'object' && n.model.provider && n.model.model) {
      models[n.id] = {
        provider: cloneValue(n.model.provider),
        model: cloneValue(n.model.model),
      }
    }
    return node
  })
  const bp = {
    id: dsl.id,
    // 空/空白名称原样保留（displayName 必填校验会拒绝），仅缺省（undefined）兜底 id
    displayName: typeof dsl.name === 'string' ? dsl.name : (dsl.id || ''),
    entry: dsl.entry,
    nodes,
    edges: (dsl.edges || []).map((e) => {
      const edge = { from: e.from, to: e.to }
      if (isDefined(e.on)) edge.on = cloneValue(e.on)
      if (isDefined(e.when)) edge.when = cloneValue(e.when)
      if (isDefined(e.result)) edge.result = cloneValue(e.result)
      if (isDefined(e.outcome)) edge.outcome = cloneValue(e.outcome)
      if (isDefined(e.countRound)) edge.countRound = cloneValue(e.countRound)
      return edge
    }),
  }
  if (dsl.description) bp.description = cloneValue(dsl.description)
  if (dsl.control && dsl.control.maxRounds != null) {
    bp.control = { maxRounds: cloneValue(dsl.control.maxRounds) }
  }
  if (isDefined(dsl.onMaxRounds)) bp.onMaxRounds = cloneValue(dsl.onMaxRounds)
  if (dsl.heteroCheck) bp.heteroCheck = true
  if (dsl.bundleRoles) bp.bundleRoles = true
  if (isDefined(dsl.humanDecision)) bp.humanDecision = cloneValue(dsl.humanDecision)
  if (Object.keys(models).length) bp.bindings = { models }
  return bp
}

module.exports = { projectToVwf, projectToBlueprint }
