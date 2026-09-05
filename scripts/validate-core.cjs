// 校验内核（候选二 T-IMP-13）——唯一规则集，单一事实源。
// 双层结构：
//   结构层 validateStructure：框架保证，与业务无关——走通性、节点/边定义合法性、
//     入口唯一、成环、when/successCondition 格式与 schema 路径、保留 id、
//     多 success-when、failure 唯一、maxRounds ∈ [1, MAX_ROUNDS_CAP]（系统上限）。
//   业务规则层 validateBlueprint：结构层 + 蓝图声明的规则——单标识（id=name）、
//     onMaxRounds 枚举、bindings 引用、heteroCheck 关联、verifyBranch 联动、
//     output.files 契约、异源硬规则 7、requireModels 选项（宿主编辑器产品收紧）。
// 消费形态：引擎 ESM `import`（Node CJS 互操作）；宿主 vwf 插件经 fs 服务读源码、
//   vm 内 `new Function('module','exports', src)` 求值并缓存（热路径内存执行，零子进程）。
// 错误结构：{ at, message, fieldKey? }——fieldKey 为编辑器逐字段标红坐标
//   （node:<id>:<field> / edge:<i>:<field> / control:<field>）；前端文案翻译为优化任务。
'use strict'

const COND_RE = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/
const HUMAN_DECISION_ID = '$human-decision'
const RESERVED = ['$end', '$entry', '$new-round', HUMAN_DECISION_ID]
const FRAMEWORK_TO = ['$end', HUMAN_DECISION_ID]
const FRAMEWORK_FROM = [HUMAN_DECISION_ID]
// 与 scripts/formal-artifacts.cjs FILE_KINDS 保持同步（#69）
const FILES_KINDS = ['json', 'markdown', 'text', 'html', 'canvas', 'flowchart', 'diagram']
const ON_MAX_ROUNDS = ['return', 'auto-reschedule']
const MAX_ROUNDS_CAP = 9 // 系统约定上限：编辑器最大可设 9 轮（用户意见 Q7）
const FANOUT_ITEMS_ARGS_RE = /^\$\.args(?:\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/
const FANOUT_ITEMS_RESULTS_RE = /^\$\.results\.([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/
const HD_RESULT_RE = /^[A-Z][A-Z0-9_]*$/
const HD_REASONS = ['HUMAN_ACCEPTANCE', 'ESCALATED_DECISION', 'MAX_ROUNDS_REACHED']
const HD_CONTROL_RESULTS = ['USER_ACCEPTED', 'ADD_BUDGET', 'STOP']
// Issue #159（A1）：运行期画卡装配把 `subsequent_effects` 建成普通对象 `{}`——choice id 若命中
// Object.prototype 继承键（toString / constructor / __proto__ 等），其判重 `pkg.subsequent_effects[id]`
// 会伪命中并把该出边静默丢弃（选项永不进画卡、续跑不可达）。这类 id 运行期无法表示，校验期
// 显式拒绝（报真实边坐标），不得依赖无原型判重表放行后再让运行期静默不可达。
const HD_RUNTIME_RESERVED_IDS = new Set(Object.getOwnPropertyNames(Object.prototype))
HD_RUNTIME_RESERVED_IDS.add('__proto__')
const HD_PACKAGE_REQUIRED = ['why', 'current_state', 'options', 'subsequent_effects']
const HD_PACKAGE_OPTIONAL_UNKNOWN = ['cost', 'benefit', 'risk', 'recommendation']
const HD_EVENT_FIELDS = [
  'record_kind', 'trigger', 'lifecycle_at_request', 'decision_id', 'run_ref',
  'node_id', 'attempt', 'reason', 'triggering_node_outcome', 'decision_package',
  'user_choice', 'impact', 'subsequent_path', 'created_at',
]
const HD_RESUME_FIELDS = ['decision_id', 'user_choice']
const HD_EVENT_RECORD_KIND = 'DECISION'
const HD_EVENT_TRIGGER = 'SYSTEM_REQUEST'
const HD_UNKNOWN = 'UNKNOWN'
const JSON_PATH_RE = /^\$\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key)
}

function hasOutcomeField(e) {
  if (!e || !hasOwn(e, 'outcome')) return false
  return e.outcome !== undefined && e.outcome !== null && e.outcome !== ''
}

function isTechnicalEdge(e) {
  return !!(e && e.on === 'technical')
}

function isStructuralEdge(e) {
  return !!(e && (e.on === 'success' || hasOutcomeField(e)))
}

function hasOutcomePath(n) {
  return !!(n && n.output && typeof n.output.outcomePath === 'string' && n.output.outcomePath.trim())
}

function parseJsonPath(expr) {
  if (typeof expr !== 'string') return null
  const m = JSON_PATH_RE.exec(expr.trim())
  return m ? m[1].split('.') : null
}

function schemaLeafAt(schema, segments) {
  let cursor = schema
  for (const key of segments) {
    if (Array.isArray(cursor)) cursor = cursor[0]
    if (!cursor || typeof cursor !== 'object') return null
    if (cursor.type === 'array' && cursor.items) cursor = cursor.items
    const props = cursor.properties
    if (!props || typeof props !== 'object' || !(key in props)) return null
    cursor = props[key]
  }
  return cursor && typeof cursor === 'object' ? cursor : null
}

function enumerableValues(leaf) {
  if (!leaf || typeof leaf !== 'object') return null
  if (Array.isArray(leaf.oneOf)) {
    const out = []
    for (let i = 0; i < leaf.oneOf.length; i++) {
      const inner = enumerableValues(leaf.oneOf[i])
      if (!inner) return null
      for (let j = 0; j < inner.length; j++) out.push(inner[j])
    }
    return out
  }
  if (leaf.const !== undefined) return [leaf.const]
  if (Array.isArray(leaf.enum)) return leaf.enum.slice()
  if (leaf.type === 'boolean') return [true, false]
  return null
}

function isStringSchemaLeaf(leaf) {
  if (!leaf || typeof leaf !== 'object') return false
  if (Array.isArray(leaf.oneOf)) {
    return leaf.oneOf.length > 0 && leaf.oneOf.every(isStringSchemaLeaf)
  }
  if (leaf.const !== undefined) return typeof leaf.const === 'string'
  if (Array.isArray(leaf.enum)) {
    return leaf.enum.length > 0 && leaf.enum.every((v) => typeof v === 'string')
  }
  return leaf.type === 'string'
}

function outcomeKey(value) {
  return JSON.stringify(value)
}

// Issue #159（方案 B）：HD 出边 choice id 与运行时取 id 逻辑逐字同构——
// 运行时（scripts/generate.mjs assembleDecisionPackage / 续跑查找）用
// `e.result || String(e.outcome)` 归一化出边 id，其中 result 段是"任意 truthy 值优先"
// （空白串 " "、数字等同样优先，绝无"非空白字符串"假设）；typed outcome（false/0 等）
// 与同名字符串（"false"/"0"），以及 result 与 outcome 同名，都会坍缩为同一 choice id，
// 导致其中一条合法出边在运行期画卡/续跑永远不可达。校验端用同一归一化 id 建冲突表，
// 杜绝"校验通过但运行期静默不可达"的中间态。HD 出边的 result+outcome 混用已在出边校验处
// 显式互斥拒绝（#159 A2），故进入本函数时二者不同边共存、取值永不分叉。
function hdChoiceId(e) {
  if (!e) return null
  if (e.result) return e.result
  const outcome = e.outcome
  if (outcome !== undefined && outcome !== null && outcome !== '') return String(outcome)
  return null
}

// ---------- 错误坐标 → 编辑器 fieldKey ----------
function fieldKeyOf(at) {
  if (!at || typeof at !== 'string') return undefined
  const node = /^\$\.nodes\[([^\]]+)\]\.(.+)$/.exec(at)
  if (node) return 'node:' + node[1] + ':' + node[2]
  // 节点级通用错误（重复 id / 保留 id / 无出边 / 不可达等）→ node:<id>:id（编辑器节点标红）
  const nodeOnly = /^\$\.nodes\[([^\]]+)\]$/.exec(at)
  if (nodeOnly) return 'node:' + nodeOnly[1] + ':id'
  const edge = /^\$\.edges\[(\d+)\]\.(.+)$/.exec(at)
  if (edge) return 'edge:' + edge[1] + ':' + edge[2]
  const control = /^\$\.control\.(.+)$/.exec(at)
  if (control) return 'control:' + control[1]
  // 工作流级业务规则字段（编辑器控件标红）
  if (at === '$.heteroCheck') return 'heteroCheck'
  if (at === '$.onMaxRounds') return 'onMaxRounds'
  if (at === '$.approved') return 'approved'
  if (at === '$.humanDecision') return 'humanDecision'
  if (at.startsWith('$.humanDecision.')) return 'humanDecision:' + at.slice('$.humanDecision.'.length)
  return undefined
}

