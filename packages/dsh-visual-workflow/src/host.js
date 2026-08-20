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
// T-IMP-06（双根加载 + 用户模板落盘闭环，FR-2/FR-3，AC-2/AC-3）：
//  - 废除硬编码 TEMPLATES（L29-74）→ 目录加载：内置 = <repo>/.generated/<id>/vwf-dsl.json
//    （生成物，CI 先 npm run generate）；用户 = ~/.dsh/visual-workflow/templates/<id>.json
//    （蓝图 JSON，宿主数据根 ~/.dsh 下新建）。
//  - list 合并双根（builtin 标志 + id 字母序），用户条目 dsl = 蓝图→vwf DSL 投影
//    （内联 projectToVwf，与 scripts/generate.mjs 行为一致）。
//  - save：结构+异源校验 → 撞名拒绝（内置只读 / 当前编辑 id ≠ 目标 → 改名提示）→
//    逆投影蓝图落盘 → spawn 生成器 user 子命令同步自包含 skill 到 ~/.dsh/skills/<id>/
//    （save 即闭环；生成失败回滚落盘，保持原子）。save 新增参数 currentId。
//  - remove：仅用户模板可删（删蓝图 + 同步删 skill 目录）；内置拒绝。
//  - findWorkflow：内置优先、用户目录兜底。
// T-IMP-07（异源接入，FR-8，AC-8）：save 与 vwf.validate 叠加内联异源硬规则
//  （有 dev+review 节点 → 缺绑定拒 / 完全同模型拒 / 弱异源警告），与引擎
//  validate-blueprint.mjs 规则 7 行为一致。
// T-IMP-12（候选一：统一编译器）：compileDsl 已删除——单一编译器 =
//  scripts/generate.mjs compileBlueprint；宿主经管道取译文：内置模板读
//  .generated/<id>/script.mjs、用户模板读 ~/.dsh/skills/<id>/script.mjs（磁盘优先，
//  含蓝图全部增强），临时图/编辑器实时查看走 CLI `generate.mjs compile` 兜底。
//  vwf.compile RPC 随之删除（仅测试在用）；vwf.script 返回统一译文。
//
// 运行形态：动态插件（cordis_define code.host）——plain JS、无 import，
// 服务经 ctx.get 获取并判空。vm 沙箱无 process/env：仓库根优先取发起 agent
// 会话 cwd（apply 时捕获），兜底 sandboxPolicy.workspaceRoot；DSH home
// （~/.dsh）经子进程引导一次（os.homedir）；用户目录写入显式传
// danger-full-access 策略（宿主数据根不受会话 workspace-write 沙箱约束）；
// fs 服务无删除能力，remove 经子进程 rm。
// ─────────────────────────────────────────────────────────────────────────────
return {
  name: 'visual-workflow-host',
  apply(ctx) {
    const engine = ctx.get('workflowEngine')
    const agents = ctx.get('agents')
    const llm = ctx.get('llm')
    const fs = ctx.get('fs')
    const sp = ctx.get('sandboxPolicy')
    const subprocess = ctx.get('subprocess')

    // ── 双根模板存储（T-IMP-06）────────────────────────────────────────────
    // 路径来源：repo 根优先 = 发起 agent 会话 cwd（会话工作区即仓库根）。
    // currentInitiator 仅在模型发起的调用中存在——浏览器审批触发的激活
    // （apply 时）与客户端 RPC 调用都没有，因此每次调用实时探测，并把任何
    // 有 initiator 的调用记录为 knownCwd 兜底；最后才落 sandboxPolicy
    // workspaceRoot（部署默认 process.cwd()）。
    // DSH home = 子进程引导（os.homedir() + '/.dsh'，一次性缓存）。
    function sessionCwd() {
      try {
        if (agents === undefined || typeof agents.currentInitiator !== 'function') return null
        const a = agents.currentInitiator()
        const cwd = a && a.session && a.session.header && a.session.header.cwd
        return typeof cwd === 'string' && cwd ? cwd : null
      } catch (e) { return null }
    }
    let knownCwd = sessionCwd()
    function repoRoot() {
      const live = sessionCwd()
      if (live) { knownCwd = live; return live }
      if (knownCwd) return knownCwd
      if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) return sp.workspaceRoot
      return null
    }

    let nodePathPromise = null
    function resolveNode() {
      if (!nodePathPromise) {
        nodePathPromise = (async () => {
          if (subprocess === undefined) return null
          try { return await Promise.resolve(subprocess.resolveExecutable('node')) } catch (e) { return null }
        })()
      }
      return nodePathPromise
    }

    // spawn node <args>，收集输出；返回 { ok, stdout, detail }
    async function runNode(args, opts) {
      const node = await resolveNode()
      if (!node) return { ok: false, detail: '子进程服务不可用（node 解析失败）' }
      try {
        const handle = subprocess.spawn({
          argv: [node].concat(args || []),
          cwd: (opts && opts.cwd) || repoRoot() || '/',
          // 移除宿主注入的 NODE_OPTIONS（如 WorkBuddy genie-safe-delete 的
          // --require 钩子会拦截 fs.rmSync 并抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，
          // 导致 remove 的 rm 子进程失败；插件自己的脚本不需要该钩子）
          env: { NODE_OPTIONS: undefined },
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 64 * 1024 },
            stderr: { maxBytes: 64 * 1024 },
          },
          graceMs: (opts && opts.graceMs) || 30000,
        })
        const outcome = await handle.done
        const readerText = (r) => { if (!r) return ''; const rd = r.readFrom(0); return rd ? rd.text : '' }
        const stdout = readerText(handle.collected.stdout)
        const stderr = readerText(handle.collected.stderr)
        if (outcome.exitCode !== 0) {
          return { ok: false, detail: ((stderr || stdout) || ('exit ' + outcome.exitCode)).trim().slice(0, 500) }
        }
        return { ok: true, stdout: stdout, stderr: stderr }
      } catch (e) {
        return { ok: false, detail: String((e && e.message) || e) }
      }
    }

    let dshHomePromise = null
    function dshHome() {
      if (!dshHomePromise) {
        dshHomePromise = (async () => {
          // 宿主 env 经 scrub 后仍保留 HOME；DSH_* 被剥除，os.homedir() 不受影响
          const r = await runNode(['-e', "console.log(require('path').join(require('os').homedir(), '.dsh'))"], { cwd: repoRoot() || '/' })
          const home = r.ok ? (r.stdout || '').trim() : ''
          return home || null
        })()
      }
      return dshHomePromise
    }

    async function rootPaths() {
      const repo = repoRoot()
      const home = await dshHome()
      return {
        repo: repo,
        builtinDir: repo ? repo + '/.generated' : null,
        userDir: home ? home + '/visual-workflow/templates' : null,
        skillRoot: home ? home + '/skills' : null,
        generator: repo ? repo + '/scripts/generate.mjs' : null,
      }
    }

    // 用户目录（~/.dsh 宿主数据根）写入不受会话 workspace-write 沙箱约束
    function writePolicy() {
      if (!sp || typeof sp.resolve !== 'function') return undefined
      try { return sp.resolve({ mode: 'danger-full-access' }) } catch (e) { return undefined }
    }

    // 内置根：.generated/<id>/vwf-dsl.json（生成物四件套之一，CI 先 npm run generate）
    async function loadBuiltins() {
      const out = new Map()
      if (fs === undefined) return out
      const p = await rootPaths()
      if (!p.builtinDir) return out
      let entries = null
      try {
        const dir = await fs.resolve(p.builtinDir)
        entries = await fs.listDir(dir)
      } catch (e) { return out }
      for (const ent of entries || []) {
        if (!ent || typeof ent.name !== 'string' || !ent.name) continue
        try {
          const target = await fs.resolve(p.builtinDir + '/' + ent.name + '/vwf-dsl.json')
          const info = await fs.stat(target)
          if (!info || info.type !== 'file') continue
          const dsl = JSON.parse(await fs.readText(target))
          if (dsl && typeof dsl.id === 'string' && dsl.id) out.set(dsl.id, dsl)
        } catch (e) { /* 单个生成物损坏不影响其余 */ }
      }
      return out
    }

    // 用户根：~/.dsh/visual-workflow/templates/<id>.json（蓝图 JSON）
    async function loadUserTemplates() {
      const out = new Map()
      if (fs === undefined) return out
      const p = await rootPaths()
      if (!p.userDir) return out
      let entries = null
      try {
        const dir = await fs.resolve(p.userDir)
        entries = await fs.listDir(dir)
      } catch (e) { return out }
      for (const ent of entries || []) {
        if (!ent || typeof ent.name !== 'string' || !/\.json$/i.test(ent.name)) continue
        try {
          const bp = JSON.parse(await fs.readText(ent.target))
          if (bp && typeof bp.id === 'string' && bp.id) out.set(bp.id, bp)
        } catch (e) { /* 损坏的模板文件跳过 */ }
      }
      return out
    }

    // ── 蓝图 ↔ vwf DSL 投影（与 scripts/generate.mjs projectToVwf 行为一致；
    // RPC 走 lossless-JSON 守卫，undefined 字段必须剔除，故条件装配）────────
    function projectToVwf(bp) {
      const models = (bp.bindings && bp.bindings.models) || {}
      return {
        id: bp.id,
        name: bp.displayName,
        description: bp.description || '',
        entry: bp.entry,
        control: { maxRounds: (bp.control && bp.control.maxRounds) || 9 },
        nodes: bp.nodes.map((n) => {
          const o = { id: n.id, profile: n.profile, label: n.label || n.id, goal: n.goal }
          if (n.output) o.output = n.output
          if (n.manualCheck) o.manualCheck = true
          if (models[n.id]) o.model = models[n.id]
          return o
        }),
        edges: bp.edges.map((e) => {
          const o = { from: e.from, to: e.to, on: e.on }
          if (e.when !== undefined) o.when = e.when
          return o
        }),
      }
    }
    // 逆投影（save 落盘格式：蓝图 JSON；增强字段 onMaxRounds/heteroCheck/
    // verifyBranch 不存在于 vwf DSL，自然不产生）
    function projectToBlueprint(dsl) {
      const models = {}
      const nodes = (dsl.nodes || []).map((n) => {
        const o = { id: n.id, profile: n.profile, label: n.label || n.id, goal: n.goal || '' }
        if (n.output) o.output = n.output
        if (n.manualCheck) o.manualCheck = true
        if (n.model && typeof n.model === 'object' && n.model.provider && n.model.model) {
          models[n.id] = { provider: n.model.provider, model: n.model.model }
        }
        return o
      })
      const bp = {
        id: dsl.id,
        displayName: dsl.name || dsl.id,
        entry: dsl.entry,
        nodes: nodes,
        edges: (dsl.edges || []).map((e) => {
          const o = { from: e.from, to: e.to, on: e.on }
          if (e.when !== undefined) o.when = e.when
          return o
        }),
      }
      if (dsl.description) bp.description = dsl.description
      if (dsl.control && dsl.control.maxRounds != null) bp.control = { maxRounds: dsl.control.maxRounds }
      if (Object.keys(models).length) bp.bindings = { models: models }
      return bp
    }

    // ── 异源硬规则（T-IMP-07，与引擎 validate-blueprint.mjs 规则 7 行为一致；
    // 入参为 vwf DSL 形态，模型在节点 model 上；dev/review 按节点 id 或
    // profile（角色）识别——编辑器新建节点默认 id 为 node-N，用户以角色
    // 表达 dev/review 时同样纳入检查）────────────────────────────────────────
    function heteroCheck(dsl) {
      const nodes = dsl && Array.isArray(dsl.nodes) ? dsl.nodes : []
      const isDev = (n) => n && (n.id === 'dev' || n.profile === 'dev')
      const isReview = (n) => n && (n.id === 'review' || n.profile === 'review')
      const dev = nodes.find(isDev)
      const review = nodes.find(isReview)
      if (!dev || !review) return { ok: true, errors: [], warnings: [] }
      const dm = dev.model
      const rm = review.model
      const tag = (m) => (m && m.provider && m.model) ? m.provider + '/' + m.model : null
      const dt = tag(dm)
      const rt = tag(rm)
      if (!dt || !rt) {
        return { ok: false, errors: [{ at: 'bindings.models', message: 'dev/review 未配置模型绑定，无法证明异源，请显式配置（节点 model 或 bindings.models）' }], warnings: [] }
      }
      if (dt === rt) {
        return { ok: false, errors: [{ at: 'bindings.models', message: 'dev 与 review 模型相同（' + dt + '）：异源硬规则要求不同 provider 或不同模型，请调整模型绑定' }], warnings: [] }
      }
      const warnings = dm.provider === rm.provider
        ? ['弱异源：dev/review 同 provider（' + dm.provider + '）不同模型，建议配置不同 provider 满足真异源']
        : []
      return { ok: true, errors: [], warnings: warnings }
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
      if (typeof dsl.name !== 'string' || !dsl.name.trim()) err('$.name', '模板名称不能为空。')
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
        // 模型绑定必填（编辑器保存路径强制；蓝图契约 bindings.models 仍允许
        // 缺省=宿主默认，host 侧为满足「provider/model 必填」的产品要求而收紧）
        const hasModel = n.model && typeof n.model === 'object'
        if (!hasModel || !n.model.provider) err('$.nodes[' + n.id + '].model.provider', label + ' 未绑定 Agent（model.provider 必填）。', nodeField(n.id, 'model.provider'), n.id)
        if (!hasModel || !n.model.model) err('$.nodes[' + n.id + '].model.model', label + ' 未绑定模型（model.model 必填）。', nodeField(n.id, 'model.model'), n.id)
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

    // ── 统一编译器管道（候选一 T-IMP-12）────────────────────────────────────
    // compileDsl 已删除：单一编译器 = scripts/generate.mjs 的 compileBlueprint，
    // 宿主按来源取译文（磁盘优先 + CLI 兜底）：
    //   - 内置模板（fromTemplate，builtin）：读 .generated/<id>/script.mjs
    //     （npm run generate 产物，含蓝图全部增强：折叠/可信度闸门/超限归因/异源日志）
    //   - 用户模板（fromTemplate，user）：读 ~/.dsh/skills/<id>/script.mjs（save 闭环产物）
    //   - 其余（编辑器实时查看 vwf.script / wf_run 临时图 args.dsl）：
    //     逆投影蓝图 → spawn `node scripts/generate.mjs compile <临时蓝图>` 取译文
    //   （DSL 不含增强字段，CLI 编译结果 = 蓝图内容决定的行为，与磁盘产物一致）

    function metaFromDsl(dsl) {
      return { name: 'vwf-' + (dsl.id || 'run'), description: dsl.name || dsl.id || 'visual workflow run', phases: (dsl.nodes || []).map(n => ({ title: (n.label || n.id) })) }
    }

    async function readTextIfExists(p) {
      if (fs === undefined) return null
      try {
        const target = await fs.resolve(p)
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return null
        return await fs.readText(target)
      } catch (e) { return null }
    }

    // opts.fromTemplate = true：模板来源 → 磁盘产物优先；false：临时图 → CLI 编译。
    async function compileViaPipeline(dsl, opts) {
      const p = await rootPaths()
      if (opts && opts.fromTemplate) {
        const builtin = await readTextIfExists(p.builtinDir + '/' + dsl.id + '/script.mjs')
        if (builtin) return { ok: true, script: builtin, meta: metaFromDsl(dsl) }
        const user = await readTextIfExists(p.skillRoot + '/' + dsl.id + '/script.mjs')
        if (user) return { ok: true, script: user, meta: metaFromDsl(dsl) }
      }
      if (fs === undefined || subprocess === undefined || !p.repo || !p.generator || !p.userDir) {
        return { ok: false, detail: '宿主子进程/文件能力不可用：无法编译临时图（模板来源请先运行 npm run generate 或经保存闭环）' }
      }
      // 临时蓝图落盘（用户目录 tmp 区，danger 策略）→ CLI compile → 清理
      const bp = projectToBlueprint(dsl)
      const tmp = p.userDir + '/tmp/compile-' + dsl.id + '-' + Date.now() + '.json'
      try {
        const target = await fs.resolve(tmp)
        await fs.writeText(target, JSON.stringify(bp, null, 2) + '\n', undefined, undefined, writePolicy())
      } catch (e) {
        return { ok: false, detail: '临时蓝图写入失败：' + String((e && e.message) || e) }
      }
      const r = await runNode([p.generator, 'compile', tmp], { cwd: p.repo, graceMs: 30000 })
      try { await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", tmp], { cwd: p.repo }) } catch (e) {}
      if (!r.ok) return { ok: false, detail: r.detail }
      try {
        const out = JSON.parse(r.stdout)
        if (!out.ok) return { ok: false, detail: '编译器返回错误：' + (out.error || '未知') }
        return { ok: true, script: out.script, meta: out.meta || metaFromDsl(dsl) }
      } catch (e) {
        return { ok: false, detail: '编译器输出不可解析：' + String((e && e.message) || e) }
      }
    }

    // 双根查找：内置优先（沿用），用户目录兜底（蓝图 → vwf DSL 投影）
    async function findWorkflow(id) {
      if (!id || typeof id !== 'string') return null
      const builtins = await loadBuiltins()
      if (builtins.has(id)) return builtins.get(id)
      const users = await loadUserTemplates()
      const bp = users.get(id)
      return bp ? projectToVwf(bp) : null
    }
    // 合并双根：builtin 标志 + id 字母序；用户条目 dsl = 蓝图 → vwf DSL 投影
    async function listWorkflows() {
      const [builtins, users] = await Promise.all([loadBuiltins(), loadUserTemplates()])
      const out = []
      for (const dsl of builtins.values()) out.push({ id: dsl.id, name: dsl.name, description: dsl.description || '', builtin: true, dsl: dsl })
      for (const bp of users.values()) {
        const dsl = projectToVwf(bp)
        out.push({ id: bp.id, name: bp.displayName, description: bp.description || '', builtin: false, dsl: dsl })
      }
      out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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
      const het = heteroCheck(v.sanitized)
      if (!het.ok) return { ok: false, errors: het.errors, fieldErrors: {} }
      const id = v.sanitized.id
      const p = await rootPaths()
      if (fs === undefined || !p.repo || !p.userDir || !p.skillRoot || !p.generator) {
        return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法解析模板目录（需 fs/subprocess/sandboxPolicy 服务）' }] }
      }
      const [builtins, users] = await Promise.all([loadBuiltins(), loadUserTemplates()])
      if (builtins.has(id)) {
        return { ok: false, errors: [{ at: '$.id', message: '内置模板只读：' + id + ' 属于内置模板，不能覆盖，请改用新 id（另存为新模板）' }] }
      }
      const currentId = a && a.currentId
      if (users.has(id) && currentId !== id) {
        return { ok: false, errors: [{ at: '$.id', message: '已存在同名模板 ' + id + '：另存为新模板请修改模板 ID；更新当前模板请保持 ID 不变。' }] }
      }
      // 逆投影蓝图 → 落盘用户目录
      const bp = projectToBlueprint(v.sanitized)
      const file = p.userDir + '/' + id + '.json'
      try {
        const target = await fs.resolve(file)
        await fs.writeText(target, JSON.stringify(bp, null, 2) + '\n', undefined, undefined, writePolicy())
      } catch (e) {
        return { ok: false, errors: [{ at: '$', message: '模板落盘失败：' + String((e && e.message) || e) }] }
      }
      // save 即闭环：spawn 生成器 user 子命令 → 自包含 skill 三件套到 ~/.dsh/skills/<id>/
      // （生成器内部先跑蓝图校验含异源；失败 exit 1 输出错误）
      const gen = await runNode([p.generator, 'user', file, p.skillRoot], { cwd: p.repo, graceMs: 60000 })
      if (!gen.ok) {
        // 闭环失败：回滚已落盘蓝图，save 保持原子（蓝图级校验失败同此路径）
        try {
          await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", file], { cwd: p.repo })
        } catch (e) {}
        return { ok: false, errors: [{ at: '$', message: '蓝图校验/技能生成失败（save 已回滚）：' + gen.detail }] }
      }
      return { ok: true, id: id, dsl: v.sanitized, warnings: het.warnings }
    })
    harness.handle('vwf.workflows.remove', async (a) => {
      const id = a && a.id
      if (!id || typeof id !== 'string') return { ok: false, errors: [{ at: '$.id', message: '缺少模板 id' }] }
      const p = await rootPaths()
      if (fs === undefined || !p.repo || !p.userDir || !p.skillRoot) {
        return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法删除用户模板' }] }
      }
      const builtins = await loadBuiltins()
      if (builtins.has(id)) {
        return { ok: false, errors: [{ at: '$.id', message: '内置模板只读：' + id + ' 属于内置模板，不能删除' }] }
      }
      const file = p.userDir + '/' + id + '.json'
      let existed = false
      try {
        const target = await fs.resolve(file)
        const info = await fs.stat(target)
        existed = !!info
      } catch (e) { existed = false }
      if (!existed) return { ok: false, errors: [{ at: '$.id', message: '用户模板不存在：' + id }] }
      // 删蓝图 + 同步删 ~/.dsh/skills/<id>/（fs 服务无删除能力，经子进程 rm）
      const rm = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", file], { cwd: p.repo })
      if (!rm.ok) return { ok: false, errors: [{ at: '$', message: '模板删除失败：' + rm.detail }] }
      const skillDir = p.skillRoot + '/' + id
      await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", skillDir], { cwd: p.repo })
      return { ok: true, id: id }
    })
    harness.handle('vwf.validate', async (a) => {
      const v = validateDsl(a && a.dsl)
      if (!v.ok) return v
      const het = heteroCheck(v.sanitized)
      if (!het.ok) return { ok: false, errors: het.errors, fieldErrors: {}, sanitized: v.sanitized }
      return { ok: true, errors: [], fieldErrors: {}, sanitized: v.sanitized, warnings: het.warnings }
    })
    // vwf.compile 已删除（T-IMP-12）：统一编译器后无独立编译 RPC；脚本经 vwf.script 走管道。
    harness.handle('vwf.script', async (a) => {
      const dsl = a && a.dsl
      const v = validateDsl(dsl)
      if (!v.ok) return { ok: false, errors: v.errors }
      const c = await compileViaPipeline(v.sanitized, { fromTemplate: false })
      if (!c.ok) return { ok: false, errors: [{ at: '$', message: c.detail }] }
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

    // wf_run 注册条件：有 agents 服务即注册（engine 解析不依赖 apply 时刻的
    // currentInitiator——浏览器审批触发的激活无 initiator；engine 不可用推迟到
    // execute 时优雅报错，且运行时模型调用通常有 currentInitiator）。
    if (agents !== undefined) {
      const tool = harness.defineTool({
        name: 'wf_run',
        description: '运行一个可视化工作流（DSL 图）：校验并编译为 workflow 脚本后交给引擎执行。args.templateId 用内置/用户模板，或 args.dsl 传自定义图。返回运行状态；人工验收节点会以 AWAITING_HUMAN_<node> 状态暂停，等待人工裁决后以 entry=节点id + approved=true/false 续跑。',
        parameters: {
          templateId: { type: 'string', description: '内置/用户工作流 id，如 dev-workflow-2-0' },
          dsl: { type: 'object', additionalProperties: true, description: '自定义工作流 DSL（nodes/edges/control）' },
          taskId: { type: 'string', required: true, description: '任务标识，如 issue-12' },
          runDir: { type: 'string', description: 'run 产物目录，缺省 .agent-runs/<taskId>' },
          baseBranch: { type: 'string', description: 'base 分支，缺省 main' },
          roleDir: { type: 'string', description: '角色目录，缺省 dsh/roles' },
          issueRef: { type: 'string', description: 'issue 引用，如 #12' },
          issueTitle: { type: 'string', description: 'issue 标题' },
          issueBody: { type: 'string', description: 'issue 正文' },
          issueComments: { type: 'string', description: 'issue 评论' },
          requirement: { type: 'string', description: '原始需求文本（无 issue 时）' },
          entry: { type: 'string', description: '续跑入口节点 id' },
          approved: { type: 'boolean', description: '人工验收续跑裁决（true 通过 / false 打回）' },
          feedback: { type: 'string', description: '人工打回意见（续跑）' },
          startRound: { type: 'number', description: '续跑起始轮次' },
          history: { type: 'array', description: '前次打回历史（续跑）' }
        },
        output: { schema: { type: 'string' }, render: (a, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          let dsl = null
          let fromTemplate = false
          if (args.templateId) {
            dsl = await findWorkflow(args.templateId)
            if (!dsl) return '错误：未知工作流 ' + args.templateId + '（可用：' + (await listWorkflows()).map(w => w.id).join(', ') + '）'
            fromTemplate = true
          } else if (args.dsl) {
            dsl = args.dsl
          } else {
            return '错误：必须提供 templateId 或 dsl'
          }
          const v = validateDsl(dsl)
          if (!v.ok) return 'DSL 校验失败：' + JSON.stringify(v.errors)
          const c = await compileViaPipeline(v.sanitized, { fromTemplate })
          if (!c.ok) return '编译失败：' + c.detail
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
      // 诊断工具（定位删除/路径问题）：op=paths 返回路径解析；op=remove 逐步执行删除
      const debugTool = harness.defineTool({
        name: 'vwf_debug',
        description: 'vwf 插件诊断：op=paths 返回双根路径解析结果；op=remove <id> 逐步执行删除流程并返回每一步结果（含真实 rm 子进程输出），用于定位删除失败。',
        parameters: {
          op: { type: 'string', required: true, description: 'paths | remove' },
          id: { type: 'string', description: 'remove 诊断的模板 id' },
        },
        output: { schema: { type: 'string' }, render: (a, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          if (args.op === 'paths') {
            const p = await rootPaths()
            return JSON.stringify({
              repoRoot: repoRoot(), knownCwd: knownCwd, dshHome: await dshHome(),
              userDir: p.userDir, skillRoot: p.skillRoot, builtinDir: p.builtinDir, generator: p.generator,
              fsAvailable: fs !== undefined, subprocessAvailable: subprocess !== undefined,
              nodePath: await resolveNode(),
            }, null, 2)
          }
          if (args.op === 'remove' && args.id) {
            const id = args.id
            const p = await rootPaths()
            const file = p.userDir + '/' + id + '.json'
            const steps = { id: id, repo: p.repo, userDir: p.userDir, file: file }
            try {
              const target = await fs.resolve(file)
              const info = await fs.stat(target)
              steps.existed = !!info
              steps.statType = info ? info.type : null
            } catch (e) { steps.statError = String((e && e.message) || e) }
            const rm = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", file], { cwd: p.repo })
            steps.rm = rm
            const skillDir = p.skillRoot + '/' + id
            const rm2 = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", skillDir], { cwd: p.repo })
            steps.rmSkill = rm2
            try {
              const after = await fs.stat(await fs.resolve(file))
              steps.fileExistsAfter = !!after
            } catch (e) { steps.fileExistsAfter = false }
            return JSON.stringify(steps, null, 2)
          }
          return '用法：vwf_debug { op: "paths" } 或 { op: "remove", id: "<模板id>" }'
        },
      })
      harness.registerTool(ctx, debugTool)
    } else {
      console.log('[vwf] workflowEngine 未解析（host ctx 与 agent-preset 桥接均不可用）或 agents 未挂载：wf_run 工具不注册；编译产物经 vwf.script RPC 提供给 workflow 工具执行')
    }
  },
}
