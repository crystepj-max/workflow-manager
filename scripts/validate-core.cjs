// 校验内核（候选二 T-IMP-13）——唯一规则集，单一事实源。
// 双层结构：
//   结构层 validateStructure：框架保证，与业务无关——走通性、节点/边定义合法性、
//     入口唯一、成环、when/successCondition 格式与 schema 路径、保留 id、
//     多 success-when、failure 唯一、maxRounds ∈ [1, MAX_ROUNDS_CAP]（系统上限）。
//   业务规则层 validateBlueprint：结构层 + 蓝图声明的规则——单标识（id=name）、
//     onMaxRounds 枚举、bindings 引用、heteroCheck 关联、verifyBranch 联动、
//     output.files 契约、异源硬规则 7、requireModels 选项（宿主编辑器产品收紧）。
// 消费形态：引擎 ESM `import`（Node CJS 互操作）；宿主 vwf 插件经 fs 服务读源码、
//   vm 内 `new Function('module','exports','require', src)` 求值并缓存（热路径内存执行，
//   零子进程；源码声明的 `./name.cjs` 相对引用由宿主加载器预解析后同步供给）。
// 错误结构：{ at, message, fieldKey? }——fieldKey 为编辑器逐字段标红坐标
//   （node:<id>:<field> / edge:<i>:<field> / control:<field>）；前端文案翻译为优化任务。
'use strict'

// 蓝图 ↔ DSL 形态投影：唯一实现 = ./projection-core.cjs（生成器直接 import，宿主经 dist 加载）。
// 本文件只转发导出——两份投影实现曾各自漂移（克隆 vs 共享引用），禁止再内嵌副本。
const { projectToVwf, projectToBlueprint, effectiveHeteroMode, isKnownHeteroValue } = require('./projection-core.cjs')

const COND_RE = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/
const HUMAN_DECISION_ID = '$human-decision'
const RESERVED = ['$end', '$entry', '$new-round', HUMAN_DECISION_ID]
const FRAMEWORK_TO = ['$end', HUMAN_DECISION_ID]
const FRAMEWORK_FROM = [HUMAN_DECISION_ID]
// 与 scripts/formal-artifacts.cjs FILE_KINDS 保持同步（#69）
const FILES_KINDS = ['json', 'markdown', 'text', 'html', 'canvas', 'flowchart', 'diagram']
const ON_MAX_ROUNDS = ['return', 'auto-reschedule']
// LOC-009 模板策略声明：与 scripts/workspace-isolation.mjs TEMPLATE_REGISTRY 键
// 及 optimize 的 resource_kind 枚举保持一致（权威在 Core 注册表）。
const WORKSPACE_TEMPLATE_IDS = ['construction', 'wf-optimize', 'wf-diagnose', 'wf-explore']
const WORKSPACE_RESOURCE_KINDS = ['git', 'files', 'document', 'config', 'other']
const MAX_ROUNDS_CAP = 9 // 系统约定上限：编辑器最大可设 9 轮（用户意见 Q7）

// ---------- LOC-031 技术预算：retry_policy 契约（单一事实源） ----------
// V1 建议基线（task-spec §9 接口与数据约定）：同一节点同一输入版本一次激活最多
// 3 次模型尝试（含首次与格式修复）；暂时错误退避 1s、2s；单次调用截止 30 分钟；
// Run 累计自动运行时间上限 4 小时（人工等待不计时）；无进展回边连续 2 次相同签名受阻。
// 蓝图可在 control.retryPolicy 显式声明覆盖（结构校验见 validateRetryPolicy）；
// 运行期启动时冻结为快照，恢复不得自动放宽或清零。
const RETRY_POLICY_DEFAULTS = {
  max_attempts: 3,
  backoff_ms: [1000, 2000],
  attempt_timeout_ms: 1800000,
  run_auto_time_ms: 14400000,
  no_progress_repeats: 2,
}
// 数值边界（校验内核与生成脚本共用常量，防两处口径漂移）
const RETRY_POLICY_LIMITS = {
  max_attempts_cap: 10,
  ms_min: 1000,
  ms_max: 24 * 60 * 60 * 1000,
  backoff_entry_max: 3600000,
}
const RETRY_POLICY_KEYS = Object.keys(RETRY_POLICY_DEFAULTS)