function edgeTouchesHumanDecision(e) {
  return !!(e && (e.to === HUMAN_DECISION_ID || e.from === HUMAN_DECISION_ID))
}

function blueprintUsesHumanDecision(bp) {
  if (!bp || typeof bp !== 'object') return false
  if (bp.humanDecision !== undefined) return true
  const edges = Array.isArray(bp.edges) ? bp.edges : []
  return edges.some(edgeTouchesHumanDecision)
}

// 结构后继：success ∪ outcome；把 $human-decision 当透明跳点（入边停机、出边仍参与走通性）。
function hopSuccessors(from, edges, ids, pred) {
  const out = []
  const hopped = {}
  const visit = (src) => {
    edges.forEach((e) => {
      if (!e || e.from !== src || !pred(e)) return
      if (e.to === '$end') return
      if (e.to === HUMAN_DECISION_ID) {
        if (!hopped[HUMAN_DECISION_ID]) {
          hopped[HUMAN_DECISION_ID] = true
          visit(HUMAN_DECISION_ID)
        }
        return
      }
      if (ids && !ids[e.to]) return
      out.push(e.to)
    })
  }
  visit(from)
  return out
}

function successSuccessors(from, edges, ids) {
  return hopSuccessors(from, edges, ids, (e) => e && e.on === 'success')
}

function structuralSuccessors(from, edges, ids) {
  return hopSuccessors(from, edges, ids, isStructuralEdge)
}

// ---------- 结构层 ----------
function pathInSchema(schema, segments) {
  let cursor = schema
  for (const key of segments) {
    if (Array.isArray(cursor)) cursor = cursor[0]
    if (!cursor || typeof cursor !== 'object') return false
    if (cursor.type === 'array' && cursor.items) cursor = cursor.items
    const props = cursor.properties
    if (!props || typeof props !== 'object' || !(key in props)) return false
    cursor = props[key]
  }
  return true
}

function deriveEntryCandidates(nodes, edges) {
  const ids = {}
  nodes.forEach((n) => { if (n && n.id) ids[n.id] = true })
  const incoming = {}
  edges.forEach((e) => {
    if (!isStructuralEdge(e)) return
    if (!e.to || e.to === '$end' || e.to === HUMAN_DECISION_ID || !ids[e.to]) return
    const fromOk = ids[e.from] || e.from === HUMAN_DECISION_ID
    if (!fromOk) return
    incoming[e.to] = true
  })
  return nodes.map((n) => n && n.id).filter((id) => id && !incoming[id])
}

function nodeIdMap(nodes) {
  const ids = {}
  nodes.forEach((n) => { if (n && n.id) ids[n.id] = true })
  return ids
}

