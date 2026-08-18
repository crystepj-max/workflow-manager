// ─────────────────────────────────────────────────────────────────────────────
// visual-workflow · HOST 半（pkg-20，编辑模块 Gold-Band 对齐版）
//
// 基于 pkg-19 host 改造：
//  - validateDsl 升级为 Gold-Band《工作流编辑器》保存校验的同构规则集
//    （入口拓扑推导 / $end 必须 / 悬空节点 / 保留 id / 成功表达式路径落在
//    output.schema 内 / 边来源目标与类型 / when 仅 success / failure 唯一 /
//    多 success 出边必须全部带 when / success 环检测），并返回
//    fieldErrors（node:<id>:<field> / edge:<i>:<field> / control:<field>）
//    供编辑面板逐字段标红——对应 WorkflowEditor.tsx 的 validateWorkflowForSave。
//  - sanitizeDsl：保存前清洗（entry 依拓扑归一、failure 边剔除 when、空白修整），
//    对应 Gold-Band 的 sanitizedWorkflow。
//  - 新增 vwf.roles RPC：列出工作区 dsh/roles/*.md 角色（fs 服务，多形态兜底），
//    供节点表单的角色选择器使用（对应 Gold-Band 的 ProfilePicker 数据源）。
//  - 保留 pkg-19 全部 RPC（workflows.list/save/remove、validate、compile、
//    script、state、models）与 wf_run 工具、运行状态跟踪。
//
// 运行形态：动态插件（cordis_define code.host）——plain JS、无 import，
// 服务经 ctx.get 获取并判空。
// ─────────────────────────────────────────────────────────────────────────────
return {
  name: 'visual-workflow-host',
  apply(ctx) {
    const engine = ctx.get('workflowEngine')
    const agents = ctx.get('agents')
    const llm = ctx.get('llm')
    const fs = ctx.get('fs')

    const TEMPLATES = {
      'dev-workflow-2-0': {
        id: 'dev-workflow-2-0',
        name: '开发工作流 2.0',
        description: 'issue 三要素门禁 → 开发 →（分流）测试/直审 → 审核 → 人工验收 → 收口（推送/合并 PR/关闭 issue），打回上限 9 轮',
        entry: 'dispatch',
        control: { maxRounds: 9 },
        nodes: [
          { id: 'dispatch', profile: 'dispatcher', label: '调度', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
            goal: '读取 GitHub issue（或原始需求文本），校验三要素（任务目标/涉及范围/验收标准）并判定是否需要集成测试；三要素缺失如实判定缺失，不追问不编造。写 dispatch-result.json 并更新 STATE.md。',
            output: { schema: { type: 'object', properties: { complete: { type: 'boolean' }, missing: { type: 'array', items: { type: 'string' } }, objective: { oneOf: [{ type: 'string' }, { type: 'null' }] }, scope: { oneOf: [{ type: 'string' }, { type: 'null' }] }, acceptance: { oneOf: [{ type: 'string' }, { type: 'null' }] }, need_integration_test: { type: 'boolean' }, reason: { type: 'string' } }, required: ['complete', 'missing', 'need_integration_test', 'reason'], additionalProperties: false }, successCondition: '$.complete == true' } },
          { id: 'dev', profile: 'dev', label: '开发', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
            goal: '在工作分支施工（tdd：先写会失败的测试再写实现），本地验证全绿后提交（不推送、不建 PR）；写 dev-report.md 并更新 STATE.md。环境受阻时 status 报 blocked。',
            output: { schema: { type: 'object', properties: { status: { type: 'string', enum: ['completed', 'blocked'] }, summary: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, self_verify: { type: 'string' }, risks: { type: 'string' } }, required: ['status', 'summary', 'self_verify'], additionalProperties: false }, successCondition: '$.status == "completed"' } },
          { id: 'route', profile: 'dispatcher', label: '分流', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            goal: '读取 dispatch-result.json，如实输出是否需要集成测试的判定，不重新分析三要素。',
            output: { schema: { type: 'object', properties: { need_integration_test: { type: 'boolean' }, reason: { type: 'string' } }, required: ['need_integration_test', 'reason'], additionalProperties: false } } },
          { id: 'test', profile: 'test', label: '测试', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            goal: '对实现做运行态验证（证据驱动判定），专杀假测试；不修改业务代码；写 test-report.md 并更新 STATE.md。环境阻塞时 result 报 BLOCKED。',
            output: { schema: { type: 'object', properties: { result: { type: 'string', enum: ['PASSED', 'FAILED', 'BLOCKED'] }, reason: { type: 'string' }, evidence: { type: 'string' }, failed_cases: { type: 'string' } }, required: ['result', 'reason', 'evidence'], additionalProperties: false }, successCondition: '$.result == "PASSED"' } },
          { id: 'review', profile: 'review', label: '审核', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            goal: '双轴独立审查（需求符合性优先 + 代码质量），只读源代码；写 review-report.md 并更新 STATE.md；存在阻塞问题必须 REQUEST_CHANGES。',
            output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT_ONLY'] }, blockers: { type: 'string' }, compliance: { type: 'string' }, summary: { type: 'string' } }, required: ['verdict', 'summary'], additionalProperties: false }, successCondition: '$.verdict != "REQUEST_CHANGES"' } },
          { id: 'accept', profile: 'accept', label: '人工验收', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, manualCheck: true,
            goal: '逐条核对验收标准（证据缺失时只读验证），写 acceptance-summary.md 与 accept-report.md 并更新 STATE.md；不代签人工结论。',
            output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS', 'FAIL', 'INCOMPLETE'] }, summary_for_human: { type: 'string' }, details: { type: 'string' } }, required: ['verdict', 'summary_for_human', 'details'], additionalProperties: false } } },
          { id: 'closeout', profile: 'closeout', label: '收口', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            goal: '一致性收口；写 cleanup-report.md；推送工作分支、创建并合并 Draft PR（squash + 删分支）、关闭 issue；收束本地工作区。禁止绕过 PR 直推 base 分支。',
            output: { schema: { type: 'object', properties: { status: { type: 'string', enum: ['done'] }, summary: { type: 'string' }, followups: { type: 'string' } }, required: ['status', 'summary'], additionalProperties: false } } }
        ],
        edges: [
          { from: 'dispatch', to: 'dev', on: 'success' },
          { from: 'dispatch', to: '$end', on: 'failure' },
          { from: 'dev', to: 'route', on: 'success' },
          { from: 'route', to: 'test', on: 'success', when: '$.need_integration_test == true' },
          { from: 'route', to: 'review', on: 'success', when: '$.need_integration_test == false' },
          { from: 'test', to: 'review', on: 'success' },
          { from: 'test', to: 'dev', on: 'failure' },
          { from: 'review', to: 'accept', on: 'success' },
          { from: 'review', to: 'dev', on: 'failure' },
          { from: 'accept', to: 'closeout', on: 'success' },
          { from: 'accept', to: 'dev', on: 'failure' },
          { from: 'closeout', to: '$end', on: 'success' }
        ]
      }
    }

    // ── 保留 id（与 Gold-Band workflowGraph.ts 的哨兵一致；插件 DSL 仅使用 $end）──
    const END_NODE = '$end'
    const ENTRY_NODE = '$entry'
    const NEW_ROUND_NODE = '$new-round'
    const RESERVED_IDS = [END_NODE, ENTRY_NODE, NEW_ROUND_NODE]

    const COND_RE = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/

    // ── 入口候选推导（对应 Gold-Band deriveWorkflowEntryCandidateIds）────────
    // 没有「非回退入边」的节点即入口候选；回退边 = 在 success 拓扑序中指向更早节点的边。
    function successTopologyOrder(dsl) {
      const ids = (dsl.nodes || []).map(n => n && n.id).filter(Boolean)
      const idSet = new Set(ids)
      const adjacency = new Map()
      const indegree = new Map()
      ids.forEach(id => { adjacency.set(id, []); indegree.set(id, 0) })
      ;(dsl.edges || []).forEach(e => {
        if (e.on !== 'success') return
        if (!idSet.has(e.from) || !idSet.has(e.to)) return
        adjacency.get(e.from).push(e.to)
        indegree.set(e.to, (indegree.get(e.to) || 0) + 1)
      })
      const queued = new Set()
      const queue = []
      const pushRoot = (id) => {
        if (!idSet.has(id) || queued.has(id)) return
        queued.add(id); queue.push(id)
      }
      pushRoot(dsl.entry)
      ids.forEach(id => { if ((indegree.get(id) || 0) === 0) pushRoot(id) })
      const ordered = []
      while (queue.length) {
        const id = queue.shift()
        ordered.push(id)
        ;(adjacency.get(id) || []).forEach(next => {
          indegree.set(next, (indegree.get(next) || 0) - 1)
          if ((indegree.get(next) || 0) === 0) pushRoot(next)
        })
      }
      ids.forEach(id => { if (!queued.has(id)) ordered.push(id) })
      const order = new Map()
      ordered.forEach((id, i) => order.set(id, i))
      return order
    }

    function isBackwardEdge(from, to, order) {
      const s = order.get(from)
      const t = order.get(to)
      return s !== undefined && t !== undefined && t < s
    }

    function deriveEntryCandidates(dsl) {
      const ids = new Set((dsl.nodes || []).map(n => n && n.id).filter(Boolean))
      const order = successTopologyOrder({ ...dsl, entry: '' })
      const incoming = new Set()
      ;(dsl.edges || []).forEach(e => {
        if (!ids.has(e.from) || !ids.has(e.to)) return
        if (e.on !== 'success' && isBackwardEdge(e.from, e.to, order)) return
        incoming.add(e.to)
      })
      return (dsl.nodes || []).map(n => n.id).filter(id => Boolean(id) && !incoming.has(id))
    }

    // ── 成功表达式路径解析（对应 Gold-Band parseExpressionPath/parseJsonPath）──
    function parseCondPath(expr) {
      const m = COND_RE.exec(String(expr || ''))
      if (!m) throw new Error('unsupported expression')
      return m[1].split('.').filter(Boolean)
    }

    // 路径是否落在 JSON Schema（properties/items 下钻）内——对应 Gold-Band
    // schemaContainsPath，但插件 DSL 的 schema 是标准 JSON Schema。
    function schemaContainsPath(schema, segments) {
      let cursor = schema
      for (const key of segments) {
        if (Array.isArray(cursor)) { cursor = cursor[0]; }
        if (!cursor || typeof cursor !== 'object') return false
        if (cursor.type === 'array' && cursor.items) { cursor = cursor.items }
        const props = cursor.properties
        if (!props || typeof props !== 'object' || !(key in props)) return false
        cursor = props[key]
      }
      return true
    }

    // ── 保存前清洗（对应 Gold-Band sanitizedWorkflow）────────────────────────
    function sanitizeDsl(dsl) {
      const next = JSON.parse(JSON.stringify(dsl || {}))
      next.edges = Array.isArray(next.edges) ? next.edges : []
      next.nodes = Array.isArray(next.nodes) ? next.nodes : []
      const candidates = deriveEntryCandidates(next)
      next.entry = candidates.length === 1 ? candidates[0] : (next.entry || '')
      next.edges = next.edges.map(e => {
        const edge = { ...e }
        if (edge.on !== 'success') delete edge.when
        return edge
      })
      if (next.control && next.control.maxRounds != null) {
        const v = Number(next.control.maxRounds)
        next.control = { ...next.control, maxRounds: Number.isFinite(v) ? Math.trunc(v) : 0 }
      }
      return next
    }

    // ── DSL 校验（Gold-Band validateWorkflowForSave 的插件 DSL 同构版）────────
    // 返回 { ok, errors, fieldErrors, sanitized }
    //  error: { at, message, fieldKey?, nodeId?, nodeIds?, edgeIndex? }
    //  fieldErrors: { 'node:<id>:<field>' | 'edge:<i>:<field>' | 'control:<field>': [message] }
    function validateDsl(dsl) {
      const errors = []
      const fieldErrors = {}
      // 注意：可选字段仅在定义时携带——host RPC 的 lossless-JSON 守卫拒绝
      // undefined 值（真机曾因此报错：errors[0].fieldKey/edgeIndex undefined）。
      const err = (at, msg, fieldKey, nodeId, edgeIndex, nodeIds) => {
        const entry = { at, message: msg }
        if (fieldKey !== undefined) entry.fieldKey = fieldKey
        if (nodeId !== undefined) entry.nodeId = nodeId
        if (edgeIndex !== undefined) entry.edgeIndex = edgeIndex
        if (nodeIds !== undefined) entry.nodeIds = nodeIds
        errors.push(entry)
        if (fieldKey) (fieldErrors[fieldKey] = fieldErrors[fieldKey] || []).push(msg)
      }
      const nodeField = (id, field) => 'node:' + id + ':' + field
      const edgeField = (i, field) => 'edge:' + i + ':' + field

      if (!dsl || typeof dsl !== 'object') { err('$', 'dsl 必须是对象'); return { ok: false, errors, fieldErrors } }
      if (typeof dsl.id !== 'string' || !dsl.id.trim()) err('$.id', '工作流 ID 不能为空。')
      if (!Array.isArray(dsl.nodes) || dsl.nodes.length === 0) err('$.nodes', '工作流至少需要一个节点。')
      if (!Array.isArray(dsl.edges)) err('$.edges', 'edges 必填（数组）')
      if (errors.length) return { ok: false, errors, fieldErrors }

      const sanitized = sanitizeDsl(dsl)
      const candidates = deriveEntryCandidates(sanitized)

      // 入口拓扑（Gold-Band：唯一无入边节点即入口）
      if (candidates.length === 0) err('$.entry', '工作流必须存在且只能存在一个没有入边的入口节点。')
      else if (candidates.length > 1) err('$.entry', '工作流存在多个入口节点：' + candidates.join(', ') + '。请通过连线收敛为唯一入口。', undefined, undefined, undefined, candidates)

      if (!dsl.edges.some(e => e && e.to === END_NODE)) err('$.edges', '工作流必须包含结束节点（存在指向 $end 的边）。')
      if (sanitized.control && sanitized.control.maxRounds != null && sanitized.control.maxRounds <= 0) {
        err('$.control.maxRounds', '打回上限必须大于 0。', 'control:maxRounds')
      }

      const ids = new Set()
      const idCounts = {}
      for (const n of dsl.nodes) {
        if (!n || typeof n !== 'object') continue
        idCounts[n.id] = (idCounts[n.id] || 0) + 1
      }
      const outgoingCounts = {}
      dsl.edges.forEach(e => { if (e && e.from) outgoingCounts[e.from] = (outgoingCounts[e.from] || 0) + 1 })

      for (const n of dsl.nodes) {
        if (!n || typeof n !== 'object') { err('$.nodes', '节点必须是对象。'); continue }
        const label = n.id ? n.id : '未命名节点'
        if (typeof n.id !== 'string' || !n.id.trim()) { err('$.nodes', '节点 ID 不能为空。', nodeField(label, 'id'), n.id || undefined); continue }
        ids.add(n.id)
        if (RESERVED_IDS.indexOf(n.id) >= 0) err('$.nodes[' + n.id + ']', label + ' 使用了系统保留节点 ID。', nodeField(n.id, 'id'), n.id)
        if (idCounts[n.id] > 1) err('$.nodes[' + n.id + ']', label + ' 节点 ID 重复。', nodeField(n.id, 'id'), n.id)
        if ((outgoingCounts[n.id] || 0) === 0) err('$.nodes[' + n.id + ']', label + ' 没有出边，无法继续执行或结束。', nodeField(n.id, 'id'), n.id)
        if (typeof n.profile !== 'string' || !n.profile.trim()) err('$.nodes[' + n.id + '].profile', label + ' 节点未关联角色。', nodeField(n.id, 'profile'), n.id)
        if (n.output !== undefined && n.output !== null) {
          if (!n.output || typeof n.output.schema !== 'object' || n.output.schema === null) {
            err('$.nodes[' + n.id + '].output.schema', label + ' 的 JSON 输出约束必填（对象）。', nodeField(n.id, 'output.schema'), n.id)
          }
          if (n.output.successCondition !== undefined && n.output.successCondition !== null && n.output.successCondition !== '') {
            if (typeof n.output.successCondition !== 'string' || !COND_RE.test(n.output.successCondition)) {
              err('$.nodes[' + n.id + '].output.successCondition', label + ' 的成功表达式格式无效（需为 $.path == value 形式）。', nodeField(n.id, 'output.successCondition'), n.id)
            } else if (n.output.schema && typeof n.output.schema === 'object') {
              try {
                const path = parseCondPath(n.output.successCondition)
                if (!schemaContainsPath(n.output.schema, path)) {
                  err('$.nodes[' + n.id + '].output.successCondition', label + ' 的成功表达式路径未在 JSON 输出约束中声明。', nodeField(n.id, 'output.successCondition'), n.id)
                }
              } catch (e) { /* COND_RE 已拦下 */ }
            }
          }
        }
      }

      let edgeIndex = -1
      for (const e of dsl.edges) {
        edgeIndex++
        const at = '$.edges[' + edgeIndex + ']'
        if (!e || typeof e !== 'object') { err(at, '第 ' + (edgeIndex + 1) + ' 条边必须是对象。', undefined, undefined, edgeIndex); continue }
        if (!e.from || !String(e.from).trim()) { err(at + '.from', '第 ' + (edgeIndex + 1) + ' 条边缺少来源节点。', edgeField(edgeIndex, 'from'), undefined, edgeIndex); continue }
        if (!ids.has(e.from)) err(at + '.from', '边的来源节点 ' + e.from + ' 不存在。', edgeField(edgeIndex, 'from'), e.from, edgeIndex)
        if (!e.to || !String(e.to).trim()) { err(at + '.to', '第 ' + (edgeIndex + 1) + ' 条边缺少目标节点。', edgeField(edgeIndex, 'to'), undefined, edgeIndex); continue }
        if (e.to !== END_NODE && !ids.has(e.to)) err(at + '.to', '边的目标节点 ' + e.to + ' 不存在。', edgeField(edgeIndex, 'to'), e.to, edgeIndex)
        if (RESERVED_IDS.indexOf(e.from) >= 0) err(at + '.from', '终止节点 ' + e.from + ' 不能作为边的来源。', edgeField(edgeIndex, 'from'), undefined, edgeIndex)
        if (e.on !== 'success' && e.on !== 'failure') { err(at + '.on', '第 ' + (edgeIndex + 1) + ' 条边类型无效。', edgeField(edgeIndex, 'on'), undefined, edgeIndex); continue }
        if (e.when !== undefined) {
          if (e.on !== 'success') err(at + '.when', 'when 条件只允许用于 success 边。', edgeField(edgeIndex, 'when'), e.from, edgeIndex)
          else if (typeof e.when !== 'string' || !COND_RE.test(e.when)) err(at + '.when', 'when 需为 $.path == value 形式。', edgeField(edgeIndex, 'when'), e.from, edgeIndex)
        }
      }

      for (const id of ids) {
        const out = dsl.edges.filter(e => e && e.from === id)
        const succ = out.filter(e => e.on === 'success')
        const fail = out.filter(e => e.on === 'failure')
        if (succ.length > 1 && succ.some(e => e.when === undefined)) {
          err('$.nodes[' + id + ']', id + ' 有多条 success 出边时必须全部带 when 条件。', nodeField(id, 'id'), id)
        }
        if (fail.length > 1) err('$.nodes[' + id + ']', id + ' 有 ' + fail.length + ' 条 failure 边，同类型边最多只能有一条。', nodeField(id, 'id'), id)
      }

      const reach = new Set()
      const stack = candidates.length === 1 ? [candidates[0]] : (dsl.entry && ids.has(dsl.entry) ? [dsl.entry] : [])
      while (stack.length) {
        const cur = stack.pop()
        if (reach.has(cur)) continue
        reach.add(cur)
        for (const e of dsl.edges) if (e && e.from === cur && e.on === 'success' && e.to !== END_NODE) stack.push(e.to)
      }
      for (const id of ids) if (!reach.has(id)) err('$.nodes[' + id + ']', id + ' 没有入边，无法从入口节点到达。', nodeField(id, 'id'), id)

      const color = {}
      const dfs = (u) => {
        color[u] = 1
        for (const e of dsl.edges) {
          if (e.from !== u || e.on !== 'success' || e.to === END_NODE) continue
          if (color[e.to] === 1) { err('$.nodes[' + e.to + ']', e.to + ' 的 success 边存在环（打回请用 failure 边）。', nodeField(e.to, 'id'), e.to); return }
          if (color[e.to] === undefined) dfs(e.to)
        }
        color[u] = 2
      }
      if (!errors.length) { const start = candidates.length === 1 ? candidates[0] : dsl.entry; if (ids.has(start)) dfs(start) }

      return { ok: errors.length === 0, errors, fieldErrors, sanitized }
    }

    function compileDsl(dsl) {
      const v = validateDsl(dsl)
      if (!v.ok) return { ok: false, errors: v.errors }
      const maxRounds = (dsl.control && dsl.control.maxRounds) || 9
      const nodesJson = JSON.stringify(dsl.nodes)
      const edgesJson = JSON.stringify(dsl.edges)
      const phases = dsl.nodes.map(n => ({ title: (n.label || n.id) }))
      const meta = { name: 'vwf-' + (dsl.id || 'run'), description: dsl.name || dsl.id || 'visual workflow run', phases: phases }
      const script = [
        "const A = args || {}",
        "const TASK = A.taskId || 'task'",
        "const RUNDIR = A.runDir || ('.agent-runs/' + TASK)",
        "const ROLE_DIR = A.roleDir || 'dsh/roles'",
        "const BASE = A.baseBranch || 'main'",
        "const WORK = 'dev2/' + TASK",
        "const MAX_ROUNDS = " + maxRounds,
        "const NODES = " + nodesJson,
        "const EDGES = " + edgesJson,
        "const BYID = {}",
        "for (const n of NODES) BYID[n.id] = n",
        "function cond(expr, res) {",
        "  if (!expr) return true",
        "  const m = /^\\$\\.([A-Za-z0-9_.]+)\\s*(==|!=)\\s*(true|false|null|\"([^\"]*)\"|-?\\d+(\\.\\d+)?)$/.exec(expr)",
        "  if (!m) return false",
        "  let v = res",
        "  for (const k of m[1].split('.')) { if (v == null) return false; v = v[k] }",
        "  let want",
        "  if (m[3] === 'true') want = true",
        "  else if (m[3] === 'false') want = false",
        "  else if (m[3] === 'null') want = null",
        "  else if (m[4] !== undefined) want = m[4]",
        "  else want = Number(m[3])",
        "  return m[2] === '==' ? v === want : v !== want",
        "}",
        "function issueBlock() {",
        "  if (A.issueBody) return 'GitHub issue ' + (A.issueRef || '') + '\\n标题：' + (A.issueTitle || '（未提供）') + '\\n正文：\\n' + A.issueBody + (A.issueComments ? '\\n\\n需求确认相关评论：\\n' + A.issueComments : '')",
        "  if (A.requirement) return '原始需求文本（运行时直接给出，以此为准）：\\n' + A.requirement",
        "  return '（本任务未提供 issue 或需求文本，请以前序产物为准）'",
        "}",
        "function roleRef(name) {",
        "  return '【角色定义】开工前先用读文件工具读取 ' + ROLE_DIR + '/' + name + '.md（相对当前工作区根目录），严格遵循其中的定位、工作流程、产出模板、判定标准与硬规则——该文件是你在本节点的唯一角色依据。\\n'",
        "}",
        "function runtimeCtx(nodeId, extra) {",
        "  const n = BYID[nodeId]",
        "  return '\\n\\n---\\n\\n## 运行上下文（编排注入，以此为准）\\n\\n' + '【节点目标】\\n' + (n.goal || '') + '\\n\\n【任务输入】\\n' + issueBlock() + '\\n\\n- 任务标识：' + TASK + '\\n- run 产物目录：' + RUNDIR + '/（不存在则创建；本节点只允许在该目录内写文件）\\n- base 分支：' + BASE + '；工作分支：' + WORK + '\\n- 当前节点：' + (n.label || nodeId) + '\\n- 完成本节点后更新 ' + RUNDIR + '/STATE.md（stage / round / status / updated，时间用 date -u +%FT%TZ）\\n' + (extra ? '\\n' + extra + '\\n' : '') + '\\n## 最终回复要求\\n完成全部工作（含写报告、更新 STATE.md）后，最终回复只给出结构化结果本身，不要复述报告全文。\\n'",
        "}",
        "async function callNode(id, round, feedback) {",
        "  const n = BYID[id]",
        "  const opts = { label: (n.label || id) + (round > 0 ? ' R' + round : ''), ...(n.model || {}) }",
        "  if (n.output && n.output.schema) opts.schema = n.output.schema",
        "  const fb = feedback ? '【上轮打回反馈——必须逐条修复】\\n' + feedback + '\\n\\n' : ''",
        "  const prompt = roleRef(n.profile) + runtimeCtx(id, fb)",
        "  phase(n.label || id)",
        "  return await agent(prompt, opts)",
        "}",
        "function outEdges(id) { return EDGES.filter(e => e.from === id) }",
        "function route(id, res, ok) {",
        "  const out = outEdges(id)",
        "  if (ok) {",
        "    for (const e of out) if (e.on === 'success' && e.when && cond(e.when, res)) return e",
        "    for (const e of out) if (e.on === 'success' && !e.when) return e",
        "  } else {",
        "    for (const e of out) if (e.on === 'failure') return e",
        "  }",
        "  return null",
        "}",
        "let current = A.entry || '" + dsl.entry + "'",
        "let round = A.startRound || 0",
        "let feedback = A.feedback || ''",
        "const results = {}",
        "const history = A.history || []",
        "while (current !== '$end') {",
        "  const n = BYID[current]",
        "  if (!n) return { status: 'ERROR', detail: '未知节点：' + current }",
        "  if (n.manualCheck) {",
        "    if (A.approved !== true) {",
        "      const res = await callNode(current, round, feedback)",
        "      results[current] = res",
        "      return { status: 'AWAITING_HUMAN_' + current, taskId: TASK, node: current, round: round, result: res, history: history, resume: { entry: current, approved: true, startRound: round, history: history, feedback: feedback } }",
        "    }",
        "    const e = route(current, results[current], true)",
        "    if (!e) return { status: 'ERROR', detail: '人工裁决后无出边：' + current }",
        "    current = e.to",
        "    continue",
        "  }",
        "  const res = await callNode(current, round, feedback)",
        "  if (res === null) {",
        "    history.push({ round: round, stage: current, verdict: 'AGENT_FAILED', reason: '节点 agent 未返回有效结果' })",
        "    const ef = route(current, null, false)",
        "    if (!ef || ef.to === '$end') return { status: 'TECHNICAL_FAILURE', stage: current, round: round, results: results, history: history }",
        "    current = ef.to; round++; feedback = '【' + (BYID[current].label || current) + ' agent 技术失败】请重试并自查。'; continue",
        "  }",
        "  results[current] = res",
        "  const ok = n.output && n.output.successCondition ? cond(n.output.successCondition, res) : true",
        "  log((n.label || current) + ' → ' + (ok ? '通过' : '未通过'))",
        "  const e = route(current, res, ok)",
        "  if (!e) return { status: ok ? 'ENDED_NO_SUCCESS_EDGE' : 'ENDED_NO_FAILURE_EDGE', stage: current, results: results, history: history }",
        "  if (e.on === 'failure') {",
        "    round++",
        "    if (e.to === '$end') return { status: 'FAILED_AT_' + current, stage: current, result: res, results: results, history: history }",
        "    if (round >= MAX_ROUNDS) return { status: 'FAILED_MAX_ROUNDS', taskId: TASK, rounds: MAX_ROUNDS, results: results, history: history, dispatch: results['dispatch'] || null }",
        "    history.push({ round: round, stage: current, verdict: 'REJECTED', reason: JSON.stringify(res) })",
        "    feedback = '【' + (n.label || current) + '未通过 · 第 ' + round + ' 轮】' + JSON.stringify(res)",
        "  } else {",
        "    feedback = ''",
        "  }",
        "  current = e.to",
        "}",
        "return { status: 'DONE', taskId: TASK, round: round, results: results, history: history }"
      ].join('\n')
      return { ok: true, script: script, meta: meta }
    }

    const userWorkflows = new Map()
    function findWorkflow(id) {
      if (TEMPLATES[id]) return TEMPLATES[id]
      const w = userWorkflows.get(id)
      return w ? w.dsl : null
    }
    function listWorkflows() {
      const out = Object.keys(TEMPLATES).map(k => ({ id: TEMPLATES[k].id, name: TEMPLATES[k].name, description: TEMPLATES[k].description, builtin: true, dsl: TEMPLATES[k] }))
      for (const w of userWorkflows.values()) out.push({ id: w.dsl.id, name: w.dsl.name || w.dsl.id, description: w.dsl.description || '', builtin: false, dsl: w.dsl })
      return out
    }

    const runs = new Map()
    ctx.on('workflow/start', (info) => { runs.set(info.id, { meta: { name: (info.meta && info.meta.name) || '', description: (info.meta && info.meta.description) || '' }, status: 'running', phase: '', logs: [], agents: [] }) })
    ctx.on('workflow/phase', (info, title) => { const r = runs.get(info.id); if (r) { r.phase = String(title); r.logs.push('[phase] ' + title); if (r.logs.length > 50) r.logs.shift() } })
    ctx.on('workflow/log', (info, message) => { const r = runs.get(info.id); if (r) { r.logs.push(String(message)); if (r.logs.length > 50) r.logs.shift() } })
    ctx.on('workflow/agent-start', (info, agent) => { const r = runs.get(info.id); if (r) r.agents.push({ seq: agent.seq, label: String(agent.label || ''), phase: agent.phase ? String(agent.phase) : '', outcome: 'running' }) })
    ctx.on('workflow/agent-end', (info, agent) => { const r = runs.get(info.id); if (!r) return; const a = r.agents[r.agents.length - 1]; if (a && a.seq === agent.seq) a.outcome = String(agent.outcome) })
    ctx.on('workflow/end', (info, result) => { const r = runs.get(info.id); if (r) r.status = String(result.stopReason) })

    harness.handle('vwf.workflows.list', async () => listWorkflows())
    harness.handle('vwf.workflows.save', async (a) => {
      const dsl = a && a.dsl
      const v = validateDsl(dsl)
      if (!v.ok) return { ok: false, errors: v.errors, fieldErrors: v.fieldErrors }
      userWorkflows.set(v.sanitized.id, { dsl: v.sanitized })
      return { ok: true, id: v.sanitized.id, dsl: v.sanitized }
    })
    harness.handle('vwf.workflows.remove', async (a) => {
      userWorkflows.delete(a && a.id)
      return { ok: true }
    })
    harness.handle('vwf.validate', async (a) => validateDsl(a && a.dsl))
    harness.handle('vwf.compile', async (a) => {
      const c = compileDsl(a && a.dsl)
      if (!c.ok) return { ok: false, errors: c.errors }
      return { ok: true, scriptLen: c.script.length, meta: c.meta }
    })
    harness.handle('vwf.script', async (a) => {
      const c = compileDsl(a && a.dsl)
      if (!c.ok) return { ok: false, errors: c.errors }
      return { ok: true, engineAvailable: !!(resolveEngine()), script: c.script, meta: c.meta }
    })
    harness.handle('vwf.state', async (a) => {
      const s = a && a.runId ? runs.get(a.runId) : null
      if (!s) return { found: false, state: null }
      return { found: true, state: { id: a.runId, meta: s.meta, status: s.status, phase: s.phase, logs: s.logs, agents: s.agents } }
    })
    harness.handle('vwf.models', async () => {
      if (llm === undefined) return { providers: [] }
      const out = []
      let providers = []
      try { providers = await Promise.resolve(llm.listProviders()) } catch (e) { return { providers: [] } }
      for (const p of providers || []) {
        const id = String(p && (p.id || p.provider || p.name) || '')
        if (!id) continue
        let models = []
        try {
          const ms = await llm.listModels(id)
          models = (ms || []).map(m => String(m && (m.id || m.model || m.name) || '')).filter(Boolean)
        } catch (e) {}
        out.push({ id: id, models: models })
      }
      return { providers: out }
    })

    // ── 角色列表（节点表单的角色选择器数据源）────────────────────────────────
    // 读取会话工作区 dsh/roles/*.md（对应 Gold-Band 的角色库）；不可用时回退到
    // 内置六角色清单。
    const FALLBACK_ROLES = [
      { id: 'dispatcher', name: '调度', summary: '调度角色：三要素门禁、分支判定、分流转发' },
      { id: 'dev', name: '开发', summary: '开发角色：测试驱动施工，满足质量闸门' },
      { id: 'test', name: '测试', summary: '测试角色：运行态验证，证据驱动判定' },
      { id: 'review', name: '审核', summary: '审核角色：独立双轴审查' },
      { id: 'accept', name: '验收', summary: '验收角色：最终核验，人工验收门禁' },
      { id: 'closeout', name: '收口', summary: '收口角色：一致性收口与交接产物汇总' }
    ]
    harness.handle('vwf.roles', async () => {
      if (fs === undefined) return { roles: FALLBACK_ROLES }
      try {
        const listFn = fs.readdir || fs.readDir || fs.list || fs.listDir
        const readFn = fs.readFile || fs.readTextFile || fs.readText
        if (!listFn) return { roles: FALLBACK_ROLES }
        let entries = await listFn.call(fs, 'dsh/roles')
        entries = (entries || []).map(e => typeof e === 'string' ? e : (e && (e.name || e.path)) || '').filter(name => /\.md$/i.test(name))
        if (!entries.length) return { roles: FALLBACK_ROLES }
        const roles = []
        for (const name of entries.sort()) {
          const id = name.replace(/\.md$/i, '')
          let summary = ''
          if (readFn) {
            try {
              const text = String(await readFn.call(fs, 'dsh/roles/' + name))
              const firstLine = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('---') && !l.startsWith('id:') && !l.startsWith('name:') && !l.startsWith('summary') && !l.startsWith('createdAt') && !l.startsWith('updatedAt') && !l.startsWith('dynamicTemplate') && !l.startsWith('#'))[0]
              summary = (firstLine || '').slice(0, 80)
            } catch (e) {}
          }
          roles.push({ id, name: id, summary })
        }
        return { roles: roles.length ? roles : FALLBACK_ROLES }
      } catch (e) {
        return { roles: FALLBACK_ROLES }
      }
    })

    // ── workflowEngine 解析 ──────────────────────────────────────────────────
    // 本部署中 workflowEngine 由 agent preset 平面挂载（workflow-worker-thread），
    // 动态插件 host ctx 看不到；经 agentPresets.serviceFor 对当前发起 agent 做
    // 只读桥接。所有分支均 try/catch，解析不到时优雅降级（不注册 wf_run）。
    function resolveEngine() {
      if (engine !== undefined) return engine
      try {
        const ap = ctx.get('agentPresets')
        if (!ap || typeof ap.serviceFor !== 'function') return undefined
        if (agents === undefined || typeof agents.currentInitiator !== 'function') return undefined
        const a = agents.currentInitiator()
        if (!a || !a.ctx) return undefined
        return ap.serviceFor(a, 'workflowEngine') || undefined
      } catch (e) { return undefined }
    }

    const runEngine = resolveEngine()
    if (runEngine !== undefined && agents !== undefined) {
      const tool = harness.defineTool({
        name: 'wf_run',
        description: '运行一个可视化工作流（DSL 图）：校验并编译为 workflow 脚本后交给引擎执行。args.templateId 用内置/用户模板，或 args.dsl 传自定义图。返回运行状态；人工验收节点会以 AWAITING_HUMAN_<node> 状态暂停，等待人工裁决后以 entry=节点id + approved=true/false 续跑。',
        parameters: {
          templateId: { type: 'string', required: false, description: '内置/用户工作流 id，如 dev-workflow-2-0' },
          dsl: { type: 'object', required: false, description: '自定义工作流 DSL（nodes/edges/control）' },
          taskId: { type: 'string', required: true, description: '任务标识，如 issue-12' },
          runDir: { type: 'string', required: false, description: 'run 产物目录，缺省 .agent-runs/<taskId>' },
          baseBranch: { type: 'string', required: false, description: 'base 分支，缺省 main' },
          roleDir: { type: 'string', required: false, description: '角色目录，缺省 dsh/roles' },
          issueRef: { type: 'string', required: false, description: 'issue 引用，如 #12' },
          issueTitle: { type: 'string', required: false, description: 'issue 标题' },
          issueBody: { type: 'string', required: false, description: 'issue 正文' },
          issueComments: { type: 'string', required: false, description: 'issue 评论' },
          requirement: { type: 'string', required: false, description: '原始需求文本（无 issue 时）' },
          entry: { type: 'string', required: false, description: '续跑入口节点 id' },
          approved: { type: 'boolean', required: false, description: '人工验收续跑裁决（true 通过 / false 打回）' },
          feedback: { type: 'string', required: false, description: '人工打回意见（续跑）' },
          startRound: { type: 'number', required: false, description: '续跑起始轮次' },
          history: { type: 'array', required: false, description: '前次打回历史（续跑）' }
        },
        output: { schema: { type: 'string' }, render: (a, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          let dsl = null
          if (args.templateId) {
            dsl = findWorkflow(args.templateId)
            if (!dsl) return '错误：未知工作流 ' + args.templateId + '（可用：' + listWorkflows().map(w => w.id).join(', ') + '）'
          } else if (args.dsl) {
            dsl = args.dsl
          } else {
            return '错误：必须提供 templateId 或 dsl'
          }
          const v = validateDsl(dsl)
          if (!v.ok) return 'DSL 校验失败：' + JSON.stringify(v.errors)
          const c = compileDsl(dsl)
          if (!c.ok) return '编译失败：' + JSON.stringify(c.errors)
          const engineNow = resolveEngine()
          if (engineNow === undefined) return '错误：当前宿主平面无法访问 workflowEngine（wf_run 需要 agent preset 挂载的工作流引擎）。可改用内置 workflow 工具执行 vwf.script 编译产物。'
          const parent = agents.requireInitiator()
          const scriptArgs = {
            taskId: args.taskId, runDir: args.runDir, roleDir: args.roleDir, baseBranch: args.baseBranch,
            issueRef: args.issueRef, issueTitle: args.issueTitle, issueBody: args.issueBody, issueComments: args.issueComments,
            requirement: args.requirement, entry: args.entry, approved: args.approved, feedback: args.feedback, startRound: args.startRound, history: args.history
          }
          const run = engineNow.start({ script: c.script, meta: c.meta, args: scriptArgs, parent: parent })
          const result = await run.result
          return JSON.stringify({ runId: String(run.id), stopReason: result.stopReason, value: result.value, agentsStarted: result.agentsStarted })
        }
      })
      harness.registerTool(ctx, tool)
    } else {
      console.log('[vwf] workflowEngine 未解析（host ctx 与 agent-preset 桥接均不可用）或 agents 未挂载：wf_run 工具不注册；编译产物经 vwf.script RPC 提供给 workflow 工具执行')
    }
  },
}
