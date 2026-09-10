// ─────────────────────────────────────────────────────────────────────────────
// visual-workflow · HOST 半
//
// 职责只有三件事：RPC 面（模板库 / 校验 / 编译 / 角色库 / 运行状态 / 工作区）、
// 工具（wf_run / vwf_workspace / vwf_debug）、运行记录。业务内核全部在仓库
// scripts/ 中，构建时复制进插件 dist/，运行时只从这一处加载——不在运行时猜路径。
//
// 运行约束（真机验证过的硬约束）：
//  - 动态插件跑在 vm 沙箱：plain JS、无 import/require/process/真定时器；
//    服务经 ctx.get 获取并判空；__VWF_PLUGIN_ROOT__ / __VWF_REPO_ROOT__ 由
//    构建产物注入（静态 bundle 经 import.meta.url，动态版本经文件头常量）。
//  - fs 服务没有删除能力：删除经子进程 `node -e fs.rmSync`；写入 ~/.dsh 等宿主数据根
//    必须显式传 danger-full-access 策略。
//  - 宿主可能注入 NODE_OPTIONS（如 WorkBuddy safe-delete 钩子拦截 rmSync）：子进程一律清掉。
//  - 两个根是两回事：代码根（插件/内核/生成器所在，构建期已知）与项目根（发起
//    agent 的会话工作区，仅模型发起的调用中可见，需实时探测）。
// ─────────────────────────────────────────────────────────────────────────────
return {
  name: 'visual-workflow-host',
  apply(ctx) {
    const engine = ctx.get('workflowEngine')
    const agents = ctx.get('agents')
    const sp = ctx.get('sandboxPolicy')
    let fs = ctx.get('fs')
    let subprocess = ctx.get('subprocess')
    // 服务可能晚于 apply 注入（静态组合包仅等待 webServer/tools/subprocess）：每次入口重取一次
    const refreshServices = () => {
      if (fs === undefined) fs = ctx.get('fs')
      if (subprocess === undefined) subprocess = ctx.get('subprocess')
    }
    const log = (m) => console.log('[vwf] ' + m)
    const errMsg = (e) => String((e && e.message) || e)
    const fail = (message, at) => ({ ok: false, errors: [{ at: at || '$', message: message }] })
    const isMissingErr = (e) => /ENOENT|no such file|not exist|不存在/i.test(errMsg(e))
    const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

    // ── 双模式注册：动态会话 = harness.handle；静态组合包 = webServer 前缀路由 ──
    // 必须用 typeof 探测未声明标识符：静态 IIFE 无 harness 全局，直接读会 ReferenceError。
    const isDynamicHost = typeof harness !== 'undefined'
    const rpcRoutes = new Map()
    function registerRpc(method, fn) {
      const wrapped = async (a) => { refreshServices(); return fn(a || {}) }
      rpcRoutes.set(method, wrapped)
      if (isDynamicHost) harness.handle(method, wrapped)
    }
    const dtools = {
      define(t) {
        if (isDynamicHost && typeof harness.defineTool === 'function') return harness.defineTool(t)
        if (typeof defineTool === 'function') return defineTool(t)
        return t
      },
      register(t) {
        if (isDynamicHost && typeof harness.registerTool === 'function') { harness.registerTool(ctx, t); return }
        const tools = ctx.get('tools')
        if (!tools || typeof tools.register !== 'function') { log('tools 服务缺失，工具未注册：' + t.name); return }
        if (typeof ctx.effect === 'function') ctx.effect(() => tools.register(t), 'vwf: tool ' + t.name)
        else tools.register(t)
      },
    }

    // ── 根路径 ────────────────────────────────────────────────────────────────
    function parentDir(dir) {
      const trimmed = String(dir || '').replace(/\/+$/, '')
      const slash = trimmed.lastIndexOf('/')
      return slash > 0 ? trimmed.slice(0, slash) : null
    }
    const PLUGIN_ROOT = (typeof __VWF_PLUGIN_ROOT__ === 'string' && __VWF_PLUGIN_ROOT__) ? __VWF_PLUGIN_ROOT__ : null
    const CODE_ROOT = (typeof __VWF_REPO_ROOT__ === 'string' && __VWF_REPO_ROOT__)
      ? __VWF_REPO_ROOT__
      : (PLUGIN_ROOT ? parentDir(parentDir(PLUGIN_ROOT)) : null)
    const DIST = PLUGIN_ROOT ? PLUGIN_ROOT + '/dist' : null
    const GENERATOR = CODE_ROOT ? CODE_ROOT + '/scripts/generate.mjs' : null
    const WS_HOST = CODE_ROOT ? CODE_ROOT + '/scripts/workspace-isolation-host.mjs' : null

    // 项目根：会话 cwd 只在模型发起的调用中存在（浏览器 RPC / 审批激活都没有），
    // 因此每次实时探测，记住最近一次有效值，最后兜底 sandboxPolicy.workspaceRoot。
    let knownCwd = null
    function projectRoot() {
      try {
        const a = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
        const cwd = a && a.session && a.session.header && a.session.header.cwd
        if (typeof cwd === 'string' && cwd) knownCwd = cwd
      } catch (e) { /* 无会话 */ }
      if (knownCwd) return knownCwd
      return (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) ? sp.workspaceRoot : null
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
    // spawn node <args>；返回 { ok, stdout, detail }
    async function runNode(args, opts) {
      const o = opts || {}
      const node = await resolveNode()
      if (!node) return { ok: false, detail: '子进程服务不可用（node 解析失败）' }
      try {
        const handle = subprocess.spawn({
          argv: [node].concat(args || []),
          cwd: o.cwd || CODE_ROOT || projectRoot() || '/',
          env: Object.assign({ NODE_OPTIONS: undefined }, o.env || {}),
          stdio: { stdin: 'ignore', stdout: { maxBytes: o.maxBytes || 64 * 1024 }, stderr: { maxBytes: o.maxBytes || 64 * 1024 } },
          graceMs: o.graceMs || 30000,
        })
        const outcome = await handle.done
        const text = (r) => { if (!r) return ''; const rd = r.readFrom(0); return rd ? rd.text : '' }
        const stdout = text(handle.collected.stdout)
        const stderr = text(handle.collected.stderr)
        if (outcome.exitCode !== 0) return { ok: false, detail: ((stderr || stdout) || ('exit ' + outcome.exitCode)).trim().slice(0, 500) }
        return { ok: true, stdout: stdout, stderr: stderr }
      } catch (e) { return { ok: false, detail: errMsg(e) } }
    }
    const rm = (path) => runNode(['-e', "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", path])

    // DSH Home：显式 DSH_HOME 是宿主事实，直接采用；vm 沙箱无 process 时经子进程探测一次。
    // #79：新 harness 对子进程环境剥离全部 DSH_* 变量（scrubbedParentEnv），探针子进程
    // 读不到 DSH_HOME 会误落到产品 ~/.dsh——探针沿祖先进程链 `ps eww` 读回真实
    // DSH_HOME（产品/开发 DSH 各自命中宿主进程自身环境），最后才回落 ~/.dsh。
    let dshHomePromise = null
    function dshHome() {
      if (!dshHomePromise) {
        dshHomePromise = (async () => {
          const env = (typeof process !== 'undefined' && process && process.env) || {}
          if (typeof env.DSH_HOME === 'string' && env.DSH_HOME) return env.DSH_HOME
          const probe = [
            "const cp=require('child_process'),path=require('path'),os=require('os');",
            "if (process.env.DSH_HOME) { console.log(process.env.DSH_HOME); process.exit(0); }",
            "function envOf(pid){try{return cp.execSync('ps eww '+pid+' 2>/dev/null',{encoding:'utf8'})}catch(e){return ''}}",
            "let pid=process.ppid;",
            "for (let i=0;i<8&&pid&&pid>1;i++){",
            "  const m=envOf(pid).match(/DSH_HOME=([^\\s]+)/);",
            "  if (m){console.log(m[1]);process.exit(0);}",
            "  try{pid=Number(cp.execSync('ps -o ppid= -p '+pid+' 2>/dev/null',{encoding:'utf8'}).trim());}catch(e){break;}",
            "}",
            "console.log(path.join(os.homedir(), '.dsh'));",
          ].join('')
          const r = await runNode(['-e', probe], { env: {} })
          if (r.ok && r.stdout.trim()) return r.stdout.trim()
          return typeof env.HOME === 'string' && env.HOME ? env.HOME.replace(/\/$/, '') + '/.dsh' : null
        })()
      }
      return dshHomePromise
    }
    // 宿主数据根下的固定目录（只算一次）
    let homeDirsPromise = null
    function homeDirs() {
      if (!homeDirsPromise) {
        homeDirsPromise = dshHome().then((home) => (home ? {
          home: home,
          userDir: home + '/visual-workflow/templates',
          removedDir: home + '/visual-workflow/removed',
          runsDir: home + '/visual-workflow/runs',
          // 逻辑运行摘要目录（#79）：<logical_run_id>.json 一任务一文件
          logicalRunsDir: home + '/visual-workflow/logical-runs',
          skillRoot: home + '/skills',
          workspaces: home + '/workspaces',
        } : null))
      }
      return homeDirsPromise
    }
    // 生成物根：项目 .generated（项目专属模板）→ 代码根 .generated（插件随附模板）
    function generatedRoots() {
      const out = []
      const project = projectRoot()
      if (project) out.push(project + '/.generated')
      if (CODE_ROOT && out.indexOf(CODE_ROOT + '/.generated') < 0) out.push(CODE_ROOT + '/.generated')
      return out
    }
    // ~/.dsh 写入不受会话 workspace-write 沙箱约束；fs 服务只认 mode === 'danger-full-access'
    function writePolicy() {
      if (sp && typeof sp.resolve === 'function') {
        try { return sp.resolve({ mode: 'danger-full-access' }) } catch (e) { /* fall through */ }
      }
      return { mode: 'danger-full-access', workspaceRoot: '/' }
    }
    const writeText = async (path, text) => fs.writeText(await fs.resolve(path), text, undefined, undefined, writePolicy())
    async function readTextIfExists(path) {
      if (fs === undefined) return null
      try {
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        return info && info.type === 'file' ? await fs.readText(target) : null
      } catch (e) { return null }
    }
    async function listDirOrNull(path) {
      if (fs === undefined) return null
      try { return await fs.listDir(await fs.resolve(path)) } catch (e) { return null }
    }
    async function fileExists(path) {
      if (fs === undefined) return false
      try { const info = await fs.stat(await fs.resolve(path)); return !!(info && info.type === 'file') } catch (e) { return false }
    }

    // ── 内核与资产加载：唯一来源 = 插件 dist/ ────────────────────────────────
    // 静态 bundle 可直接注入已加载模块（__VWF_KERNELS__，真 import，零 eval）；动态闭包
    // 无 import，经 fs 读源码求值。缺失即明确报错，不降级、不去别处找。
    const assetCache = new Map()
    function loadDist(file) {
      if (!assetCache.has(file)) {
        const pending = (async () => {
          const injected = (typeof __VWF_KERNELS__ === 'object' && __VWF_KERNELS__) ? __VWF_KERNELS__[file] : undefined
          if (injected !== undefined) return injected
          if (!DIST) throw new Error('插件根未注入：请使用 npm run build 产出的 dist 版本')
          if (fs === undefined) throw new Error('宿主文件能力不可用')
          const src = await fs.readText(await fs.resolve(DIST + '/' + file))
          if (/\.cjs$/.test(file)) {
            const module = { exports: {} }
            new Function('module', 'exports', src)(module, module.exports)
            return module.exports
          }
          return /\.json$/.test(file) ? JSON.parse(src) : src
        })().catch((e) => { assetCache.delete(file); throw new Error('插件资产不可用 dist/' + file + '：' + errMsg(e)) })
        assetCache.set(file, pending)
      }
      return assetCache.get(file)
    }
    const kernel = () => loadDist('validate-core.cjs')
    let roleLibraryPromise = null
    function roleLibrary() {
      if (!roleLibraryPromise) {
        roleLibraryPromise = Promise.all([loadDist('role-library.cjs'), loadDist('builtin-roles.json')])
          .then(([mod, manifest]) => mod.createRoleLibrary(manifest))
          .catch((e) => { roleLibraryPromise = null; throw e })
      }
      return roleLibraryPromise
    }

    // ── 模板存储：生成物（只读；历史两套已迁为自定义）+ 用户目录 ─────────────────
    const LEGACY_CUSTOM_IDS = { 'default-workflow': true, 'dev-workflow-2-0': true }
    const isLegacyCustomId = (id) => !!LEGACY_CUSTOM_IDS[id]

    // strict=true：清单/单文件读取失败即抛出（角色引用统计等破坏性前置不得把失败当空清单）
    async function loadGenerated(strict) {
      const out = new Map()
      if (fs === undefined) {
        if (strict) throw new Error('宿主文件能力不可用：无法扫描内置模板')
        return out
      }
      for (const root of generatedRoots()) {
        let entries = null
        try { entries = await fs.listDir(await fs.resolve(root)) } catch (e) {
          if (strict && !isMissingErr(e)) throw new Error('内置模板清单读取失败：' + errMsg(e))
          continue
        }
        for (const ent of entries || []) {
          if (!ent || typeof ent.name !== 'string' || !ent.name) continue
          try {
            const target = await fs.resolve(root + '/' + ent.name + '/vwf-dsl.json')
            const info = await fs.stat(target)
            if (!info || info.type !== 'file') continue
            const dsl = JSON.parse(await fs.readText(target))
            if (dsl && typeof dsl.id === 'string' && dsl.id && !out.has(dsl.id)) out.set(dsl.id, dsl)
          } catch (e) {
            if (strict) throw new Error('内置模板读取失败：' + errMsg(e))
          }
        }
      }
      return out
    }
    async function splitGenerated(strict) {
      const builtins = new Map()
      const shipped = new Map()
      for (const [id, dsl] of await loadGenerated(strict)) (isLegacyCustomId(id) ? shipped : builtins).set(id, dsl)
      return { builtins, shipped }
    }
    async function loadRemovedIds() {
      const out = new Set()
      const d = fs === undefined ? null : await homeDirs()
      const entries = d ? await listDirOrNull(d.removedDir) : null
      for (const ent of entries || []) if (ent && typeof ent.name === 'string' && ent.name) out.add(ent.name)
      return out
    }
    async function loadUserTemplates(strict) {
      const out = new Map()
      if (fs === undefined) {
        if (strict) throw new Error('宿主文件能力不可用：无法扫描用户模板')
        return out
      }
      const d = await homeDirs()
      if (!d) {
        if (strict) throw new Error('无法解析用户模板目录')
        return out
      }
      let entries = null
      try { entries = await fs.listDir(await fs.resolve(d.userDir)) } catch (e) {
        if (strict && !isMissingErr(e)) throw new Error('用户模板清单读取失败：' + errMsg(e))
        return out
      }
      for (const ent of entries || []) {
        if (!ent || typeof ent.name !== 'string' || !/\.json$/i.test(ent.name)) continue
        try {
          const bp = JSON.parse(await fs.readText(ent.target))
          if (bp && typeof bp.id === 'string' && bp.id) out.set(bp.id, bp)
        } catch (e) {
          if (strict) throw new Error('用户模板读取失败：' + errMsg(e))
        }
      }
      return out
    }
    // 查找：用户覆盖 → 未删除的历史生成物 → 正式内置
    async function findWorkflow(id) {
      if (!id || typeof id !== 'string') return null
      const bp = (await loadUserTemplates()).get(id)
      if (bp) return (await kernel()).projectToVwf(bp)
      if ((await loadRemovedIds()).has(id)) return null
      const { builtins, shipped } = await splitGenerated()
      return shipped.get(id) || builtins.get(id) || null
    }
    // 合并三源为清单条目；同 id 用户覆盖优先，已删除标记的历史 id 不再列出
    async function workflowEntries(strict) {
      const [{ builtins, shipped }, users, removed, core] = await Promise.all([splitGenerated(strict), loadUserTemplates(strict), loadRemovedIds(), kernel()])
      const out = []
      const seen = new Set()
      const push = (dsl, name, builtin) => { seen.add(dsl.id); out.push({ id: dsl.id, name: name, description: dsl.description || '', builtin: builtin, dsl: dsl }) }
      for (const dsl of builtins.values()) push(dsl, dsl.name, true)
      for (const bp of users.values()) if (!seen.has(bp.id)) push(core.projectToVwf(bp), bp.displayName, false)
      for (const dsl of shipped.values()) if (!seen.has(dsl.id) && !removed.has(dsl.id)) push(dsl, dsl.name, false)
      return out
    }
    async function listWorkflows() {
      return (await workflowEntries()).sort((a, b) => (a.builtin === b.builtin ? byId(a.id, b.id) : a.builtin ? -1 : 1))
    }

    // ── 校验管道：sanitize（DSL 形态归一）→ 逆投影蓝图 → 内核 validateBlueprint ──
    // JSON tab / wf_run 可能直接传蓝图落盘格式（displayName / bindings.models）：先投影为 DSL
    function ingestToDsl(raw, core) {
      if (!raw || typeof raw !== 'object') return raw
      const hasBindings = !!(raw.bindings && raw.bindings.models && typeof raw.bindings.models === 'object' && Object.keys(raw.bindings.models).length)
      if (typeof raw.displayName !== 'string' && !hasBindings) return raw
      if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return raw
      return core.projectToVwf({ ...raw, displayName: typeof raw.displayName === 'string' ? raw.displayName : (raw.name || raw.id || '') })
    }
    // 保存前清洗：entry 依拓扑归一、failure 边剔除 when、maxRounds 取整
    function sanitizeDsl(dsl, core) {
      const next = JSON.parse(JSON.stringify(dsl || {}))
      next.edges = Array.isArray(next.edges) ? next.edges : []
      next.nodes = Array.isArray(next.nodes) ? next.nodes : []
      const candidates = core.deriveEntryCandidates(next.nodes, next.edges)
      next.entry = candidates.length === 1 ? candidates[0] : (next.entry || '')
      next.edges = next.edges.map((e) => {
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
    // 返回 { ok, errors, fieldErrors, sanitized, warnings }；错误 { at, message, fieldKey? }
    // （lossless-JSON 守卫：可选键仅在有值时携带，sanitized 早退时显式 null）
    async function validatePipeline(input) {
      const bad = (message) => ({ ok: false, errors: [{ at: '$', message: message }], fieldErrors: {}, sanitized: null, warnings: [] })
      let core
      try { core = await kernel() } catch (e) { return bad('校验内核不可用：' + errMsg(e)) }
      const dsl = ingestToDsl(input, core)
      if (!dsl || typeof dsl !== 'object') return bad('dsl 必须是对象')
      const errors = []
      const fieldErrors = {}
      // 内核只产出 fieldKey（逐字段标红）与坐标串；编辑器「关闭弹窗后定位首个问题」
      // 还需要 nodeId / edgeIndex 才能选中节点/边并滚动过去（LOC-001 §5「定位到该边字段」）。
      // 坐标串是唯一事实源：从 `at` 反解，不额外引入第二套坐标。
      const locateOf = (at) => {
        if (typeof at !== 'string') return null
        const node = /^\$\.nodes\[([^\]]+)\]/.exec(at)
        if (node) return { nodeId: node[1] }
        const edge = /^\$\.edges\[(\d+)\]/.exec(at)
        if (edge) return { edgeIndex: Number(edge[1]) }
        return null
      }
      const push = (e) => {
        const entry = { at: e.at, message: e.message }
        if (e.fieldKey !== undefined) entry.fieldKey = e.fieldKey
        const loc = locateOf(e.at)
        if (loc) {
          if (loc.nodeId !== undefined) entry.nodeId = loc.nodeId
          if (loc.edgeIndex !== undefined) entry.edgeIndex = loc.edgeIndex
        }
        errors.push(entry)
        if (entry.fieldKey !== undefined) (fieldErrors[entry.fieldKey] = fieldErrors[entry.fieldKey] || []).push(e.message)
      }
      // 原始边预检：failure 边带 when 必须报错（sanitize 会剔除 when，须在清洗前拦截）
      ;(Array.isArray(dsl.edges) ? dsl.edges : []).forEach((e, i) => {
        if (e && e.when !== undefined && e.on !== 'success') push({ at: '$.edges[' + i + '].when', message: 'when 只允许用于 success 边', fieldKey: 'edge:' + i + ':when' })
      })
      const sanitized = sanitizeDsl(dsl, core)
      const v = core.validateBlueprint(core.projectToBlueprint(sanitized), { requireModels: true })
      for (const e of v.errors || []) push(e)
      return { ok: v.ok && errors.length === 0, errors, fieldErrors, sanitized, warnings: v.warnings || [] }
    }

    // ── 编译：单一编译器 = scripts/generate.mjs compileBlueprint ─────────────────
    // 模板来源（wf_run templateId）读磁盘产物：用户 skill 闭环产物 → 项目/代码根 .generated；
    // 其余（编辑器当前图、wf_run 临时图）把蓝图作为参数交给 CLI 编译——编辑中未保存的
    // 改动必须反映在脚本里，不能拿磁盘上的旧产物充数。
    const metaFromDsl = (dsl) => ({ name: 'vwf-' + (dsl.id || 'run'), description: dsl.name || dsl.id || 'visual workflow run', phases: (dsl.nodes || []).map((n) => ({ title: n.label || n.id })) })
    async function compileDsl(dsl, opts) {
      const d = await homeDirs()
      if (opts && opts.fromTemplate && d) {
        for (const spot of [d.skillRoot].concat(generatedRoots())) {
          const script = await readTextIfExists(spot + '/' + dsl.id + '/script.mjs')
          if (script === null) continue
          const out = { ok: true, script: script, meta: metaFromDsl(dsl) }
          // bundleRoles 模板产物旁带 roles/ 自包含角色包，命中则随译文返回 roleDir
          const roles = await listDirOrNull(spot + '/' + dsl.id + '/roles')
          if (roles && roles.length) out.roleDir = spot + '/' + dsl.id + '/roles'
          return out
        }
      }
      if (subprocess === undefined || !GENERATOR) return { ok: false, detail: '宿主子进程能力不可用或插件根未注入：无法编译（模板来源请先运行 npm run generate 或经保存闭环）' }
      const bp = JSON.stringify((await kernel()).projectToBlueprint(dsl))
      if (bp.length > 120 * 1024) return { ok: false, detail: '蓝图过大（超过 120KB），无法作为编译参数传递' }
      // 编译输出上限 1MB：全内置角色内联的图约 66KB，默认 64KB 会静默截断
      const r = await runNode([GENERATOR, 'compile', '--inline', bp], { graceMs: 30000, maxBytes: 1024 * 1024 })
      if (!r.ok) return { ok: false, detail: r.detail }
      try {
        const out = JSON.parse(r.stdout)
        if (!out.ok) return { ok: false, detail: '编译器返回错误：' + (out.error || '未知') }
        return { ok: true, script: out.script, meta: out.meta || metaFromDsl(dsl) }
      } catch (e) { return { ok: false, detail: '编译器输出不可解析：' + errMsg(e) } }
    }

    // ── 运行记录：内存与磁盘同一结构，全部常驻内存 ────────────────────────────────
    // 落盘 ~/.dsh/visual-workflow/runs/<encodeURIComponent(runId)>.json，启动时全量回载，
    // 超过 RUNS_RETAIN 淘汰最旧（占用任务的记录不淘汰）。live 集合 = 本进程内执行中的 run；
    // 重启后回载的 running 记录不在 live 中，因而不再占用其 taskId。
    const RUNS_RETAIN = 50
    const TERMINAL_STATUS_RE = /^(DONE|STOPPED|WAITING_HUMAN|AWAITING_HUMAN_.+|FAILED_AT_.+|FAILED_MAX_ROUNDS|FAILED_ITEM_CAP|FAILED_AGENT_CAP|TECHNICAL_FAILURE|ENDED_NO_SUCCESS_EDGE|ENDED_NO_FAILURE_EDGE|ENDED_NO_OUTCOME_EDGE|ROUTE_HALTED|ERROR)$/
    const HD_STRING_KEYS = ['decision_id', 'reason', 'node']
    const HD_NUMBER_KEYS = ['round', 'budgetUsed', 'maxRounds', 'decisionSeq']
    const HD_OBJECT_KEYS = ['decision_package', 'control_event', 'blocked_edge', 'results']
    const runs = new Map()
    const runFiles = new Map()
    const live = new Set()
    const runFile = (id) => runFiles.get(id) || (encodeURIComponent(String(id)) + '.json')
    const isHumanWait = (s) => s === 'WAITING_HUMAN' || String(s || '').indexOf('AWAITING_HUMAN_') === 0
    // workflow/end 只有 completed，可能在 wf_run 回写 WAITING_HUMAN 之后到达把等待态盖掉；
    // 此时仍靠 decision_id + Package 识别可续跑的停机记录
    const isParkedHd = (rec) => !!rec && (rec.status === 'WAITING_HUMAN' || (rec.status === 'completed' && !!rec.decision_id && !!rec.decision_package && typeof rec.decision_package === 'object'))
    const holdsTask = (rec) => !!rec && !rec.supersededBy && (live.has(rec.id) || isHumanWait(rec.status) || isParkedHd(rec))
    const runTs = (rec) => rec.updatedAt || rec.startedAt || 0

    function newRecord(id) {
      return {
        id: String(id), meta: { name: '', description: '' }, status: 'running', phase: '', logs: [], agents: [], formalRecords: [],
        taskId: '', workflowId: '', startedAt: Date.now(), supersededBy: '',
        decision_id: '', reason: '', decision_package: null, control_event: null, blocked_edge: null, results: null, history: null,
        node: '', round: null, budgetUsed: null, maxRounds: null, decisionSeq: null, updatedAt: 0,
      }
    }
    function ensureRun(id) {
      let rec = runs.get(String(id))
      if (!rec) { rec = newRecord(id); runs.set(rec.id, rec) }
      return rec
    }
    function fromDisk(data) {
      const rec = newRecord(data.id)
      for (const k of Object.keys(rec)) if (data[k] !== undefined && data[k] !== null) rec[k] = data[k]
      rec.meta = { name: String((data.meta && data.meta.name) || ''), description: String((data.meta && data.meta.description) || '') }
      rec.status = typeof data.status === 'string' && data.status ? data.status : 'unknown'
      rec.logs = Array.isArray(rec.logs) ? rec.logs.map(String).slice(-50) : []
      rec.agents = Array.isArray(rec.agents) ? rec.agents.filter((a) => a && typeof a === 'object') : []
      rec.formalRecords = Array.isArray(rec.formalRecords) ? rec.formalRecords : []
      return rec
    }
    function applyHdValue(rec, val) {
      if (!val || typeof val !== 'object') return
      for (const k of HD_STRING_KEYS) if (typeof val[k] === 'string' && val[k]) rec[k] = val[k]
      for (const k of HD_NUMBER_KEYS) if (typeof val[k] === 'number') rec[k] = val[k]
      for (const k of HD_OBJECT_KEYS) if (val[k] && typeof val[k] === 'object') rec[k] = val[k]
      if (Array.isArray(val.history)) rec.history = val.history
    }
    const summary = (rec) => ({ id: rec.id, name: rec.meta.name, status: rec.status, phase: rec.phase, taskId: rec.taskId, workflowId: rec.workflowId, startedAt: rec.startedAt, supersededBy: rec.supersededBy, decision_id: rec.decision_id, reason: rec.reason })

    // 无定时器节流：每个 run 至多一个飞行中写入，期间变更只置 dirty，写完按最新态补一次尾写
    const writeQueues = new Map()
    function persist(runId) {
      const id = String(runId || '')
      if (!id) return
      let q = writeQueues.get(id)
      if (!q) { q = { dirty: false, pending: false }; writeQueues.set(id, q) }
      q.dirty = true
      if (!q.pending) drainWrite(id, q)
    }
    function drainWrite(id, q) {
      if (!q.dirty) { writeQueues.delete(id); return }
      q.dirty = false
      q.pending = true
      writeRun(id)
        .catch((e) => log('运行记录落盘失败（不影响运行）：' + id + '：' + errMsg(e)))
        .then(() => { q.pending = false; drainWrite(id, q); evictSoon() })
    }
    async function writeRun(id) {
      const rec = runs.get(id)
      const d = fs === undefined ? null : await homeDirs()
      if (!rec || !d) return
      rec.updatedAt = Date.now()
      await writeText(d.runsDir + '/' + runFile(id), JSON.stringify(rec, null, 2) + '\n')
    }
    let evictChain = Promise.resolve()
    let evictWarned = false
    function evictSoon() { evictChain = evictChain.then(evictRuns).catch((e) => log('运行记录淘汰失败（不影响运行）：' + errMsg(e))) }
    async function evictRuns() {
      const d = fs === undefined ? null : await homeDirs()
      if (!d || runs.size <= RUNS_RETAIN) return
      if (subprocess === undefined) {
        if (!evictWarned) { evictWarned = true; log('subprocess 服务不可用：运行记录淘汰暂停（' + runs.size + ' 条超过上限 ' + RUNS_RETAIN + '）') }
        return
      }
      const ordered = Array.from(runs.values()).sort((a, b) => (runTs(a) - runTs(b)) || byId(a.id, b.id))
      for (const rec of ordered.slice(0, ordered.length - RUNS_RETAIN)) {
        if (holdsTask(rec)) continue
        const r = await rm(d.runsDir + '/' + runFile(rec.id))
        if (r.ok) { runs.delete(rec.id); runFiles.delete(rec.id) } else log('运行记录淘汰删除失败：' + rec.id + '：' + r.detail)
      }
    }
    async function loadRuns() {
      for (let attempt = 0; attempt < 10 && fs === undefined; attempt++) {
        refreshServices()
        if (fs !== undefined) break
        // 动态会话 vm 沙箱没有真定时器（调用会被拦截）：无定时器则放弃重试
        try { await new Promise((r) => setTimeout(r, 100 * (attempt + 1))) } catch (e) { break }
      }
      if (fs === undefined) { log('fs 服务不可用，运行记录未回载'); return }
      const d = await homeDirs()
      const entries = d ? await listDirOrNull(d.runsDir) : null
      for (const ent of entries || []) {
        if (!ent || ent.type !== 'file' || !/\.json$/i.test(ent.name)) continue
        try {
          const data = JSON.parse(await fs.readText(await fs.resolve(d.runsDir + '/' + ent.name)))
          if (!data || typeof data.id !== 'string' || !data.id) throw new Error('缺少 id 字段')
          if (runs.has(data.id)) continue
          runs.set(data.id, fromDisk(data))
          runFiles.set(data.id, ent.name)
        } catch (e) { log('跳过损坏的运行记录：' + ent.name + '（' + errMsg(e) + '）') }
      }
      evictSoon()
    }
    const runsHydration = loadRuns().catch((e) => log('运行记录回载失败：' + errMsg(e)))

    // ── Logical Run 逻辑运行摘要（#79）────────────────────────────────────
    // 一次任务 = 一个逻辑运行：人工恢复/暂停/受阻/模型切换都发生在同一次运行内，
    // 形成"第 N 段执行"，不产生新的用户级 Run。固定八态 Lifecycle（仅后三者为终态）
    // + 结构化 reason；运行创建时冻结快照 Rev 1，v0.1 运行中仅可更换 Provider/Model
    // 并产生追加式修订（旧修订永不覆盖）。新语义只写运行摘要（logical-runs 目录），
    // 既有 runs/ 事件流记录语义零改动（#87 锁定）。持久化同构 runs 记录（节流写队列/
    // 启动全量回载）；摘要是追溯档案单元，不做容量淘汰。
    const LIFECYCLE_STATES = ['READY', 'RUNNING', 'WAITING_HUMAN', 'PAUSED', 'BLOCKED', 'COMPLETED', 'STOPPED', 'FAILED']
    const LIFECYCLE_TERMINAL = ['COMPLETED', 'STOPPED', 'FAILED']
    const LOGICAL_RUN_SCHEMA = 1
    const logicalRuns = new Map()           // logical_run_id → 摘要对象（启动全量回载，追溯档案）
    const logicalRunByEngineRun = new Map() // 引擎运行 id → logical_run_id（段反查，看板 join 用）

    const logicalRunFile = (id) => encodeURIComponent(String(id || '')) + '.json'
    const logicalReason = (code, message) => {
      const r = { code: String(code || 'UNSPECIFIED') }
      if (message !== undefined && message !== null && String(message) !== '') r.message = String(message)
      return r
    }
    function newLogicalRecord(info) {
      const now = Date.now()
      const providerModel = {}
      for (const n of (info.dsl && info.dsl.nodes) || []) {
        if (n && n.model && (n.model.provider || n.model.model)) {
          providerModel[n.id] = { provider: String(n.model.provider || 'default'), model: String(n.model.model || 'default') }
        }
      }
      const rec = {
        logical_run_id: String(info.logical_run_id),
        schema: LOGICAL_RUN_SCHEMA,
        task_id: String(info.taskId || ''),
        template_id: String(info.templateId || ''),
        title: String((info.dsl && info.dsl.name) || info.templateId || ''),
        derived_from: info.derivedFrom ? String(info.derivedFrom) : null,
        created_at: now,
        updated_at: now,
        lifecycle: { state: 'READY', reason: null },
        terminal: false,
        completion: null,
        segments: [],
        snapshots: [],
        node_attempts: [],
        business_outcomes: {},
        workspace: null,
      }
      // Rev 1 冻结：工作流定义 + 角色（编译产物内联角色正文与路由）+ Provider/Model
      // 绑定 + 运行关键配置。修订仅 Provider/Model，不改脚本，故后续修订以 script_ref
      // 指向 Rev 1，不再复制。
      rec.snapshots.push({
        revision: 1,
        created_at: now,
        active: true,
        workflow: { id: String((info.dsl && info.dsl.id) || info.templateId || ''), name: String((info.dsl && info.dsl.name) || ''), dsl: info.dsl || null },
        roles: { role_dir: String(info.roleDir || '') },
        script: info.script || null,
        provider_model: providerModel,
        config: info.config || {},
      })
      return rec
    }
    function createLogicalRun(info) {
      const rec = newLogicalRecord(info)
      logicalRuns.set(rec.logical_run_id, rec)
      requestLogicalPersist(rec.logical_run_id)
      return rec
    }
    function activeSnapshot(rec) {
      for (const s of rec.snapshots) if (s.active) return s
      return rec.snapshots[rec.snapshots.length - 1] || null
    }
    // 仅 Provider/Model 可改（R3）：追加修订，旧修订 active 翻转保留，不无痕覆盖。
    // 合并语义与编译脚本一致：显式节点覆盖优先，$default 只作用于未显式覆盖的节点。
    function appendSnapshotRevision(rec, overrides) {
      const prev = activeSnapshot(rec)
      if (!prev) return null
      const ov = (overrides && typeof overrides === 'object') ? overrides : {}
      const def = (ov.$default && typeof ov.$default === 'object') ? ov.$default : null
      const merged = {}
      for (const k of Object.keys(prev.provider_model || {})) {
        const cur = prev.provider_model[k] || {}
        const o = (ov[k] && typeof ov[k] === 'object') ? ov[k] : def
        merged[k] = {
          provider: (o && o.provider !== undefined && o.provider !== '') ? String(o.provider) : String(cur.provider || 'default'),
          model: (o && o.model !== undefined && o.model !== '') ? String(o.model) : String(cur.model || 'default'),
        }
      }
      const now = Date.now()
      prev.active = false
      const next = {
        revision: prev.revision + 1,
        created_at: now,
        active: true,
        workflow: prev.workflow,
        roles: prev.roles,
        script_ref: 1,
        provider_model: merged,
        config: prev.config,
      }
      rec.snapshots.push(next)
      rec.updated_at = now
      return next
    }
    function effectiveProviderModel(rec, nodeId) {
      const snap = activeSnapshot(rec)
      const pm = (snap && snap.provider_model) || {}
      return pm[nodeId] || null
    }
    function logicalSetState(rec, state, reason) {
      if (LIFECYCLE_STATES.indexOf(state) < 0) return false
      rec.lifecycle = { state: state, reason: reason || null }
      rec.terminal = LIFECYCLE_TERMINAL.indexOf(state) >= 0
      rec.updated_at = Date.now()
      return true
    }
    function appendLogicalSegment(rec, runId, trigger, decisionId) {
      const seg = {
        index: rec.segments.length + 1,
        run_id: String(runId),
        trigger: String(trigger || 'start'),
        started_at: Date.now(),
        ended_at: null,
        status: 'running',
        active: true,
      }
      if (decisionId) seg.decision_id = String(decisionId)
      for (const s of rec.segments) s.active = false
      rec.segments.push(seg)
      logicalRunByEngineRun.set(String(runId), rec.logical_run_id)
      rec.updated_at = Date.now()
      return seg
    }
    function endLogicalSegment(rec, runId, status) {
      const seg = rec.segments.find((s) => s.run_id === String(runId)) || null
      if (!seg) return null
      seg.status = String(status || '')
      seg.ended_at = Date.now()
      seg.active = false
      rec.updated_at = Date.now()
      return seg
    }
    // 段收尾 → 八态 Lifecycle + 结构化 reason（R1/R6/R11）。引擎段状态原样保留在
    // segment.status；Lifecycle 闸门不改写专业结果（R7）——业务结果由
    // recordNodeAttempts 独立落档，不参与状态映射。
    function logicalTransitionFor(canon, stopReason, value) {
      const v = value && typeof value === 'object' ? value : {}
      const reasonFromValue = typeof v.reason === 'string' && v.reason ? logicalReason(v.reason) : null
      if (canon === 'DONE') return { state: 'COMPLETED', reason: null }
      if (canon === 'STOPPED') return { state: 'STOPPED', reason: reasonFromValue || logicalReason('STOPPED') }
      if (canon === 'WAITING_HUMAN') return { state: 'WAITING_HUMAN', reason: reasonFromValue || logicalReason('ESCALATED_DECISION') }
      if (canon.indexOf('AWAITING_HUMAN_') === 0) return { state: 'WAITING_HUMAN', reason: logicalReason('LEGACY_GATE', canon) }
      if (canon === 'ROUTE_HALTED') return { state: 'WAITING_HUMAN', reason: reasonFromValue || logicalReason('ROUTE_HALTED') }
      if (canon) return { state: 'FAILED', reason: logicalReason('RUN_FAILED', canon) }
      if (stopReason === 'cancelled') return { state: 'FAILED', reason: logicalReason('ENGINE_CANCELLED') }
      if (stopReason === 'error') return { state: 'FAILED', reason: logicalReason('ENGINE_ERROR') }
      return null
    }
    // 业务结果提取：新模式 outcomePath/completionPath（$.x.y 语法）；旧模式无声明
    // 不编造。control_event.triggering_node_outcome 兜底（额度耗尽时触发节点）。
    function readOutcomePath(obj, path) {
      const raw = String(path || '')
      const keys = (raw.indexOf('$.') === 0 ? raw.slice(2) : raw).split('.').filter(Boolean)
      let cur = obj
      for (const k of keys) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = cur[k]
      }
      return cur
    }
    function outcomePathOf(dsl, nodeId) {
      const node = ((dsl && dsl.nodes) || []).find((n) => n && n.id === nodeId) || null
      return (node && node.output && (node.output.outcomePath || node.output.completionPath)) || null
    }
    // 段内新完成节点（段末 results − 段首 results）→ node_attempts 记录当时实际
    // Snapshot Revision / Provider / Model（段内修订冻结，逐节点准确）+ 声明了业务
    // 结果路径的节点入 business_outcomes（与 Lifecycle 分别持久化）。
    function recordNodeAttempts(rec, dsl, beforeKeys, results, controlEvent) {
      const snap = activeSnapshot(rec)
      const segNo = rec.segments.length
      let added = 0
      for (const nodeId of Object.keys(results || {})) {
        if (beforeKeys && beforeKeys.has(nodeId)) continue
        const r = results[nodeId]
        if (r == null || typeof r !== 'object') continue
        const eff = effectiveProviderModel(rec, nodeId)
        const path = outcomePathOf(dsl, nodeId)
        let outcome = path !== null ? readOutcomePath(r, path) : undefined
        if (outcome === undefined && controlEvent && controlEvent.node_id === nodeId && controlEvent.triggering_node_outcome !== undefined) {
          outcome = controlEvent.triggering_node_outcome
        }
        const attempt = {
          node: String(nodeId),
          segment: segNo,
          snapshot_revision: snap ? snap.revision : null,
          provider: String((eff && eff.provider) || 'default'),
          model: String((eff && eff.model) || 'default'),
          outcome: outcome === undefined ? null : outcome,
          completed_at: Date.now(),
        }
        rec.node_attempts.push(attempt)
        if (outcome !== undefined && outcome !== null) {
          rec.business_outcomes[String(nodeId)] = {
            outcome: outcome,
            path: path,
            segment: segNo,
            snapshot_revision: attempt.snapshot_revision,
            at: attempt.completed_at,
          }
        }
        added++
      }
      if (added) rec.updated_at = Date.now()
      return added
    }
    function logicalRunPayload(rec) {
      return {
        logical_run_id: rec.logical_run_id,
        schema: LOGICAL_RUN_SCHEMA,
        task_id: rec.task_id,
        template_id: rec.template_id,
        title: rec.title,
        derived_from: rec.derived_from,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        lifecycle: { state: rec.lifecycle.state, reason: rec.lifecycle.reason },
        terminal: rec.terminal === true,
        completion: rec.completion || null,
        segments: rec.segments.map((s) => {
          const out = { index: s.index, run_id: s.run_id, trigger: s.trigger, started_at: s.started_at, ended_at: s.ended_at, status: s.status, active: s.active === true }
          if (s.decision_id) out.decision_id = s.decision_id
          return out
        }),
        snapshots: rec.snapshots,
        node_attempts: rec.node_attempts,
        business_outcomes: rec.business_outcomes,
        workspace: rec.workspace || null,
      }
    }
    const logicalWriteQueues = new Map()
    function requestLogicalPersist(id) {
      const key = String(id || '')
      if (!key) return
      let q = logicalWriteQueues.get(key)
      if (!q) { q = { dirty: false, pending: false }; logicalWriteQueues.set(key, q) }
      q.dirty = true
      if (!q.pending) drainLogicalWrite(key, q)
    }
    function drainLogicalWrite(key, q) {
      if (!q.dirty) { logicalWriteQueues.delete(key); return }
      q.dirty = false
      q.pending = true
      writeLogicalRun(key)
        .catch((e) => log('逻辑运行摘要落盘失败（不影响运行）：' + key + '：' + errMsg(e)))
        .then(() => { q.pending = false; drainLogicalWrite(key, q) })
    }
    async function writeLogicalRun(id) {
      const rec = logicalRuns.get(id)
      const d = fs === undefined ? null : await homeDirs()
      if (!rec || !d) return
      rec.updated_at = Date.now()
      await writeText(d.logicalRunsDir + '/' + logicalRunFile(id), JSON.stringify(logicalRunPayload(rec), null, 2) + '\n')
    }
    function hydrateLogicalRunFromDisk(data) {
      if (!data || typeof data !== 'object') return false
      const id = typeof data.logical_run_id === 'string' && data.logical_run_id ? data.logical_run_id : null
      if (!id || logicalRuns.has(id)) return false
      const lc = data.lifecycle && LIFECYCLE_STATES.indexOf(data.lifecycle.state) >= 0
        ? { state: data.lifecycle.state, reason: data.lifecycle.reason || null }
        : { state: 'FAILED', reason: logicalReason('RECORD_CORRUPTED', 'lifecycle 缺失或非法') }
      const rec = {
        logical_run_id: id,
        schema: typeof data.schema === 'number' ? data.schema : LOGICAL_RUN_SCHEMA,
        task_id: typeof data.task_id === 'string' ? data.task_id : '',
        template_id: typeof data.template_id === 'string' ? data.template_id : '',
        title: typeof data.title === 'string' ? data.title : '',
        derived_from: typeof data.derived_from === 'string' ? data.derived_from : null,
        created_at: typeof data.created_at === 'number' ? data.created_at : null,
        updated_at: typeof data.updated_at === 'number' ? data.updated_at : null,
        lifecycle: lc,
        terminal: data.terminal === true || LIFECYCLE_TERMINAL.indexOf(lc.state) >= 0,
        completion: data.completion && typeof data.completion === 'object' ? data.completion : null,
        segments: Array.isArray(data.segments) ? data.segments.filter((s) => s && typeof s === 'object' && typeof s.run_id === 'string' && s.run_id) : [],
        snapshots: Array.isArray(data.snapshots) ? data.snapshots.filter((s) => s && typeof s === 'object') : [],
        node_attempts: Array.isArray(data.node_attempts) ? data.node_attempts.filter((s) => s && typeof s === 'object') : [],
        business_outcomes: data.business_outcomes && typeof data.business_outcomes === 'object' && !Array.isArray(data.business_outcomes) ? data.business_outcomes : {},
        workspace: data.workspace && typeof data.workspace === 'object' ? data.workspace : null,
      }
      logicalRuns.set(id, rec)
      for (const s of rec.segments) if (s.run_id) logicalRunByEngineRun.set(s.run_id, id)
      return true
    }
    async function loadLogicalRuns() {
      for (let attempt = 0; attempt < 10 && fs === undefined; attempt++) {
        refreshServices()
        if (fs !== undefined) break
        try { await new Promise((r) => setTimeout(r, 100 * (attempt + 1))) } catch (e) { break }
      }
      if (fs === undefined) return
      const d = await homeDirs()
      const entries = d ? await listDirOrNull(d.logicalRunsDir) : null
      const loaded = []
      for (const ent of entries || []) {
        if (!ent || ent.type !== 'file' || !/\.json$/i.test(ent.name)) continue
        try {
          const data = JSON.parse(await fs.readText(await fs.resolve(d.logicalRunsDir + '/' + ent.name)))
          if (!data || typeof data.logical_run_id !== 'string' || !data.logical_run_id) throw new Error('缺少 logical_run_id 字段')
          loaded.push(data)
        } catch (e) { log('跳过损坏的逻辑运行摘要：' + ent.name + '（' + errMsg(e) + '）') }
      }
      loaded.sort((a, b) => ((a.created_at || 0) - (b.created_at || 0)))
      for (const data of loaded) hydrateLogicalRunFromDisk(data)
    }
    const logicalRunsHydration = loadLogicalRuns().catch((e) => log('逻辑运行摘要回载失败：' + errMsg(e)))

    // #74 Runtime Preflight Probe（运行前模型可用性探针）────────────────
    // Static Validation 回答"配置是否合法"；Probe 回答"当前是否具备实际模型运行
    // 条件"：对去重后的 provider+model 做最小真实调用（不携带业务正文/角色 Prompt/
    // 产物，不评价回答质量）。探针降级（llm 服务无生成流能力）只如实标注，不伪装
    // available；BLOCKED 只用于探针明确失败（可恢复的外部问题）。
    // 缓存（审查 R1 阻断项修复）：宿主 llm 服务不暴露凭证可观察信号，无法检测
    // credential 变化——因此只保留 5s 去抖窗口（防一键检测连点）且只缓存全部可用
    // 的结果；失败结果永不缓存（修复凭证后立即重探立即生效）；Run Preflight 恒为
    // 真实探测（force）。「credential/context 变化即失效」由 5s 失效上界 + 失败不
    // 缓存共同保证。
    const PROBE_DEBOUNCE_MS = 5000
    const probeCache = new Map() // 指纹 → { at, results }；仅性能优化，重启即失效
    const probeOk = (r) => r.status === 'available'
    // 不阻断启动的探针结论：这些状态不表达"该绑定不可用"的事实，只是探针自身
    // 的局限（宿主无生成流能力 / 探针请求形态被宿主拒绝）。阻断只留给对绑定本身
    // 有结论的失败（配置缺失、鉴权、配额、不可达、模型不存在…），否则探针缺陷
    // 会变成"全量 BLOCKED"（UAT-02 教训）。
    const PROBE_NON_BLOCKING = new Set(['available', 'probe_degraded', 'probe_internal_error'])
    const probeBlocksStart = (r) => !PROBE_NON_BLOCKING.has(r.status)
    // sanitized DSL / 快照 provider_model → 去重绑定集合（provider+model 相同只探一次）
    function dedupeProbeBindings(nodeBindings) {
      const out = new Map()
      for (const [nodeId, pm] of Object.entries(nodeBindings || {})) {
        if (!pm || typeof pm !== 'object' || (!pm.provider && !pm.model)) continue
        const provider = String(pm.provider || 'default')
        const model = String(pm.model || 'default')
        const key = provider + '\u0000' + model
        let b = out.get(key)
        if (!b) { b = { key: key, provider: provider, model: model, nodes: [] }; out.set(key, b) }
        b.nodes.push(String(nodeId))
      }
      return Array.from(out.values())
    }
    function probeBindingsOfDsl(dsl) {
      const map = {}
      for (const n of (dsl && dsl.nodes) || []) if (n && n.id && n.model) map[String(n.id)] = n.model
      return dedupeProbeBindings(map)
    }
    // 绑定 → 配置事实（listProviders/listModels）：provider 是否注册、model 是否
    // 在已配置目录中。这不是可用性判定（目录成员资格是 advisory），而是"节点绑定
    // 指向的路由是否还存在"的判定：UAT-02 实测——已删除配置的 v4-pro/v4-flash 上游
    // 仍能应答，只有配置判定能识别它们"确实不可用"（用户口径：配置已删除即不可用）。
    // 目录读不到（listProviders 抛错 / listModels 抛错或返回空目录）一律按"无法判定"
    // 处理，退回真实探针结论，避免目录不完整造成新的误报。
    async function probeCatalog(llm, bindings) {
      let registered = null
      try {
        const list = (await Promise.resolve(llm.listProviders())) || []
        registered = new Set(list.map((p) => String((p && (p.id || p.provider || p.name)) || '')).filter(Boolean))
      } catch (e) { return null }
      const models = new Map()
      for (const b of bindings) {
        if (!registered.has(b.provider) || models.has(b.provider)) continue
        let set = null
        try {
          const list = (await Promise.resolve(llm.listModels(b.provider))) || []
          const ids = list.map((m) => String((m && (m.id || m.model || m.name)) || '')).filter(Boolean)
          set = ids.length ? new Set(ids) : null // 空目录视为未知，不据此判不可用
        } catch (e) { set = null }
        models.set(b.provider, set)
      }
      return { registered: registered, models: models }
    }
    // 配置判定结论（null = 无法判定/配置正常，交给真实探针）
    function classifyProbeBinding(catalog, binding) {
      if (!catalog) return null
      if (!catalog.registered.has(binding.provider)) {
        return {
          status: 'provider_not_configured',
          code: 'PROVIDER_NOT_CONFIGURED',
          message: 'Provider「' + binding.provider + '」当前未配置（可能已删除或改名）：请检查该节点的模型绑定。',
        }
      }
      const models = catalog.models.get(binding.provider)
      if (models && !models.has(binding.model)) {
        return {
          status: 'model_not_configured',
          code: 'MODEL_NOT_CONFIGURED',
          message: '模型「' + binding.model + '」不在 Provider「' + binding.provider + '」当前已配置的模型目录中（可能已删除或改名）：请重新选择该节点的模型。',
        }
      }
      return null
    }
    // 探针上下文指纹：绑定列表 + llm provider 目录。目录变化（增删 provider/模型，
    // 即 credential/context 变化的可观察事实）即换指纹，缓存失效。
    async function probeFingerprint(llm, bindings) {
      let catalog = 'catalog-error'
      try {
        const providers = (await Promise.resolve(llm.listProviders())) || []
        catalog = providers.map((p) => String((p && (p.id || p.provider || p.name)) || '')).filter(Boolean).sort().join(',')
      } catch (e) { /* 目录不可读不阻断探针，指纹退化为绑定列表 */ catalog = 'catalog-error' }
      return bindings.map((b) => b.key).sort().join('|') + '#' + catalog
    }
    // 错误安全清洗：剥离常见凭证/密钥形态，限长；只用于展示，不参与路由解析
    function sanitizeProbeMessage(raw) {
      let t = String(raw == null ? '' : raw)
      t = t.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
      t = t.replace(/Bearer\s+[A-Za-z0-9._~+/-]{6,}/gi, 'Bearer ***')
      t = t.replace(/(api[-_]?key|token|password)["'=:\s]+[A-Za-z0-9._~+/-]{6,}/gi, '$1 ***')
      t = t.replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
      t = t.replace(/eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){1,2}/g, 'jwt-***')
      t = t.replace(/\b[0-9a-f]{24,}\b/gi, '***')
      return t.slice(0, 300)
    }
    // 宿主 LlmError.code（provider-neutral）+ HTTP status → 七类探针结论。
    // 码表覆盖两套事实源：dsh 宿主 llm 运行时（QUOTA/TIMEOUT/UNKNOWN_MODEL/
    // TRANSPORT/SERVER/NO_ADAPTER/HTTP_N…）与仓内适配器（NETWORK/PROVIDER…），
    // status 作兜底维度（402 配额 / 404 模型不存在 / 5xx 不可达）。
    function classifyProbeFailure(err) {
      const code = String((err && err.code) || '').toUpperCase()
      const status = (err && err.failure && typeof err.failure.status === 'number') ? err.failure.status : null
      const message = sanitizeProbeMessage((err && err.message) || err)
      if (code === 'AUTH') return { status: status === 403 ? 'permission_denied' : 'auth_failed', code: code || 'AUTH', message: message }
      // 配额判定含中文 Provider 文案（UAT-01 实测：zai 429 + 「余额不足或无可用资源包」），
      // 须先于 RATE_LIMIT——同一 429 在余额耗尽时应报 quota 而非 rate_limit
      if (code === 'QUOTA' || code === 'QUOTA_EXCEEDED' || status === 402 || /余额不足|无可用资源包|请充值|usage[\s_-]*limit[\s_-]*(has\s*)?been[\s_-]*reached|insufficient/i.test(message)) return { status: 'quota', code: code || 'QUOTA', message: message }
      if (code === 'RATE_LIMIT') return { status: 'rate_limit', code: code, message: message }
      if (code === 'TIMEOUT' || code === 'ABORTED') return { status: 'timeout', code: code || 'TIMEOUT', message: message }
      if (code === 'UNKNOWN_MODEL' || code === 'HTTP_404' || code === 'HTTP_403' || code === 'CONTEXT_WINDOW_EXCEEDED' || status === 404) return { status: 'model_unavailable', code: code || 'HTTP_404', message: message }
      if (code === 'NO_ADAPTER' || code === 'NETWORK' || code === 'TRANSPORT' || code === 'SERVER' || code === 'HTTP_5XX' || (status !== null && status >= 500)) return { status: 'provider_unreachable', code: code, message: message }
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|network/i.test(message)) return { status: 'provider_unreachable', code: code || 'TRANSPORT', message: message }
      // 探针自身请求形态 / 宿主内部脚本异常（不是 Provider 的结论）：单独成类，
      // 否则探针缺陷会被伪装成"其他 Provider 错误"，把误报指向 Provider（UAT-02
      // 实测：content.some is not a function 曾被报成 provider_error）。此类不阻断启动。
      if (code === 'UNKNOWN' && /is not a function|Cannot read propert|Cannot destructure|is not iterable|undefined is not an object|of undefined|of null/i.test(message)) {
        return { status: 'probe_internal_error', code: code, message: '探针请求未被宿主接受（疑似探针/宿主缺陷，非 Provider 结论）：' + message }
      }
      return { status: 'provider_error', code: code || 'UNKNOWN', message: message }
    }
    // 单绑定最小真实调用：maxTokens=1 的 "ping"，消费至流结束。可用判据 = 流以
    // finish(stop) 正常收尾且收到过至少一个模型输出证据 chunk（text/reasoning/
    // tool-call delta 或 usage）——空结束不判可用（UAT-01 实测教训：zai 余额不足、
    // codex 撞额度时 LlmRuntime.stream() 把失败归一化为终态 finish 而非抛异常，
    // reason.kind='error'/'aborted' 且携带结构化 failure）。
    // 请求形态是硬约束（UAT-02 误报回归的根因）：messages[].content 必须是内容块
    // 数组（[{ type: 'text', text }]），不能是裸字符串。宿主 LlmRuntime 会对
    // message.content 做文件/图片投影（contentHasFile/contentHasImage →
    // projectImagesForTextModel），文本模型上字符串 content 触发
    // TypeError「content.some is not a function」，被归一化为终态 finish(error)，
    // 于是**所有**绑定一律误报不可用。宿主对 content 的类型不做请求期校验，
    // 所以这里必须自己守住形态。
    // 兼容流/流承诺两种返回形态；不可迭代 = 探针降级（宿主无生成流能力）。
    async function probeOneBinding(llm, binding) {
      const base = { key: binding.key, provider: binding.provider, model: binding.model, nodes: binding.nodes.slice() }
      const started = Date.now()
      const finish = (status, code, message) => ({ ...base, status: status, code: code, message: message || '', checked_at: Date.now(), duration_ms: Date.now() - started })
      try {
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
        let iter = llm.stream({ provider: binding.provider, model: binding.model, messages: messages, maxTokens: 1 })
        if (!iter || typeof iter[Symbol.asyncIterator] !== 'function') {
          if (iter && typeof iter.then === 'function') iter = await iter
          if (!iter || typeof iter[Symbol.asyncIterator] !== 'function') {
            const e = new Error('llm 服务未提供可消费的生成流（探针降级）')
            e.probeCapability = true
            throw e
          }
        }
        let sawEvidence = false
        let sawFinish = false
        for await (const chunk of iter) {
          if (chunk && typeof chunk === 'object') {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta' || chunk.type === 'usage') sawEvidence = true
            // 终态 finish：检查 reason.kind（error/aborted 携带结构化 failure）
            if (chunk.type === 'finish') {
              sawFinish = true
              const reason = chunk.reason
              const kind = (reason && typeof reason === 'object') ? String(reason.kind || '') : String(reason || '')
              if (kind === 'error' || kind === 'aborted') {
                const failure = (reason && typeof reason === 'object' && reason.failure && typeof reason.failure === 'object') ? reason.failure : null
                const synthetic = new Error(sanitizeProbeMessage((failure && failure.message) || errMsg(reason || chunk)))
                if (failure) {
                  synthetic.code = failure.code
                  synthetic.failure = failure
                }
                const c = classifyProbeFailure(synthetic)
                return finish(c.status, c.code, c.message)
              }
              // 'stop' / 未知 kind（merge-extensible）视为正常收尾，继续等流关闭
            }
            // 防御：个别适配器以显式 error 事件（而非 finish reason）传递失败
            if (chunk.type === 'error' || (chunk.error && typeof chunk.error === 'object')) {
              const err = (chunk.error && typeof chunk.error === 'object') ? chunk.error : chunk
              const c = classifyProbeFailure(err)
              return finish(c.status, c.code, c.message)
            }
          }
          void chunk
        }
        if (!sawFinish) return finish('provider_error', 'STREAM_CLOSED', sanitizeProbeMessage('流在收尾事件前关闭，结果不可信'))
        if (!sawEvidence) return finish('provider_error', 'EMPTY_RESPONSE', sanitizeProbeMessage('流正常结束但未收到任何模型输出（空响应），不判可用'))
        return finish('available', 'OK', '')
      } catch (e) {
        if (e && typeof e === 'object' && e.probeCapability) return finish('probe_degraded', 'PROBE_DEGRADED', sanitizeProbeMessage(errMsg(e)))
        const c = classifyProbeFailure(e)
        return finish(c.status, c.code, c.message)
      }
    }
    // 去重并发探测；成功结果短时缓存（credential/context 变化 → 指纹变化 → 失效；
    // force 跳过缓存）。缓存仅性能优化，不作长 Run 持续可用保证。
    async function probeBindings(llm, bindings, opts) {
      const force = !!(opts && opts.force)
      const fingerprint = await probeFingerprint(llm, bindings)
      // 去抖窗口（5s）只服务一键检测连点；命中时以当前请求 bindings 回填 nodes
      //（指纹不含 workflow 身份，防止跨工作流回填错误受影响节点）。
      const hit = force ? null : probeCache.get(fingerprint)
      if (hit && Date.now() - hit.at < PROBE_DEBOUNCE_MS) {
        const byKey = new Map(bindings.map((b) => [b.key, b.nodes]))
        return {
          ok: hit.results.every(probeOk),
          results: hit.results.map((r) => ({ ...r, nodes: byKey.get(r.key) || r.nodes, cached: true })),
          fingerprint: fingerprint,
          cached: true,
        }
      }
      const catalog = await probeCatalog(llm, bindings)
      const results = await Promise.all(bindings.map((b) => {
        // 配置判定先行：绑定指向的路由已不存在（Provider/Model 从配置里删除或改名）
        // 时不必也不应发起真实调用——它表达的是"配置已失效"，而不是"网络此刻不通"。
        const configFailure = classifyProbeBinding(catalog, b)
        if (configFailure) {
          return {
            key: b.key, provider: b.provider, model: b.model, nodes: b.nodes.slice(),
            status: configFailure.status, code: configFailure.code, message: configFailure.message,
            checked_at: Date.now(), duration_ms: 0, catalog: 'not_configured',
          }
        }
        return probeOneBinding(llm, b)
      }))
      // 只缓存全部可用结果：失败永不缓存——修复凭证/配额后立即重探立即生效
      if (results.every(probeOk)) {
        probeCache.set(fingerprint, { at: Date.now(), results: results })
        while (probeCache.size > 32) probeCache.delete(probeCache.keys().next().value)
      }
      return { ok: results.every(probeOk), results: results, fingerprint: fingerprint, cached: false }
    }
    // 探针失败一行摘要（BLOCKED reason 与回执用）；已清洗，不含凭证
    function probeFailureSummary(results) {
      return (results || []).filter((r) => !probeOk(r))
        .map((r) => r.provider + '/' + r.model + '：' + r.status + (r.message ? '（' + r.message + '）' : ''))
        .join('；')
    }

    function latestLogicalRunForTask(taskId) {
      let found = null
      for (const rec of logicalRuns.values()) {
        if (rec.task_id === String(taskId || '')) {
          if (!found || (rec.created_at || 0) >= (found.created_at || 0)) found = rec
        }
      }
      return found
    }
    // 终态后继续 = 派生新逻辑运行并保留来源关系（R8）：taskId#2、taskId#3 …
    function nextLogicalRunId(taskId) {
      const base = String(taskId || '')
      let n = 2
      while (logicalRuns.has(base + '#' + n)) n++
      return base + '#' + n
    }
    // 看板 join（不改 runs/ 记录语义，R13）：引擎运行 id → 逻辑运行段信息
    function logicalJoinForRun(runId) {
      const lrId = logicalRunByEngineRun.get(String(runId || ''))
      if (!lrId) return null
      const rec = logicalRuns.get(lrId)
      if (!rec) return { logical_run_id: lrId }
      const seg = rec.segments.find((s) => s.run_id === String(runId)) || null
      return {
        logical_run_id: lrId,
        segment: seg ? seg.index : null,
        segment_count: rec.segments.length,
        logical_state: rec.lifecycle.state,
      }
    }
    // 平台 workflow 工具直起的引擎运行（无 wf_run 边界）：按事件流可得信息落退化摘要
    // ——单段、completion=null（事件层 value 被剥掉，任务规格风险第 3 条已知限制）。
    function recordDegenerateLogicalRun(runId, stopReason) {
      const id = String(runId || '')
      if (!id || logicalRunByEngineRun.has(id)) return
      const now = Date.now()
      const runRec = runs.get(id)
      const rec = {
        logical_run_id: id,
        schema: LOGICAL_RUN_SCHEMA,
        task_id: '',
        template_id: '',
        title: runRec && runRec.meta ? String(runRec.meta.name || '') : '',
        derived_from: null,
        created_at: now,
        updated_at: now,
        lifecycle: {
          state: stopReason === 'completed' ? 'COMPLETED' : 'FAILED',
          reason: stopReason === 'completed' ? null : logicalReason(stopReason === 'cancelled' ? 'ENGINE_CANCELLED' : 'ENGINE_ERROR'),
        },
        terminal: true,
        completion: null,
        segments: [{ index: 1, run_id: id, trigger: 'engine_event', started_at: now, ended_at: now, status: String(stopReason || ''), active: false }],
        snapshots: [],
        node_attempts: [],
        business_outcomes: {},
        workspace: null,
      }
      logicalRuns.set(id, rec)
      logicalRunByEngineRun.set(id, id)
      requestLogicalPersist(id)
    }
    // #93 工作区上下文入档（消费 #93 数据契约）：身份视图 + 事件时间线 + 清理审计，
    // 复制进摘要，Workspace 清理后仍可完整追溯（R9）。非阻断：#93 未部署（notFound）
    // 或调用失败时保留现有入档。
    async function refreshWorkspaceContext(rec, taskId) {
      if (fs === undefined || typeof wsHostCall !== 'function') return
      let r = null
      try { r = await wsHostCall('context', { logical_run_id: String(taskId || '') }) } catch (e) { return }
      if (!r || !r.ok) return
      const ws = r.workspace || null
      const events = Array.isArray(r.events) ? r.events : []
      const prev = rec.workspace
      rec.workspace = {
        workspace_id: ws ? ws.workspace_id : (prev && prev.workspace_id) || null,
        mode: ws ? ws.workspace_mode : (prev && prev.mode) || null,
        workspace_path: ws ? ws.workspace_path : (prev && prev.workspace_path) || null,
        source_path: ws ? ws.source_path : (prev && prev.source_path) || null,
        source_revision: ws ? ws.source_revision : (prev && prev.source_revision) || null,
        work_branch: ws ? ws.work_branch : (prev && prev.work_branch) || null,
        current_head: ws ? ws.current_head : (prev && prev.current_head) || null,
        base_commit: ws ? ws.base_commit : (prev && prev.base_commit) || null,
        lifecycle: ws ? ws.lifecycle : (prev && prev.lifecycle) || null,
        allocated_at: ws ? ws.created_at : (prev && prev.allocated_at) || null,
        events: events,
        resource_locks: events.filter((e) => e && (e.type === 'lock_acquired' || e.type === 'lock_released')),
        integration_checkpoints: events.filter((e) => e && e.type === 'integration_checkpoint'),
        cleanup: r.cleanup || (prev && prev.cleanup) || null,
        refreshed_at: Date.now(),
      }
      rec.updated_at = Date.now()
    }

    ctx.on('workflow/start', (info) => {
      const rec = ensureRun(info.id)
      rec.meta = { name: String((info.meta && info.meta.name) || ''), description: String((info.meta && info.meta.description) || '') }
      persist(rec.id)
    })
    const onRun = (id, mutate) => { const rec = runs.get(String(id)); if (rec) { mutate(rec); persist(rec.id) } }
    const pushLog = (rec, line) => { rec.logs.push(String(line)); if (rec.logs.length > 50) rec.logs.shift() }
    ctx.on('workflow/phase', (info, title) => onRun(info.id, (rec) => { rec.phase = String(title); pushLog(rec, '[phase] ' + title) }))
    ctx.on('workflow/log', (info, message) => onRun(info.id, (rec) => pushLog(rec, message)))
    ctx.on('workflow/agent-start', (info, agent) => onRun(info.id, (rec) => rec.agents.push({ seq: agent.seq, label: String(agent.label || ''), phase: agent.phase ? String(agent.phase) : '', outcome: 'running' })))
    // 按 seq 精确匹配：pipeline 并发下 agent-start/agent-end 可能交错到达
    ctx.on('workflow/agent-end', (info, agent) => onRun(info.id, (rec) => { const a = rec.agents.find((x) => x.seq === agent.seq); if (a) a.outcome = String(agent.outcome) }))
    ctx.on('workflow/end', (info, result) => {
      live.delete(String(info.id))
      onRun(info.id, (rec) => {
        // wf_run 已回写的脚本权威终态（WAITING_HUMAN / DONE / …）不得被迟到的 end 盖掉
        if (!TERMINAL_STATUS_RE.test(String(rec.status || ''))) rec.status = String(result.stopReason)
        // 终局时仍 running 的子代理不可能再有结果（引擎对启动即失败的项不投递 agent-end）
        for (const a of rec.agents) if (a.outcome === 'running') a.outcome = 'failed'
      })
      // #79：未纳管引擎运行（平台 workflow 工具直起）按事件流可得信息落退化摘要。
      // wf_run 边界运行在此处必已登记，不会进入该分支。
      if (!logicalRunByEngineRun.has(String(info.id))) recordDegenerateLogicalRun(info.id, String((result && result.stopReason) || ''))
    })

    // 同 taskId 互斥：占用该任务的最新记录
    function taskHolder(taskId) {
      let found = null
      if (!taskId) return null
      for (const rec of runs.values()) {
        if (rec.taskId === taskId && holdsTask(rec) && (!found || runTs(rec) >= runTs(found))) found = rec
      }
      return found
    }
    // 续跑启动后：同 taskId 的停机记录标记接管，旧卡片退出门禁队列
    function supersedeParked(taskId, newRunId) {
      for (const rec of runs.values()) {
        if (rec.id === newRunId || rec.taskId !== taskId || rec.supersededBy) continue
        if (isHumanWait(rec.status) || isParkedHd(rec)) { rec.supersededBy = newRunId; persist(rec.id) }
      }
    }
    function canonicalStop(result) {
      const v = result && result.value
      const cand = v && typeof v === 'object' && typeof v.status === 'string' ? v.status : (typeof v === 'string' ? v : '')
      return TERMINAL_STATUS_RE.test(cand) ? cand : ''
    }
    // 脚本终态 → workspace 生命周期：人工等待保留，DONE 完成，STOPPED 停止，其余失败
    function lifecycleFor(canon, stopReason) {
      if (canon === 'DONE') return 'COMPLETED'
      if (canon === 'STOPPED') return 'STOPPED'
      if (isHumanWait(canon)) return 'WAITING_HUMAN'
      if (canon || stopReason === 'cancelled' || stopReason === 'error') return 'FAILED'
      return null
    }

    // ── 模板 / 校验 / 编译 / 运行状态 RPC ─────────────────────────────────────
    registerRpc('vwf.workflows.list', () => listWorkflows())
    registerRpc('vwf.workflows.save', async (a) => {
      const v = await validatePipeline(a.dsl)
      if (!v.ok) return { ok: false, errors: v.errors, fieldErrors: v.fieldErrors }
      const id = v.sanitized.id
      const d = fs === undefined ? null : await homeDirs()
      if (!d || !GENERATOR) return fail('宿主文件能力不可用或插件根未注入：无法保存模板')
      const [{ builtins }, users] = await Promise.all([splitGenerated(), loadUserTemplates()])
      if (builtins.has(id)) return fail('内置模板只读：' + id + ' 属于内置模板，不能覆盖，请改用新 id（另存为新模板）', '$.id')
      if (users.has(id) && a.currentId !== id) return fail('已存在同名模板 ' + id + '：另存为新模板请修改模板 ID；更新当前模板请保持 ID 不变。', '$.id')
      const file = d.userDir + '/' + id + '.json'
      try { await writeText(file, JSON.stringify((await kernel()).projectToBlueprint(v.sanitized), null, 2) + '\n') } catch (e) { return fail('模板落盘失败：' + errMsg(e)) }
      // save 即闭环：生成器 user 子命令同步自包含 skill 到 ~/.dsh/skills/<id>/；失败回滚落盘保持原子
      const gen = await runNode([GENERATOR, 'user', file, d.skillRoot], { graceMs: 60000 })
      if (!gen.ok) {
        await rm(file)
        return fail('蓝图校验/技能生成失败（save 已回滚）：' + gen.detail)
      }
      if (isLegacyCustomId(id)) await rm(d.removedDir + '/' + id)
      return { ok: true, id: id, dsl: v.sanitized, warnings: v.warnings }
    })
    registerRpc('vwf.workflows.remove', async (a) => {
      const id = a.id
      if (!id || typeof id !== 'string') return fail('缺少模板 id', '$.id')
      const d = fs === undefined ? null : await homeDirs()
      if (!d) return fail('宿主文件能力不可用：无法删除用户模板')
      if ((await splitGenerated()).builtins.has(id)) return fail('内置模板只读：' + id + ' 属于内置模板，不能删除', '$.id')
      const file = d.userDir + '/' + id + '.json'
      const existed = (await readTextIfExists(file)) !== null
      if (!existed && (!isLegacyCustomId(id) || (await loadRemovedIds()).has(id))) return fail('用户模板不存在：' + id, '$.id')
      if (existed) {
        const r = await rm(file)
        if (!r.ok) return fail('模板删除失败：' + r.detail)
      }
      await rm(d.skillRoot + '/' + id)
      // 历史模板删除后写删除标记，避免生成物再次出现在模板库
      if (isLegacyCustomId(id)) { try { await writeText(d.removedDir + '/' + id, '') } catch (e) { /* 标记失败不阻断删除 */ } }
      return { ok: true, id: id }
    })
    registerRpc('vwf.validate', async (a) => {
      const v = await validatePipeline(a.dsl)
      return { ok: v.ok, errors: v.errors, fieldErrors: v.fieldErrors, sanitized: v.sanitized, warnings: v.warnings }
    })
    // 编辑器「一键检测」入口：先静态校验（失败不发起 Probe）；通过后对去重绑定
    // 做最小真实调用，报告每 provider+model 状态、可操作失败原因与受影响节点。
    registerRpc('vwf.probe', async (a) => {
      const v = await validatePipeline(a.dsl)
      if (!v.ok) {
        return {
          ok: false,
          stage: 'static',
          errors: v.errors,
          fieldErrors: v.fieldErrors,
          sanitized: v.sanitized,
          warnings: v.warnings,
        }
      }
      const base = { sanitized: v.sanitized, warnings: v.warnings }
      const bindings = probeBindingsOfDsl(v.sanitized)
      if (!bindings.length) {
        return { ...base, ok: true, stage: 'probe', results: [], summary: '无显式模型绑定，无可探测项' }
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        return {
          ...base,
          ok: false,
          stage: 'probe',
          code: 'LLM_SERVICE_UNAVAILABLE',
          errors: [{ path: '$', message: 'llm 服务不可用：无法发起运行前探针。请确认 DSH 宿主已挂载 llm 服务。' }],
          results: bindings.map((b) => ({ key: b.key, provider: b.provider, model: b.model, nodes: b.nodes.slice(), status: 'unknown', code: 'LLM_SERVICE_UNAVAILABLE', message: 'llm 服务不可用' })),
        }
      }
      const r = await probeBindings(llm, bindings, { force: a.force === true })
      return {
        ...base,
        ok: r.results.every(probeOk),
        stage: 'probe',
        results: r.results,
        checked_at: Date.now(),
        cached: r.cached === true,
      }
    })
    // 会话 / wf_run 正式路径仍用 vwf.script；allocate:true 时分配隔离 workspace 并注入脚本默认 args（面板不再暴露预览/准备运行按钮）
    registerRpc('vwf.script', async (a) => {
      const v = await validatePipeline(a.dsl)
      if (!v.ok) return { ok: false, errors: v.errors }
      const c = await compileDsl(v.sanitized)
      if (!c.ok) return fail(c.detail)
      let script = c.script
      let workspaceArgs = null
      if (a.allocate === true || a.taskId) {
        const taskId = String(a.taskId || (v.sanitized.id + '-' + Date.now()))
        const prepared = await prepareRunWorkspace({ taskId: taskId, templateId: a.templateId || v.sanitized.id, baseBranch: a.baseBranch || 'main' })
        if (!prepared.ok) return fail('Run Workspace 分配失败，隔离保证无法建立：' + prepared.error)
        if (prepared.workspace) {
          workspaceArgs = scriptArgsFromWorkspace(prepared.workspace, prepared.capability, taskId)
          script = injectWorkspaceDefaults(script, workspaceArgs)
          await markWorkspaceLifecycle(taskId, 'RUNNING')
        }
      }
      return { ok: true, engineAvailable: !!resolveEngine(), script: script, meta: c.meta, workspaceArgs: workspaceArgs }
    })
    registerRpc('vwf.state', async (a) => {
      await runsHydration
      const rec = a.runId ? runs.get(String(a.runId)) : null
      return rec ? { found: true, state: rec } : { found: false, state: null }
    })
    const listRunSummaries = async () => {
      await runsHydration
      const out = Array.from(runs.values()).map((rec) => {
        const row = summary(rec)
        // #79：逻辑运行 join（第 N 段呈现数据源；旧记录无逻辑运行归属时不加字段）
        const lj = logicalJoinForRun(rec.id)
        if (lj) Object.assign(row, lj)
        return row
      }).sort((a, b) => ((b.startedAt || 0) - (a.startedAt || 0)) || byId(b.id, a.id))
      return { runs: out }
    }
    registerRpc('vwf.runs.list', listRunSummaries)
    registerRpc('vwf.runs.history', listRunSummaries)
    // #79：逻辑运行摘要只读取（为 #75 Run Dashboard 冻结的数据模型）
    registerRpc('vwf.logicalRuns.get', async (a) => {
      const id = String((a && a.logical_run_id) || '')
      if (!id) return { found: false, record: null }
      let rec = logicalRuns.get(id)
      if (!rec) {
        // 内存 miss 回落磁盘（同 runs 记录口径）：重启后未回载进内存的摘要按 id 直查
        const d = fs === undefined ? null : await homeDirs()
        if (d) {
          try {
            hydrateLogicalRunFromDisk(JSON.parse(await fs.readText(await fs.resolve(d.logicalRunsDir + '/' + logicalRunFile(id)))))
          } catch (e) { /* 不存在或损坏：按缺失返回 */ }
          rec = logicalRuns.get(id)
        }
      }
      if (!rec) return { found: false, record: null }
      return { found: true, record: logicalRunPayload(rec) }
    })
    registerRpc('vwf.artifacts.ingest', async (a) => {
      const { runId, nodeId, artifacts } = a
      if (!runId || !nodeId || !Array.isArray(artifacts) || !artifacts.length) return fail('缺少 runId / nodeId / artifacts')
      const rec = runs.get(String(runId))
      if (!rec) return fail('运行记录不存在：' + runId, '$.runId')
      let core
      try { core = await loadDist('formal-artifacts.cjs') } catch (e) { return fail('Formal Artifact 内核不可用：' + errMsg(e)) }
      try {
        rec.formalRecords = core.ingestArtifacts(rec.formalRecords, {
          runId: String(runId), nodeId: String(nodeId), artifacts: artifacts, outcome: a.outcome !== undefined ? a.outcome : null,
          provenance: {
            logical_run_id: String(runId), node: String(nodeId), attempt: a.attempt || 1,
            snapshot_revision: a.snapshot_revision || 'unspecified', provider: a.provider || 'unknown', model: a.model || 'unknown',
            produced_by: a.produced_by || 'vwf:artifacts.ingest', node_business_outcome: a.outcome !== undefined ? a.outcome : null,
          },
        })
        persist(rec.id)
        return { ok: true, formalRecords: rec.formalRecords, produced: artifacts.length, taskId: rec.taskId }
      } catch (e) { return fail(errMsg(e)) }
    })
    // llm 服务就绪可能晚于插件 apply：每次现取
    registerRpc('vwf.models', async () => {
      const llm = ctx.get('llm')
      if (llm === undefined) { log('vwf.models：llm 服务不可用，返回空 provider 列表'); return { providers: [] } }
      let providers = []
      try { providers = (await Promise.resolve(llm.listProviders())) || [] } catch (e) { log('vwf.models：listProviders 失败：' + errMsg(e)); return { providers: [] } }
      const out = []
      for (const p of providers) {
        const id = String((p && (p.id || p.provider || p.name)) || '')
        if (!id) continue
        let models = []
        try { models = ((await llm.listModels(id)) || []).map((m) => String((m && (m.id || m.model || m.name)) || '')).filter(Boolean) } catch (e) { log('vwf.models：listModels(' + id + ') 失败：' + errMsg(e)) }
        out.push({ id: id, models: models })
      }
      return { providers: out }
    })
    // 界面文案：语言资源随插件 dist/locales/<locale>.json 分发，客户端按需拉取
    registerRpc('vwf.i18n', async (a) => {
      const locale = String(a.locale || 'zh').toLowerCase().slice(0, 2)
      const id = /^[a-z]{2}$/.test(locale) ? locale : 'zh'
      const messages = await loadDist('locales/' + id + '.json').catch(() => (
        id === 'zh' ? null : loadDist('locales/zh.json').catch(() => null)
      ))
      return { locale: id, messages: messages || {} }
    })

    // ── 角色库：决策内核 role-library.cjs + 清单 builtin-roles.json；本段只做事实采集与效果执行 ──
    // 内置角色正文以插件打包快照（dist/roles/<id>.md）为准（与运行时 roleRef 同源）；
    // 自定义角色 = 项目 dsh/roles/*.md 中不属于内置集合的文件；打包角色包只读回退，绝不回写。
    const roleDir = () => { const p = projectRoot(); return p ? p + '/dsh/roles' : 'dsh/roles' }
    const pathOf = (h) => (typeof h === 'string') ? h : (h && (h.displayPath || h.targetKey)) || null
    // 读取角色目录：{ files: Map<id,{content}>, state: ok|missing|error, message }
    // 只有确认不存在（ENOENT）才算 missing；其余错误 fail-closed，防止把失败当空库放行而覆盖既有角色
    async function readRoleFiles() {
      const out = new Map()
      const error = (message) => ({ files: out, state: 'error', message: message })
      if (fs === undefined) return error('宿主文件能力不可用')
      const dir = roleDir()
      let target, info
      try { target = await fs.resolve(dir) } catch (e) { return isMissingErr(e) ? { files: out, state: 'missing', message: '角色目录不存在：' + dir } : error('角色目录解析失败：' + errMsg(e)) }
      try { info = await fs.stat(target) } catch (e) { return error('角色目录状态读取失败：' + errMsg(e)) }
      if (!info) return { files: out, state: 'missing', message: '角色目录不存在：' + dir }
      if (info.type !== 'directory') return error('角色目录不是目录：' + dir)
      let entries
      try { entries = (await fs.listDir(target) || []).filter((e) => e && typeof e.name === 'string' && /\.md$/i.test(e.name)).sort((a, b) => byId(a.name, b.name)) } catch (e) { return error('角色目录读取失败：' + errMsg(e)) }
      for (const ent of entries) {
        let content = null
        try { content = String(await fs.readText(await fs.resolve(dir + '/' + ent.name))) } catch (e) { /* 单文件失败保留 id 防同名覆盖 */ }
        out.set(ent.name.replace(/\.md$/i, ''), { content: content })
      }
      return { files: out, state: 'ok' }
    }
    // 打包角色包回退：bundleRoles 模板产物旁的 roles/ 快照（含已迁出内置集合的历史角色如 dispatcher）
    async function bundledLegacyRoles() {
      const out = new Map()
      const d = await homeDirs()
      for (const spot of generatedRoots().concat(d ? [d.skillRoot] : [])) {
        for (const ent of (await listDirOrNull(spot)) || []) {
          if (!ent || ent.type !== 'directory' || !ent.name || ent.name === 'roles') continue
          for (const rf of (await listDirOrNull(spot + '/' + ent.name + '/roles')) || []) {
            if (!rf || rf.type !== 'file' || !rf.name || !rf.name.endsWith('.md')) continue
            const id = rf.name.slice(0, -3)
            if (!id || out.has(id)) continue
            const text = await readTextIfExists(spot + '/' + ent.name + '/roles/' + rf.name)
            if (text !== null) out.set(id, text)
          }
        }
      }
      return out
    }
    // 目录事实带短时缓存：页面打开/角色管理/角色变更会连续拉取列表；自身写操作立即失效，
    // 外部直接改文件的变更最迟 2 秒可见
    let catalogCache = null
    const invalidateCatalog = () => { catalogCache = null }
    async function collectRoleCatalog() {
      if (catalogCache && Date.now() - catalogCache.at < 2000) return catalogCache.value
      const inv = await readRoleFiles()
      let bundled = new Map()
      try { bundled = await bundledLegacyRoles() } catch (e) { /* 回退源不可用不阻断 */ }
      const value = {
        state: inv.state, message: inv.message || '',
        workspace: Array.from(inv.files, ([id, f]) => ({ id: id, content: f.content })),
        bundled: Array.from(bundled, ([id, content]) => ({ id: id, content: content })),
      }
      catalogCache = { at: Date.now(), value: value }
      return value
    }
    let builtinBodiesPromise = null
    function collectBuiltinBodies(lib) {
      if (!builtinBodiesPromise) {
        builtinBodiesPromise = (async () => {
          const bodies = {}
          for (const id of lib.describe().builtinIds) bodies[id] = await loadDist('roles/' + id + '.md').catch(() => null)
          return bodies
        })()
      }
      return builtinBodiesPromise
    }
    async function detailFacts(lib) {
      return { includeContent: true, catalog: await collectRoleCatalog(), builtinBodies: await collectBuiltinBodies(lib) }
    }
    // 引用事实：正式内置 + 用户模板 + 未删除的历史生成物 + 可选开放草稿；strict 读取失败 fail-closed
    async function collectWorkflowFacts(draftDsl) {
      try {
        const mapNodes = (dsl) => ((dsl && dsl.nodes) || []).map((n) => ({ id: n.id, label: n.label, profile: n.profile }))
        const records = (await workflowEntries(true)).map((w) => ({ workflowId: String(w.id), workflowName: String(w.name), builtin: w.builtin, nodes: mapNodes(w.dsl) }))
        const facts = { state: 'ok', records: records }
        if (draftDsl && Array.isArray(draftDsl.nodes)) {
          facts.draft = { name: draftDsl.name, nodes: mapNodes(draftDsl) }
          if (draftDsl.id) facts.draft.id = draftDsl.id
        }
        return facts
      } catch (e) { return { state: 'error', message: errMsg(e) } }
    }
    // 效果执行（唯一写/删出口）：写文件、重命名（写新→删旧，删失败回滚新）、删除
    async function applyRoleEffect(effect) {
      try { return await applyEffect(effect) } finally { invalidateCatalog() }
    }
    async function applyEffect(effect) {
      const dir = roleDir()
      const file = (id) => dir + '/' + id + '.md'
      if (effect.kind === 'write' || effect.kind === 'rename') {
        try { await writeText(file(effect.kind === 'write' ? effect.id : effect.to), effect.content) } catch (e) { return fail('角色文件写入失败：' + errMsg(e)) }
        if (effect.kind === 'write') return { ok: true }
        let oldAbs = null
        try { oldAbs = pathOf(await fs.resolve(file(effect.from))) } catch (e) { /* 解析失败按删除失败处理 */ }
        const rmOld = oldAbs ? await rm(oldAbs) : { ok: false, detail: '旧角色文件路径解析失败' }
        if (rmOld.ok) return { ok: true }
        let rolledBack = false
        try { rolledBack = (await rm(pathOf(await fs.resolve(file(effect.to))))).ok } catch (e) { /* 回滚失败下方提示 */ }
        return fail('旧角色文件删除失败（已回滚新文件' + (rolledBack ? '' : '，回滚失败，请手动清理 ') + '）：' + rmOld.detail)
      }
      if (effect.kind === 'remove') {
        let abs = null
        try { abs = pathOf(await fs.resolve(file(effect.id))) } catch (e) { /* 同下 */ }
        const r = abs ? await rm(abs) : { ok: false, detail: '角色文件路径解析失败' }
        return r.ok ? { ok: true } : fail('角色删除失败：' + r.detail)
      }
      return fail('未知角色变更意图：' + String(effect && effect.kind))
    }
    const withLib = (handler) => async (a) => {
      let lib
      try { lib = await roleLibrary() } catch (e) { return fail('角色库内核不可用：' + errMsg(e)) }
      return handler(lib, a)
    }
    registerRpc('vwf.roles', withLib(async (lib) => {
      const r = await lib.execute({ operation: 'list', facts: { includeContent: false, catalog: await collectRoleCatalog(), builtinBodies: await collectBuiltinBodies(lib) } })
      return { roles: r.roles }
    }))
    registerRpc('vwf.roles.get', withLib(async (lib, a) => lib.execute({ operation: 'get', id: a.id, facts: await detailFacts(lib) })))
    registerRpc('vwf.roles.usage', withLib(async (lib, a) => {
      if (!a.id || typeof a.id !== 'string') return fail('缺少角色 id', '$.id')
      return lib.execute({ operation: 'usage', id: a.id, facts: { workflows: await collectWorkflowFacts(a.draftDsl) } })
    }))
    registerRpc('vwf.roles.validate', withLib(async (lib, a) => lib.execute({ operation: 'validateName', name: a.name, excludeId: a.excludeId, facts: { catalog: await collectRoleCatalog() } })))
    const changeFacts = async () => ({ capabilities: { fs: fs !== undefined, subprocess: subprocess !== undefined }, catalog: await collectRoleCatalog() })
    registerRpc('vwf.roles.create', withLib(async (lib, a) => {
      if (fs === undefined) return fail('宿主文件能力不可用：无法创建角色')
      const r = await lib.execute({ operation: 'change', action: 'create', name: a.name, content: a.content, facts: await changeFacts() })
      if (!r.ok) return r
      const applied = await applyRoleEffect(r.effect)
      return applied.ok ? lib.execute({ operation: 'get', id: r.effect.id, facts: await detailFacts(lib) }) : applied
    }))
    // 内容修改全局生效（引用按 id 共享）；重命名仅零引用放行且需要 subprocess 删旧文件
    registerRpc('vwf.roles.update', withLib(async (lib, a) => {
      if (fs === undefined) return fail('宿主文件能力不可用：无法更新角色')
      const facts = await changeFacts()
      const newName = String(a.name || '').trim()
      if (a.id && newName && newName !== a.id) facts.workflows = await collectWorkflowFacts(a.draftDsl)
      const r = await lib.execute({ operation: 'change', action: 'update', id: a.id, name: a.name, content: a.content, facts: facts })
      if (!r.ok) return r
      const applied = await applyRoleEffect(r.effect)
      return applied.ok ? lib.execute({ operation: 'get', id: r.effect.kind === 'rename' ? r.effect.to : a.id, facts: await detailFacts(lib) }) : applied
    }))
    registerRpc('vwf.roles.remove', withLib(async (lib, a) => {
      if (fs === undefined || subprocess === undefined) return fail('宿主文件能力不可用：无法删除角色')
      const facts = await changeFacts()
      facts.workflows = await collectWorkflowFacts(a.draftDsl)
      const r = await lib.execute({ operation: 'change', action: 'remove', id: a.id, facts: facts })
      if (!r.ok) return r
      const applied = await applyRoleEffect(r.effect)
      return applied.ok ? { ok: true, id: a.id } : applied
    }))

    // ── 工作区隔离：核心实现 = scripts/workspace-isolation.mjs，经包装脚本子进程调用 ──
    async function wsHostCall(cmd, input, opts) {
      if (!WS_HOST || (await readTextIfExists(WS_HOST)) === null) return { ok: false, notFound: true, error: 'workspace-isolation-host.mjs 未找到（宿主未部署 #93 集成）' }
      const d = await homeDirs()
      if (!d) return { ok: false, notFound: true, error: '无法解析 workspace 根目录' }
      const payload = { ...input, work_root: input.work_root || d.workspaces }
      const r = await runNode([WS_HOST, cmd, JSON.stringify(payload)], { graceMs: (opts && opts.graceMs) || 30000, maxBytes: 256 * 1024 })
      if (!r.ok) return { ok: false, error: 'workspace host 调用失败：' + r.detail }
      try {
        const parsed = JSON.parse(r.stdout)
        return parsed.ok ? parsed : { ok: false, error: parsed.error || 'workspace host 业务错误', detail: parsed.detail }
      } catch (e) { return { ok: false, error: 'workspace host 输出不可解析：' + errMsg(e), raw: r.stdout } }
    }
    // 模板 id → 隔离策略模板类型
    function mapTemplateId(id) {
      const lower = String(id || '').toLowerCase()
      if (/optim/.test(lower)) return 'optimize'
      if (/diagnose|debug/.test(lower)) return 'diagnose'
      if (/explore|research/.test(lower)) return 'explore'
      return 'construction'
    }
    // 能力令牌：allocate 时由宿主生成，注入脚本 args；workspace RPC 必须携带匹配令牌，
    // 防止猜测另一个 Run 的 taskId 越权读写对方现场（vm 沙箱无 crypto，用高熵拼接）
    const workspaceCaps = new Map()
    function capabilityFor(runId) {
      let cap = workspaceCaps.get(runId)
      if (!cap) {
        const rand = () => Math.random().toString(36).slice(2)
        cap = 'cap-' + rand() + rand() + rand() + Date.now().toString(36) + '-' + (workspaceCaps.size + 1)
        workspaceCaps.set(runId, cap)
      }
      return cap
    }
    function scriptArgsFromWorkspace(ws, cap, taskId) {
      return {
        taskId: taskId || undefined, workspace_id: ws.workspace_id, workspace_path: ws.workspace_path, source_path: ws.source_path,
        records_path: ws.records_path, work_branch: ws.work_branch, source_revision: ws.source_revision, workspace_capability: cap || undefined,
      }
    }
    function injectWorkspaceDefaults(script, defaults) {
      const payload = {}
      for (const k of Object.keys(defaults || {})) if (defaults[k] !== undefined && defaults[k] !== null) payload[k] = defaults[k]
      const json = JSON.stringify(payload)
      const marker = 'const __VWF_WS_DEFAULTS__ = {}'
      if (script && script.indexOf(marker) >= 0) return script.replace(marker, 'const __VWF_WS_DEFAULTS__ = ' + json)
      const old = 'const A = args || {}'
      if (script && script.indexOf(old) >= 0) return script.replace(old, 'const A = Object.assign({}, ' + json + ', args || {})')
      return 'const A = Object.assign({}, ' + json + ', args || {})\n' + (script || '')
    }
    // 返回 { ok, workspace?, capability? }；包装脚本未部署 → ok 且无 workspace（回退旧行为）；
    // 已部署但分配失败 → fail closed（隔离是核心保证，不得静默降级到共享现场）
    async function prepareRunWorkspace(opts) {
      const taskId = String(opts.taskId || '')
      if (!taskId) return { ok: false, error: '缺少 taskId' }
      const alloc = await wsHostCall('allocate', { logical_run_id: taskId, template_id: mapTemplateId(opts.templateId), repository_path: projectRoot() || null, base_ref: opts.baseBranch || 'main', task_identity: taskId })
      if (alloc.notFound) return { ok: true, notFound: true }
      if (!alloc.ok || !alloc.workspace) return { ok: false, error: alloc.error || 'workspace 分配失败（未知原因）' }
      return { ok: true, workspace: alloc.workspace, capability: capabilityFor(taskId) }
    }
    async function markWorkspaceLifecycle(taskId, lifecycle) {
      if (!taskId || !lifecycle) return
      try { await wsHostCall('setLifecycle', { logical_run_id: String(taskId), lifecycle: lifecycle }) } catch (e) { /* 非阻断 */ }
    }
    // workspace RPC 表：[包装脚本命令, 是否校验能力令牌, 载荷映射]。供编译后的 workflow 脚本在节点内调用。
    const str = (v) => String(v || '')
    const WS_OPS = {
      allocate: ['allocate', false, (a) => ({
        logical_run_id: str(a.taskId), template_id: mapTemplateId(a.templateId), repository_path: a.repository_path || null, repository: a.repository || null,
        base_ref: a.baseBranch || 'main', base_commit: a.base_commit || null, work_branch: a.work_branch || null, task_identity: str(a.taskId), allow_parallel: !!a.allow_parallel,
      })],
      get: ['get', true, (a, id) => ({ logical_run_id: id })],
      setLifecycle: ['setLifecycle', true, (a, id) => ({ logical_run_id: id, lifecycle: str(a.lifecycle), extra: a.extra || {} })],
      recordSourceSync: ['recordSourceSync', true, (a, id) => ({ logical_run_id: id, current_head: a.current_head || undefined, source_revision: a.source_revision || undefined })],
      // 只接收 Run 身份，权威 workspace 由包装脚本从注册表解析，不信任调用方传入的路径
      buildProvenance: ['buildAttemptProvenance', true, (a, id) => ({ logical_run_id: id, node: str(a.node), attempt: Number(a.attempt || 1) })],
      acquireLock: ['acquireLock', true, (a, id) => ({ logical_run_id: id, resource_key: str(a.resource_key), owner: str(a.owner), ttl_ms: a.ttl_ms || undefined })],
      releaseLock: ['releaseLock', true, (a, id) => ({ lock_id: str(a.lock_id), owner: str(a.owner), logical_run_id: id, reason: a.reason || undefined })],
      cleanup: ['cleanup', true, (a, id) => ({ logical_run_id: id, opts: a.opts || {} })],
      writeSource: ['writeSourceFile', true, (a, id) => ({ logical_run_id: id, rel: str(a.rel), content: str(a.content) })],
      readSource: ['readSourceFile', true, (a, id) => ({ logical_run_id: id, rel: str(a.rel) })],
      writeWorker: ['writeWorkerFile', true, (a, id) => ({ logical_run_id: id, worker_id: str(a.worker_id), rel: str(a.rel), content: str(a.content) })],
      readWorker: ['readWorkerFile', true, (a, id) => ({ logical_run_id: id, worker_id: str(a.worker_id), rel: str(a.rel) })],
      checkpoint: ['computeIntegrationCheckpointFromRepo', false, (a) => ({ base_ref: str(a.base_ref), base_commit: str(a.base_commit), repository_path: str(a.repository_path), target_ref: a.target_ref || undefined })],
    }
    for (const op of Object.keys(WS_OPS)) {
      const [cmd, needsCap, build] = WS_OPS[op]
      registerRpc('vwf.workspace.' + op, async (a) => {
        const id = str(a.logical_run_id || a.workspace_id || a.taskId)
        if (needsCap) {
          if (!id) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
          const expected = workspaceCaps.get(id)
          if (!expected) return { ok: false, error: '该 Run 未登记 workspace capability（可能未经 wf_run 分配或已释放）' }
          if (a.capability !== expected) return { ok: false, error: 'workspace capability 不匹配，拒绝越权访问' }
        }
        const result = await wsHostCall(cmd, build(a, id))
        if (op === 'allocate' && result.ok && result.workspace && id) result.capability = capabilityFor(id)
        // #79：清理审计沿真实调用时序入档——终态收尾刷新早于清理（#93 cleanup 要求
        // workspace 已终态），cleanup 审计只能在本钩子落摘要；最新逻辑运行承接该
        // workspace 的最终审计，保留既有身份/事件入档。
        if (op === 'cleanup' && result && result.ok) {
          const rec = latestLogicalRunForTask(id)
          if (rec) {
            await refreshWorkspaceContext(rec, id)
            requestLogicalPersist(rec.logical_run_id)
          }
        }
        return result
      })
    }

    // ── 静态组合包：webServer 前缀路由（POST /dsh-visual-workflow/<method>，信封 {rpcId,method,payload}→{rpcId,result}）──
    if (!isDynamicHost) {
      const route = {
        kind: 'prefix',
        path: '/dsh-visual-workflow',
        handler: function vwfRpcHandler(req, res) {
          if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'POST only' })); return }
          let raw = ''
          req.on('data', (c) => { raw += c })
          req.on('end', async () => {
            let msg = {}
            try { msg = JSON.parse(raw || '{}') || {} } catch (e) { /* 空信封 */ }
            const fn = rpcRoutes.get(String(msg.method || ''))
            let result
            if (typeof fn !== 'function') result = fail('未知方法：' + msg.method)
            else try { result = await fn(msg.payload || {}) } catch (e) { result = fail(errMsg(e)) }
            try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rpcId: String(msg.rpcId || 'r0'), result: result === undefined ? null : result })) } catch (e) { /* 连接已断 */ }
          })
        },
      }
      const registerOn = (owner, ws) => {
        if (!ws || typeof ws.register !== 'function') return false
        if (owner && typeof owner.effect === 'function') owner.effect(() => ws.register(route), 'vwf: rpc route')
        else ws.register(route)
        return true
      }
      // webServer 可能晚于本插件激活（旧安装位未声明 inject）：经 ctx.inject 延迟注册
      if (!registerOn(ctx, ctx.get('webServer')) && typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (wctx) => registerOn(wctx, (wctx && typeof wctx.get === 'function' ? wctx.get('webServer') : wctx) || wctx))
      }
      if (ctx.get('webServer') === undefined) log('webServer 服务当前不可用：静态 RPC 路由延迟到 webServer 激活')
    }

    // ── workflowEngine：本部署由 agent preset 平面挂载，host ctx 看不到，经 agentPresets 对当前发起 agent 桥接 ──
    function resolveEngine() {
      if (engine !== undefined) return engine
      try {
        const ap = ctx.get('agentPresets')
        if (!ap || typeof ap.serviceFor !== 'function' || agents === undefined || typeof agents.currentInitiator !== 'function') return undefined
        const a = agents.currentInitiator()
        return (a && a.ctx && ap.serviceFor(a, 'workflowEngine')) || undefined
      } catch (e) { return undefined }
    }

    // ── 工具：有 agents 服务即注册；engine 不可用推迟到 execute 时报错 ────────────
    if (agents === undefined) {
      log('agents 未挂载：wf_run 工具不注册；编译产物经 vwf.script RPC 提供给 workflow 工具执行')
      return
    }
    const textTool = (t) => dtools.define({ ...t, output: { schema: { type: 'string' }, render: (a, value) => [{ type: 'text', text: value }] } })
    dtools.register(textTool({
      name: 'wf_run',
      description: '运行一个可视化工作流（DSL 图）：校验并编译为 workflow 脚本后交给引擎执行。args.templateId 用内置/用户模板，或 args.dsl 传自定义图。返回运行状态；Human Decision 以 WAITING_HUMAN 暂停，用 decision_id + user_choice 续跑；残留人工门禁以 AWAITING_HUMAN_<node> 暂停，用 entry + approved 续跑。',
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
        approved: { type: 'boolean', description: '残留人工门禁续跑裁决（true 通过）；Human Decision 禁止此字段' },
        feedback: { type: 'string', description: '人工打回意见（续跑）' },
        startRound: { type: 'number', description: '续跑起始轮次' },
        history: { type: 'array', description: '前次打回历史（续跑）' },
        decision_id: { type: 'string', description: 'Human Decision 续跑：稳定 decision_id' },
        user_choice: { type: 'string', description: 'Human Decision 续跑：Decision Result（如 STOP / USER_ACCEPTED / ADD_BUDGET）' },
        blocked_edge: { type: 'object', additionalProperties: true, description: 'ADD_BUDGET 时被额度拦住的自动边 { from, to, on }' },
        results: { type: 'object', additionalProperties: true, description: '续跑时带回的节点结果快照' },
        model_overrides: { type: 'object', additionalProperties: true, description: '#79 续跑时可更换 Provider/Model：{ 节点id | "$default": { provider, model } }；产生追加式快照修订（旧修订保留可查），仅续跑生效' },
      },
      async execute(rawArgs) {
        refreshServices()
        // 工具平台会 deepFreeze 入参：续跑回填写到浅拷贝上
        const args = Object.assign({}, rawArgs || {})
        const taskId = String(args.taskId || '')
        // 互斥判定必须看到完整门禁状态，先等启动回载完成
        await runsHydration
        const isHdResume = !!args.decision_id
        const isLegacyResume = !!args.entry
        const holder = taskHolder(taskId)
        if (holder) {
          const st = String(holder.status || '')
          let allow
          if (st === 'WAITING_HUMAN' || isParkedHd(holder)) allow = isHdResume && (!holder.decision_id || holder.decision_id === String(args.decision_id))
          else if (st.indexOf('AWAITING_HUMAN_') === 0) allow = isLegacyResume
          else allow = isHdResume || isLegacyResume
          if (!allow) {
            return '错误：任务 ' + taskId + ' 已有进行中的运行 ' + holder.id + '（状态 ' + (st || 'running') +
              '）：同 taskId 串行互斥。WAITING_HUMAN 请带 decision_id 与 user_choice 续跑；残留门禁请带 entry=<节点id> 与 approved；并行任务请换一个 taskId。'
          }
        }
        let dsl = null
        let fromTemplate = false
        if (args.templateId) {
          dsl = await findWorkflow(args.templateId)
          if (!dsl) return '错误：未知工作流 ' + args.templateId + '（可用：' + (await listWorkflows()).map((w) => w.id).join(', ') + '）'
          fromTemplate = true
        } else if (args.dsl) dsl = args.dsl
        else return '错误：必须提供 templateId 或 dsl'
        const usesHd = dsl && typeof dsl === 'object' && (dsl.humanDecision !== undefined || (Array.isArray(dsl.edges) && dsl.edges.some((e) => e && (e.to === '$human-decision' || e.from === '$human-decision'))))
        if (usesHd && args.approved !== undefined) return '错误：Human Decision 续跑禁止 approved，请传 decision_id 与 user_choice'
        // Human Decision 续跑：从停机记录回填未显式传入的现场
        const parked = isHdResume && holder && isParkedHd(holder) ? holder : null
        if (parked) {
          const emptyObj = (v) => v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
          if (args.blocked_edge == null && parked.blocked_edge) args.blocked_edge = parked.blocked_edge
          if (emptyObj(args.results) && parked.results) args.results = parked.results
          if (emptyObj(args.results) && parked.node && parked.control_event && parked.control_event.triggering_node_outcome) args.results = { [parked.node]: parked.control_event.triggering_node_outcome }
          if (args.history == null && parked.history) args.history = parked.history
          for (const k of ['round', 'budgetUsed', 'maxRounds', 'decisionSeq']) {
            const argKey = k === 'round' ? 'startRound' : k
            if (args[argKey] == null && parked[k] != null) args[argKey] = parked[k]
          }
          if (!args.entry && parked.node) args.entry = parked.node
        }
        const v = await validatePipeline(dsl)
        if (!v.ok) return 'DSL 校验失败：' + JSON.stringify(v.errors)
        const c = await compileDsl(v.sanitized, { fromTemplate: fromTemplate })
        if (!c.ok) return '编译失败：' + c.detail
        const engineNow = resolveEngine()
        if (engineNow === undefined) return '错误：当前宿主平面无法访问 workflowEngine（wf_run 需要 agent preset 挂载的工作流引擎）。可改用内置 workflow 工具执行 vwf.script 编译产物。'
        const parent = agents.requireInitiator()

        // ── #79 Logical Run 归属解析 ─────────────────────────────────────────
        // 新启 = 创建逻辑运行（快照 Rev 1 冻结）；同 taskId 终态后再启 = 派生新运行
        // （R8）；崩溃残留的非终态运行标 FAILED 后派生；续跑 = 挂到同一逻辑运行追加
        // 执行分段（R2）。逻辑运行摘要回载完成后才裁决（Codex R2 ⑤：只 await
        // runsHydration 会与 loadLogicalRuns 竞速，重启窗口内误判"无前任"）。
        try { if (typeof logicalRunsHydration !== 'undefined' && logicalRunsHydration) await logicalRunsHydration } catch (e) { /* 回载失败已留痕 */ }
        const logicalTaskId = taskId
        const beforeResultKeys = new Set(Object.keys((args.results && typeof args.results === 'object' && !Array.isArray(args.results)) ? args.results : {}))
        const logicalRunConfig = () => {
          const cfg = { runDir: args.runDir, baseBranch: args.baseBranch, roleDir: args.roleDir || c.roleDir, issueRef: args.issueRef, issueTitle: args.issueTitle }
          for (const k of Object.keys(cfg)) { if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') delete cfg[k] }
          return cfg
        }
        let logicalRec = null
        let logicalTrigger = 'start'
        // #74：BLOCKED（探针失败）恢复 = 同一逻辑运行修改 Provider/Model → 新 Revision
        // → 重新 Probe → Resume；不是新启，也不是崩溃残留派生。
        let probeResume = false
        if (isHdResume || isLegacyResume) {
          const latest = latestLogicalRunForTask(logicalTaskId)
          if (latest && latest.terminal) {
            return '错误：任务 ' + logicalTaskId + ' 的逻辑运行 ' + latest.logical_run_id + ' 已终态（' + latest.lifecycle.state + '），同一运行不能继续。请直接重新发起（将派生新运行并保留来源关系）。'
          }
          logicalTrigger = isHdResume ? 'human_decision' : 'legacy_resume'
          if (latest) {
            logicalRec = latest
          } else {
            // 旧形态挂起记录（升级前）升级后续跑：由本段起新建逻辑运行承接，不回写旧记录（R14）
            logicalRec = createLogicalRun({
              logical_run_id: logicalTaskId,
              taskId: logicalTaskId,
              templateId: String(args.templateId || v.sanitized.id || ''),
              dsl: v.sanitized,
              script: c.script,
              roleDir: args.roleDir || c.roleDir || '',
              config: logicalRunConfig(),
            })
          }
        } else {
          const latest = latestLogicalRunForTask(logicalTaskId)
          const blockedProbe = latest && !latest.terminal
            && latest.lifecycle.state === 'BLOCKED'
            && latest.lifecycle.reason && latest.lifecycle.reason.code === 'PROBE_FAILED'
          if (blockedProbe) {
            const ov = args.model_overrides
            if (!ov || typeof ov !== 'object' || Array.isArray(ov) || !Object.keys(ov).length) {
              return '错误：任务 ' + logicalTaskId + ' 的逻辑运行 ' + latest.logical_run_id + ' 因运行前模型探针未通过而 BLOCKED（' + String((latest.lifecycle.reason && latest.lifecycle.reason.message) || '') + '）。请带 model_overrides 修改当前 Run 的 Provider/Model 后重试：将产生新的 Snapshot Revision、重新探针并恢复同一逻辑运行。'
            }
            logicalRec = latest
            logicalTrigger = 'model_recovery'
            probeResume = true
          } else {
            if (latest && !latest.terminal) {
              // 互斥已放行的崩溃残留：前任标 FAILED（结构化 reason），派生新运行
              logicalSetState(latest, 'FAILED', logicalReason('RUNTIME_RESTARTED', '同 taskId 重新发起，前任运行进程已中断'))
              await refreshWorkspaceContext(latest, latest.logical_run_id)
              requestLogicalPersist(latest.logical_run_id)
            }
            logicalRec = createLogicalRun({
              logical_run_id: latest ? nextLogicalRunId(logicalTaskId) : logicalTaskId,
              taskId: logicalTaskId,
              templateId: String(args.templateId || v.sanitized.id || ''),
              dsl: v.sanitized,
              script: c.script,
              roleDir: args.roleDir || c.roleDir || '',
              config: logicalRunConfig(),
              derivedFrom: latest ? latest.logical_run_id : null,
            })
          }
        }
        // #79 快照修订（R3/R4）：续跑携带 model_overrides → 追加 Rev N（仅
        // Provider/Model），旧修订保留，新修订只影响后续执行；#74 BLOCKED 恢复同理。
        if (((isHdResume || isLegacyResume) || probeResume) && args.model_overrides && typeof args.model_overrides === 'object' && !Array.isArray(args.model_overrides) && Object.keys(args.model_overrides).length) {
          const rev = appendSnapshotRevision(logicalRec, args.model_overrides)
          if (rev) requestLogicalPersist(logicalRec.logical_run_id)
        }
        // Codex R2 ①：续跑必须执行 Rev 1 冻结脚本（R3：运行中仅 Provider/Model 可改，
        // 工作流定义冻结）——等待期间模板被修改时，重新编译会让"新脚本 + script_ref:1
        // 快照"静默失配。Rev 1 无脚本（旧形态承接）时才用当前编译产物。
        // #74 BLOCKED 恢复同为既有运行的继续，遵守同一冻结纪律。
        const snap1 = (logicalRec.snapshots || []).find((s) => s.revision === 1) || null
        const frozenScript = snap1 && typeof snap1.script === 'string' && snap1.script ? snap1.script : null
        const execScript = (isHdResume || isLegacyResume || probeResume) && frozenScript ? frozenScript : c.script
        // Codex R2 ②：续跑传入 active 快照的合并绑定（而非本次 delta）——Rev3 只改 B
        // 时，A 必须仍用 Rev2 的覆盖值执行；合并语义与编译脚本一致（显式覆盖优先，
        // $default 兜底未显式覆盖节点）。
        const activeSnap = activeSnapshot(logicalRec)
        const modelOverridesForExec = (isHdResume || isLegacyResume || probeResume) ? structuredClone(activeSnap ? activeSnap.provider_model : null) : undefined

        // #74 Preflight Probe：业务节点执行前对本次将使用的 active 快照去重探测。
        // 探针明确失败 → BLOCKED（可恢复，不改写 Workflow Outcome）；探针降级
        // （llm 服务无生成流能力）与探针自身缺陷（probe_internal_error）只如实标注
        // 不阻断，避免探针问题卡死全部 Run。
        if (logicalRec) {
          const activeBindings = dedupeProbeBindings(activeSnap ? activeSnap.provider_model : null)
          if (activeBindings.length) {
            const llmSvc = ctx.get('llm')
            if (llmSvc === undefined) {
              log('vwf.probe(preflight)：llm 服务不可用，跳过运行前探针（不阻断启动）')
            } else {
              // Run 启动探针恒为真实探测（force）：缓存只服务一键检测连点，
              // 避免 BLOCKED 恢复或启动前读到去抖窗口内的陈旧结论（审查 R1 阻断项）
              const probe = await probeBindings(llmSvc, activeBindings, { force: true })
              const blocking = probe.results.filter(probeBlocksStart)
              if (blocking.length) {
                const summaryText = probeFailureSummary(blocking)
                logicalSetState(logicalRec, 'BLOCKED', logicalReason('PROBE_FAILED', summaryText))
                requestLogicalPersist(logicalRec.logical_run_id)
                return JSON.stringify({
                  blocked: true,
                  stage: 'preflight_probe',
                  logical_run_id: logicalRec.logical_run_id,
                  snapshot_revision: activeSnap ? activeSnap.revision : null,
                  failures: blocking,
                  hint: '模型探针未通过：请修改当前 Run 的 Provider/Model 后，用 wf_run（同 taskId + model_overrides）恢复同一逻辑运行；完成后将产生新的 Snapshot Revision 并重新探针。若本运行此前因人工决策处于 WAITING_HUMAN，请在原续跑参数（decision_id/user_choice）基础上追加 model_overrides 恢复。',
                }, null, 2)
              }
              if (probe.results.some((r) => r.status === 'probe_degraded')) log('vwf.probe(preflight)：探针降级（无生成流能力），结果仅作参考，不阻断启动')
              if (probe.results.some((r) => r.status === 'probe_internal_error')) log('vwf.probe(preflight)：探针请求未被宿主接受（疑似探针缺陷），结果仅作参考，不阻断启动')
            }
          }
        }

        // Codex R2 ③：派生运行按自身 logical_run_id 分配 workspace——沿用原 taskId 会让
        // #93 注册表把前任（仍注册）的 workspace 复用给派生运行，或在清理后把溯源记到
        // 旧身份下。markWorkspaceLifecycle/refreshWorkspaceContext 同步用该 ID。
        const wsIdentity = logicalRec.logical_run_id
        const prepared = await prepareRunWorkspace({ taskId: wsIdentity, templateId: args.templateId || v.sanitized.id, baseBranch: args.baseBranch || 'main' })
        if (!prepared.ok) {
          // Codex R2 ⑥：分配失败不得留下 READY 悬挂记录（否则下次重试被误判为崩溃残留）
          logicalSetState(logicalRec, 'FAILED', logicalReason('WORKSPACE_ALLOCATE_FAILED', String(prepared.error || '')))
          requestLogicalPersist(logicalRec.logical_run_id)
          log('workspace allocate 失败（fail closed，拒绝启动）：' + prepared.error)
          return '错误：Run Workspace 分配失败，隔离保证无法建立，工作流拒绝启动：' + prepared.error + '（请检查仓库根可访问性、DSH Home/workspaces 目录权限与 workspace-isolation-host.mjs 是否存在）'
        }
        const ws = prepared.workspace || null
        if (ws) log('workspace allocated: ' + ws.workspace_id + ' at ' + ws.workspace_path)
        else if (prepared.notFound) log('workspace 集成未部署（workspace-isolation-host.mjs 缺失），回退旧行为')

        const scriptArgs = Object.assign({
          taskId: args.taskId, runDir: args.runDir, roleDir: args.roleDir || c.roleDir, baseBranch: args.baseBranch,
          issueRef: args.issueRef, issueTitle: args.issueTitle, issueBody: args.issueBody, issueComments: args.issueComments,
          requirement: args.requirement, entry: args.entry, approved: args.approved, feedback: args.feedback, startRound: args.startRound, history: args.history,
          decision_id: args.decision_id, user_choice: args.user_choice, blocked_edge: args.blocked_edge, results: args.results,
          budgetUsed: args.budgetUsed, maxRounds: args.maxRounds, decisionSeq: args.decisionSeq,
          // #79: 快照修订的 Provider/Model（Codex R2 ②：active 快照的合并绑定；仅续跑
          // 生效——新启透传会让脚本用覆盖模型执行而 Rev1 快照仍记蓝图绑定，归因失真）
          model_overrides: modelOverridesForExec,
        }, ws ? scriptArgsFromWorkspace(ws, prepared.capability, undefined) : {})
        for (const k of Object.keys(scriptArgs)) if (scriptArgs[k] === undefined) delete scriptArgs[k]

        // 启动引擎前先标 RUNNING：崩溃/start 抛错不得把 workspace 永久留在 READY
        if (ws) await markWorkspaceLifecycle(wsIdentity, 'RUNNING')
        // Codex R2 ①：续跑执行 Rev 1 冻结脚本（见上方 execScript 说明）
        const startReq = { script: execScript, meta: c.meta, args: scriptArgs, parent: parent }
        if (ws && ws.source_path) { startReq.cwd = ws.source_path; startReq.workspaceRoot = ws.source_path }
        let run
        try { run = engineNow.start(startReq) } catch (e) {
          if (ws) await markWorkspaceLifecycle(wsIdentity, 'FAILED')
          if (logicalRec) {
            logicalSetState(logicalRec, 'FAILED', logicalReason('ENGINE_START_FAILED', errMsg(e)))
            requestLogicalPersist(logicalRec.logical_run_id)
          }
          return '错误：工作流引擎启动失败，workspace 已标 FAILED：' + errMsg(e)
        }
        // 启动边界自登记（workflow/start 事件不带 taskId）；续跑把同 taskId 前序门禁记录标记接管
        const runId = String(run.id)
        const rec = ensureRun(runId)
        rec.taskId = taskId
        rec.workflowId = String(args.templateId || v.sanitized.id || '')
        live.add(runId)
        persist(runId)
        if (isHdResume || isLegacyResume) supersedeParked(taskId, runId)
        // #79：本段执行挂到逻辑运行（READY/WAITING_HUMAN → RUNNING，清 reason）
        if (logicalRec) {
          appendLogicalSegment(logicalRec, runId, logicalTrigger, isHdResume ? String(args.decision_id || '') : '')
          logicalSetState(logicalRec, 'RUNNING', null)
          requestLogicalPersist(logicalRec.logical_run_id)
        }
        let result
        try { result = await run.result } catch (e) {
          if (ws) await markWorkspaceLifecycle(wsIdentity, 'FAILED')
          if (logicalRec) {
            endLogicalSegment(logicalRec, runId, 'ENGINE_ERROR')
            logicalSetState(logicalRec, 'FAILED', logicalReason('ENGINE_ERROR', errMsg(e)))
            requestLogicalPersist(logicalRec.logical_run_id)
          }
          return '错误：工作流运行失败，workspace 已标 FAILED：' + errMsg(e)
        }
        // 权威终态回写：completed 时以脚本返回 value.status 为准；回执保持引擎原样不翻译
        const canon = result && result.stopReason === 'completed' ? canonicalStop(result) : ''
        if (canon) onRun(runId, (r) => { r.status = canon; applyHdValue(r, result.value) })
        // #79 逻辑运行收尾：八态映射 + 完成类型镜像 + 节点实际修订/模型/业务结果
        // 记录 + 工作区上下文入档。Lifecycle 闸门不改写专业结果（R7）。
        if (logicalRec) {
          const value = result && result.value
          endLogicalSegment(logicalRec, runId, canon || String((result && result.stopReason) || ''))
          if (canon === 'DONE') {
            const comp = value && value.completion
            if (comp && typeof comp === 'object' && typeof comp.type === 'string' && comp.type.trim()) {
              logicalRec.completion = {
                type: comp.type,
                node: comp.node !== undefined && comp.node !== null ? String(comp.node) : '',
                path: comp.path !== undefined && comp.path !== null ? String(comp.path) : '',
              }
            }
          }
          recordNodeAttempts(logicalRec, v.sanitized, beforeResultKeys, value && value.results, value && value.control_event)
          const trans = logicalTransitionFor(canon, result && result.stopReason, value)
          if (trans) logicalSetState(logicalRec, trans.state, trans.reason)
          await refreshWorkspaceContext(logicalRec, wsIdentity)
          requestLogicalPersist(logicalRec.logical_run_id)
        }
        if (ws) {
          const lc = lifecycleFor(canon, result && result.stopReason)
          if (lc) await markWorkspaceLifecycle(wsIdentity, lc)
        }
        return JSON.stringify({ runId: runId, stopReason: result.stopReason, value: result.value, agentsStarted: result.agentsStarted })
      },
    }))
    dtools.register(textTool({
      name: 'vwf_workspace',
      description: '按已分配的 Logical Run 访问隔离 workspace。必须携带本 Run 的 workspace_capability。op=' + Object.keys(WS_OPS).join('|'),
      parameters: {
        op: { type: 'string', required: true, description: Object.keys(WS_OPS).join(' | ') },
        logical_run_id: { type: 'string', required: true, description: 'Logical Run / taskId' },
        capability: { type: 'string', required: true, description: 'wf_run 或获取脚本注入的 workspace_capability' },
        rel: { type: 'string', description: '相对 source/worker 的路径' },
        content: { type: 'string', description: '写入内容' },
        worker_id: { type: 'string' },
        resource_key: { type: 'string' },
        owner: { type: 'string' },
        lock_id: { type: 'string' },
        node: { type: 'string' },
        attempt: { type: 'number' },
        lifecycle: { type: 'string' },
      },
      async execute(rawArgs) {
        const fn = rpcRoutes.get('vwf.workspace.' + String((rawArgs && rawArgs.op) || ''))
        if (typeof fn !== 'function') return JSON.stringify({ ok: false, error: '未知 workspace op：' + (rawArgs && rawArgs.op) })
        try { const res = await fn(rawArgs); return typeof res === 'string' ? res : JSON.stringify(res) } catch (e) { return JSON.stringify({ ok: false, error: errMsg(e) }) }
      },
    }))
    dtools.register(textTool({
      name: 'vwf_debug',
      description: 'vwf 插件诊断：op=paths 返回路径解析结果与服务可用性。',
      parameters: { op: { type: 'string', required: true, description: 'paths' } },
      async execute(args) {
        if (args.op !== 'paths') return '用法：vwf_debug { op: "paths" }'
        refreshServices()
        const d = await homeDirs()
        return JSON.stringify({
          pluginRoot: PLUGIN_ROOT, codeRoot: CODE_ROOT, dist: DIST, generator: GENERATOR, workspaceHost: WS_HOST,
          projectRoot: projectRoot(), dshHome: await dshHome(), generatedRoots: generatedRoots(), userDir: d && d.userDir, skillRoot: d && d.skillRoot, runsDir: d && d.runsDir,
          fsAvailable: fs !== undefined, subprocessAvailable: subprocess !== undefined, nodePath: await resolveNode(),
        }, null, 2)
      },
    }))
  },
}