function reachable(entry, nodes, edges) {
  const ids = nodeIdMap(nodes)
  const reach = {}
  const stack = [entry]
  while (stack.length) {
    const cur = stack.pop()
    if (reach[cur]) continue
    reach[cur] = true
    structuralSuccessors(cur, edges, ids).forEach((to) => { if (!reach[to]) stack.push(to) })
  }
  return reach
}

function successPathExists(from, to, edges) {
  const seen = {}
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === to) return true
    if (seen[cur]) continue
    seen[cur] = true
    structuralSuccessors(cur, edges, null).forEach((next) => {
      if (!seen[next]) stack.push(next)
    })
  }
  return false
}

function hasSuccessCycle(entry, nodes, edges) {
  const ids = nodeIdMap(nodes)
  const color = {}
  let cyclic = false
  const dfs = (u) => {
    color[u] = 1
    successSuccessors(u, edges, ids).forEach((v) => {
      if (cyclic) return
      if (color[v] === 1) { cyclic = true; return }
      if (color[v] === undefined) dfs(v)
    })
    color[u] = 2
  }
  if (entry) dfs(entry)
  return cyclic
}

function tarjanSccs(ids, succs) {
  const index = {}
  const low = {}
  const stack = []
  const onStack = {}
  const sccs = []
  let idx = 0
  const strongconnect = (v) => {
    index[v] = low[v] = idx++
    stack.push(v)
    onStack[v] = true
    ;(succs[v] || []).forEach((w) => {
      if (index[w] === undefined) {
        strongconnect(w)
        low[v] = Math.min(low[v], low[w])
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], index[w])
      }
    })
    if (low[v] === index[v]) {
      const comp = []
      let w
      do {
        w = stack.pop()
        onStack[w] = false
        comp.push(w)
      } while (w !== v)
      sccs.push(comp)
    }
  }
  Object.keys(ids).forEach((v) => { if (index[v] === undefined) strongconnect(v) })
  return sccs
}

function sccHasStructuralExit(comp, edges) {
  const inComp = {}
  comp.forEach((id) => { inComp[id] = true })
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!e || !inComp[e.from] || !isStructuralEdge(e)) continue
    if (e.to === '$end' || e.to === HUMAN_DECISION_ID) return true
    if (e.to && !inComp[e.to]) return true
  }
  return false
}

function hasStructuralSelfLoop(id, edges) {
  return edges.some((e) => e && e.from === id && e.to === id && isStructuralEdge(e))
}

function hasUnexitedBusinessScc(nodes, edges) {
  const ids = nodeIdMap(nodes)
  const succs = {}
  Object.keys(ids).forEach((id) => { succs[id] = structuralSuccessors(id, edges, ids) })
  const sccs = tarjanSccs(ids, succs)
  for (let i = 0; i < sccs.length; i++) {
    const comp = sccs[i]
    const nontrivial = comp.length > 1 || (comp.length === 1 && hasStructuralSelfLoop(comp[0], edges))
    if (nontrivial && !sccHasStructuralExit(comp, edges)) return true
  }
  return false
}