function validateRetryPolicy(rp) {
  const errors = []
  const err = (at, message) => errors.push({ at, message, fieldKey: fieldKeyOf(at) })
  if (!rp || typeof rp !== 'object' || Array.isArray(rp)) {
    err('$.control.retryPolicy', 'retryPolicy 必须是对象，允许键：' + RETRY_POLICY_KEYS.join(' | '))
    return errors
  }
  const L = RETRY_POLICY_LIMITS
  for (const k of Object.keys(rp)) {
    if (!RETRY_POLICY_KEYS.includes(k)) err('$.control.retryPolicy.' + k, '未知键 ' + k + '（允许：' + RETRY_POLICY_KEYS.join(' | ') + '）')
  }
  if (rp.max_attempts !== undefined) {
    if (!Number.isInteger(rp.max_attempts) || rp.max_attempts < 1 || rp.max_attempts > L.max_attempts_cap) {
      err('$.control.retryPolicy.max_attempts', 'max_attempts 须为 1-' + L.max_attempts_cap + ' 的整数，当前：' + JSON.stringify(rp.max_attempts))
    }
  }
  if (rp.backoff_ms !== undefined) {
    const cap = (Number.isInteger(rp.max_attempts) && rp.max_attempts >= 1 ? rp.max_attempts : RETRY_POLICY_DEFAULTS.max_attempts) - 1
    const okArr = Array.isArray(rp.backoff_ms) && rp.backoff_ms.length >= 1 && rp.backoff_ms.length <= cap
      && rp.backoff_ms.every((v) => Number.isInteger(v) && v >= 0 && v <= L.backoff_entry_max)
    if (!okArr) {
      err('$.control.retryPolicy.backoff_ms', 'backoff_ms 须为 1-' + cap + ' 个 0-' + L.backoff_entry_max + ' 之间的整数毫秒（重试等待档位，相邻尝试之间逐档取用）')
    }
  }
  const msField = (key) => {
    if (rp[key] === undefined) return
    if (!Number.isInteger(rp[key]) || rp[key] < L.ms_min || rp[key] > L.ms_max) {
      err('$.control.retryPolicy.' + key, key + ' 须为 ' + L.ms_min + '-' + L.ms_max + ' 的整数毫秒，当前：' + JSON.stringify(rp[key]))
    }
  }
  msField('attempt_timeout_ms')
  msField('run_auto_time_ms')
  if (rp.no_progress_repeats !== undefined) {
    if (!Number.isInteger(rp.no_progress_repeats) || rp.no_progress_repeats < 1 || rp.no_progress_repeats > L.max_attempts_cap) {
      err('$.control.retryPolicy.no_progress_repeats', 'no_progress_repeats 须为 1-' + L.max_attempts_cap + ' 的整数，当前：' + JSON.stringify(rp.no_progress_repeats))
    }
  }
  return errors
}
const FANOUT_ITEMS_ARGS_RE = /^\$\.args(?:\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/
const FANOUT_ITEMS_RESULTS_RE = /^\$\.results\.([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/
// LOC-024 节点输入声明：选择器只支持 $.task / $.results.<节点id> 的明确字段链；
// 禁止 eval、路径穿越与目录扫描（V1 无任意表达式执行器）。
const INPUT_NAME_RE = /^[a-z][a-z0-9_]*$/
const INPUT_SELECTOR_TASK_RE = /^\$\.task(?:\.[A-Za-z0-9_-]+)*$/
const INPUT_SELECTOR_RESULTS_RE = /^\$\.results\.([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/
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

// 回退边不计入入口入边（契约：failure/technical 本就不是结构边；新模式回退走
// outcome + countRound，自环也视为回退）。未标 countRound 的前向 outcome 仍是结构入边。
function isRollbackEdge(e) {
  if (!isStructuralEdge(e)) return false
  if (e.from === e.to) return true
  return e.countRound !== undefined
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
  if (at === '$.workspace') return 'workspace'
  if (at.startsWith('$.workspace.')) return 'workspace:' + at.slice('$.workspace.'.length)
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
    if (!isStructuralEdge(e) || isRollbackEdge(e)) return
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

// ---------- 编译输入尺寸闸门（#131） ----------
// 编译产物把整份蓝图内嵌后经定长通道回传（host.js runNode stdout maxBytes 1MB）：
// 文档越大响应越大，任何定长上限都会被打爆——超限在 JSON.parse 前被截断，
// vwf.script / wf_run(args.dsl) 对合法大图直接崩溃。
// 计量口径 = 转义后字节（JSON.stringify 产物，与编译嵌入同源）：中文按 UTF-8 计 3 字节，
// 引号/反斜杠计转义；禁止用原始字符数近似。总闸对现状体量（内置图约 66KB）留一个数量级冗余，
// 同时给内置角色正文内联、CLI 二次 JSON 包装与转义膨胀留实测余量（见 compile-input-size-gate 测试）。
const COMPILE_INPUT_LIMIT_TOTAL_BYTES = 850 * 1024
const COMPILE_INPUT_LIMIT_GOAL_BYTES = 425 * 1024

function escapedJsonBytes(v) {
  return Buffer.byteLength(JSON.stringify(v))
}

function sizeKb(bytes) {
  return Math.ceil(bytes / 1024) + 'KB'
}

// 返回首个超限描述 { at, message }，未超限返回 null。
// 单节点 goal 优先于总量：报错能定位到具体节点；同一次只报一项，不叠加刷屏。
function compileInputSizeViolation(bp) {
  if (!bp || typeof bp !== 'object' || !Array.isArray(bp.nodes)) return null
  for (const n of bp.nodes) {
    if (!n || typeof n.goal !== 'string') continue
    const bytes = escapedJsonBytes(n.goal)
    if (bytes > COMPILE_INPUT_LIMIT_GOAL_BYTES) {
      return {
        at: '$.nodes[' + n.id + '].goal',
        message: '节点 ' + n.id + ' 的 goal ' + sizeKb(bytes) + ' 超过单节点上限 ' + sizeKb(COMPILE_INPUT_LIMIT_GOAL_BYTES) + '——请精简该节点 goal 或拆分节点',
      }
    }
  }
  const total = escapedJsonBytes(bp)
  if (total > COMPILE_INPUT_LIMIT_TOTAL_BYTES) {
    return {
      at: '$',
      message: '蓝图总量 ' + sizeKb(total) + ' 超过上限 ' + sizeKb(COMPILE_INPUT_LIMIT_TOTAL_BYTES) + '——请精简节点 goal 或拆分节点',
    }
  }
  return null
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
  // LOC-031：技术预算策略声明（可选）。声明后编译期固化为运行起始快照的一部分；
  // 运行期仍可用 retry_policy_overrides 在边界内显式调整，恢复采用冻结快照。
  if (bp.control !== undefined && (bp.control === null || typeof bp.control !== 'object' || Array.isArray(bp.control))) {
    err('$.control', 'control 必须是对象（{ maxRounds, retryPolicy? }）')
  } else if (bp.control && bp.control.retryPolicy !== undefined && bp.control.retryPolicy !== null) {
    errors.push(...validateRetryPolicy(bp.control.retryPolicy))
  }
  // LOC-009：workspace 隔离策略声明（可选）。声明后 host 不再按模板 id 名字猜测；
  // template_id 权威集合 = workspace-isolation.mjs TEMPLATE_REGISTRY 的键。
  if (bp.workspace !== undefined) {
    const w = bp.workspace
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      err('$.workspace', 'workspace 必须是对象 { template_id, resource_kind? }')
    } else {
      if (!WORKSPACE_TEMPLATE_IDS.includes(w.template_id)) err('$.workspace.template_id', 'workspace.template_id 必填且 ∈ ' + WORKSPACE_TEMPLATE_IDS.join(' | '))
      if (w.resource_kind !== undefined && !WORKSPACE_RESOURCE_KINDS.includes(w.resource_kind)) err('$.workspace.resource_kind', 'workspace.resource_kind ∈ ' + WORKSPACE_RESOURCE_KINDS.join(' | ') + '（仅 optimize 类声明需要）')
    }
  }

  if (!Array.isArray(bp.nodes) || bp.nodes.length === 0) { err('$.nodes', 'nodes 至少一个节点'); return { ok: false, errors, warnings: [] } }
  if (!Array.isArray(bp.edges)) { err('$.edges', 'edges 必填（数组）'); return { ok: false, errors, warnings: [] } }

  // 编译输入尺寸闸门（#131）：保存/校验路径最早拒绝超大文档，报错进错误列表可定位
  const sizeViolation = compileInputSizeViolation(bp)
  if (sizeViolation) err(sizeViolation.at, sizeViolation.message)

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

  // LOC-024 节点输入声明（显式交接节点输入与返工反馈）：
  //   - required/optional 必须显式声明；首次运行默认值以 default 显式声明
  //   - 选择器只支持 $.task[.字段链] / $.results.<节点id>[.字段链]
  //   - 生产节点必须沿结构边（success/outcome）先于消费节点（自引用需结构自环，如返工 outcome 自环）
  //   - artifact 引用必须已在该生产节点 output.files 声明（引用错误在编译期拦截）
  //   - 旧蓝图整体省略 inputs = 旧输入模式（legacy），运行时维持原行为
  bp.nodes.forEach((n) => {
    if (!n || !n.id) return
    if (n.inputs === undefined) return
    const kind = n.kind === undefined ? 'worker' : n.kind
    if (kind === 'fanout') {
      err('$.nodes[' + n.id + '].inputs', 'fanout 节点禁止 inputs（并行子代理不参与节点级输入交接）')
      return
    }
    if (!Array.isArray(n.inputs) || n.inputs.length === 0) {
      err('$.nodes[' + n.id + '].inputs', 'inputs 必须是非空数组（维持旧输入模式请整体省略该字段）')
      return
    }
    const seenNames = {}
    n.inputs.forEach((b, i) => {
      const at = '$.nodes[' + n.id + '].inputs[' + i + ']'
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        err(at, '输入绑定必须是对象 { name, from, required, default?, artifact? }')
        return
      }
      if (typeof b.name !== 'string' || !INPUT_NAME_RE.test(b.name)) {
        err(at + '.name', '绑定名必填且为 snake_case（小写字母开头，仅小写字母/数字/下划线），当前：' + JSON.stringify(b.name))
      } else if (seenNames[b.name]) {
        err(at + '.name', '绑定名重复：' + b.name)
      }
      seenNames[b.name] = true
      if (b.required !== true && b.required !== false) {
        err(at + '.required', 'required 必须显式声明为布尔（true=必需，false=可选；可选未产生时按声明走 default/缺省）')
      }
      let producer = null
      if (typeof b.from !== 'string' || (!INPUT_SELECTOR_TASK_RE.test(b.from) && !INPUT_SELECTOR_RESULTS_RE.test(b.from))) {
        err(at + '.from', 'from 选择器仅支持 $.task[.字段链] 或 $.results.<节点id>[.字段链] 的明确字段链（禁止 eval、路径穿越与目录扫描），当前：' + JSON.stringify(b.from))
      } else {
        const rm = INPUT_SELECTOR_RESULTS_RE.exec(b.from)
        if (rm) {
          producer = rm[1]
          if (!ids[producer]) {
            err(at + '.from', 'from 引用的生产节点 ' + producer + ' 不存在')
          } else if (!successPathExists(producer, n.id, bp.edges)) {
            err(at + '.from', 'from 引用的生产节点 ' + producer + ' 必须沿结构边（success/outcome，含返工 outcome 环）先于消费节点 ' + n.id)
          }
        }
      }
      if (b.artifact !== undefined) {
        if (typeof b.artifact !== 'string' || !b.artifact.trim() || b.artifact.startsWith('/') || b.artifact.includes('..')) {
          err(at + '.artifact', 'artifact 必须是生产节点 output.files 中声明的相对文件名（禁止绝对路径与路径穿越），当前：' + JSON.stringify(b.artifact))
        } else if (!producer) {
          err(at + '.artifact', 'artifact 引用必须配合 $.results.<节点id> 选择器使用（任务输入没有产物文件）')
        } else if (ids[producer]) {
          const prod = bp.nodes.find((x) => x && x.id === producer)
          const files = prod && prod.output && prod.output.files
          if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).includes(b.artifact)) {
            err(at + '.artifact', 'artifact ' + b.artifact + ' 未在生产节点 ' + producer + ' 的 output.files 中声明（引用错误须在编译期定位）')
          }
        }
      }
    })
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
  // 异源档位三态（LOC-021）：关/弱/强，缺失或旧值 true → 弱，旧值 false → 关；非法值按弱档处理并报错。
  const heteroValueInvalid = bp.heteroCheck !== undefined && bp.heteroCheck !== null && !isKnownHeteroValue(bp.heteroCheck)
  if (heteroValueInvalid) {
    err('$.heteroCheck', 'heteroCheck 档位值非法（' + JSON.stringify(bp.heteroCheck) + '）：仅支持 "off" / "weak" / "strong"（旧布尔值 true=弱、false=关 仍兼容）；已按弱档继续校验，请修正后保存')
  }
  const heteroMode = heteroValueInvalid ? 'weak' : effectiveHeteroMode(bp.heteroCheck)
  // 异源规则（规则 7，T-06 修订：按档位判定，仅 dev↔review 一对；关档跳过，旧数据兼容优先级高于新语义）
  const warnings = []
  const devNode = bp.nodes.find((n) => n && (n.id === 'dev' || n.profile === 'dev'))
  const reviewNode = bp.nodes.find((n) => n && (n.id === 'review' || n.profile === 'review'))
  // 显式声明强档但缺开发/审核配对 → 警示（不拦）：强档要求无从执行，提示用户档位不会生效。
  // 弱档是现状默认，模板可为表达意图显式声明弱档而无配对（不提示）；关档不校验，旧值 false 遗留不提示。
  if (heteroMode === 'strong' && bp.heteroCheck !== undefined && bp.heteroCheck !== null && bp.heteroCheck !== false
      && !(devNode && reviewNode)) {
    warnings.push('异源档位 strong 已声明，但该蓝图没有开发与审核节点（按节点 id 或 profile 识别），强档要求无从执行——请补充配对节点，或将 heteroCheck 降为 "weak" / "off"')
  }
  if (heteroMode !== 'off' && devNode && reviewNode) {
    const bm = (bp.bindings && bp.bindings.models) || {}
    const dm = bm[devNode.id]
    const rm = bm[reviewNode.id]
    if (!dm || !rm) {
      err('$.bindings.models', 'dev/review 未配置 bindings.models，无法证明异源（异源档位：' + heteroMode + '），请显式配置；或将 heteroCheck 置为 "off" 关闭校验')
    } else {
      const dt = (dm.provider || 'default') + '/' + (dm.model || 'default')
      const rt = (rm.provider || 'default') + '/' + (rm.model || 'default')
      if (dt === rt) {
        err('$.bindings.models', 'dev 与 review 模型相同（' + dt + '）：异源档位 ' + heteroMode + ' 要求不同 provider 或不同模型，请调整 bindings.models；或将 heteroCheck 置为 "off" 关闭校验')
      } else if (dm.provider === rm.provider) {
        if (heteroMode === 'strong') {
          err('$.bindings.models', '异源档位 strong 要求 dev 与 review 使用不同 provider（当前同为 ' + dm.provider + '：dev=' + dt + '，review=' + rt + '），请调整 bindings.models；或将 heteroCheck 降为 "weak" / "off"')
        } else {
          warnings.push('弱异源：dev/review 同 provider（' + dm.provider + '）不同模型，建议配置不同 provider 满足真异源')
        }
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

  // 裁决一致性声明（LOC-025 / WR-002）：双裁决字段节点（route + verdict / result）可在
  // output.consistency 声明配对表 { field, pairs }——pairs 以业务路由取值为键、该路由下
  // 结论字段必须等于的取值为值。机制全局（校验器只认蓝图声明表），语义随模板（建设
  // review/test 的 6 个合法组合声明在 templates/wf-construction-full-feature.json，不伪装
  // 为既有全局语义）。运行时（generate.mjs 产物）在路由选择前按同一张表做确定性检查，
  // 表外组合以 CONTRACT_INCONSISTENT 拒绝，不作专业通过判断。未声明的节点维持原行为
  // （旧蓝图零迁移；已启动运行的冻结快照不受影响）。
  bp.nodes.forEach((n) => {
    if (!n || !n.id) return
    const decl = n.output && n.output.consistency
    if (decl === undefined) return
    const at = '$.nodes[' + n.id + '].output.consistency'
    if (!hasOutcomePath(n)) {
      err(at, 'consistency 仅支持声明了 outcomePath 的业务结果路由节点（矛盾组合须在路由选择前被确定性拒绝）')
      return
    }
    if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
      err(at, 'consistency 必须是对象 { field, pairs }')
      return
    }
    if (typeof decl.field !== 'string' || !decl.field.trim()) {
      err(at + '.field', 'consistency.field 必填（与业务路由配对的结论字段名，如 verdict / result）')
    }
    if (!decl.pairs || typeof decl.pairs !== 'object' || Array.isArray(decl.pairs) || Object.keys(decl.pairs).length === 0) {
      err(at + '.pairs', 'consistency.pairs 必填（非空对象：业务路由取值 → 结论字段取值）')
      return
    }
    const schema = n.output.schema
    if (!schema || typeof schema !== 'object') return // schema 缺失由 outcomePath 规则另行报错，此处不重复
    const outSegs = parseJsonPath(String(n.output.outcomePath).trim())
    if (!outSegs) return // outcomePath 格式由其规则报错，此处不重复
    if (outSegs.length === 1 && outSegs[0] === decl.field) {
      err(at + '.field', 'consistency.field 不得与 outcomePath 字段同名（自我配对无意义）')
    }
    if (!pathInSchema(schema, [decl.field])) {
      err(at + '.field', 'consistency.field 未在 output.schema 中声明：' + decl.field)
      return
    }
    const fieldVals = enumerableValues(schemaLeafAt(schema, [decl.field]))
    if (!fieldVals) {
      err(at + '.field', 'consistency.field 必须可穷举（enum / const / oneOf 常量），当前：' + decl.field)
      return
    }
    const outVals = enumerableValues(schemaLeafAt(schema, outSegs)) || []
    const seenFieldVals = {}
    const pairKeys = Object.keys(decl.pairs)
    pairKeys.forEach((k) => {
      const v = decl.pairs[k]
      if (!outVals.some((x) => outcomeKey(x) === outcomeKey(k))) {
        err(at + '.pairs', 'consistency.pairs 键 ' + outcomeKey(k) + ' 不在 outcomePath 枚举内（允许：' + outVals.map((x) => outcomeKey(x)).join('、') + '）')
      }
      if (!fieldVals.some((x) => outcomeKey(x) === outcomeKey(v))) {
        err(at + '.pairs', 'consistency.pairs 值 ' + outcomeKey(v) + ' 不在字段 ' + decl.field + ' 枚举内（允许：' + fieldVals.map((x) => outcomeKey(x)).join('、') + '）')
      }
      const fk = outcomeKey(v)
      if (seenFieldVals[fk]) {
        err(at + '.pairs', '同一结论取值 ' + fk + ' 不得配对多个路由取值（每份专业结论只有一种可解释的路由）')
      }
      seenFieldVals[fk] = true
    })
    outVals.forEach((v) => {
      if (!pairKeys.some((k) => outcomeKey(k) === outcomeKey(v))) {
        err(at + '.pairs', '路由枚举取值 ' + outcomeKey(v) + ' 缺少配对（pairs 必须覆盖 outcomePath 全部取值，防止未声明组合绕过路由前检查）')
      }
    })
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
            if (HD_CONTROL_RESULTS.includes(id)) {
              // #163：运行期续跑先解释控制名（USER_ACCEPTED→DONE / STOP→STOPPED /
              // ADD_BUDGET→预算续跑），outcome 边占用控制名会让声明 to 永不可达、
              // 画卡承诺与实际行为不符；与 result 同规，校验期显式拒绝。
              err(at + '.outcome', '控制类 Result（USER_ACCEPTED / ADD_BUDGET / STOP）由框架解释，不得作为蓝图出边 outcome（#163）；请改用业务名（如 CONFIRM_PROCEED）')
            } else if (HD_RUNTIME_RESERVED_IDS.has(id)) {
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
  // LOC-005 parity 门禁：补导出图语义判定，供 client 副本对拍（行为不变，仅导出）。
  isStructuralEdge,
  isRollbackEdge,
  projectToVwf,
  projectToBlueprint,
  // LOC-021 异源档位三态：供宿主/客户端复用同一归一口径，勿复制映射逻辑。
  effectiveHeteroMode,
  extractFileTokens,
  blueprintUsesHumanDecision,
  compileInputSizeViolation,
  COMPILE_INPUT_LIMIT_TOTAL_BYTES,
  COMPILE_INPUT_LIMIT_GOAL_BYTES,
  COND_RE,
  MAX_ROUNDS_CAP,
  // LOC-031 技术预算：默认策略 / 数值边界 / 校验（生成脚本注入同源常量）
  RETRY_POLICY_DEFAULTS,
  RETRY_POLICY_LIMITS,
  validateRetryPolicy,
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