// 结构层校验：nodes/edges 定义合法性 + 走通性（框架保证，与业务无关）。
// opts：{ entry, maxRounds }；maxRounds 提供时强制 1..MAX_ROUNDS_CAP。
function validateStructure(nodes, edges, opts) {
  const errors = []
  const err = (at, message) => errors.push({ at, message, fieldKey: fieldKeyOf(at) })
  const entry = (opts && opts.entry) || ''
  const maxRounds = opts && opts.maxRounds

  if (maxRounds !== undefined && maxRounds !== null) {
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_CAP) {
      err('$.control.maxRounds', '打回上限必须为 1-' + MAX_ROUNDS_CAP + ' 的整数（系统约定上限 ' + MAX_ROUNDS_CAP + '），当前：' + maxRounds)
    }
  }

  if (!Array.isArray(nodes) || nodes.length === 0) { err('$.nodes', 'nodes 至少一个节点'); return { errors } }
  const ids = {}
  const idCounts = {}
  const outgoing = {}
  nodes.forEach((n) => {
    if (!n || typeof n !== 'object') { err('$.nodes', '节点必须是对象'); return }
    if (typeof n.id !== 'string' || !n.id.trim()) { err('$.nodes', '节点 id 不能为空'); return }
    if (RESERVED.includes(n.id)) err('$.nodes[' + n.id + ']', '节点 id 使用了系统保留 id ' + n.id)
    if (idCounts[n.id]) err('$.nodes[' + n.id + ']', '节点 id 重复')
    idCounts[n.id] = 1
    ids[n.id] = true
    if (typeof n.profile !== 'string' || !n.profile.trim()) err('$.nodes[' + n.id + '].profile', '节点未关联角色 profile（对应 dsh/roles/*.md）')
    if (typeof n.goal !== 'string' || !n.goal.trim()) err('$.nodes[' + n.id + '].goal', '节点缺 goal')
    if (n.output !== undefined && n.output !== null) {
      const o = n.output
      if (!o.schema || typeof o.schema !== 'object') err('$.nodes[' + n.id + '].output.schema', 'output.schema 必填（对象）')
      if (o.successCondition !== undefined && o.successCondition !== null && o.successCondition !== '') {
        if (typeof o.successCondition !== 'string' || !COND_RE.test(o.successCondition)) {
          err('$.nodes[' + n.id + '].output.successCondition', 'successCondition 需为 $.path == value 形式')
        } else if (o.schema && typeof o.schema === 'object') {
          const segs = COND_RE.exec(o.successCondition)[1].split('.')
          if (!pathInSchema(o.schema, segs)) err('$.nodes[' + n.id + '].output.successCondition', '成功表达式路径未在 output.schema 中声明')
        }
      }
    }
  })

  if (!Array.isArray(edges)) { err('$.edges', 'edges 必填（数组）'); return { errors } }
  edges.forEach((e, i) => {
    const at = '$.edges[' + i + ']'
    if (!e || typeof e !== 'object') { err(at, '边必须是对象'); return }
    const fromOk = e.from && (ids[e.from] || FRAMEWORK_FROM.includes(e.from))
    const toOk = e.to && (ids[e.to] || FRAMEWORK_TO.includes(e.to))
    if (!fromOk) err(at + '.from', '边的来源节点 ' + e.from + ' 不存在')
    if (!toOk) err(at + '.to', '边的目标节点 ' + e.to + ' 不存在')
    const hasOut = hasOutcomeField(e)
    const hasOn = e.on !== undefined && e.on !== null && e.on !== ''
    if (hasOut && hasOn) {
      err(at + '.on', 'outcome 与 on 互斥')
    } else if (hasOut) {
      if (e.when !== undefined) err(at + '.when', '业务边禁止 when')
      if (e.countRound !== undefined && typeof e.countRound !== 'boolean') {
        err(at + '.countRound', 'countRound 须为布尔')
      }
    } else if (e.on === 'technical') {
      if (e.when !== undefined) err(at + '.when', 'technical 边禁止 when')
      if (e.countRound !== undefined) err(at + '.countRound', 'countRound 仅业务边可声明')
    } else if (e.on === 'success' || e.on === 'failure') {
      if (e.when !== undefined) {
        if (e.on !== 'success') err(at + '.when', 'when 只允许用于 success 边')
        else if (typeof e.when !== 'string' || !COND_RE.test(e.when)) err(at + '.when', 'when 需为 $.path == value 形式')
      }
      if (e.countRound !== undefined) err(at + '.countRound', 'countRound 仅业务边可声明')
    } else {
      err(at + '.on', 'on ∈ { success, failure, technical }，或改用业务边 outcome')
    }
    outgoing[e.from] = (outgoing[e.from] || 0) + 1
  })

  if (!edges.some((e) => e && e.to === '$end')) err('$.edges', '必须包含指向 $end 的边（结束节点）')
  const cands = deriveEntryCandidates(nodes, edges)
  const entryOk = entry && ids[entry]
  if (cands.length === 0) err('$.entry', '没有入口节点')
  else if (cands.length > 1) err('$.entry', '入口不唯一：' + cands.join('、') + '；请通过连线收敛为唯一入口（与 validateDsl 严格一致）')
  else if (!entryOk) err('$.entry', 'entry 必填，须为推导出的入口节点 ' + cands[0])
  else if (entry !== cands[0]) err('$.entry', 'entry 与推导入口不一致：' + entry + ' ≠ ' + cands[0])

  nodes.forEach((n) => { if (n && (outgoing[n.id] || 0) === 0) err('$.nodes[' + n.id + ']', '节点没有出边，无法继续或结束') })

  Object.keys(ids).forEach((id) => {
    const out = edges.filter((e) => e && e.from === id)
    const succ = out.filter((e) => e.on === 'success')
    const fail = out.filter((e) => e.on === 'failure')
    if (succ.length > 1 && succ.some((e) => e.when === undefined)) err('$.nodes[' + id + ']', '多条 success 出边必须全部带 when 条件')
    if (fail.length > 1) err('$.nodes[' + id + ']', 'failure 边最多一条（打回唯一路径）')
    // 走通性（候选三 Q12）：有成功条件（可判失败）的节点必须有 failure 出口
    const node = nodes.find((n) => n && n.id === id)
    if (node && node.output && node.output.successCondition && fail.length === 0) {
      err('$.nodes[' + id + ']', '节点 ' + (node.label || id) + ' 有成功条件（successCondition）但无 failure 出边——判定失败时将无出口（走通性违约），请补 failure 边或移除成功条件')
    }
  })

  const effEntry = entryOk ? entry : (cands.length === 1 ? cands[0] : '')
  if (effEntry) {
    const reach = reachable(effEntry, nodes, edges)
    nodes.forEach((n) => { if (n && !reach[n.id]) err('$.nodes[' + n.id + ']', '节点不可达（无法从入口沿结构边到达）') })
    if (hasSuccessCycle(effEntry, nodes, edges)) err('$.nodes', 'success 边存在环（打回请用 failure 边）')
    if (hasUnexitedBusinessScc(nodes, edges)) {
      err('$.nodes', '业务结果环缺少出口（须能离开该强连通分量，或到达 $end / $human-decision）')
    }
  }
  return { errors }
}

// ---------- 文件名 token 提取（候选五 C5：契约一致性自动断言） ----------
// 仅提取「反引号引用的文件名」（`dev-report.md`）——裸提及（package.json 等工程文件）
// 不纳入检查，避免误报；约定：交付物文件名在 goal/角色文件中用反引号显式引用。
const FILE_TOKEN_RE = /`([A-Za-z0-9][A-Za-z0-9._-]*\.(?:json|md|markdown|txt|html|canvas\.json|flowchart\.json|diagram\.json))`/g
function extractFileTokens(text) {
  if (typeof text !== 'string') return []
  const out = new Set()
  for (const m of String(text).matchAll(FILE_TOKEN_RE)) out.add(m[1])
  return [...out]
}

// ---------- 业务规则层（蓝图声明的规则） ----------
// opts：{ requireModels }——宿主编辑器保存路径的产品收紧（每节点模型绑定必填）。
function validateBlueprint(bp, opts) {
  const errors = []
  const err = (at, message) => errors.push({ at, message, fieldKey: fieldKeyOf(at) })
  const requireModels = !!(opts && opts.requireModels)

  if (!bp || typeof bp !== 'object') return { ok: false, errors: [{ at: '$', message: '蓝图必须是对象' }], warnings: [] }
  if (typeof bp.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bp.id)) err('$.id', 'id 必填且为 kebab-case（小写英文+连字符），如 dev-workflow-2-0')
  if (typeof bp.displayName !== 'string' || !bp.displayName.trim()) err('$.displayName', 'displayName（中文展示名）必填非空 —— 生成 skill 的触发词之一（FR-6）')
  if (bp.name !== undefined && bp.name !== bp.id) err('$.name', 'name 与 id 必须一致（单标识方案，D1），或删除 name')
  if (bp.onMaxRounds !== undefined && !ON_MAX_ROUNDS.includes(bp.onMaxRounds)) err('$.onMaxRounds', 'onMaxRounds ∈ { return, auto-reschedule }')

  if (!Array.isArray(bp.nodes) || bp.nodes.length === 0) { err('$.nodes', 'nodes 至少一个节点'); return { ok: false, errors, warnings: [] } }
  if (!Array.isArray(bp.edges)) { err('$.edges', 'edges 必填（数组）'); return { ok: false, errors, warnings: [] } }

  const structure = validateStructure(bp.nodes, bp.edges, {
    entry: bp.entry,
    maxRounds: (bp.control && bp.control.maxRounds) !== undefined ? (bp.control && bp.control.maxRounds) : undefined,
  })
  errors.push(...structure.errors)

  // 蓝图级业务规则
  const ids = {}
  bp.nodes.forEach((n) => { if (n && n.id) ids[n.id] = true })

  // fanout 节点契约：类型、items 来源、逐项目标、失败阈值与互斥字段。
  bp.nodes.forEach((n) => {
    if (!n || !n.id) return
    const kind = n.kind === undefined ? 'worker' : n.kind
    if (kind !== 'worker' && kind !== 'fanout') {
      err('$.nodes[' + n.id + '].kind', 'kind 仅接受 worker | fanout，缺省为 worker')
      return
    }
    if (kind !== 'fanout') {
      if (n.items !== undefined) err('$.nodes[' + n.id + '].items', 'items 仅允许用于 kind=fanout 节点')
      if (n.failOn !== undefined) err('$.nodes[' + n.id + '].failOn', 'failOn 仅允许用于 kind=fanout 节点')
      return
    }

    if (typeof n.items !== 'string' || !n.items.trim()) {
      err('$.nodes[' + n.id + '].items', 'fanout 节点 items 必填')
    } else {
      const resultMatch = FANOUT_ITEMS_RESULTS_RE.exec(n.items)
      if (!FANOUT_ITEMS_ARGS_RE.test(n.items) && !resultMatch) {
        err('$.nodes[' + n.id + '].items', 'items 仅支持 $.args[.路径] 或 $.results.<节点id>[.路径]')
      } else if (resultMatch) {
        const ref = resultMatch[1]
        if (!ids[ref]) err('$.nodes[' + n.id + '].items', 'items 引用的节点 ' + ref + ' 不存在')
        else if (ref === n.id || !successPathExists(ref, n.id, bp.edges)) {
          err('$.nodes[' + n.id + '].items', 'items 引用节点 ' + ref + ' 必须沿 success 边先于 fanout 节点 ' + n.id)
        }
      }
    }
    if (typeof n.goal !== 'string' || !n.goal.includes('{{item}}')) {
      err('$.nodes[' + n.id + '].goal', 'fanout 节点 goal 必须包含 {{item}} 占位')
    }
    if (n.failOn !== undefined && n.failOn !== 'any' && n.failOn !== 'all'
      && !(Number.isInteger(n.failOn) && n.failOn >= 0)) {
      err('$.nodes[' + n.id + '].failOn', 'failOn 仅接受 any | all | 非负整数，缺省为 all')
    }
    if (n.output && n.output.successCondition !== undefined) {
      err('$.nodes[' + n.id + '].output.successCondition', 'fanout 节点禁止 output.successCondition；失败判定统一使用 failOn')
    }
    if (hasOutcomePath(n)) {
      err('$.nodes[' + n.id + '].output.outcomePath', 'fanout 节点禁止 outcomePath（不参与 Business Outcome Routing）')
    }
    if (n.output && typeof n.output.completionPath === 'string' && n.output.completionPath.trim()) {
      err('$.nodes[' + n.id + '].output.completionPath', 'fanout 节点禁止 completionPath')
    }
    if (n.manualCheck) err('$.nodes[' + n.id + '].manualCheck', 'fanout 节点禁止 manualCheck')
    if (n.verifyBranch) err('$.nodes[' + n.id + '].verifyBranch', 'fanout 节点禁止 verifyBranch')
    bp.edges.forEach((e, i) => {
      if (e && e.from === n.id && e.to === HUMAN_DECISION_ID) {
        err('$.nodes[' + n.id + '].kind', 'fanout 节点禁止升级到 Human Decision（坐标 edge:' + i + ':to）')
      }
      if (e && e.from === n.id && (hasOutcomeField(e) || isTechnicalEdge(e))) {
        err('$.nodes[' + n.id + '].kind', 'fanout 节点禁止 outcome / technical 边（failOn 仍走 failure）')
      }
    })
    if (!bp.edges.some((e) => e && e.from === n.id && e.on === 'failure')) {
      err('$.nodes[' + n.id + '].kind', 'fanout 节点必须有 failure 出边')
    }
  })

  // output.files 契约（蓝图级，DSL 无此字段）
  bp.nodes.forEach((n) => {
    if (!n || !n.output || !n.output.files) return
    const o = n.output
    if (!o.files || typeof o.files !== 'object' || Array.isArray(o.files)) {
      err('$.nodes[' + n.id + '].output.files', 'output.files 必须是对象 { "<相对路径>": "json|markdown|text" }')
    } else {
      Object.keys(o.files).forEach((p) => {
        const valid = typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.endsWith('/') && !p.includes('..') && p !== 'STATE.md'
        if (!valid) err('$.nodes[' + n.id + '].output.files.' + p, '文件路径须为合法相对路径（非空、不以 / 开头或结尾、不含 ..、不得为保留文件 STATE.md）')
        if (!FILES_KINDS.includes(o.files[p])) err('$.nodes[' + n.id + '].output.files.' + p, '文件类型须为 ' + FILES_KINDS.join(' | ') + '，当前：' + o.files[p])
      })
    }
    if (n.verifyBranch) {
      const req = (o.schema && o.schema.required) || []
      if (!req.includes('verified_branch') || !req.includes('verified_head'))
        err('$.nodes[' + n.id + '].verifyBranch', 'verifyBranch=true 时 output.schema 的 required 必须含 verified_branch 与 verified_head（DSH 可信度闸门）')
    }
  })

  // bindings / 模型绑定（requireModels = 宿主编辑器产品收紧；异源硬规则依赖 bindings）
  if (bp.bindings) {
    const b = bp.bindings
    if (b.models) Object.keys(b.models).forEach((k) => {
      if (!ids[k]) err('$.bindings.models.' + k, 'bindings.models 引用的节点 ' + k + ' 不存在')
    })
  }
  if (requireModels) {
    bp.nodes.forEach((n) => {
      if (!n || !n.id) return
      const m = (bp.bindings && bp.bindings.models && bp.bindings.models[n.id]) || null
      const label = n.label || n.id
      if (!m || !m.provider) err('$.nodes[' + n.id + '].model.provider', '节点 ' + label + ' 未绑定 Agent（model.provider 必填）。')
      if (!m || !m.model) err('$.nodes[' + n.id + '].model.model', '节点 ' + label + ' 未绑定模型（model.model 必填）。')
    })
  }
  if (bp.heteroCheck && !(bp.nodes.some((n) => n && (n.id === 'dev' || n.profile === 'dev')) && bp.nodes.some((n) => n && (n.id === 'review' || n.profile === 'review')))) {
    err('$.heteroCheck', 'heteroCheck=true 需要存在 dev 与 review 节点（按节点 id 或 profile 识别，异源检查对象）')
  }

  // 异源硬规则（规则 7，T-06：全局强制，仅 dev↔review）
  const warnings = []
  const devNode = bp.nodes.find((n) => n && (n.id === 'dev' || n.profile === 'dev'))
  const reviewNode = bp.nodes.find((n) => n && (n.id === 'review' || n.profile === 'review'))
  if (devNode && reviewNode) {
    const bm = (bp.bindings && bp.bindings.models) || {}
    const dm = bm[devNode.id]
    const rm = bm[reviewNode.id]
    if (!dm || !rm) {
      err('$.bindings.models', 'dev/review 未配置 bindings.models，无法证明异源，请显式配置')
    } else {
      const dt = (dm.provider || 'default') + '/' + (dm.model || 'default')
      const rt = (rm.provider || 'default') + '/' + (rm.model || 'default')
      if (dt === rt) {
        err('$.bindings.models', 'dev 与 review 模型相同（' + dt + '）：异源硬规则要求不同 provider 或不同模型，请调整 bindings.models')
      } else if (dm.provider === rm.provider) {
        warnings.push('弱异源：dev/review 同 provider（' + dm.provider + '）不同模型，建议配置不同 provider 满足真异源')
      }
    }
  }

  // Business Outcome Routing / Completion Mapping（#77 / #88 / #91 / #92 / #89）
  bp.nodes.forEach((n) => {
    if (!n || !n.id) return
    const kind = n.kind === undefined ? 'worker' : n.kind
    if (kind === 'fanout') return
    const outs = bp.edges.filter((e) => e && e.from === n.id)
    const newMode = hasOutcomePath(n)

    if (n.output && typeof n.output.completionPath === 'string' && n.output.completionPath.trim()) {
      const cpath = n.output.completionPath.trim()
      const csegs = parseJsonPath(cpath)
      if (!csegs) {
        err('$.nodes[' + n.id + '].output.completionPath', 'completionPath 需为 $.field 形式')
      } else if (!n.output.schema || typeof n.output.schema !== 'object') {
        err('$.nodes[' + n.id + '].output.schema', '声明 completionPath 时 output.schema 必填')
      } else if (!pathInSchema(n.output.schema, csegs)) {
        err('$.nodes[' + n.id + '].output.completionPath', '完成类型路径未在 output.schema 中声明')
      } else if (!isStringSchemaLeaf(schemaLeafAt(n.output.schema, csegs))) {
        err('$.nodes[' + n.id + '].output.completionPath', 'completionPath 叶子必须是 string')
      }
      const toEnd = outs.some((e) => isStructuralEdge(e) && e.to === '$end')
      if (!toEnd) {
        err('$.nodes[' + n.id + '].output.completionPath', 'completionPath 仅允许声明在有结构边指向 $end 的节点上')
      }
    }

    if (newMode) {
      if (n.output.successCondition !== undefined && n.output.successCondition !== null && n.output.successCondition !== '') {
        err('$.nodes[' + n.id + '].output.successCondition', '新模式（有 outcomePath）禁止 successCondition')
      }
      const segs = parseJsonPath(n.output.outcomePath.trim())
      if (!segs) {
        err('$.nodes[' + n.id + '].output.outcomePath', 'outcomePath 需为 $.field 形式')
        return
      }
      if (!n.output.schema || typeof n.output.schema !== 'object') {
        err('$.nodes[' + n.id + '].output.schema', '声明 outcomePath 时 output.schema 必填')
        return
      }
      if (!pathInSchema(n.output.schema, segs)) {
        err('$.nodes[' + n.id + '].output.outcomePath', '业务结果路径未在 output.schema 中声明')
        return
      }
      const leaf = schemaLeafAt(n.output.schema, segs)
      const vals = enumerableValues(leaf)
      if (!vals) {
        err('$.nodes[' + n.id + '].output.outcomePath', 'outcomePath 必须可穷举（enum / const / oneOf 常量，或 boolean）')
        return
      }
      const outcomeEdges = outs.filter(hasOutcomeField)
      const technical = outs.filter(isTechnicalEdge)
      const legacy = outs.filter((e) => e && (e.on === 'success' || e.on === 'failure'))
      if (legacy.length) {
        err('$.nodes[' + n.id + '].output.outcomePath', '新模式禁止 on: success / failure 出边')
      }
      if (outs.some((e) => e && e.when !== undefined)) {
        err('$.nodes[' + n.id + '].output.outcomePath', '新模式禁止 when')
      }
      if (technical.length > 1) {
        err('$.nodes[' + n.id + ']', 'on: technical 边最多一条')
      }
      const seen = {}
      outcomeEdges.forEach((e) => {
        const key = outcomeKey(e.outcome)
        if (seen[key]) err('$.nodes[' + n.id + ']', '同一 outcome 取值只能有一条出边：' + key)
        seen[key] = true
      })
      vals.forEach((v) => {
        const key = outcomeKey(v)
        if (!seen[key]) err('$.nodes[' + n.id + ']', '枚举值 ' + key + ' 缺少对应 outcome 出边')
      })
      outcomeEdges.forEach((e) => {
        const key = outcomeKey(e.outcome)
        if (!vals.some((v) => outcomeKey(v) === key)) {
          err('$.nodes[' + n.id + ']', 'outcome 取值 ' + key + ' 不在 outcomePath 枚举内')
        }
      })
    } else {
      outs.forEach((e, i) => {
        if (!e) return
        const at = '$.edges[' + bp.edges.indexOf(e) + ']'
        if (hasOutcomeField(e)) err(at + '.outcome', '旧模式节点禁止 outcome 边（须先声明 outcomePath）')
        if (isTechnicalEdge(e)) err(at + '.on', '旧模式节点禁止 on: technical（技术失败仍走 failure）')
      })
    }
  })

  // Human Decision（#116）：拓扑已在结构层允许 $human-decision；此处钉契约键与互斥。
  {
    const usesHd = blueprintUsesHumanDecision(bp)
    if (usesHd) {
      if (bp.approved !== undefined) {
        err('$.approved', '使用 Human Decision 的蓝图禁止 approved（残留门禁续跑字段；新路径用 decision_id / user_choice）')
      }
      bp.nodes.forEach((n) => {
        if (n && n.approved !== undefined) {
          err('$.nodes[' + n.id + '].approved', '使用 Human Decision 的蓝图禁止节点 approved')
        }
        if (n && n.manualCheck) {
          err('$.nodes[' + n.id + '].manualCheck', 'Human Decision 与残留 manualCheck 不得同图（新蓝图只走 HD，残留门禁冷冻至废弃）')
        }
      })
    }
    if (bp.humanDecision !== undefined) {
      const hd = bp.humanDecision
      if (!hd || typeof hd !== 'object' || Array.isArray(hd)) {
        err('$.humanDecision', 'humanDecision 必须是对象')
      } else if (hd.maxRoundsReachedOptions !== undefined) {
        const opts = hd.maxRoundsReachedOptions
        const at = '$.humanDecision.maxRoundsReachedOptions'
        if (!Array.isArray(opts) || opts.length === 0) {
          err(at, '额度耗尽默认控制选项可覆盖但不可删到零（至少保留一项 USER_ACCEPTED | ADD_BUDGET | STOP）')
        } else {
          const seen = {}
          opts.forEach((name, i) => {
            if (!HD_CONTROL_RESULTS.includes(name)) {
              err(at, 'maxRoundsReachedOptions[' + i + '] 须为 USER_ACCEPTED | ADD_BUDGET | STOP，当前：' + name)
            } else if (seen[name]) {
              err(at, 'maxRoundsReachedOptions 不得重复：' + name)
            }
            seen[name] = true
          })
        }
      }
    }
    const seenHdResults = {}
    const seenHdOutcomes = {}
    // Issue #159：按运行时归一化 choice id 建统一冲突表——typed outcome 与同名字符串
    // （outcome: false vs outcome: "false"）、以及 result 与 outcome 同名（result: "SHIP"
    // vs outcome: "SHIP"）在运行期（generate.mjs e.result || String(e.outcome)）都坍缩为
    // 同一 choice id，其中一条出边静默不可达；此处显式拒绝并报告两条冲突边坐标与归一化 id。
    // 判重表用 Map 而非普通对象（#159 A1）：普通对象会把 toString/constructor/__proto__ 等
    // 经 Object.prototype 继承链伪报为已登记，既误伤合法单边又让冲突错误生成
    // "$.edges[function toString()...]" 这类非真实边坐标。
    const seenHdChoiceIds = new Map()
    const hdIn = bp.edges.filter((e) => e && e.to === HUMAN_DECISION_ID && isStructuralEdge(e))
    const hdOut = bp.edges.filter((e) => e && e.from === HUMAN_DECISION_ID)
    if (hdIn.length === 0 && hdOut.some(hasOutcomeField)) {
      err('$.edges', '$human-decision 无入边却声明了出边')
    }
    if (hdIn.some(hasOutcomeField) && !hdOut.some(hasOutcomeField)) {
      err('$.edges', '$human-decision 有业务入边时必须至少有一条 outcome 出边')
    }
    bp.edges.forEach((e, i) => {
      if (!e) return
      const at = '$.edges[' + i + ']'
      if (e.to === HUMAN_DECISION_ID && e.on === 'failure') {
        err(at + '.on', '升 Human Decision 的入边须为 success（failure 边仍表示打回）')
      }
      if (e.from !== HUMAN_DECISION_ID) return
      // Issue #159（A2）：outcome 与 result 同边混合字段显式互斥——result 只属于 on:"success"
      // 出边（SCREAMING_SNAKE 显式命名）；结构层仅禁 outcome 与 on 互斥、不禁 outcome 与 result，
      // 而运行期画卡/续跑一律 `e.result || String(e.outcome)`（任意 truthy result 优先，含空白串
      // " "）。outcome 边若夹带 truthy result，校验端与运行期会对同一条边取不同 choice id 身份，
      // 冲突蓝图可穿过校验（如 outcome:"A" 与 outcome:"B" 各带 result:" " 时校验视为 A/B 不冲突、
      // 运行期两条边都坍缩为空白 result）。此处显式拒绝，杜绝该分叉。
      if (hasOutcomeField(e) && e.result !== undefined) {
        err(at + '.result', 'outcome 与 result 互斥：result 仅用于 on:"success" 出边；业务 outcome 边携带 result 时运行期 e.result || String(e.outcome) 会改取其身份（#159）')
        return
      }
      if (hasOutcomeField(e)) {
        const key = outcomeKey(e.outcome)
        if (seenHdOutcomes[key]) {
          err(at + '.outcome', 'Decision Result 重复：' + key)
        } else {
          seenHdOutcomes[key] = true
          const id = hdChoiceId(e)
          if (id !== null) {
            if (HD_RUNTIME_RESERVED_IDS.has(id)) {
              // #159（A1）：判重表本身已无原型污染（Map），但该 id 运行期无法表示——
              // 普通对象 subsequent_effects 会把继承键当已占用、静默丢弃该出边；此处
              // 显式拒绝并给出真实边坐标与修复指引，不允许校验放行后运行期再次不可达。
              err(at + '.outcome', 'choice id "' + id + '" 为运行时保留键（画卡装配的 subsequent_effects 以普通对象承载，toString/constructor/__proto__ 等原型键会被判为已占用而静默丢弃该出边）；请改用显式 result 命名（如 result: SHIP）区分（#159）')
            } else {
              const first = seenHdChoiceIds.get(id)
              if (first !== undefined) {
                err(at + '.outcome', 'HD 选项归一化冲突：与 $.edges[' + first + '] 归一化后为同一 choice id "' + id + '"（运行期画卡/续跑按 e.result || String(e.outcome) 归一化取 id，两条边坍缩为一、后者不可达）；请改用显式 result 命名区分')
              } else {
                seenHdChoiceIds.set(id, i)
              }
            }
          }
        }
        return
      }
      if (e.on !== 'success') {
        err(at + '.on', '$human-decision 出边须为 success，用 result 区分 Decision Result')
        return
      }
      if (typeof e.result !== 'string' || !e.result.trim()) {
        err(at + '.result', '$human-decision 出边必须带 result（业务 Decision Result id）')
      } else if (HD_CONTROL_RESULTS.includes(e.result)) {
        err(at + '.result', '控制类 Result（USER_ACCEPTED / ADD_BUDGET / STOP）由框架解释，不得作为蓝图出边 result')
      } else if (!HD_RESULT_RE.test(e.result)) {
        err(at + '.result', 'result 须为 SCREAMING_SNAKE（如 SHIP），当前：' + e.result)
      } else if (seenHdResults[e.result]) {
        err(at + '.result', 'Decision Result 重复：' + e.result)
      } else {
        seenHdResults[e.result] = true
        const id = hdChoiceId(e)
        if (id !== null) {
          const first = seenHdChoiceIds.get(id)
          if (first !== undefined) {
            err(at + '.result', 'HD 选项归一化冲突：与 $.edges[' + first + '] 归一化后为同一 choice id "' + id + '"（运行期画卡/续跑按 e.result || String(e.outcome) 归一化取 id，两条边坍缩为一、后者不可达）；请改用显式 result 命名区分')
          } else {
            seenHdChoiceIds.set(id, i)
          }
        }
      }
    })
  }

  // 契约一致性（候选五 C5 规则 A）：goal 中反引号引用的文件名必须全局声明
  // （某节点 output.files ∪ 保留文件 STATE.md）——output.files 为权威，改一处漏一处即红
  {
    const declared = new Set(['STATE.md'])
    bp.nodes.forEach((n) => {
      if (n && n.output && n.output.files && typeof n.output.files === 'object' && !Array.isArray(n.output.files)) {
        Object.keys(n.output.files).forEach((p) => declared.add(p))
      }
    })
    bp.nodes.forEach((n) => {
      if (!n || typeof n.goal !== 'string') return
      for (const tok of extractFileTokens(n.goal)) {
        if (!declared.has(tok)) {
          err('$.nodes[' + n.id + '].goal', 'goal 提及的文件名 `' + tok + '` 未在任何节点 output.files 声明（或保留文件 STATE.md）——文件契约以 output.files 为权威，请同步命名')
        }
      }
    })
  }

  return { ok: errors.length === 0, errors, warnings, counts: { nodes: bp.nodes.length, edges: bp.edges.length } }
}

module.exports = {
  validateStructure,
  validateBlueprint,
  deriveEntryCandidates,
  extractFileTokens,
  blueprintUsesHumanDecision,
  COND_RE,
  MAX_ROUNDS_CAP,
  HUMAN_DECISION_ID,
  HD_REASONS,
  HD_CONTROL_RESULTS,
  HD_PACKAGE_REQUIRED,
  HD_PACKAGE_OPTIONAL_UNKNOWN,
  HD_EVENT_FIELDS,
  HD_RESUME_FIELDS,
  HD_EVENT_RECORD_KIND,
  HD_EVENT_TRIGGER,
  HD_UNKNOWN,
}
