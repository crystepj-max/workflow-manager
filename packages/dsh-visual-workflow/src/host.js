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
    // vm 沙箱不保证注入 structuredClone（动态 Cordis 宿主实测缺失）：数据深拷贝走守卫回退。
    const deepCloneData = (value) => {
      if (value === null || value === undefined) return value
      return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
    }
    // 磁盘回载字段守卫（LOC-029 顺带收敛 hydrate 三元链）：类型不符取默认值
    const asStr = (v, d) => (typeof v === 'string' ? v : d)
    const asNum = (v, d) => (typeof v === 'number' ? v : d)
    const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
    const asArr = (v, f) => (Array.isArray(v) ? v.filter(f || ((x) => x && typeof x === 'object')) : [])

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
    const RECORDS_HOST = CODE_ROOT ? CODE_ROOT + '/scripts/records-host.mjs' : null
    const QUALITY_COST_HOST = CODE_ROOT ? CODE_ROOT + '/scripts/run-quality-cost.mjs' : null
    // LOC-032：受管理外部操作账本 + execute-or-reconcile（与 records-host 同进程边界模式）
    const OPERATIONS_HOST = CODE_ROOT ? CODE_ROOT + '/scripts/operations-host.mjs' : null
    // LOC-037：收口事实整理与授权交付动作分离（与 operations-host 同进程边界模式）
    const DELIVERY_CLOSEOUT_HOST = CODE_ROOT ? CODE_ROOT + '/scripts/delivery-closeout-host.mjs' : null

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
          // LOC-014 模型覆盖层：一内置模板一文件，键 = 节点id | "$default"，值 = { provider, model }
          modelOverridesDir: home + '/visual-workflow/model-overrides',
          removedDir: home + '/visual-workflow/removed',
          runsDir: home + '/visual-workflow/runs',
          // 逻辑运行摘要目录（#79）：<logical_run_id>.json 一任务一文件
          logicalRunsDir: home + '/visual-workflow/logical-runs',
          // Formal Records Store 目录（LOC-008）：与 logical-runs 同组织，一逻辑运行一文件
          recordsDir: home + '/visual-workflow/records',
          // 受管理外部操作账本目录（LOC-032）：一 Run 一文件
          operationsDir: home + '/visual-workflow/operations',
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
    // 无 import，经 fs 读源码求值。.cjs 内核可 require('./name.cjs') 引用同目录内核，
    // 求值前由本函数按源码预解析（见下）。缺失即明确报错，不降级、不去别处找。
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
            // 内核可声明 `require('./name.cjs')` 引用同目录内核（validate-core →
            // projection-core）：求值前按源码预解析这些引用，求值时同步供给；其余引用拒绝。
            const declared = new Map()
            for (const m of src.matchAll(/require\((['"])\.\/([\w.-]+\.cjs)\1\)/g)) {
              declared.set(m[2], await loadDist(m[2]))
            }
            const module = { exports: {} }
            const requireKernel = (id) => {
              const key = String(id).replace(/^\.\//, '')
              if (declared.has(key)) return declared.get(key)
              throw new Error('内核只允许预先声明的 ./name.cjs 引用：' + id)
            }
            new Function('module', 'exports', 'require', src)(module, module.exports, requireKernel)
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
    // ── LOC-014 模型覆盖层 ────────────────────────────────────────────────────
    // 覆盖只作用于 bindings.models 的 provider/model；键语义与 #79 model_overrides
    // 对齐：节点 id 精确覆盖优先，"$default" 兜底未显式覆盖的节点（单一来源常量）。
    const MODEL_OVERRIDE_DEFAULT_KEY = '$default'
    // 覆盖清洗：剔除非法键值（非对象 / 缺 provider 或 model）；无效节点键在合成时忽略。
    // 键禁路径分隔符与 '..'（防覆盖文件出现怪键；id 侧另有 safeTemplateId 双重防线）
    function sanitizeOverride(ov) {
      const out = {}
      for (const k of Object.keys(ov || {})) {
        if (!safeTemplateId(k)) continue
        const v = ov[k]
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue
        const provider = typeof v.provider === 'string' ? v.provider.trim() : ''
        const model = typeof v.model === 'string' ? v.model.trim() : ''
        if (!provider || !model) continue
        out[k] = { provider, model }
      }
      return out
    }
    // 模板 id 字符集白名单（RPC 三端点共用）：禁路径分隔符 / '..'（防 model-overrides/<id>.json 拼接穿越）
    function safeTemplateId(id) {
      return typeof id === 'string' && id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..') && /^[A-Za-z0-9._$-]+$/.test(id)
    }
    // 读取覆盖层：坏 JSON / 非法结构忽略并留痕，绝不阻断模板加载（规格 §11）
    async function loadModelOverrides() {
      const out = new Map()
      if (fs === undefined) return out
      const d = await homeDirs()
      if (!d) return out
      let entries = null
      try { entries = await fs.listDir(await fs.resolve(d.modelOverridesDir)) } catch (e) { return out }
      for (const ent of entries || []) {
        if (!ent || typeof ent.name !== 'string' || !/\.json$/i.test(ent.name)) continue
        const id = ent.name.replace(/\.json$/i, '')
        try {
          const ov = sanitizeOverride(JSON.parse(await fs.readText(ent.target)))
          if (Object.keys(ov).length) out.set(id, ov)
        } catch (e) {
          log('模型覆盖文件忽略（解析失败）：' + ent.name + '：' + errMsg(e))
        }
      }
      return out
    }
    // 单一合成函数（规格 §9）：深拷贝 DSL，按覆盖替换模型绑定。
    // 🔴 权威形态 = node.model 内联（.generated 生成物无 bindings，运行时读节点内联模型——
    // loc-014-r1 产品 UAT 实测纠正：只写 bindings 对运行时无效）；蓝图落盘形态
    // （bindings.models）存在时双写保持一致。键语义与 #79 运行时对齐（generate.mjs
    // 编译脚本同源）：节点 id 精确覆盖优先，"$default" 作用于所有未被精确覆盖的节点。
    function composeModelBindings(dsl, ov) {
      if (!ov || typeof ov !== 'object' || !Object.keys(ov).length) return dsl
      if (!dsl || typeof dsl !== 'object') return dsl
      const next = JSON.parse(JSON.stringify(dsl))
      if (!next.bindings || typeof next.bindings !== 'object') next.bindings = {}
      if (!next.bindings.models || typeof next.bindings.models !== 'object') next.bindings.models = {}
      const models = next.bindings.models
      const nodes = (Array.isArray(next.nodes) ? next.nodes : []).filter((n) => n && typeof n.id === 'string' && n.id)
      for (const n of nodes) {
        const v = ov[n.id] || ov[MODEL_OVERRIDE_DEFAULT_KEY]
        if (!v || typeof v !== 'object') continue
        const patch = { provider: v.provider, model: v.model }
        n.model = { ...(typeof n.model === 'object' && n.model ? n.model : {}), ...patch }
        models[n.id] = { ...(typeof models[n.id] === 'object' && models[n.id] ? models[n.id] : {}), ...patch }
      }
      return next
    }
    // 查找：用户覆盖（整份）→ 未删除的历史生成物 → 正式内置（⊕ 模型覆盖层）
    // userDir 整份覆盖优先（已是用户自定义资产，D3-2）：模型覆盖层对其忽略。
    async function findWorkflow(id) {
      if (!id || typeof id !== 'string') return null
      const bp = (await loadUserTemplates()).get(id)
      if (bp) return (await kernel()).projectToVwf(bp)
      if ((await loadRemovedIds()).has(id)) return null
      const { builtins, shipped } = await splitGenerated()
      const dsl = shipped.get(id) || builtins.get(id) || null
      if (!dsl) return null
      const ov = (await loadModelOverrides()).get(id)
      return ov ? composeModelBindings(dsl, ov) : dsl
    }
    // 合并三源为清单条目；同 id 用户整份覆盖优先，已删除标记的历史 id 不再列出；
    // 内置条目合成模型覆盖层并携带 modelOverridden 标记（模板库"已覆盖"最小展示，D2）
    async function workflowEntries(strict) {
      const [{ builtins, shipped }, users, removed, core, overrides] = await Promise.all([splitGenerated(strict), loadUserTemplates(strict), loadRemovedIds(), kernel(), loadModelOverrides()])
      const out = []
      const seen = new Set()
      const push = (dsl, name, builtin, extra) => { seen.add(dsl.id); out.push({ id: dsl.id, name: name, description: dsl.description || '', builtin: builtin, dsl: dsl, ...(extra || {}) }) }
      for (const dsl of builtins.values()) {
        const ov = overrides.get(dsl.id)
        const eff = ov ? composeModelBindings(dsl, ov) : dsl
        push(eff, eff.name || dsl.name, true, ov ? { modelOverridden: true } : null)
      }
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
      if (typeof raw.displayName !== 'string' && !hasBindings) {
        // DSL 形态直传：异源档位旧布尔经内核口径归一为三态字符串（LOC-021），
        // 避免 sanitized/落盘残留 true/false 与「蓝图单一事实源=三态字符串」漂移。
        if (raw.heteroCheck === true) return { ...raw, heteroCheck: 'weak' }
        if (raw.heteroCheck === false) return { ...raw, heteroCheck: 'off' }
        return raw
      }
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
    // 一律现编译（与当前生成器/引擎契约同源）；预编译产物仅在无子进程环境整体回落。
    // 现编译后仍探测产物旁 roles/ 自包含角色包随译文返回 roleDir——兼容角色
    // （builtin:false，不内联）靠它走读文件路径，磁盘旧脚本不再复用但角色包必须保留。
    const metaFromDsl = (dsl) => ({ name: 'vwf-' + (dsl.id || 'run'), description: dsl.name || dsl.id || 'visual workflow run', phases: (dsl.nodes || []).map((n) => ({ title: n.label || n.id })) })
    // 探测 <id>/roles/ 自包含角色包（只取角色目录，不取旧脚本）
    async function findRoleDir(dslId) {
      const d = await homeDirs()
      if (!d) return null
      for (const spot of [d.skillRoot].concat(generatedRoots())) {
        const roles = await listDirOrNull(spot + '/' + dslId + '/roles')
        if (roles && roles.length) return spot + '/' + dslId + '/roles'
      }
      return null
    }
    async function compileDsl(dsl, opts) {
      const d = await homeDirs()
      // 先现编译（与当前生成器/引擎契约同源），预编译产物仅作无子进程环境的回落：
      // 保存闭环产物可能出自旧版生成器（如 agent cwd 契约收紧前），优先复用会让
      // 运行时执行与引擎不兼容的过期脚本（UAT 实证：skill 产物带 cwd 被新引擎拒绝）
      if (subprocess !== undefined && GENERATOR) {
        const bp = JSON.stringify((await kernel()).projectToBlueprint(dsl))
        if (bp.length > 120 * 1024) return { ok: false, detail: '蓝图过大（超过 120KB），无法作为编译参数传递' }
        // 编译输出上限 1MB：全内置角色内联的图约 66KB，默认 64KB 会静默截断
        const r = await runNode([GENERATOR, 'compile', '--inline', bp], { graceMs: 30000, maxBytes: 1024 * 1024 })
        if (!r.ok) return { ok: false, detail: r.detail }
        try {
          const out = JSON.parse(r.stdout)
          if (!out.ok) return { ok: false, detail: '编译器返回错误：' + (out.error || '未知') }
          const result = { ok: true, script: out.script, meta: out.meta || metaFromDsl(dsl) }
          const roleDir = await findRoleDir(dsl.id)
          if (roleDir) result.roleDir = roleDir
          return result
        } catch (e) { return { ok: false, detail: '编译器输出不可解析：' + errMsg(e) } }
      }
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
      return { ok: false, detail: '宿主子进程能力不可用或插件根未注入：无法编译（模板来源请先运行 npm run generate 或经保存闭环）' }
    }

    // ── 运行记录：内存与磁盘同一结构，全部常驻内存 ────────────────────────────────
    // 落盘 ~/.dsh/visual-workflow/runs/<encodeURIComponent(runId)>.json，启动时全量回载，
    // 超过 RUNS_RETAIN 淘汰最旧（占用任务的记录不淘汰）。live 集合 = 本进程内执行中的 run；
    // 重启后回载的 running 记录不在 live 中，因而不再占用其 taskId。
    // ── 运行记录存储内核（LOC-004）：单飞行写队列/写盘/回载重试各实现一次，
    // runs 与 logicalRuns 是同一 store 的两个实例；淘汰为 runs 专属（onDrained 挂钩）。
    function createRecordStore({ label, dirKey, touch, serialize, onDrained }) {
      const records = new Map()
      const fileNames = new Map()
      const fileOf = (id) => fileNames.get(id) || (encodeURIComponent(String(id)) + '.json')
      const queues = new Map()
      function persist(id) {
        id = String(id || '')
        if (!id) return
        let q = queues.get(id)
        if (!q) { q = { dirty: false, pending: false }; queues.set(id, q) }
        q.dirty = true
        if (!q.pending) drain(id, q)
      }
      function drain(id, q) {
        if (!q.dirty) { queues.delete(id); return }
        q.dirty = false
        q.pending = true
        write(id)
          .catch((e) => log(label + '落盘失败（不影响运行）：' + id + '：' + errMsg(e)))
          .then(() => { q.pending = false; drain(id, q); if (onDrained) onDrained() })
      }
      async function write(id) {
        const rec = records.get(id)
        const d = fs === undefined ? null : await homeDirs()
        if (!rec || !d) return
        if (touch) touch(rec)
        await writeText(d[dirKey] + '/' + fileOf(id), JSON.stringify(serialize ? serialize(rec) : rec, null, 2) + '\n')
      }
      // fs 服务等待重试 + 目录列举；JSON 解析与水合留给调用方（错误文案各自保留）
      async function loadEntries() {
        for (let attempt = 0; attempt < 10 && fs === undefined; attempt++) {
          refreshServices()
          if (fs !== undefined) break
          // 动态会话 vm 沙箱没有真定时器（调用会被拦截）：无定时器则放弃重试
          try { await new Promise((r) => setTimeout(r, 100 * (attempt + 1))) } catch (e) { break }
        }
        if (fs === undefined) return null
        const d = await homeDirs()
        const entries = d ? await listDirOrNull(d[dirKey]) : null
        const out = []
        for (const ent of entries || []) {
          if (!ent || ent.type !== 'file' || !/\.json$/i.test(ent.name)) continue
          try { out.push({ name: ent.name, text: await fs.readText(await fs.resolve(d[dirKey] + '/' + ent.name)) }) }
          catch (e) { log('跳过损坏的' + label + '：' + ent.name + '（' + errMsg(e) + '）') }
        }
        return out
      }
      return { records, fileNames, fileOf, persist, loadEntries }
    }

    const RUNS_RETAIN = 50
    // #80：PAUSED 属权威运行状态（宿主回写后不得被迟到的 workflow/end 以 'cancelled' 盖掉），
    // 但不是终态——终态判定仍以 LIFECYCLE_TERMINAL 为准。
    // LOC-030：BLOCKED 同为权威运行状态（脚本受阻返回体不得被迟到的 end 盖成 'completed'），
    // 且同样不是生命周期终态（可恢复受阻，terminal=false）—— holdsTask 不含它，并发名额随受阻释放。
    let srcMod = (typeof __VWF_KERNELS__ === 'object' && __VWF_KERNELS__ && __VWF_KERNELS__['state-recovery-core.cjs']) || null
    let srcCorePromise = null
    function srcCore() {
      if (srcMod) return Promise.resolve(srcMod)
      if (!srcCorePromise) {
        srcCorePromise = loadDist('state-recovery-core.cjs').then((m) => { srcMod = m; return m }).catch((e) => { srcCorePromise = null; throw e })
      }
      return srcCorePromise
    }
    srcCore().catch((e) => log('state-recovery-core 预加载失败（首次 wf_run 将重试）：' + errMsg(e)))
    const TERMINAL_STATUS_RE = () => (srcMod && srcMod.TERMINAL_STATUS_RE) || /^(DONE|STOPPED|WAITING_HUMAN|PAUSED|BLOCKED|AWAITING_HUMAN_.+|FAILED_AT_.+|FAILED_MAX_ROUNDS|FAILED_ITEM_CAP|FAILED_AGENT_CAP|TECHNICAL_FAILURE|ENDED_NO_SUCCESS_EDGE|ENDED_NO_FAILURE_EDGE|ENDED_NO_OUTCOME_EDGE|ROUTE_HALTED|ERROR)$/
    const HD_STRING_KEYS = ['decision_id', 'reason', 'node']
    const HD_NUMBER_KEYS = ['round', 'budgetUsed', 'maxRounds', 'decisionSeq']
    const HD_OBJECT_KEYS = ['decision_package', 'control_event', 'blocked_edge', 'results']
    const runsStore = createRecordStore({
      label: '运行记录',
      dirKey: 'runsDir',
      touch: (rec) => { rec.updatedAt = Date.now() },
      onDrained: () => evictSoon(),
    })
    const runs = runsStore.records
    const runFiles = runsStore.fileNames
    const runFile = (id) => runsStore.fileOf(id)
    const live = new Set()
    const isHumanWait = (s) => (srcMod ? srcMod.isHumanWaitStatus(s) : (s === 'WAITING_HUMAN' || String(s || '').indexOf('AWAITING_HUMAN_') === 0))
    // workflow/end 只有 completed，可能在 wf_run 回写 WAITING_HUMAN 之后到达把等待态盖掉；
    // 此时仍靠 decision_id + Package 识别可续跑的停机记录
    const isParkedHd = (rec) => (srcMod ? srcMod.isParkedHumanDecision(rec) : (!!rec && (rec.status === 'WAITING_HUMAN' || (rec.status === 'completed' && !!rec.decision_id && !!rec.decision_package && typeof rec.decision_package === 'object'))))
    // #80：PAUSED 记录持有任务（可恢复现场），占用 taskId 直到恢复或派生
    const holdsTask = (rec) => !!rec && !rec.supersededBy && (live.has(rec.id) || isHumanWait(rec.status) || isParkedHd(rec) || rec.status === 'PAUSED')
    const runTs = (rec) => rec.updatedAt || rec.startedAt || 0

    function newRecord(id) {
      return {
        id: String(id), meta: { name: '', description: '' }, status: 'running', phase: '', logs: [], agents: [], formalRecords: [],
        taskId: '', workflowId: '', startedAt: Date.now(), supersededBy: '',
        decision_id: '', reason: '', decision_package: null, control_event: null, blocked_edge: null, results: null, history: null,
        error_detail: '',
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
    const summary = (rec) => ({ id: rec.id, name: rec.meta.name, status: rec.status, phase: rec.phase, taskId: rec.taskId, workflowId: rec.workflowId, startedAt: rec.startedAt, supersededBy: rec.supersededBy, decision_id: rec.decision_id, reason: rec.reason, node: rec.node || '' })

    // 无定时器节流：每个 run 至多一个飞行中写入，期间变更只置 dirty，写完按最新态补一次尾写
    // （队列实现收敛于 runsStore，LOC-004；此处保留原函数名作为薄委托，19 个调用点零改动）
    function persist(runId) { runsStore.persist(runId) }
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
      const list = await runsStore.loadEntries()
      if (list === null) { log('fs 服务不可用，运行记录未回载'); return }
      for (const { name, text } of list) {
        try {
          const data = JSON.parse(text)
          if (!data || typeof data.id !== 'string' || !data.id) throw new Error('缺少 id 字段')
          if (runs.has(data.id)) continue
          runs.set(data.id, fromDisk(data))
          runFiles.set(data.id, name)
        } catch (e) { log('跳过损坏的运行记录：' + name + '（' + errMsg(e) + '）') }
      }
      evictSoon()
    }
    const runsHydration = loadRuns().catch((e) => log('运行记录回载失败：' + errMsg(e)))

    // ── Logical Run 逻辑运行摘要（#79）────────────────────────────────────
    // 一次任务 = 一个逻辑运行：人工恢复/暂停/受阻/模型切换都发生在同一次运行内，
    // 形成"第 N 段执行"，不产生新的用户级 Run。固定八态 Lifecycle（仅后三者为终态）
    // + 结构化 reason；运行创建时冻结快照 Rev 1，v0.1 运行中仅可更换 Provider/Model
    // 并产生追加式修订（旧修订永不覆盖）。新语义只写运行摘要（logical-runs 目录），
    // 既有 runs/ 事件流记录语义零改动（#87 锁定）。持久化管线与 runs 共用同一 store
    // （LOC-004 收敛，见 createRecordStore）；摘要是追溯档案单元，不做容量淘汰。
    const LIFECYCLE_STATES = ['READY', 'RUNNING', 'WAITING_HUMAN', 'PAUSED', 'BLOCKED', 'COMPLETED', 'STOPPED', 'FAILED']
    const LIFECYCLE_TERMINAL = ['COMPLETED', 'STOPPED', 'FAILED']
    const LOGICAL_RUN_SCHEMA = 1
    const logicalStore = createRecordStore({
      label: '逻辑运行摘要',
      dirKey: 'logicalRunsDir',
      touch: (rec) => { rec.updated_at = Date.now() },
      serialize: (rec) => logicalRunPayload(rec),
    })
    const logicalRuns = logicalStore.records
    const logicalRunByEngineRun = new Map() // 引擎运行 id → logical_run_id（段反查，看板 join 用）
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
        // #80 运行控制面：Guidance Record / 控制事件 / 基线修订均为追加式，不覆盖
        guidance: [],
        control_events: [],
        baseline_revisions: [],
        baseline_applied_upto: 0,
        pause_state: null,     // { action: 'pause'|'interrupt', requested_at } 段取消后翻译为 PAUSED
        pause_resume: null,    // PAUSED 后的恢复现场（检查点重建）{ entry, results, history, round, feedback, budgetUsed, maxRounds, decisionSeq, degraded }
        // Formal Records Store 互相引用（LOC-008）：提交成功后由宿主刷新（count + 时间）
        formal_records: null,
        workspace: null,
        // LOC-028：宿主签发的人工决定与消费记录（防伪造 completion / 幂等恢复）
        human_decisions: [],
        consumed_decisions: {},
        human_waits: [],
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
    function trackHumanWait(rec, prevState, nextState) {
      rec.human_waits = Array.isArray(rec.human_waits) ? rec.human_waits : []
      const waitStates = ['WAITING_HUMAN', 'PAUSED', 'BLOCKED']
      const open = rec.human_waits.find((w) => w && !w.ended_at)
      if (waitStates.indexOf(nextState) >= 0 && prevState === 'RUNNING') {
        rec.human_waits.push({
          started_at: new Date().toISOString(),
          ended_at: null,
          reason: nextState,
          node: null,
        })
      } else if (open && nextState === 'RUNNING') {
        open.ended_at = new Date().toISOString()
      }
    }
    function logicalSetState(rec, state, reason) {
      if (LIFECYCLE_STATES.indexOf(state) < 0) return false
      const prev = rec.lifecycle && rec.lifecycle.state ? rec.lifecycle.state : null
      trackHumanWait(rec, prev, state)
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
    // LOC-030：脚本携带经校验的显式终止描述（termination={business_outcome,lifecycle,
    // reason_code,resumable,resume_node,completion_type?}）时优先按描述映射——技术执行段
    // 结束不再自动等于业务完成：BLOCKED 非终态可恢复；COMPLETED 描述必须有有效完成映射
    //（value.completion.type），缺失降级 COMPLETION_MISSING 可恢复受阻；旧无描述 Run
    // 保留 legacy 标识（不改写历史，不冒充已验证完成）。
    function logicalTransitionFor(canon, stopReason, value) {
      const v = value && typeof value === 'object' ? value : {}
      const t = v.termination
      const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null)
      const okDesc = t && typeof t === 'object' && (t.lifecycle === 'BLOCKED' || t.lifecycle === 'COMPLETED')
        && str(t.business_outcome) && str(t.reason_code) && str(t.resume_node)
      if (okDesc) {
        if (t.lifecycle === 'BLOCKED') return { state: 'BLOCKED', reason: logicalReason(str(t.reason_code), str(t.business_outcome)) }
        const comp = v.completion
        return comp && typeof comp.type === 'string' && comp.type.trim()
          ? { state: 'COMPLETED', reason: null }
          : { state: 'BLOCKED', reason: logicalReason('COMPLETION_MISSING') }
      }
      const reasonFromValue = typeof v.reason === 'string' && v.reason ? logicalReason(v.reason) : null
      // 历史 DONE 无终止描述：无法可靠推断真实业务结果——保留 COMPLETED 终态并标记 legacy 映射
      if (canon === 'DONE') return { state: 'COMPLETED', reason: logicalReason('LEGACY') }
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
    // node_attempts 入档与 Formal Record 提交共用同一业务结果事实源。
    function businessOutcomeOf(dsl, nodeId, r, controlEvent) {
      const path = outcomePathOf(dsl, nodeId)
      let outcome = path !== null ? readOutcomePath(r, path) : undefined
      if (outcome === undefined && controlEvent && controlEvent.node_id === nodeId && controlEvent.triggering_node_outcome !== undefined) {
        outcome = controlEvent.triggering_node_outcome
      }
      return outcome
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
        const outcome = businessOutcomeOf(dsl, nodeId, r, controlEvent)
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
        guidance: rec.guidance || [],
        control_events: rec.control_events || [],
        baseline_revisions: rec.baseline_revisions || [],
        baseline_applied_upto: rec.baseline_applied_upto || 0,
        last_engine_error: rec.last_engine_error || null,
        pause_state: rec.pause_state || null,
        pause_resume: rec.pause_resume || null,
        // LOC-027：活动评价基线引用与历史版本（不可变副本审计链）
        evaluation_baseline: rec.evaluation_baseline || null,
        evaluation_baselines: rec.evaluation_baselines || [],
        formal_records: rec.formal_records || null,
        workspace: rec.workspace || null,
        human_decisions: rec.human_decisions || [],
        consumed_decisions: rec.consumed_decisions || {},
        human_waits: rec.human_waits || [],
      }
    }
    // 队列实现收敛于 logicalStore（LOC-004）；保留原函数名作为薄委托，11 个调用点零改动
    function requestLogicalPersist(id) { logicalStore.persist(id) }
    function hydrateLogicalRunFromDisk(data) {
      if (!data || typeof data !== 'object') return false
      const id = typeof data.logical_run_id === 'string' && data.logical_run_id ? data.logical_run_id : null
      if (!id || logicalRuns.has(id)) return false
      const lc = data.lifecycle && LIFECYCLE_STATES.indexOf(data.lifecycle.state) >= 0
        ? { state: data.lifecycle.state, reason: data.lifecycle.reason || null }
        : { state: 'FAILED', reason: logicalReason('RECORD_CORRUPTED', 'lifecycle 缺失或非法') }
      const rec = {
        logical_run_id: id,
        schema: asNum(data.schema, LOGICAL_RUN_SCHEMA),
        task_id: asStr(data.task_id, ''),
        template_id: asStr(data.template_id, ''),
        title: asStr(data.title, ''),
        derived_from: asStr(data.derived_from, null),
        created_at: asNum(data.created_at, null),
        updated_at: asNum(data.updated_at, null),
        lifecycle: lc,
        terminal: data.terminal === true || LIFECYCLE_TERMINAL.indexOf(lc.state) >= 0,
        completion: asObj(data.completion),
        segments: asArr(data.segments, (s) => s && typeof s === 'object' && typeof s.run_id === 'string' && s.run_id),
        snapshots: asArr(data.snapshots),
        node_attempts: asArr(data.node_attempts),
        business_outcomes: asObj(data.business_outcomes) || {},
        guidance: asArr(data.guidance),
        control_events: asArr(data.control_events),
        baseline_revisions: asArr(data.baseline_revisions),
        baseline_applied_upto: Number(data.baseline_applied_upto) || 0,
        last_engine_error: asStr(data.last_engine_error, null),
        pause_state: asObj(data.pause_state),
        pause_resume: asObj(data.pause_resume),
        evaluation_baseline: asObj(data.evaluation_baseline),
        evaluation_baselines: Array.isArray(data.evaluation_baselines) ? data.evaluation_baselines.filter((r) => r && typeof r === 'object') : [],
        formal_records: asObj(data.formal_records),
        workspace: asObj(data.workspace),
        human_decisions: Array.isArray(data.human_decisions) ? data.human_decisions.filter((d) => d && typeof d === 'object') : [],
        consumed_decisions: asObj(data.consumed_decisions) || {},
        human_waits: Array.isArray(data.human_waits) ? data.human_waits.filter((w) => w && typeof w === 'object') : [],
      }
      logicalRuns.set(id, rec)
      for (const s of rec.segments) if (s.run_id) logicalRunByEngineRun.set(s.run_id, id)
      return true
    }
    async function loadLogicalRuns() {
      const list = await logicalStore.loadEntries()
      if (list === null) return
      const loaded = []
      for (const { name, text } of list) {
        try {
          const data = JSON.parse(text)
          if (!data || typeof data.logical_run_id !== 'string' || !data.logical_run_id) throw new Error('缺少 logical_run_id 字段')
          loaded.push(data)
        } catch (e) { log('跳过损坏的逻辑运行摘要：' + name + '（' + errMsg(e) + '）') }
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
        pause_pending: !!rec.pause_state,
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
        // Formal Records Store 互相引用（LOC-008）：提交成功后由宿主刷新（count + 时间）
        formal_records: null,
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

    // ── #80 运行控制面：Pause / Interrupt / Guidance / Resume ────────────────
    // 机制（对齐真实引擎契约 R-03 + worker.cjs/index.js 源码核实）：abort signal →
    // 引擎 cancel() 并经共享信号中止进行中的子代理请求，在钩子边界抛 CANCELLED →
    // 段以 stopReason='cancelled' 收束，且脚本返回值被引擎强制丢弃（value=null）。
    // - Interrupt：立即 abort（当前 Attempt 即刻终止）。
    // - Safe Pause：不立即 abort——workflow/log 观察到最近完成节点的 [pw-ckpt] 检查点
    //   后才 abort（生效点=节点边界，最坏等待一个节点完成）；检查点与 abort 之间若
    //   下一节点已启动，其 Attempt 被中止并在恢复后整体重跑。
    // 恢复现场从 [pw-ckpt] 检查点行重建（引擎不回传 results，宿主自建）；无检查点=
    // 降级，恢复要求人工指定 entry，不猜。
    const segmentCtrls = new Map() // 引擎运行 id → AbortController（段取消）
    // LOC-029 逐次 attempt 提交：编译脚本在每次真实调用前后输出 [vwf-attempt] 行，
    // 宿主据此向 Records Store 逐次提交执行记录并在段收尾按「确认 → 回填节点最新索引」
    // 固定顺序推进。编排逻辑在 scripts/attempt-ledger.cjs（dist 内核，不占 dynamic
    // 闭包载荷预算）；内核缺失（未随 dist 部署）时回退既有段末扫描行为。
    let attkP = null
    const attk = () => (attkP = attkP || loadDist('attempt-ledger.cjs').then((m) => m.create({
      call: recordsHostCall,
      lrecOf: (id) => {
        const lrId = logicalRunByEngineRun.get(String(id))
        return lrId ? logicalRuns.get(lrId) : null
      },
      snapOf: activeSnapshot,
      onLine: (ev, lrec) => {
        if (!ev || !ev.n || !ev.ri || typeof ev.ri !== 'object') return
        if (ev.a !== 'e' && ev.a !== 'l') return
        if (ev.a === 'e' && ev.s && ev.s !== 'completed') return
        lrec.resolved_inputs_map = lrec.resolved_inputs_map || {}
        lrec.resolved_inputs_map[String(ev.n)] = ev.ri
      },
    })))
    // Safe Pause 的检查点观察：仅 action=pause 等待检查点；interrupt 即时路径不经此。
    // c='$end' 的检查点代表图已走完（随后正常收束走 control_voided），不得在其上中止。
    function maybeAbortAtCheckpoint(engineRunId, message) {
      const lrId = logicalRunByEngineRun.get(String(engineRunId || ''))
      const lrec = lrId ? logicalRuns.get(lrId) : null
      if (!lrec || !lrec.pause_state || lrec.pause_state.action !== 'pause') return
      const raw = String(message || '')
      const idx = raw.indexOf('[pw-ckpt]')
      if (idx < 0) return
      try {
        const ck = JSON.parse(raw.slice(idx + '[pw-ckpt]'.length))
        if (!ck || typeof ck !== 'object' || ck.c === '$end') return
        const ctl = segmentCtrls.get(String(engineRunId || ''))
        if (ctl && typeof ctl.abort === 'function') ctl.abort()
      } catch (e) { /* 损坏行不作为中止依据 */ }
    }
    function controlEvent(rec, type, extra) {
      const ev = Object.assign({ type: String(type), at: Date.now() }, extra && typeof extra === 'object' ? extra : {})
      rec.control_events.push(ev)
      rec.updated_at = ev.at
      return ev
    }

    // ── LOC-035 产物清单（纯逻辑内核 = dist/artifact-manifest.cjs）────────────────────
    // 编译脚本节点完成时输出 [am-submit] → 宿主读字节核验、不可变快照与 manifest 索引；
    // WAITING_HUMAN（READY_FOR_HUMAN）前检查必需产物，缺失则 BLOCKED 但保留专业结果。
    let amKernelPromise = null
    function amKernel() {
      if (!amKernelPromise) amKernelPromise = loadDist('artifact-manifest.cjs').catch(() => { amKernelPromise = null; return null })
      return amKernelPromise
    }
    const amRuns = new Map()
    function observeArtifactSubmit(engineRunId, message) {
      const amc = amRuns.get(String(engineRunId || ''))
      if (!amc) return
      const req = amc.kernel.parseSubmitRequest(message)
      if (!req) return
      let result
      try {
        const prev = amc.byNode.get(req.node) || null
        result = amc.kernel.processSubmit({ cwd: amc.cwd, runDir: amc.runDir, taskId: amc.taskId, req, prevManifest: prev })
      } catch (e) {
        result = { ok: false, error: errMsg(e) }
      }
      if (result && result.ok && result.manifest) {
        amc.byNode.set(req.node, result.manifest)
        const lrId = logicalRunByEngineRun.get(String(engineRunId))
        const lrec = lrId ? logicalRuns.get(lrId) : null
        if (lrec) {
          lrec.artifact_manifests = lrec.artifact_manifests || {}
          lrec.artifact_manifests[req.node] = result.manifest
          controlEvent(lrec, 'artifact_manifest_submitted', {
            node: req.node,
            revision: result.manifest.revision,
            materials_status: result.manifest.materials_status,
            required_complete: result.manifest.required_complete,
          })
          requestLogicalPersist(lrec.logical_run_id)
        }
      }
    }
    function artifactGateOf(engineRunId, nodeId) {
      const amc = amRuns.get(String(engineRunId || ''))
      if (!amc) return null
      const man = amc.byNode.get(String(nodeId || ''))
      return amc.kernel.gateBlockOf(man, nodeId)
    }

    // ── LOC-027 评价基线冻结契约（纯逻辑内核 = dist/evaluation-baseline.cjs，进程边界留在宿主）──
    // producer 业务放行时脚本输出 [eb-freeze] 请求行 → 子进程按原始字节算 SHA-256 并在
    // Run 产物目录按版本隔离保存不可变副本 → 检查点边界中止本段（复用 #80 abort）→
    // 成功=注入已核验引用自动恢复；文件缺失/不可读/摘要与模型声称值不符=BLOCKED 不进入
    // 执行；后续段收尾核验原路径，改写/证据缺失=基线冲突 BLOCKED（副本保留）。模型摘要
    // 不作权威值；未核验一律标 unverified。内核不可用（旧 dist）时闸门停用并留痕。
    let ebKernelPromise = null
    function ebKernel() {
      if (!ebKernelPromise) ebKernelPromise = loadDist('evaluation-baseline.cjs').catch(() => { ebKernelPromise = null; return null })
      return ebKernelPromise
    }
    // engineRunId → { decl, kernel, cwd, runDir, taskId, pending: Map<version, { req, promise }> }
    const ebRuns = new Map()
    const EB_GATE_MAX_RESUMES = 5
    function observeBaselineRequest(engineRunId, message) {
      const ebc = ebRuns.get(String(engineRunId || ''))
      if (!ebc) return
      const req = ebc.kernel.parseFreezeRequest(message)
      if (!req || ebc.pending.has(req.version)) return
      const payload = ebc.kernel.freezePayload({ artifact: ebc.decl.artifact, cwd: ebc.cwd, runDir: ebc.runDir, taskId: ebc.taskId, req: req })
      const freeze = runNode(['-e', ebc.kernel.snippetSource(), JSON.stringify(payload)], { graceMs: 30000 }).then((r) => ebc.kernel.parseSubprocessJson(r))
      ebc.pending.set(req.version, { req: payload, promise: freeze })
      const lrId = logicalRunByEngineRun.get(String(engineRunId))
      const lrec = lrId ? logicalRuns.get(lrId) : null
      if (lrec) {
        controlEvent(lrec, 'evaluation_baseline_freeze_requested', { version: req.version, source: payload.source, claimed_digest: req.claimed_digest, supersedes: req.supersedes })
        requestLogicalPersist(lrec.logical_run_id)
      }
    }
    // 冻结待决时在检查点边界中止本段（与 #80 安全暂停同机制：引擎在钩子边界抛 CANCELLED）
    function maybeAbortAtBaselinePending(engineRunId, message) {
      const ebc = ebRuns.get(String(engineRunId || ''))
      if (!ebc || !ebc.pending.size) return
      const raw = String(message || '')
      const idx = raw.indexOf('[pw-ckpt]')
      if (idx < 0) return
      try {
        const ck = JSON.parse(raw.slice(idx + '[pw-ckpt]'.length))
        if (!ck || typeof ck !== 'object' || ck.c === '$end') return
        const ctl = segmentCtrls.get(String(engineRunId || ''))
        if (ctl && typeof ctl.abort === 'function') ctl.abort()
      } catch (e) { /* 损坏行不作为中止依据 */ }
    }
    function ebBaselineArgs(rec) {
      if (!rec || !rec.evaluation_baseline) return {}
      return { evaluation_baseline: deepCloneData(rec.evaluation_baseline), evaluation_baseline_version: rec.evaluation_baseline.version }
    }
    // 段收尾闸门：等待本段全部冻结结果。失败（缺失/不可读/摘要不符）→ 结构化 BLOCKED；
    // 成功且段被中止 → 从检查点注入已核验引用自动恢复（返回恢复段结果）。非取消段
    // （无中止能力/竞速）只入档已核验引用，本段不再恢复。
    async function runBaselineGate(env) {
      const { logicalRec, engineRunId, result, execScript, meta, scriptArgs, parent, segCtl, taskId, ws, wsIdentity, engine: gateEngine } = env
      const ebc = ebRuns.get(String(engineRunId || ''))
      if (!ebc || !ebc.pending.size) return null
      const versions = [...ebc.pending.keys()].sort((a, b) => a - b)
      const version = versions[versions.length - 1]
      const pending = ebc.pending.get(version)
      const frozen = await pending.promise
      const block = ebc.kernel.gateBlockOf(frozen, pending.req, ebc.decl.producerNode)
      if (block) {
        controlEvent(logicalRec, block.event, { version: version, code: String((frozen && frozen.code) || 'FREEZE_FAILED'), error: String((frozen && frozen.error) || ''), claimed: pending.req.claimed_digest, actual: frozen && frozen.digest !== undefined ? String(frozen.digest) : null })
        requestLogicalPersist(logicalRec.logical_run_id)
        return { handled: true, blocked: true, version: version, code: block.code, message: block.message, recovery_hint: block.recovery_hint }
      }
      const ref = ebc.kernel.baselineRefOf(frozen, pending.req, ebc.taskId)
      logicalRec.evaluation_baseline = ref
      logicalRec.evaluation_baselines = (logicalRec.evaluation_baselines || []).concat([ref])
      controlEvent(logicalRec, 'evaluation_baseline_frozen', { version: version, digest: ref.digest, artifact_path: ref.artifact_path })
      requestLogicalPersist(logicalRec.logical_run_id)
      if (!result || result.stopReason !== 'cancelled') return { handled: true, blocked: false, resumed: false }
      // 段被中止：从检查点重建现场，注入已核验基线引用自动恢复
      const ck = extractCheckpoint(runs.get(String(engineRunId)))
      if (!ck || ck.degraded || !ck.entry) {
        return { handled: true, blocked: true, version: version, code: 'EVALUATION_BASELINE_RESUME_LOST', message: '评价基线 v' + version + ' 冻结成功，但该段无可用检查点现场，无法自动恢复后续节点。', recovery_hint: '人工确认续跑入口后用 wf_run entry=<节点id> 续跑；续跑参数将携带已核验基线引用' }
      }
      const cap = capabilityFor(wsIdentity)
      const fresh = await wsHostCall('get', { logical_run_id: wsIdentity, capability: cap }).catch(() => ({ ok: false }))
      const resumeArgs = ebc.kernel.resumeArgsOf(scriptArgs, ck, deepCloneData(ref))
      if (fresh && fresh.ok && fresh.workspace) Object.assign(resumeArgs, scriptArgsFromWorkspace(fresh.workspace, cap))
      const resumeReq = { script: execScript, meta: meta, args: resumeArgs, parent: parent }
      if (segCtl) resumeReq.signal = segCtl.signal
      if (ws && ws.source_path) { resumeReq.cwd = ws.source_path; resumeReq.workspaceRoot = ws.source_path }
      const resumed = gateEngine.start(resumeReq)
      const resumedId = String(resumed.id)
      const resumedRec = ensureRun(resumedId)
      resumedRec.taskId = taskId
      resumedRec.workflowId = logicalRec.template_id
      live.add(resumedId)
      persist(resumedId)
      onRun(String(engineRunId), (r) => { r.supersededBy = resumedId })
      ebRuns.set(resumedId, { decl: ebc.decl, kernel: ebc.kernel, cwd: ebc.cwd, runDir: ebc.runDir, taskId: ebc.taskId, pending: new Map() })
      if (segCtl) segmentCtrls.set(resumedId, segCtl)
      appendLogicalSegment(logicalRec, resumedId, 'evaluation_baseline_resume')
      logicalSetState(logicalRec, 'RUNNING', null)
      requestLogicalPersist(logicalRec.logical_run_id)
      let resumedResult
      try { resumedResult = await resumed.result } catch (e) {
        segmentCtrls.delete(resumedId)
        endLogicalSegment(logicalRec, resumedId, 'ENGINE_ERROR')
        logicalSetState(logicalRec, 'FAILED', logicalReason('ENGINE_ERROR', errMsg(e)))
        requestLogicalPersist(logicalRec.logical_run_id)
        return { handled: true, blocked: true, version: version, code: 'EVALUATION_BASELINE_RESUME_FAILED', message: '评价基线恢复段引擎失败：' + errMsg(e) }
      }
      segmentCtrls.delete(resumedId)
      endLogicalSegment(logicalRec, String(engineRunId), 'CANCELLED_BASELINE_FREEZE')
      const resumedCanon = resumedResult && resumedResult.stopReason === 'completed' ? canonicalStop(resumedResult) : ''
      if (resumedCanon) onRun(resumedId, (r) => { r.status = resumedCanon; applyHdValue(r, resumedResult.value) })
      if (resumedResult && resumedResult.error) onRun(resumedId, (r) => { r.error_detail = String(resumedResult.error).slice(0, 500) })
      endLogicalSegment(logicalRec, resumedId, resumedCanon || String((resumedResult && resumedResult.stopReason) || ''))
      controlEvent(logicalRec, 'evaluation_baseline_resumed', { version: version, entry: ck.entry, resume_run_id: resumedId, terminal: resumedCanon || String((resumedResult && resumedResult.stopReason) || '') })
      requestLogicalPersist(logicalRec.logical_run_id)
      return {
        handled: true,
        blocked: false,
        resumed: true,
        result: resumedResult,
        canon: resumedCanon,
        runId: resumedId,
        seededKeys: new Set(Object.keys(ck.results || {})),
      }
    }
    // 已核验基线的事后核验：原路径与冻结副本逐字节比对（改写/缺失=基线冲突）。
    // 核验基础设施故障（清单/副本缺失、子进程失败）按 fail closed 处理，不把证据缺失包装为成功。
    async function verifyBaselineOriginal(ebk, rec) {
      const ref = rec && rec.evaluation_baseline
      if (!ref || ref.status !== 'verified' || !ref.source_path || !ref.artifact_path) return null
      return ebk.parseSubprocessJson(await runNode(['-e', ebk.snippetSource(), JSON.stringify(ebk.verifyPayloadOf(ref))], { graceMs: 30000 }))
    }
    // 从 run 记录日志提取最后一条检查点（脚本每完成一个节点路由后输出）。
    // 无检查点 = 该段无可用现场（旧脚本/解析失败）：恢复退化为人工指定 entry，不猜。
    function extractCheckpoint(runRec) {
      if (!runRec) return null
      if (srcMod) return srcMod.extractCheckpointFromLogs(runRec.logs)
      for (let i = runRec.logs.length - 1; i >= 0; i--) {
        const line = String(runRec.logs[i] || '')
        const idx = line.indexOf('[pw-ckpt]')
        if (idx < 0) continue
        try {
          const ck = JSON.parse(line.slice(idx + '[pw-ckpt]'.length))
          if (ck && typeof ck === 'object' && typeof ck.c === 'string' && ck.c && ck.c !== '$end') {
            return {
              entry: ck.c,
              results: ck.r && typeof ck.r === 'object' ? ck.r : {},
              history: Array.isArray(ck.h) ? ck.h : [],
              round: Number(ck.rd) || 0,
              feedback: typeof ck.fb === 'string' ? ck.fb : '',
              budgetUsed: Number(ck.bu) || 0,
              maxRounds: Number(ck.mr) || 0,
              decisionSeq: Number(ck.ds) || 0,
              degraded: false,
              ...(ck.tb && { technical_budget: ck.tb }),
            }
          }
        } catch (e) { /* 损坏行跳过，继续向前找 */ }
      }
      return { entry: null, results: {}, history: [], round: 0, feedback: '', budgetUsed: 0, maxRounds: 0, decisionSeq: 0, degraded: true }
    }
    // Guidance Record（Run 级适用）：mode=coach 普通指导；mode=baseline 实质基线变更，
    // 必须提供新基线要点并产生追加式 Baseline Revision（配对提交，无孤儿 Guidance）。
    function appendGuidanceRecord(rec, { text, mode, new_baseline }) {
      if (!(typeof text === 'string' && text.trim())) {
        return { ok: false, error: 'Guidance 内容不能为空：请提供 text。' }
      }
      const m = mode === 'baseline' ? 'baseline' : 'coach'
      if (m === 'baseline' && !(typeof new_baseline === 'string' && new_baseline.trim())) {
        return { ok: false, error: '改基线声明必须提供 new_baseline（新基线要点）：实质基线变更不允许只留意图不留内容。' }
      }
      const seq = rec.guidance.length + 1
      const g = { seq: seq, mode: m, text: String(text || ''), at: Date.now() }
      if (m === 'baseline') {
        g.new_baseline = String(new_baseline).trim()
        const revision = { revision: rec.baseline_revisions.length + 1, text: g.new_baseline, guidance_seq: seq, created_at: g.at }
        rec.baseline_revisions.push(revision)
        // 受影响 Proof 保守全失效（运行时依赖图信息不足时的既定口径，规格 §18）：
        // 基线变更前产生的业务结果标记 stale，重跑通过后由新结果自然覆盖。
        for (const k of Object.keys(rec.business_outcomes || {})) {
          const bo = rec.business_outcomes[k]
          if (bo && !bo.stale) { bo.stale = true; bo.stale_reason = 'BASELINE_CHANGE_R' + revision.revision }
        }
        controlEvent(rec, 'baseline_change', { revision: revision.revision, guidance_seq: seq })
      }
      rec.guidance.push(g)
      controlEvent(rec, 'guidance', { guidance_seq: seq, mode: m })
      requestLogicalPersist(rec.logical_run_id)
      return { ok: true, guidance: g }
    }
    // 恢复载荷：检查点现场 + 适用 Guidance（Run 级，全部窗口）+ 待生效基线修订。
    // 实质基线变更未被消费时（baseline_applied_upto 之后仍有修订），恢复回跳基线
    // 负责节点整体重跑——v0.1 = Rev1 冻结工作流的入口节点（建设模板即 preflight；
    // 其余模板由 #82 承接），变更前业务结果已保守标失效，重跑后由新结果覆盖恢复。
    function buildPauseResumeArgs(rec) {
      const pr = rec.pause_resume || null
      if (!pr) return null
      const applied = rec.baseline_applied_upto || 0
      const pending = (rec.baseline_revisions || []).filter((r) => r.revision > applied)
      const rev1Dsl = rec.snapshots && rec.snapshots[0] && rec.snapshots[0].workflow && rec.snapshots[0].workflow.dsl
      const built = srcMod ? srcMod.buildPauseResumePayload({
        pauseResume: {
          entry: pr.entry,
          results: deepCloneData(pr.results && typeof pr.results === 'object' ? pr.results : {}),
          history: Array.isArray(pr.history) ? deepCloneData(pr.history) : [],
          round: Number(pr.round) || 0,
          feedback: typeof pr.feedback === 'string' ? pr.feedback : '',
          budgetUsed: Number(pr.budgetUsed) || 0,
          maxRounds: Number(pr.maxRounds) || 0,
          decisionSeq: Number(pr.decisionSeq) || 0,
          technical_budget: pr.technical_budget || undefined,
        },
        baselineRevisions: rec.baseline_revisions || [],
        baselineAppliedUpto: applied,
        rev1Entry: rev1Dsl && rev1Dsl.entry ? rev1Dsl.entry : null,
        guidance: rec.guidance || [],
        extraArgs: ebBaselineArgs(rec),
      }) : null
      if (built) return built
      const args = {
        entry: pr.entry || undefined,
        results: pr.results && typeof pr.results === 'object' ? deepCloneData(pr.results) : {},
        history: Array.isArray(pr.history) ? deepCloneData(pr.history) : [],
        startRound: Number(pr.round) || 0,
        feedback: typeof pr.feedback === 'string' ? pr.feedback : '',
        budgetUsed: Number(pr.budgetUsed) || 0,
        maxRounds: Number(pr.maxRounds) || 0,
        decisionSeq: Number(pr.decisionSeq) || 0,
        technical_budget: pr.technical_budget || undefined,
      }
      const lastRev = pending.length ? pending[pending.length - 1] : (rec.baseline_revisions || [])[rec.baseline_revisions.length - 1]
      if (lastRev) args.baseline_amendment = lastRev.text
      let rebaseBlocked = false
      if (pending.length) {
        if (rev1Dsl && rev1Dsl.entry) args.entry = rev1Dsl.entry
        else rebaseBlocked = true
      }
      const coach = (rec.guidance || []).filter((g) => g.mode === 'coach' && g.text)
      if (coach.length) args.guidance_text = coach.map((g) => '- ' + g.text).join('\n')
      Object.assign(args, ebBaselineArgs(rec))
      return { args: args, pendingRebase: pending.length > 0, rebaseBlocked: rebaseBlocked }
    }

    ctx.on('workflow/start', (info) => {
      const rec = ensureRun(info.id)
      rec.meta = { name: String((info.meta && info.meta.name) || ''), description: String((info.meta && info.meta.description) || '') }
      persist(rec.id)
    })
    const onRun = (id, mutate) => { const rec = runs.get(String(id)); if (rec) { mutate(rec); persist(rec.id) } }
    const pushLog = (rec, line) => { rec.logs.push(String(line)); if (rec.logs.length > 50) rec.logs.shift() }
    ctx.on('workflow/phase', (info, title) => onRun(info.id, (rec) => { rec.phase = String(title); pushLog(rec, '[phase] ' + title) }))
    ctx.on('workflow/log', (info, message) => {
      onRun(info.id, (rec) => pushLog(rec, message))
      maybeAbortAtCheckpoint(info.id, message)
      // LOC-027 评价基线：冻结请求观察 + 冻结待决时的检查点中止
      observeBaselineRequest(info.id, message)
      maybeAbortAtBaselinePending(info.id, message)
      observeArtifactSubmit(info.id, message)
      attk().then((t) => t.line(info.id, message)).catch(() => { /* 内核缺失：段末扫描回退 */ })
    })
    ctx.on('workflow/agent-start', (info, agent) => onRun(info.id, (rec) => rec.agents.push({ seq: agent.seq, label: String(agent.label || ''), phase: agent.phase ? String(agent.phase) : '', outcome: 'running' })))
    // 按 seq 精确匹配：pipeline 并发下 agent-start/agent-end 可能交错到达
    ctx.on('workflow/agent-end', (info, agent) => onRun(info.id, (rec) => { const a = rec.agents.find((x) => x.seq === agent.seq); if (a) a.outcome = String(agent.outcome) }))
    ctx.on('workflow/end', (info, result) => {
      live.delete(String(info.id))
      // LOC-027：无待决冻结的基线上下文随段结束回收（待决条目等待闸门消费，不在此删）
      const ebcEnd = ebRuns.get(String(info.id || ''))
      if (ebcEnd && ebcEnd.pending.size === 0) ebRuns.delete(String(info.id || ''))
      amRuns.delete(String(info.id || ''))
      onRun(info.id, (rec) => {
        // wf_run 已回写的脚本权威终态（WAITING_HUMAN / DONE / …）不得被迟到的 end 盖掉
        if (!TERMINAL_STATUS_RE().test(String(rec.status || ''))) rec.status = String(result.stopReason)
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
    // 续跑启动后：同 taskId 的停机记录标记接管，旧卡片退出门禁队列（#80：PAUSED 同理）
    function supersedeParked(taskId, newRunId) {
      for (const rec of runs.values()) {
        if (rec.id === newRunId || rec.taskId !== taskId || rec.supersededBy) continue
        if (isHumanWait(rec.status) || isParkedHd(rec) || rec.status === 'PAUSED') { rec.supersededBy = newRunId; persist(rec.id) }
      }
    }
    function canonicalStop(result) {
      return srcMod ? srcMod.canonicalStopFromResult(result) : (function () {
        const v = result && result.value
        const cand = v && typeof v === 'object' && typeof v.status === 'string' ? v.status : (typeof v === 'string' ? v : '')
        return TERMINAL_STATUS_RE().test(cand) ? cand : ''
      })()
    }
    // 脚本终态 → workspace 生命周期：人工等待保留，DONE 完成，STOPPED 停止，
    // BLOCKED 可恢复受阻（LOC-030：不落 FAILED，恢复后继续同一 Run），其余失败
    function lifecycleFor(canon, stopReason) {
      return srcMod ? srcMod.lifecycleForStatus(canon, stopReason) : (function () {
        if (canon === 'DONE') return 'COMPLETED'
        if (canon === 'STOPPED') return 'STOPPED'
        if (canon === 'BLOCKED') return 'BLOCKED'
        if (isHumanWait(canon)) return 'WAITING_HUMAN'
        if (canon || stopReason === 'cancelled' || stopReason === 'error') return 'FAILED'
        return null
      })()
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
    // ── LOC-014 模型覆盖 RPC：仅内置模板可保存/清除（结构改动仍须另存为自定义）──
    registerRpc('vwf.workflows.modelOverride.get', async (a) => {
      const id = a && a.id
      if (!id || typeof id !== 'string') return fail('缺少模板 id', '$.id')
      if (!safeTemplateId(id)) return fail('非法模板 id：' + id, '$.id')
      if (fs === undefined) return fail('宿主文件能力不可用：无法读取模型覆盖')
      const d = await homeDirs()
      if (!d) return fail('无法解析 DSH Home：无法读取模型覆盖')
      return { ok: true, id, overrides: (await loadModelOverrides()).get(id) || {} }
    })
    registerRpc('vwf.workflows.modelOverride.save', async (a) => {
      const id = a && a.id
      if (!id || typeof id !== 'string') return fail('缺少模板 id', '$.id')
      if (!safeTemplateId(id)) return fail('非法模板 id：' + id, '$.id')
      if (fs === undefined) return fail('宿主文件能力不可用：无法保存模型覆盖')
      const d = await homeDirs()
      if (!d) return fail('无法解析 DSH Home：无法保存模型覆盖')
      if (!(await splitGenerated()).builtins.has(id)) return fail('仅内置模板支持模型覆盖：' + id + ' 不是内置模板（自定义模板请直接编辑其绑定）', '$.id')
      const ov = sanitizeOverride(a.overrides && typeof a.overrides === 'object' && !Array.isArray(a.overrides) ? a.overrides : {})
      if (!Object.keys(ov).length) return fail('覆盖内容为空：请至少填写一个节点（或默认）的 Provider 与 Model；如需恢复默认请使用清除覆盖', '$.overrides')
      try { await writeText(d.modelOverridesDir + '/' + id + '.json', JSON.stringify(ov, null, 2) + '\n') } catch (e) { return fail('模型覆盖落盘失败：' + errMsg(e)) }
      return { ok: true, id, overrides: ov }
    })
    registerRpc('vwf.workflows.modelOverride.clear', async (a) => {
      const id = a && a.id
      if (!id || typeof id !== 'string') return fail('缺少模板 id', '$.id')
      if (!safeTemplateId(id)) return fail('非法模板 id：' + id, '$.id')
      if (fs === undefined) return fail('宿主文件能力不可用：无法清除模型覆盖')
      const d = await homeDirs()
      if (!d) return fail('无法解析 DSH Home：无法清除模型覆盖')
      // 仅正式内置才有本机制写出的覆盖文件：非内置 id 直接幂等成功（不触碰文件系统）
      if (!(await splitGenerated()).builtins.has(id)) return { ok: true, id }
      const r = await rm(d.modelOverridesDir + '/' + id + '.json')
      if (r && r.ok === false) return fail('模型覆盖清除失败：' + (r.detail || ''))
      return { ok: true, id }
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
        const prepared = await prepareRunWorkspace({ taskId: taskId, templateId: a.templateId || v.sanitized.id, baseBranch: a.baseBranch || 'main', declaredWorkspace: v.sanitized.workspace, resourceKind: a.resource_kind })
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
            hydrateLogicalRunFromDisk(JSON.parse(await fs.readText(await fs.resolve(d.logicalRunsDir + '/' + logicalStore.fileOf(id)))))
          } catch (e) { /* 不存在或损坏：按缺失返回 */ }
          rec = logicalRuns.get(id)
        }
      }
      if (!rec) return { found: false, record: null }
      return { found: true, record: logicalRunPayload(rec) }
    })
    // LOC-008：Formal Records 单一提交/查询通道（commit 同时供 wf_run 收尾与
    // 显式调用；list/get 按 logical_run_id 查询，重启后直读磁盘 Store）。
    registerRpc('vwf.records.commit', async (a) => {
      const id = String((a && a.logical_run_id) || '')
      if (!id || !Array.isArray(a.entries) || !a.entries.length) return fail('缺少 logical_run_id / entries')
      return recordsHostCall('commit', { logical_run_id: id, logical_run_ref: a.logical_run_ref, entries: a.entries })
    })
    registerRpc('vwf.records.list', async (a) => {
      const id = String((a && a.logical_run_id) || '')
      if (!id) return fail('缺少 logical_run_id')
      // LOC-029：可选 node / attempt_id 过滤——按 Run/Node/Attempt 获取逐次记录
      return recordsHostCall('list', { logical_run_id: id, node: a && a.node, attempt_id: a && a.attempt_id })
    })
    registerRpc('vwf.records.get', async (a) => {
      const id = String((a && a.logical_run_id) || '')
      const recordId = String((a && a.record_id) || '')
      if (!id || !recordId) return fail('缺少 logical_run_id / record_id')
      return recordsHostCall('get', { logical_run_id: id, record_id: recordId })
    })
    // LOC-043：质量成本 metrics（消费 attempt 记录 + 质量证据；可重建 JSON + 人读摘要）
    async function qualityCostCall(cmd, input, opts) {
      if (!QUALITY_COST_HOST || (await readTextIfExists(QUALITY_COST_HOST)) === null) {
        return { ok: false, notFound: true, error: 'run-quality-cost.mjs 未找到（LOC-043 运行时集成未部署）' }
      }
      const r = await runNode([QUALITY_COST_HOST, cmd, JSON.stringify(input || {})], { graceMs: (opts && opts.graceMs) || 30000, maxBytes: 1024 * 1024 })
      if (!r.ok) return { ok: false, error: 'quality cost 调用失败：' + r.detail }
      try {
        const parsed = JSON.parse(r.stdout)
        return parsed.ok ? parsed : { ok: false, error: parsed.error || 'quality cost 业务错误' }
      } catch (e) { return { ok: false, error: 'quality cost 输出不可解析：' + errMsg(e), raw: r.stdout } }
    }
    async function buildMetricsForRun(id, priceTable) {
      let rec = logicalRuns.get(id)
      if (!rec) {
        const d = fs === undefined ? null : await homeDirs()
        if (d) {
          try {
            hydrateLogicalRunFromDisk(JSON.parse(await fs.readText(await fs.resolve(d.logicalRunsDir + '/' + logicalStore.fileOf(id)))))
          } catch (e) { /* miss */ }
          rec = logicalRuns.get(id)
        }
      }
      const list = await recordsHostCall('list', { logical_run_id: id })
      if (!list.ok) return list
      return qualityCostCall('build', {
        logical_run_id: id,
        template_id: rec ? rec.template_id : null,
        attempts: list.attempts || [],
        human_waits: rec ? rec.human_waits || [] : [],
        records: list.records || [],
        price_table: priceTable || null,
      })
    }
    registerRpc('vwf.metrics.get', async (a) => {
      const id = String((a && a.logical_run_id) || '')
      if (!id) return fail('缺少 logical_run_id')
      const built = await buildMetricsForRun(id, a && a.price_table ? a.price_table : null)
      if (!built.ok) return built
      const rep = await qualityCostCall('report', { metrics: built.metrics })
      return { ok: true, logical_run_id: id, metrics: built.metrics, report: rep.ok ? rep.report : null }
    })
    registerRpc('vwf.metrics.compare', async (a) => {
      const ids = Array.isArray(a && a.logical_run_ids) ? a.logical_run_ids.map(String).filter(Boolean) : []
      if (!ids.length) return fail('缺少 logical_run_ids')
      const runs = []
      for (const id of ids) {
        const built = await buildMetricsForRun(id, a && a.price_table ? a.price_table : null)
        if (!built.ok) return built
        runs.push(built.metrics)
      }
      const cmp = await qualityCostCall('compare', { runs })
      if (!cmp.ok) return cmp
      return { ok: true, comparison: cmp.comparison, runs }
    })
    // LOC-032：受管理外部操作入口（execute-or-reconcile）。已确认成功只确认不重复执行；
    // 结果不确定先核查，无法核查时 NEEDS_RECONCILIATION 受阻（unknown 禁止再次执行）。
    // 必填字段缺失在宿主侧拒绝；授权/能力/冲突等业务码由内核返回（operationsHostCall 透传）。
    const opCall = (cmd, a, fields) => {
      for (const k of fields) if (!String(((a || {})[k]) || '').trim()) return fail('缺少 ' + k)
      return operationsHostCall(cmd, a)
    }
    registerRpc('vwf.operations.execute', (a) => opCall('execute', a, ['run_id', 'logical_action', 'target', 'authorization_scope', 'authorization_ref']))
    registerRpc('vwf.operations.reconcile', (a) => opCall('reconcile', a, ['run_id', 'logical_action']))
    registerRpc('vwf.operations.get', (a) => opCall('get', a, ['run_id', 'logical_action']))
    registerRpc('vwf.operations.list', (a) => opCall('list', a, ['run_id']))
    // LOC-037：收口交付动作（事实整理 / 动作计划 / 完整收口）。必填 run_id；closeout 另需 operations_dir。
    const deliveryCall = (cmd, a, fields) => {
      for (const k of fields) if (!String(((a || {})[k]) || '').trim()) return fail('缺少 ' + k)
      return deliveryCloseoutHostCall(cmd, a)
    }
    registerRpc('vwf.delivery.gatherFacts', (a) => deliveryCall('gather-facts', a, ['run_id']))
    registerRpc('vwf.delivery.planActions', (a) => deliveryCall('plan-actions', a, ['run_id']))
    registerRpc('vwf.delivery.closeout', (a) => deliveryCall('closeout', a, ['run_id']))
    registerRpc('vwf.artifacts.ingest', async (a) => {
      const { runId, nodeId, artifacts } = a
      if (!runId || !nodeId || !Array.isArray(artifacts) || !artifacts.length) return fail('缺少 runId / nodeId / artifacts')
      const rec = runs.get(String(runId))
      if (!rec) return fail('运行记录不存在：' + runId, '$.runId')
      let core
      try { core = await loadDist('formal-artifacts.cjs') } catch (e) { return fail('Formal Artifact 内核不可用：' + errMsg(e)) }
      const provenance = {
        logical_run_id: String(runId), node: String(nodeId), attempt: a.attempt || 1,
        snapshot_revision: a.snapshot_revision || 'unspecified', provider: a.provider || 'unknown', model: a.model || 'unknown',
        produced_by: a.produced_by || 'vwf:artifacts.ingest', node_business_outcome: a.outcome !== undefined ? a.outcome : null,
      }
      try {
        rec.formalRecords = core.ingestArtifacts(rec.formalRecords, {
          runId: String(runId), nodeId: String(nodeId), artifacts: artifacts, outcome: a.outcome !== undefined ? a.outcome : null,
          provenance,
        })
      } catch (e) { return fail(errMsg(e)) }
      // LOC-008 升级：legacy formalRecords 字段保留兼容，同时经单一通道写入正式
      // Store（artifact:<runId>:<node>:<path>，#69 record_id 约定不变）。提交失败
      // 不回滚 legacy 行为（非阻断，与既有 ingest 语义一致）。
      let storeCommitted = null
      const lrId = logicalRunByEngineRun.get(String(runId)) || String(runId)
      const store = await recordsHostCall('commit', {
        logical_run_id: lrId,
        entries: artifacts.map((art) => ({
          type: 'artifact',
          record_id: core.artifactRecordId(String(runId), String(nodeId), art.path),
          provenance: { ...provenance, logical_run_id: lrId, node_business_outcome: a.outcome !== undefined ? a.outcome : null },
          kind: art.kind,
          body_value: art.content,
        })),
      })
      if (store.ok) storeCommitted = { logical_run_id: lrId, committed: store.committed, record_count: store.record_count }
      else if (!store.notFound) log('Formal Records 产物入库失败（legacy 记录不受影响）：' + store.error)
      persist(rec.id)
      return { ok: true, formalRecords: rec.formalRecords, produced: artifacts.length, taskId: rec.taskId, store_committed: storeCommitted }
    })
    // #80 运行控制面：pause / interrupt（RUNNING 专属）与 guidance（PAUSED 专属）。
    // 状态语义不混用：WAITING_HUMAN 归 Human Decision 流程、BLOCKED 归外部条件恢复。
    registerRpc('vwf.run.control', async (a) => {
      await runsHydration
      try { if (typeof logicalRunsHydration !== 'undefined' && logicalRunsHydration) await logicalRunsHydration } catch (e) { /* 回载失败已留痕 */ }
      const action = String((a && a.action) || '')
      const lrId = String((a && a.logical_run_id) || '')
      const rec = logicalRuns.get(lrId)
      if (!rec) return fail('逻辑运行不存在：' + lrId, '$.logical_run_id')
      if (rec.terminal) return fail('逻辑运行已终态（' + rec.lifecycle.state + '），控制面不可用：' + lrId)
      if (action === 'pause' || action === 'interrupt') {
        if (rec.lifecycle.state !== 'RUNNING') return fail('仅 RUNNING 的逻辑运行可' + (action === 'interrupt' ? '中断' : '暂停') + '；当前为 ' + rec.lifecycle.state + '（WAITING_HUMAN / BLOCKED / PAUSED 三态语义不混用）')
        const activeSeg = rec.segments.find((s) => s.active) || null
        if (!activeSeg) return fail('无活动执行段，无法下发控制')
        const ctl = segmentCtrls.get(String(activeSeg.run_id))
        if (!ctl || typeof ctl.abort !== 'function') return fail('运行控制通道不可用（宿主不支持中止，或该段已收尾/宿主已重启）：控制请求被拒绝，不静默无效。')
        if (rec.pause_state) {
          // §11.2：等待检查点的暂停请求可升级为立即中断；其余重复请求拒绝
          if (rec.pause_state.action === 'pause' && action === 'interrupt') {
            rec.pause_state.action = 'interrupt'
            controlEvent(rec, 'interrupt_requested', { run_id: String(activeSeg.run_id), upgraded_from: 'pause' })
            requestLogicalPersist(lrId)
            try { ctl.abort() } catch (e) { return fail('中止信号下发失败：' + errMsg(e)) }
            return { ok: true, action: 'interrupt', state: 'requested', upgraded: true, logical_run_id: lrId, run_id: String(activeSeg.run_id) }
          }
          return fail('已有待生效的 ' + rec.pause_state.action + ' 请求，请等待其生效。')
        }
        rec.pause_state = { action: action, requested_at: Date.now() }
        controlEvent(rec, action === 'interrupt' ? 'interrupt_requested' : 'pause_requested', { run_id: String(activeSeg.run_id) })
        requestLogicalPersist(lrId)
        if (action === 'interrupt') {
          // Interrupt 不等检查点：立即中止（当前 Attempt 即刻终止）
          try { ctl.abort() } catch (e) { rec.pause_state = null; requestLogicalPersist(lrId); return fail('中止信号下发失败：' + errMsg(e)) }
        }
        // pause 不在此处 abort：workflow/log 检查点观察者会在最近完成节点的检查点后中止
        return { ok: true, action: action, state: 'requested', logical_run_id: lrId, run_id: String(activeSeg.run_id) }
      }
      if (action === 'guidance') {
        if (rec.lifecycle.state !== 'PAUSED') return fail('仅 PAUSED 的逻辑运行可提交 Guidance；当前为 ' + rec.lifecycle.state + '（Guidance 与 Human Decision / BLOCKED 语义不混用）')
        const r = appendGuidanceRecord(rec, { text: a && a.text, mode: a && a.mode, new_baseline: a && a.new_baseline })
        if (!r.ok) return fail(r.error)
        // 顺带 persist 最近段的 run 记录：看板以 run.updatedAt 驱动 PAUSED 卡刷新
        const lastSeg = rec.segments[rec.segments.length - 1]
        const rr = lastSeg ? runs.get(String(lastSeg.run_id)) : null
        if (rr) persist(rr.id)
        return { ok: true, guidance: r.guidance, baseline_revisions: rec.baseline_revisions.length, logical_run_id: lrId }
      }
      return fail('未知 action：' + action + '（可用：pause | interrupt | guidance）')
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
        // 业务错误对象整包透传（保留 code/conflicts 等结构化字段，LOC-017 闸门按 code 路由）
        return parsed.ok ? parsed : Object.assign({ ok: false, error: parsed.error || 'workspace host 业务错误', detail: parsed.detail }, parsed)
      } catch (e) { return { ok: false, error: 'workspace host 输出不可解析：' + errMsg(e), raw: r.stdout } }
    }
    // 模板 → 隔离策略类型（LOC-009）：以 Core TEMPLATE_REGISTRY 为权威，不再按
    // 模板 id 名字猜测。解析顺序：① templateId 精确等于注册表键；
    // ② 模板声明的 workspace.template_id（蓝图 meta 字段，投影双向同步）；
    // ③ 保守默认 construction（ISOLATED_WRITE git worktree）。
    let templateRegistryPromise = null
    function templateRegistry() {
      if (!templateRegistryPromise) {
        templateRegistryPromise = wsHostCall('templateRegistry', {})
          .then((r) => (r && r.ok && r.registry && typeof r.registry === 'object' ? r.registry : null))
          .catch(() => null)
          .then((reg) => {
            // 失败不缓存：瞬时故障不得把本进程后续 allocate 永久钉死在保守默认
            if (!reg) templateRegistryPromise = null
            return reg
          })
      }
      return templateRegistryPromise
    }
    function declaredWorkspaceTemplate(declared) {
      return (declared && typeof declared === 'object' && !Array.isArray(declared)) ? declared : null
    }
    async function resolveTemplateKind(templateId, declared) {
      const reg = await templateRegistry()
      const id = String(templateId || '')
      if (reg) {
        if (Object.prototype.hasOwnProperty.call(reg, id)) return id
        const decl = declaredWorkspaceTemplate(declared)
        const declaredKind = decl ? String(decl.template_id || '') : ''
        if (declaredKind && Object.prototype.hasOwnProperty.call(reg, declaredKind)) return declaredKind
      }
      // 注册表不可得（包装脚本未部署等）时同样保守默认：allocate 路径本就会
      // notFound 回退旧行为，此处不做 id 猜测。
      return 'construction'
    }
    // optimize 的 resource_kind：运行参数显式传入优先，其次模板声明；都不给则
    // 缺省交给 Core 策略解析 fail closed（optimize 必须提供 resource_kind）。
    function resolveResourceKind(explicit, declared) {
      const decl = declaredWorkspaceTemplate(declared)
      return String(explicit || (decl && decl.resource_kind) || '') || undefined
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
        // LOC-013：隔离模式随现场注入脚本（ISOLATED_READ 时运行上下文标注 source 只读）
        workspace_mode: ws.workspace_mode || undefined,
      }
    }
    // LOC-026：候选捕获范围缺省由包装脚本侧排除 Run 产物目录（与编译脚本 RUNDIR 同源）
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
      const templateId = await resolveTemplateKind(opts.templateId, opts.declaredWorkspace)
      const resourceKind = resolveResourceKind(opts.resourceKind, opts.declaredWorkspace)
      const alloc = await wsHostCall('allocate', { logical_run_id: taskId, template_id: templateId, resource_kind: resourceKind, repository_path: projectRoot() || null, base_ref: opts.baseBranch || 'main', task_identity: taskId })
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
    // 携带 Run 身份的载荷统一组装 logical_run_id（A4：包装脚本侧仍只信注册表解析）
    const runArgs = (f) => (a, id) => ({ logical_run_id: id, ...f(a) })
    const WS_OPS = {
      // allocate 的模板解析要查注册表（异步）：build 为 async，模板 id 与
      // resource_kind 在进入包装脚本前已解析为最终值
      allocate: ['allocate', false, async (a) => ({
        logical_run_id: str(a.taskId), template_id: await resolveTemplateKind(a.templateId, a.declared_workspace), resource_kind: resolveResourceKind(a.resource_kind, a.declared_workspace), repository_path: a.repository_path || null, repository: a.repository || null,
        base_ref: a.baseBranch || 'main', base_commit: a.base_commit || null, work_branch: a.work_branch || null, task_identity: str(a.taskId), allow_parallel: !!a.allow_parallel,
      })],
      get: ['get', true, runArgs(() => ({}))],
      setLifecycle: ['setLifecycle', true, runArgs((a) => ({ lifecycle: str(a.lifecycle), extra: a.extra || {} }))],
      recordSourceSync: ['recordSourceSync', true, runArgs((a) => ({ current_head: a.current_head || undefined, source_revision: a.source_revision || undefined }))],
      // 只接收 Run 身份，权威 workspace 由包装脚本从注册表解析，不信任调用方传入的路径
      buildProvenance: ['buildAttemptProvenance', true, runArgs((a) => ({ node: str(a.node), attempt: Number(a.attempt || 1) }))],
      // LOC-026：候选证明（捕获范围由包装脚本缺省构造）
      captureCandidate: ['captureCandidate', true, runArgs(() => ({}))],
      acquireLock: ['acquireLock', true, runArgs((a) => ({ resource_key: str(a.resource_key), owner: str(a.owner), ttl_ms: a.ttl_ms || undefined }))],
      releaseLock: ['releaseLock', true, runArgs((a) => ({ lock_id: str(a.lock_id), owner: str(a.owner), reason: a.reason || undefined }))],
      cleanup: ['cleanup', true, runArgs((a) => ({ opts: a.opts || {} }))],
      writeSource: ['writeSourceFile', true, runArgs((a) => ({ rel: str(a.rel), content: str(a.content) }))],
      readSource: ['readSourceFile', true, runArgs((a) => ({ rel: str(a.rel) }))],
      writeWorker: ['writeWorkerFile', true, runArgs((a) => ({ worker_id: str(a.worker_id), rel: str(a.rel), content: str(a.content) }))],
      readWorker: ['readWorkerFile', true, runArgs((a) => ({ worker_id: str(a.worker_id), rel: str(a.rel) }))],
      checkpoint: ['computeIntegrationCheckpointFromRepo', false, (a) => ({ base_ref: str(a.base_ref), base_commit: str(a.base_commit), repository_path: str(a.repository_path), target_ref: a.target_ref || undefined })],
      // LOC-017 集成闸门：gatePlan（只读观测 + 候选捕获 + 锁键）/ syncTarget（真 merge + 实况登记）
      gatePlan: ['gatePlan', true, runArgs((a) => ({ target_ref: a.target_ref || undefined }))],
      syncTarget: ['syncTarget', true, runArgs((a) => ({ target_ref: a.target_ref || undefined }))],
      gateSyncEntry: ['gateSyncEntry', true, runArgs((a) => ({ target_head: str(a.target_head), previous_synced_head: a.previous_synced_head || undefined, integrated_before: a.integrated_before === true, merge_result: str(a.merge_result), attempt: Number(a.attempt || 1), snapshot_revision: str(a.snapshot_revision) }))],
      activeLock: ['activeLockFor', true, (a) => ({ resource_key: str(a.resource_key) })],
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
        // allocate 的模板解析要查注册表（异步），载荷构建统一按可 await 处理
        const result = await wsHostCall(cmd, await build(a, id))
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

    // ── Formal Records 运行时（LOC-008）：核心实现 = scripts/records-host.mjs，经包装脚本子进程调用 ──
    // 与 workspace 同模式：内核 formal-records.mjs 是 ESM + fs（vm 沙箱无法求值），
    // 只在真实 Node 子进程中加载；本侧只做事实采集与效果执行。每次调用独立进程、
    // 权威状态在磁盘（<DSH Home>/visual-workflow/records/<logical_run_id>.json），
    // 重启后按 logical_run_id 查询天然生效。
    async function recordsHostCall(cmd, input, opts) {
      if (!RECORDS_HOST || (await readTextIfExists(RECORDS_HOST)) === null) return { ok: false, notFound: true, error: 'records-host.mjs 未找到（LOC-008 运行时集成未部署）' }
      const d = await homeDirs()
      if (!d) return { ok: false, error: '无法解析 DSH Home：records 目录不可用' }
      const payload = { ...input, records_dir: input.records_dir || d.recordsDir }
      const r = await runNode([RECORDS_HOST, cmd, JSON.stringify(payload)], { graceMs: (opts && opts.graceMs) || 30000, maxBytes: 1024 * 1024 })
      if (!r.ok) return { ok: false, error: 'records host 调用失败：' + r.detail }
      try {
        const parsed = JSON.parse(r.stdout)
        return parsed.ok ? parsed : { ok: false, error: parsed.error || 'records host 业务错误' }
      } catch (e) { return { ok: false, error: 'records host 输出不可解析：' + errMsg(e), raw: r.stdout } }
    }
    // LOC-032：操作账本进程边界（与 recordsHostCall 同模式）。外部交付动作可能慢，
    // graceMs 放宽到 120s；业务受阻（NEEDS_RECONCILIATION 等）透传 code。
    async function operationsHostCall(cmd, input, opts) {
      if (!OPERATIONS_HOST || (await readTextIfExists(OPERATIONS_HOST)) === null) return { ok: false, notFound: true, error: 'operations-host.mjs 未找到（LOC-032 运行时集成未部署）' }
      const d = await homeDirs()
      if (!d) return { ok: false, error: '无法解析 DSH Home：operations 目录不可用' }
      const payload = { ...input, operations_dir: input.operations_dir || d.operationsDir }
      const r = await runNode([OPERATIONS_HOST, cmd, JSON.stringify(payload)], { graceMs: (opts && opts.graceMs) || 120000, maxBytes: 1024 * 1024 })
      if (!r.ok) return { ok: false, error: 'operations host 调用失败：' + r.detail }
      try {
        const parsed = JSON.parse(r.stdout)
        return parsed.ok ? parsed : {
          ok: false, code: parsed.code, blocked: parsed.blocked === true,
          status: parsed.status, operation_id: parsed.operation_id,
          error: parsed.error || parsed.message || 'operations host 业务错误',
        }
      } catch (e) { return { ok: false, error: 'operations host 输出不可解析：' + errMsg(e), raw: r.stdout } }
    }
    // LOC-037：收口交付动作进程边界（与 operationsHostCall 同模式）
    async function deliveryCloseoutHostCall(cmd, input, opts) {
      if (!DELIVERY_CLOSEOUT_HOST || (await readTextIfExists(DELIVERY_CLOSEOUT_HOST)) === null) return { ok: false, notFound: true, error: 'delivery-closeout-host.mjs 未找到（LOC-037 运行时集成未部署）' }
      const d = await homeDirs()
      if (!d) return { ok: false, error: '无法解析 DSH Home：operations 目录不可用' }
      const payload = { ...input, operations_dir: input.operations_dir || d.operationsDir }
      const r = await runNode([DELIVERY_CLOSEOUT_HOST, cmd, JSON.stringify(payload)], { graceMs: (opts && opts.graceMs) || 120000, maxBytes: 1024 * 1024 })
      if (!r.ok) return { ok: false, error: 'delivery closeout host 调用失败：' + r.detail }
      try {
        const parsed = JSON.parse(r.stdout)
        return parsed.ok ? parsed : {
          ok: false, code: parsed.code, status: parsed.status,
          delivery_status: parsed.delivery_status,
          error: parsed.error || parsed.message || 'delivery closeout host 业务错误',
        }
      } catch (e) { return { ok: false, error: 'delivery closeout host 输出不可解析：' + errMsg(e), raw: r.stdout } }
    }
    // 节点收尾产物 → commit 条目（单一提交通道的宿主侧采集）：
    //  - 每个本段新完成节点 → node:<logical_run_id>:<nodeId> 的追加 Revision；
    //  - verifyBranch 节点（审核/测试）强制加发 proof：<logical_run_id>:<nodeId> 的
    //    proof_decision，body 绑定 verified_branch / verified_head / workspace；
    //    依赖（覆盖的 Record Revision）由 Store 端在签发时刻按当时全部节点/产物
    //    记录结链——之后目标 Revision 前进，旧 Proof 即 not_covering_current（stale）。
    // verified_* 以节点结论为准（编译脚本 claimError 已强制校验其存在）。
    // LOC-026：Proof 绑定宿主签发时刻实况捕获的 candidate_ref（权威），并记录节点自报
    // candidate_sha256 的核对结论 candidate_match；捕获失败仅记 candidate_match=false
    //（闸门按 mismatch 拒绝，不当 legacy 放行）。
    //  - verifyBranch 节点强制加发 proof；dependencies 来自 resolved_inputs（LOC-034），
    //    不再从 Store 全量推导。段内 [vwf-attempt] 的 ri 由 attempt-ledger 写入
    //    logicalRec.resolved_inputs_map；段末扫描回退时用 legacy 规则补上游节点引用。
    function resolvedInputsFor(logicalRec, nodeId, results, isProof, newKeys) {
      const riMap = logicalRec.resolved_inputs_map || {}
      if (riMap[nodeId]) return riMap[nodeId]
      if (!isProof) return { mode: 'legacy', items: [] }
      const idx = Array.isArray(newKeys) ? newKeys.indexOf(nodeId) : -1
      const upstream = idx >= 0 ? newKeys.slice(0, idx) : Object.keys(results || {}).filter((k) => k !== nodeId)
      const items = upstream.filter((k) => results[k] != null).map((k) => ({
        binding: 'from_' + k,
        producer: String(k),
        version_ref: 'tmp-exec:1:00000000',
      }))
      const sync = logicalRec.last_gate_sync
      if (sync && sync.record_id && sync.record_revision) {
        items.push({
          binding: 'sync',
          record_ref: { record_id: sync.record_id, record_revision: sync.record_revision },
          version_ref: 'record:' + sync.record_id + '@' + sync.record_revision,
        })
      }
      return { mode: 'legacy', items }
    }
    async function nodeRecordEntries(logicalRec, dsl, results, newKeys, segNo, ws, snap, controlEvent) {
      const logicalRunId = logicalRec.logical_run_id
      const entries = []
      let cand = null
      for (const nodeId of newKeys) {
        const res = results[nodeId]
        if (res == null || typeof res !== 'object') continue
        const node = ((dsl && dsl.nodes) || []).find((n) => n && n.id === nodeId) || null
        const outcome = businessOutcomeOf(dsl, nodeId, res, controlEvent)
        const provenance = {
          logical_run_id: logicalRunId,
          node: String(nodeId),
          attempt: segNo,
          snapshot_revision: snap ? String(snap.revision) : 'unspecified',
          provider: String((snap && snap.provider_model && snap.provider_model[nodeId] && snap.provider_model[nodeId].provider) || 'default'),
          model: String((snap && snap.provider_model && snap.provider_model[nodeId] && snap.provider_model[nodeId].model) || 'default'),
          produced_by: 'vwf:runtime',
          node_business_outcome: outcome === undefined ? null : outcome,
        }
        entries.push({
          type: 'node_result',
          record_id: 'node:' + logicalRunId + ':' + nodeId,
          provenance,
          body_value: res,
          resolved_inputs: resolvedInputsFor(logicalRec, nodeId, results, false, newKeys),
        })
        if (node && node.verifyBranch) {
          if (!cand) {
            const c = await wsHostCall('captureCandidate', { logical_run_id: logicalRunId, capability: capabilityFor(logicalRunId) })
            if (c.candidate) cand = c.candidate
          }
          const proofBody = {
            node: String(nodeId),
            verified_branch: res.verified_branch === undefined ? null : res.verified_branch,
            verified_head: res.verified_head === undefined ? null : res.verified_head,
            workspace: ws ? { workspace_id: ws.workspace_id || null, source_path: ws.source_path || null, work_branch: ws.work_branch || null } : null,
            candidate_ref: cand,
            candidate_match: !!(cand && res.candidate_sha256 === cand.version.content_sha256),
          }
          entries.push({
            type: 'proof',
            record_id: 'proof:' + logicalRunId + ':' + nodeId,
            provenance,
            body_value: proofBody,
            resolved_inputs: resolvedInputsFor(logicalRec, nodeId, results, true, newKeys),
          })
        }
      }
      return entries
    }
    // 提交并刷新摘要互相引用（非阻断：证据记录失败不推翻专业结果，与落盘失败同待遇）
    async function commitNodeRecords(logicalRec, entries) {
      const r = await recordsHostCall('commit', {
        logical_run_id: logicalRec.logical_run_id,
        logical_run_ref: {
          state: logicalRec.lifecycle.state,
          title: logicalRec.title,
          template_id: logicalRec.template_id,
          task_id: logicalRec.task_id,
        },
        entries,
      })
      if (r.ok) {
        logicalRec.formal_records = { record_count: r.record_count, last_commit_at: Date.now() }
        requestLogicalPersist(logicalRec.logical_run_id)
      } else if (r.notFound) log('records-host.mjs 未部署：本轮节点产物未入 Formal Records Store')
      else log('Formal Records 提交失败（不影响运行）：' + r.error)
      return r
    }

    // ── Integration Gate（LOC-017）：「测试通过 → 人工验收」之间的自动集成闸门 ────
    // 编排契约（B1–B13，规格 .scratch/LOC-017-integration-gate/task-spec-V2.md）：
    //   触发 = WAITING_HUMAN 结算 + Git ISOLATED_WRITE（B1/B2）；未前进即放行（B3）；
    //   已前进 = 取集成锁（B9/B10/B11）→ 真 merge（沿用仓库 merge 策略）→ recordSourceSync
    //   → 同步证据 artifact 新 Revision（B4，无新版本拒绝放行）→ 自动重跑本 Run 全部
    //   审核/测试（B5/B6，复用既有引擎段；RETURN_DEV 按既有转移回开发，B8）→ 放行前
    //   重新观测（B13/R3）→ assertIntegrationAllowed 全覆盖判定（旧 Proof 不背书，B7）。
    //   全部判定与效果委托内核（workspace-isolation / formal-records / integration-gate），
    //   宿主只做编排与落盘（control_events + 重跑段照常入 Formal Records，B12）。
    const GATE_MAX_ITERATIONS = 3
    const GATE_LOCK_OWNER = 'integration-gate'
    const GATE_LOCK_TTL_MS = 60 * 60 * 1000
    const GATE_HEARTBEAT_MS = 10 * 60 * 1000
    // 收集 verifyBranch 节点当前最新 Proof 引用（重跑前的旧 Proof 由此参与判定）
    async function gateLatestProofs(runId, verifyNodes) {
      const proofs = []
      for (const nodeId of verifyNodes) {
        const g = await recordsHostCall('get', { logical_run_id: runId, record_id: 'proof:' + runId + ':' + nodeId })
        if (g.ok && g.found && Array.isArray(g.revisions) && g.revisions.length) {
          const latest = g.revisions[g.revisions.length - 1]
          proofs.push({ record_id: String(latest.record_id || g.record_id), record_revision: Number(latest.record_revision) })
        }
      }
      return proofs
    }
    async function runIntegrationGate(env) {
      const { logicalRec, ws, wsIdentity, dsl, scriptArgs, meta, execScript, parent, segCtl, resultsNow, taskId, outerRunId, engine: gateEngine } = env
      const trace = { decision: null, iterations: 0, syncs: [], reruns: [], rerun_terminal: null, blocked: null, proofs_state: null, observed_head: null }
      const blocked = (code, message, extra) => {
        trace.decision = 'blocked'
        trace.blocked = Object.assign({ code, message: String(message || '') }, extra || {})
        return { trace, blocked: true, code, message }
      }
      const cap = capabilityFor(wsIdentity)
      let heldLockId = null
      const releaseGateLock = async (reason) => {
        if (!heldLockId) return
        const id = heldLockId
        heldLockId = null
        try { await wsHostCall('releaseLock', { logical_run_id: wsIdentity, capability: cap, lock_id: id, owner: GATE_LOCK_OWNER, reason: reason || 'integration gate window closed' }) } catch (e) { trace.release_error = errMsg(e) }
      }
      try {
        const verifyNodes = ((dsl && dsl.nodes) || []).filter((n) => n && n.verifyBranch).map((n) => n.id)
        if (ws.workspace_mode !== 'ISOLATED_WRITE') return { trace: Object.assign(trace, { decision: 'skipped', reason: 'non_isolated_write' }) }
        // B1 适用面：无审核/测试节点的图不是建设类流程，闸门不适用（保持旧行为，不回归）
        if (!verifyNodes.length) return { trace: Object.assign(trace, { decision: 'skipped', reason: 'no_verify_nodes' }) }
        // ── LOC-026 候选核验：实况候选已随 gatePlan 捕获（内核 planTargetSync），此处
        // 逐个 Proof 比较"所指候选 vs 实况"（委托 records-host assertCandidates / 内核
        // compareCandidate）；捕获/比较失败 fail closed；无 candidate_ref 的历史 Proof 记
        // legacy_unverified，不伪造绑定，仍由既有 Revision 覆盖判定约束（兼容冻结快照）。
        const candGate = async (plan) => {
          const C = await recordsHostCall('assertCandidates', { logical_run_id: wsIdentity, candidate: plan.candidate })
          trace.candidate_checks = C.checks
          return C.pass ? null : blocked(C.code || 'GATE_CANDIDATE_FAILED', C.message || C.error)
        }
        // 最近一次闸门重跑段的收束现场：放行时 wf_run 返回它（人工拿到的是重跑后的 decision_id）
        let lastRerun = null
        for (let iteration = 1; iteration <= GATE_MAX_ITERATIONS; iteration++) {
          trace.iterations = iteration
          const plan = await wsHostCall('gatePlan', { logical_run_id: wsIdentity, capability: cap, target_ref: ws.base_ref })
          if (!plan.ok) return blocked(plan.code || 'GATE_PLAN_FAILED', '闸门观测/计划失败，fail closed（B13）：' + (plan.error || '未知'))
          trace.observed_head = plan.target_head
          const syncGet = await recordsHostCall('get', { logical_run_id: wsIdentity, record_id: plan.sync_record_id })
          const syncRevs = syncGet.ok && syncGet.found && Array.isArray(syncGet.revisions) ? syncGet.revisions : []
          const lastSync = syncRevs.length ? syncRevs[syncRevs.length - 1] : null
          const lastSyncedHead = lastSync && lastSync.body && lastSync.body.value ? (lastSync.body.value.synced_head || null) : null
          // 观测放行基线 = 上次同步头（有同步史）|| 分配基线；比较由内核 computeCheckpoint 完成。
          // 注意：内核在「目标已前进」时返回 ok:false + hint（业务判定），不是观测失败；
          // 观测失败（B13）= 拿不到 target_advanced 布尔值。
          const cpRes = await wsHostCall('computeIntegrationCheckpointFromRepo', { base_ref: ws.base_ref, base_commit: lastSyncedHead || ws.base_commit, repository_path: ws.repository_path, target_ref: ws.base_ref })
          // 真实 wrapper 契约：{ ok, checkpoint: {target_advanced,...} }（checkpoint 嵌套一层）
          const cp = cpRes && cpRes.ok ? cpRes.checkpoint : null
          if (!cp || typeof cp.target_advanced !== 'boolean') return blocked('GATE_OBSERVE_FAILED', '目标 HEAD 观测失败，fail closed（B13）：' + ((cpRes && cpRes.error) || '未知'))
          if (!cp.target_advanced && !lastSync) {
            // B3：目标未前进且从未同步——候选核验通过后直接放行，不重跑、不额外耗时
            const gateBlocked = await candGate(plan)
            if (gateBlocked) return gateBlocked
            trace.decision = 'pass'
            trace.proofs_state = 'still_valid'
            return { trace }
          }
          let needRerun = false
          if (cp.target_advanced) trace.syncs.push({ at: iteration, observed_head: plan.target_head, integrated_before: plan.integrated_before === true })
          else {
            // 有同步史但目标未再前进：已有 Proof 覆盖上次同步 Revision 即放行（重跑中断后的续判定）
            const assertion = await recordsHostCall('assertIntegration', {
              logical_run_id: wsIdentity,
              target_record_id: plan.sync_record_id,
              proofs: await gateLatestProofs(wsIdentity, verifyNodes),
              target_advanced: false,
            })
            if (assertion.ok) {
              // Revision 覆盖满足后仍须候选核验（LOC-026）：所指候选 = 实况候选才放行
              const gateBlocked = await candGate(plan)
              if (gateBlocked) return gateBlocked
              trace.decision = 'pass'
              trace.proofs_state = assertion.proofs_state || 'rerun_completed'
              return lastRerun
                ? { trace, finalCanon: lastRerun.canon, finalStopReason: lastRerun.stopReason, finalStop: lastRerun.stopReason, finalValue: lastRerun.value, finalRunId: lastRerun.runId }
                : { trace }
            }
            needRerun = true
            trace.reruns.push({ at: iteration, reason: 'PROOFS_NOT_COVERING', stale: assertion.stale || [] })
          }
          // —— 同步 + 重跑窗口：全程持锁 + 心跳（B9）；抢不到锁 → BLOCKED 提示占用方（B10）——
          const lock = await wsHostCall('acquireLock', { logical_run_id: wsIdentity, capability: cap, resource_key: plan.resource_key, owner: GATE_LOCK_OWNER, ttl_ms: GATE_LOCK_TTL_MS }).catch((e) => ({ ok: false, error: errMsg(e) }))
          if (!lock.ok || !lock.lock) {
            let holder = null
            try {
              const al = await wsHostCall('activeLockFor', { logical_run_id: wsIdentity, capability: cap, resource_key: plan.resource_key })
              if (al.ok && al.lock) holder = al.lock.logical_run_id
            } catch (e) { /* 查询失败不掩盖占用事实 */ }
            return blocked('GATE_LOCK_BUSY', '集成锁被占用' + (holder ? '：' + holder : '') + '；锁释放后可从 uat 节点续跑同一逻辑运行（wf_run entry=uat）', { holder, resource_key: plan.resource_key })
          }
          heldLockId = lock.lock.lock_id
          let hbFailures = 0
          let hbTimer = null
          if (typeof setInterval === 'function') {
            try {
              hbTimer = setInterval(() => {
                // 业务失败（ok:false，如续期被拒/锁丢失）与传输故障一并计数（§11 fail closed）
                wsHostCall('acquireLock', { logical_run_id: wsIdentity, capability: cap, resource_key: plan.resource_key, owner: GATE_LOCK_OWNER, ttl_ms: GATE_LOCK_TTL_MS }).then((res) => { if (!res || res.ok === false) hbFailures++ }).catch(() => { hbFailures++ })
              }, GATE_HEARTBEAT_MS)
              if (hbTimer && typeof hbTimer.unref === 'function') hbTimer.unref()
            } catch (e) { hbTimer = null /* 无定时器环境：TTL 兜底（R2） */ }
          }
          try {
            wsHostCall('setLifecycle', { logical_run_id: wsIdentity, capability: cap, lifecycle: 'RUNNING', extra: { hold_integration: true } }).catch(() => {})
            if (cp.target_advanced) {
              // 真同步：merge（沿用仓库策略）→ recordSourceSync 只信实况 → 同步证据新 Revision（B4）
              const sync = await wsHostCall('syncTarget', { logical_run_id: wsIdentity, capability: cap, target_ref: ws.base_ref })
              if (!sync.ok) return blocked(sync.code || 'GATE_SYNC_FAILED', sync.error || '目标同步失败，fail closed', sync.conflicts ? { conflicts: sync.conflicts } : undefined)
              const entryBuild = await wsHostCall('gateSyncEntry', { logical_run_id: wsIdentity, capability: cap, target_head: sync.target_head || plan.target_head || '', previous_synced_head: lastSyncedHead, integrated_before: sync.integrated_before === true, merge_result: sync.merge_result || '', attempt: logicalRec.segments.length, snapshot_revision: activeSnapshot(logicalRec) ? activeSnapshot(logicalRec).revision : 'unspecified' })
              if (!entryBuild.ok || !entryBuild.entry) return blocked('GATE_SYNC_RECORD_FAILED', '同步证据 entry 构造失败：' + (entryBuild.error || '未知'))
              const commit = await recordsHostCall('commit', { logical_run_id: wsIdentity, entries: [entryBuild.entry] })
              const committed = commit.ok && Array.isArray(commit.committed) ? commit.committed.find((c) => c.record_id === plan.sync_record_id) : null
              if (!commit.ok || !committed || !(committed.record_revision > (lastSync ? lastSync.record_revision : 0))) {
                return blocked('GATE_SYNC_NO_NEW_VERSION', '同步未产生新产物版本：拒绝放行且不得报告 rerun_completed（B4）', { records_error: commit.error || null })
              }
              const last = trace.syncs[trace.syncs.length - 1]
              last.record_revision = committed.record_revision
              last.current_head = sync.current_head
              last.merge_result = sync.merge_result
              logicalRec.last_gate_sync = { record_id: plan.sync_record_id, record_revision: committed.record_revision }
              await markWorkspaceLifecycle(wsIdentity, 'RUNNING')
            } else if (!needRerun) {
              // 理论不可达（advanced 或 needRerun 必有一）：保守放行判定交给下一轮
            }
            // B5/B6：自动重跑本 Run 全部审核/测试——从第一个 verifyBranch 节点再起一段
            //（继承既有脚本冻结、Provider/Model 快照与轮次历史；剥掉人工决策字段）。
            // 种子结果剔除将重新执行的节点（verify 节点 + 人工等待源节点），保证段收尾
            // 按新完成节点重签 node/Proof Record（B6：新 Proof 只能来自真实重跑）。
            const haltSources = new Set(((dsl && dsl.edges) || []).filter((e) => e && e.to === '$human-decision' && e.from).map((e) => e.from))
            const rerunSeed = {}
            if (resultsNow && typeof resultsNow === 'object') {
              for (const k of Object.keys(resultsNow)) {
                if (verifyNodes.indexOf(k) >= 0 || haltSources.has(k)) continue
                rerunSeed[k] = resultsNow[k]
              }
            }
            const rerunArgs = Object.assign({}, scriptArgs, {
              entry: verifyNodes[0],
              results: rerunSeed,
              feedback: '',
            })
            delete rerunArgs.decision_id
            delete rerunArgs.user_choice
            delete rerunArgs.approved
            // LOC-027：重跑段同样携带活动评价基线引用（评估摘要闸门在重跑段保持有效）
            Object.assign(rerunArgs, ebBaselineArgs(logicalRec))
            const fresh = await wsHostCall('get', { logical_run_id: wsIdentity, capability: cap })
            if (fresh.ok && fresh.workspace) Object.assign(rerunArgs, scriptArgsFromWorkspace(fresh.workspace, cap))
            const rerunReq = { script: execScript, meta, args: rerunArgs, parent }
            if (segCtl) rerunReq.signal = segCtl.signal
            if (ws.source_path) { rerunReq.cwd = ws.source_path; rerunReq.workspaceRoot = ws.source_path }
            const rerun = gateEngine.start(rerunReq)
            const rerunRunId = String(rerun.id)
            const rerunRec = ensureRun(rerunRunId)
            rerunRec.taskId = taskId
            rerunRec.workflowId = logicalRec.template_id
            live.add(rerunRunId)
            persist(rerunRunId)
            const freshWs = fresh.ok && fresh.workspace ? fresh.workspace : ws
            attk().then((t) => t.setWs(rerunRunId, freshWs)).catch(() => {})
            onRun(outerRunId, (r) => { r.supersededBy = rerunRunId })
            appendLogicalSegment(logicalRec, rerunRunId, 'integration_gate_rerun')
            logicalSetState(logicalRec, 'RUNNING', null)
            requestLogicalPersist(logicalRec.logical_run_id)
            let rerunResult
            try { rerunResult = await rerun.result } catch (e) {
              endLogicalSegment(logicalRec, rerunRunId, 'ENGINE_ERROR')
              logicalRec.last_engine_error = errMsg(e)
              logicalSetState(logicalRec, 'FAILED', logicalReason('ENGINE_ERROR', errMsg(e)))
              requestLogicalPersist(logicalRec.logical_run_id)
              if (hbFailures > 0) trace.heartbeat_failures = hbFailures
              return { trace, rerun_failed: true, engine_error: errMsg(e) }
            }
            const rerunCanon = rerunResult && rerunResult.stopReason === 'completed' ? canonicalStop(rerunResult) : ''
            const rerunValue = rerunResult && rerunResult.value
            if (rerunCanon) onRun(rerunRunId, (r) => { r.status = rerunCanon; applyHdValue(r, rerunValue) })
            if (rerunResult && rerunResult.error) onRun(rerunRunId, (r) => { r.error_detail = String(rerunResult.error).slice(0, 500) })
            endLogicalSegment(logicalRec, rerunRunId, rerunCanon || String((rerunResult && rerunResult.stopReason) || ''))
            const rerunResults = rerunValue && typeof rerunValue.results === 'object' && rerunValue.results ? rerunValue.results : null
            // LOC-029：重跑段同样先结算逐次提交；无逐次事件（旧冻结脚本）走扫描回退
            const attRerun = await attk().then((t) => t.settle(logicalRec, rerunRunId, logicalRec.segments.length)).catch(() => null)
            const beforeKeys = new Set(Object.keys(rerunSeed))
            if (!attRerun) recordNodeAttempts(logicalRec, dsl, beforeKeys, rerunResults, rerunValue && rerunValue.control_event)
            const trans2 = logicalTransitionFor(rerunCanon, rerunResult && rerunResult.stopReason, rerunValue)
            if (trans2) logicalSetState(logicalRec, trans2.state, trans2.reason)
            if (rerunResults && !attRerun) {
              const newKeys = Object.keys(rerunResults).filter((k) => !beforeKeys.has(k))
              if (newKeys.length) {
                const entries = await nodeRecordEntries(logicalRec, dsl, rerunResults, newKeys, logicalRec.segments.length, fresh.ok && fresh.workspace ? fresh.workspace : ws, activeSnapshot(logicalRec), rerunValue && rerunValue.control_event)
                if (entries.length) await commitNodeRecords(logicalRec, entries)
              }
            }
            await refreshWorkspaceContext(logicalRec, wsIdentity)
            requestLogicalPersist(logicalRec.logical_run_id)
            trace.reruns.push({
              at: iteration, entry: verifyNodes[0], run_id: rerunRunId,
              canon: rerunCanon || String((rerunResult && rerunResult.stopReason) || ''),
              agents_started: rerunResult ? rerunResult.agentsStarted : null,
            })
            lastRerun = { canon: rerunCanon, stopReason: rerunResult ? rerunResult.stopReason : undefined, value: rerunValue, runId: rerunRunId }
            if (hbFailures > 0) {
              // 心跳刷新失败按 fail closed 处理并留痕（§11）：重跑段已完全收束，闸门不放行
              return blocked('GATE_LOCK_HEARTBEAT_FAILED', '集成锁心跳刷新失败，fail closed：闸门不放行（详见运行记录）', { heartbeat_failures: hbFailures })
            }
            if (rerunCanon !== 'WAITING_HUMAN') {
              // 重跑段未回到人工等待（停止/暂停/失败/继续图中流转）：按其终态收束，不放行
              trace.rerun_terminal = rerunCanon || String((rerunResult && rerunResult.stopReason) || '')
              return {
                trace,
                finalCanon: rerunCanon,
                finalStopReason: rerunResult && rerunResult.stopReason,
                finalStop: rerunResult ? rerunResult.stopReason : undefined,
                finalValue: rerunValue,
                finalRunId: rerunRunId,
              }
            }
            // 回到循环顶部重新观测：目标可能再次前进（R3）；重跑 Proof 已入 Store
          } finally {
            if (hbTimer) { try { clearInterval(hbTimer) } catch (e) { /* 忽略 */ } }
            await releaseGateLock()
            wsHostCall('setLifecycle', { logical_run_id: wsIdentity, capability: cap, lifecycle: 'RUNNING', extra: { hold_integration: false } }).catch(() => {})
          }
        }
        return blocked('GATE_ITERATION_CAP', '闸门迭代上限：目标在闸门窗口内反复前进，fail closed 交人工')
      } catch (e) {
        return blocked('GATE_INTERNAL_ERROR', '集成闸门内部错误：' + errMsg(e))
      }
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
        resource_kind: { type: 'string', description: 'LOC-009：输入资源类型（git | files | document | config | other）。optimize 类工作流必传（git/files→ISOLATED_WRITE git 工作区；document/config/other→SANDBOX），由模板声明或运行参数正式传入' },
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
        technical_budget: { type: 'object', additionalProperties: true },
        technical_budget_grant: { type: 'object', additionalProperties: true, description: '提额' },
        retry_policy_overrides: { type: 'object', additionalProperties: true, description: '时间上限可调' },
        resume_paused: { type: 'boolean', description: '#80 暂停恢复：对 PAUSED 的逻辑运行按检查点现场续跑同一 Logical Run；恢复后的节点读取暂停期间提交的全部 Guidance 与最新基线修订（wf_control 提交）' },
      },
      async execute(rawArgs) {
        refreshServices()
        await srcCore()
        // 工具平台会 deepFreeze 入参：续跑回填写到浅拷贝上
        const args = Object.assign({}, rawArgs || {})
        const taskId = String(args.taskId || '')
        // 互斥判定必须看到完整门禁状态，先等启动回载完成
        await runsHydration
        const isHdResume = !!args.decision_id
        const isLegacyResume = !!args.entry
        // #80：暂停恢复是独立续跑形态——按检查点现场回填 entry/results，不得当成新启动
        const isPauseResume = args.resume_paused === true
        const isResumeLike = isHdResume || isLegacyResume || isPauseResume
        const holder = taskHolder(taskId)
        if (holder) {
          const st = String(holder.status || '')
          let allow
          if (st === 'WAITING_HUMAN' || isParkedHd(holder)) allow = isHdResume && (!holder.decision_id || holder.decision_id === String(args.decision_id))
          else if (st.indexOf('AWAITING_HUMAN_') === 0) allow = isLegacyResume
          else if (st === 'PAUSED') allow = isPauseResume
          else allow = isHdResume || isLegacyResume
          if (!allow) {
            return '错误：任务 ' + taskId + ' 已有进行中的运行 ' + holder.id + '（状态 ' + (st || 'running') +
              '）：同 taskId 串行互斥。WAITING_HUMAN 请带 decision_id 与 user_choice 续跑；残留门禁请带 entry=<节点id> 与 approved；PAUSED 请带 resume_paused=true 恢复同一逻辑运行；并行任务请换一个 taskId。'
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
          if (!args.halt_reason && parked.reason) args.halt_reason = parked.reason
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
        // LOC-027：基线恢复段以检查点现场为段首基线（beforeResultKeys 随恢复段更新，
        // 保证逐节点入档只记恢复段新完成的节点）
        let beforeResultKeys = new Set(Object.keys((args.results && typeof args.results === 'object' && !Array.isArray(args.results)) ? args.results : {}))
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
        // #80：暂停恢复是独立续跑形态——按检查点现场回填 entry/results，不得当成新启动
        if (isHdResume || isLegacyResume || isPauseResume) {
          const latest = latestLogicalRunForTask(logicalTaskId)
          if (latest && latest.terminal) {
            return '错误：任务 ' + logicalTaskId + ' 的逻辑运行 ' + latest.logical_run_id + ' 已终态（' + latest.lifecycle.state + '），同一运行不能继续。请直接重新发起（将派生新运行并保留来源关系）。'
          }
          // LOC-017 fail-open 封堵：闸门拦截（BLOCKED）后人工决策续跑会从 $human-decision
          // 直接走到收口（DONE 不再触发闸门），以旧 Proof 背书已前进目标——闸门拦截
          // 一律拒绝，唯一恢复路径 = entry=uat 重过闸门（B10 恢复语义）。
          // 只认 GATE_ 前缀错误码：探针失败（PROBE_FAILED）的 BLOCKED 走既有
          // model_overrides 原地恢复路径，不得误伤。
          if (latest && !latest.terminal && isHdResume && latest.lifecycle.state === 'BLOCKED'
              && latest.lifecycle.reason && typeof latest.lifecycle.reason.code === 'string'
              && latest.lifecycle.reason.code.indexOf('GATE_') === 0) {
            return '错误：逻辑运行 ' + latest.logical_run_id + ' 被集成闸门拦截（' + latest.lifecycle.reason.code + '）：人工决策续跑不可用，否则将绕过闸门放行。请从 uat 节点续跑同一逻辑运行（wf_run entry=uat），重新通过集成闸门后再进入人工验收。'
          }
          // LOC-030：NEEDS_REDEFINE 受阻不可原样恢复（resumable=false）——保留旧 Run 原样，
          // 基线重定义后重新发起（派生新运行并保留来源），不在同一 Run 静默换版续跑。
          if (latest && !latest.terminal && isResumeLike && latest.lifecycle.state === 'BLOCKED'
              && latest.lifecycle.reason && latest.lifecycle.reason.code === 'NEEDS_REDEFINE') {
            return '错误：逻辑运行 ' + latest.logical_run_id + '（NEEDS_REDEFINE）：基线需重定义，不可原样恢复；请重定义后重新发起（保留旧 Run）。'
          }
          logicalTrigger = isHdResume ? 'human_decision' : (isPauseResume ? 'pause_resume' : 'legacy_resume')
          // #80 暂停恢复：检查点现场 + 适用 Guidance（Run 级）+ 最新基线修订回填执行载荷
          if (isPauseResume) {
            if (!latest) return '错误：任务 ' + logicalTaskId + ' 没有可恢复的逻辑运行，resume_paused 仅用于恢复 PAUSED 运行。'
            if (latest.lifecycle.state !== 'PAUSED') return '错误：逻辑运行 ' + latest.logical_run_id + ' 当前为 ' + latest.lifecycle.state + '（非 PAUSED）：resume_paused 不适用于该状态，Guidance / Human Decision / BLOCKED 三态语义不混用。'
            if (!latest.pause_resume) return '错误：逻辑运行 ' + latest.logical_run_id + ' 缺少暂停恢复现场（该段未产生可用检查点）；请人工确认入口节点后改用 entry=<节点id> 续跑。'
            const built = buildPauseResumeArgs(latest)
            if (!built) return '错误：逻辑运行 ' + latest.logical_run_id + ' 缺少暂停恢复现场；请人工确认续跑入口节点后改用 entry=<节点id> 续跑。'
            if (built.rebaseBlocked) return '错误：逻辑运行 ' + latest.logical_run_id + ' 存在待回跑的基线修订，但 Rev1 冻结工作流缺少入口节点，无法自动回跳基线负责节点；请人工处理基线变更后重试。'
            // 待回跑修订存在时不接受显式 entry：显式入口会绕过基线节点重跑（§9 规则 7）
            if (built.pendingRebase && args.entry !== undefined) return '错误：逻辑运行 ' + latest.logical_run_id + ' 存在待回跑的基线修订，resume_paused 不接受显式 entry（回跳基线负责节点是强制路径）；请去掉 entry 直接恢复。'
            const prArgs = built.args
            if (prArgs.entry === undefined && args.entry === undefined) return '错误：暂停现场无检查点入口（降级现场），请人工确认续跑入口节点后改用 entry=<节点id> 续跑。'
            for (const k of Object.keys(prArgs)) if (args[k] === undefined || args[k] === null || (typeof args[k] === 'object' && !Array.isArray(args[k]) && args[k] !== null && Object.keys(args[k]).length === 0)) args[k] = prArgs[k]
          }
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
        if ((isHdResume || isLegacyResume || isPauseResume || probeResume) && args.model_overrides && typeof args.model_overrides === 'object' && !Array.isArray(args.model_overrides) && Object.keys(args.model_overrides).length) {
          const rev = appendSnapshotRevision(logicalRec, args.model_overrides)
          if (rev) requestLogicalPersist(logicalRec.logical_run_id)
        }
        // Codex R2 ①：续跑必须执行 Rev 1 冻结脚本（R3：运行中仅 Provider/Model 可改，
        // 工作流定义冻结）——等待期间模板被修改时，重新编译会让"新脚本 + script_ref:1
        // 快照"静默失配。Rev 1 无脚本（旧形态承接）时才用当前编译产物。
        // #74 BLOCKED 恢复同为既有运行的继续，遵守同一冻结纪律。
        const snap1 = (logicalRec.snapshots || []).find((s) => s.revision === 1) || null
        const frozenScript = snap1 && typeof snap1.script === 'string' && snap1.script ? snap1.script : null
        const execScript = (isHdResume || isLegacyResume || isPauseResume || probeResume) && frozenScript ? frozenScript : c.script
        // Codex R2 ②：续跑传入 active 快照的合并绑定（而非本次 delta）——Rev3 只改 B
        // 时，A 必须仍用 Rev2 的覆盖值执行；合并语义与编译脚本一致（显式覆盖优先，
        // $default 兜底未显式覆盖节点）。
        const activeSnap = activeSnapshot(logicalRec)
        const modelOverridesForExec = (isHdResume || isLegacyResume || isPauseResume || probeResume) ? deepCloneData(activeSnap ? activeSnap.provider_model : null) : undefined

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
        const prepared = await prepareRunWorkspace({ taskId: wsIdentity, templateId: args.templateId || v.sanitized.id, baseBranch: args.baseBranch || 'main', declaredWorkspace: v.sanitized.workspace, resourceKind: args.resource_kind })
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

        // LOC-028：人工决策续跑必须由宿主签发 decision_ref（含候选绑定），禁止信任模型自报
        let hostDecisionRef = null
        if (isHdResume && logicalRec) {
          let candidateRef = null
          if (ws && ws.source_path) {
            try {
              const cap = await wsHostCall('captureCandidate', { logical_run_id: logicalRec.logical_run_id, capability: capabilityFor(logicalRec.logical_run_id) })
              candidateRef = cap && cap.candidate ? cap.candidate : null
            } catch (e) { log('captureCandidate（人工决定）失败：' + errMsg(e)) }
          }
          hostDecisionRef = {
            decision_id: String(args.decision_id),
            logical_run_id: logicalRec.logical_run_id,
            checkpoint_id: String(args.decision_id),
            candidate_ref: candidateRef,
            choice: String(args.user_choice),
            actor_source: 'host_ui',
            decided_at: new Date().toISOString(),
          }
          if (hostDecisionRef.logical_run_id !== logicalRec.logical_run_id) {
            return '错误：人工决定归属 Run 不匹配，拒绝续跑。'
          }
          const dig = candidateRef && candidateRef.version && candidateRef.version.content_sha256
            ? String(candidateRef.version.content_sha256) : null
          const prior = logicalRec.consumed_decisions && logicalRec.consumed_decisions[hostDecisionRef.decision_id]
          if (prior) {
            if (prior.candidate_digest && dig && prior.candidate_digest !== dig) {
              return '错误：成果在决定后已变化，须重新获得针对新版本的验收（decision_id=' + hostDecisionRef.decision_id + '）。'
            }
            if (prior.completion && (args.user_choice === 'USER_ACCEPTED' || args.user_choice === 'ACCEPT' || args.user_choice === 'CONDITIONAL_PASS')) {
              return JSON.stringify({
                runId: holder && holder.id ? holder.id : 'idempotent',
                stopReason: 'completed',
                value: {
                  status: 'DONE',
                  taskId: args.taskId,
                  decision_id: hostDecisionRef.decision_id,
                  user_choice: args.user_choice,
                  completion: prior.completion,
                  idempotent_replay: true,
                  results: args.results || (parked && parked.results) || null,
                },
                agentsStarted: 0,
              })
            }
          }
          logicalRec.human_decisions = (logicalRec.human_decisions || []).concat([hostDecisionRef])
          controlEvent(logicalRec, 'human_decision_recorded', { decision_id: hostDecisionRef.decision_id, choice: hostDecisionRef.choice, candidate_digest: dig })
        }

        const scriptArgs = Object.assign({
          taskId: args.taskId, runDir: args.runDir, roleDir: args.roleDir || c.roleDir, baseBranch: args.baseBranch,
          issueRef: args.issueRef, issueTitle: args.issueTitle, issueBody: args.issueBody, issueComments: args.issueComments,
          requirement: args.requirement, entry: args.entry, approved: args.approved, feedback: args.feedback, startRound: args.startRound, history: args.history,
          decision_id: args.decision_id, user_choice: args.user_choice, blocked_edge: args.blocked_edge, results: args.results, halt_reason: args.halt_reason,
          budgetUsed: args.budgetUsed, maxRounds: args.maxRounds, decisionSeq: args.decisionSeq,
          technical_budget: args.technical_budget, technical_budget_grant: args.technical_budget_grant, retry_policy_overrides: args.retry_policy_overrides,
          // #80：暂停期间的用户指导（Run 级）与最新基线修订文本——经脚本 runtimeCtx/issueBlock
          // 注入执行上下文；普通 Guidance 不触碰基线，基线修订只经显式 mode=baseline 产生
          guidance_text: args.guidance_text, baseline_amendment: args.baseline_amendment,
          // LOC-027：活动评价基线引用（续跑由 ebBaselineArgs 注入；新启为 undefined 并被清理）
          evaluation_baseline: args.evaluation_baseline, evaluation_baseline_version: args.evaluation_baseline_version,
          // #79: 快照修订的 Provider/Model（Codex R2 ②：active 快照的合并绑定；仅续跑
          // 生效——新启透传会让脚本用覆盖模型执行而 Rev1 快照仍记蓝图绑定，归因失真）
          model_overrides: modelOverridesForExec,
          decision_ref: hostDecisionRef || undefined,
          consumed_decisions: logicalRec ? (logicalRec.consumed_decisions || {}) : undefined,
        }, ws ? scriptArgsFromWorkspace(ws, prepared.capability, undefined) : {})
        if (hostDecisionRef && ws && ws.source_path && hostDecisionRef.candidate_ref) {
          scriptArgs.candidate_ref = hostDecisionRef.candidate_ref
        }
        for (const k of Object.keys(scriptArgs)) if (scriptArgs[k] === undefined) delete scriptArgs[k]

        // 启动引擎前先标 RUNNING：崩溃/start 抛错不得把 workspace 永久留在 READY
        if (ws) await markWorkspaceLifecycle(wsIdentity, 'RUNNING')
        // LOC-027：续跑（人工决策/旧门禁/暂停恢复/模型恢复）携带活动评价基线引用（在
        // scriptArgs 组装前注入，恢复段节点提示与摘要闸门才能拿到已核验基线）
        if (logicalRec && (isHdResume || isLegacyResume || isPauseResume || probeResume)) Object.assign(args, ebBaselineArgs(logicalRec))
        // Codex R2 ①：续跑执行 Rev 1 冻结脚本（见上方 execScript 说明）
        const startReq = { script: execScript, meta: c.meta, args: scriptArgs, parent: parent }
        // #80：段取消信号——pause/interrupt 经 vwf.run.control 中止本段（引擎在当前钩子
        // 边界抛 CANCELLED，进行中 agent 自然完成，不硬杀）。宿主不支持 AbortController
        // 时不下发 signal：pause/interrupt 会得到明确失败而不是静默无效。
        const segCtl = typeof AbortController === 'function' ? new AbortController() : null
        if (segCtl) startReq.signal = segCtl.signal
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
        if (segCtl) segmentCtrls.set(runId, segCtl)
        // 逐次 Proof 需要段 workspace 绑定（LOC-029）：与 workspace 生命周期同段登记
        attk().then((t) => t.setWs(runId, ws)).catch(() => {})
        const rec = ensureRun(runId)
        rec.taskId = taskId
        rec.workflowId = String(args.templateId || v.sanitized.id || '')
        live.add(runId)
        persist(runId)
        if (isHdResume || isLegacyResume || isPauseResume) supersedeParked(taskId, runId)
        // LOC-027：评价基线上下文登记（声明 evaluationBaseline 的模板才启用观察与冻结闸门）
        const ebDecl = v.sanitized && v.sanitized.evaluationBaseline && typeof v.sanitized.evaluationBaseline === 'object'
          ? v.sanitized.evaluationBaseline
          : null
        if (ebDecl && logicalRec) {
          const ebk = await ebKernel()
          if (ebk) ebRuns.set(runId, { decl: ebDecl, kernel: ebk, cwd: (ws && ws.source_path) || projectRoot() || '', runDir: args.runDir || null, taskId: logicalTaskId, pending: new Map() })
          else log('评价基线内核不可用（dist/evaluation-baseline.cjs 缺失）：本运行基线保持未核验口径')
        }
        const amk = await amKernel()
        if (amk && logicalRec) {
          const runDirRel = args.runDir || ('.agent-runs/' + logicalTaskId)
          amRuns.set(runId, {
            kernel: amk,
            cwd: projectRoot() || ((ws && ws.source_path) || ''),
            runDir: runDirRel,
            taskId: logicalTaskId,
            byNode: new Map(),
          })
        } else if (logicalRec) {
          log('产物清单内核不可用（dist/artifact-manifest.cjs 缺失）：材料就绪闸门停用')
        }
        // #79：本段执行挂到逻辑运行（READY/WAITING_HUMAN → RUNNING，清 reason）
        if (logicalRec) {
          appendLogicalSegment(logicalRec, runId, logicalTrigger, isHdResume ? String(args.decision_id || '') : '')
          logicalSetState(logicalRec, 'RUNNING', null)
          requestLogicalPersist(logicalRec.logical_run_id)
        }
        let result
        try { result = await run.result } catch (e) {
          segmentCtrls.delete(runId)
          if (ws) await markWorkspaceLifecycle(wsIdentity, 'FAILED')
          if (logicalRec) {
            logicalRec.pause_state = null
            endLogicalSegment(logicalRec, runId, 'ENGINE_ERROR')
            logicalSetState(logicalRec, 'FAILED', logicalReason('ENGINE_ERROR', errMsg(e)))
            requestLogicalPersist(logicalRec.logical_run_id)
          }
          return '错误：工作流运行失败，workspace 已标 FAILED：' + errMsg(e)
        }
        segmentCtrls.delete(runId)
        // 权威终态回写：completed 时以脚本返回 value.status 为准；回执保持引擎原样不翻译
        // （LOC-027：基线闸门恢复段会接管 result，canon 相应重算）
        let canon = result && result.stopReason === 'completed' ? canonicalStop(result) : ''
        if (canon) {
          onRun(runId, (r) => {
            r.status = canon
            applyHdValue(r, result.value)
            // LOC-030：受阻回执统一解释——运行卡片带原因码与恢复入口（看板与 Skill 同口径）
            const tv = canon === 'BLOCKED' && result.value && result.value.termination
            if (tv && typeof tv.reason_code === 'string' && tv.reason_code) {
              r.reason = tv.reason_code
              if (typeof tv.resume_node === 'string' && tv.resume_node) r.node = tv.resume_node
            }
          })
        }
        // 诊断可追溯：引擎 error/cancelled 的渲染错误写入运行记录（此前 result.error 被丢弃，
        // 现场只能看到 status=error 无从定位）
        if (result && result.error) {
          const detail = String(result.error).slice(0, 500)
          onRun(runId, (r) => { r.error_detail = detail })
          log('段错误详情（' + runId + '）：' + detail)
        }
        // #80 暂停/中断收束：引擎取消段（stopReason=cancelled，脚本返回值被引擎强制丢弃）
        // 且控制面有待生效请求 → 翻译为 PAUSED，恢复现场从检查点行重建；不经 FAILED 映射。
        const pauseAction = logicalRec && logicalRec.pause_state && result && result.stopReason === 'cancelled'
          ? String(logicalRec.pause_state.action || 'pause')
          : null
        if (pauseAction) {
          const ck = extractCheckpoint(runs.get(runId))
          // 本段无可用检查点时保留上一有效现场（保守可恢复），不用降级现场静默覆盖
          const prevPr = logicalRec.pause_resume
          if (!(ck.degraded && prevPr && prevPr.degraded === false)) logicalRec.pause_resume = ck
          logicalRec.pause_state = null
          endLogicalSegment(logicalRec, runId, pauseAction === 'interrupt' ? 'CANCELLED_INTERRUPT' : 'CANCELLED_PAUSE')
          // #79 逐节点语义在取消段不缺位：检查点 results（段首基线之后新完成的节点）
          // 照常入档 node_attempts / business_outcomes（含溯源与结果提取）。
          // LOC-029：新脚本段先结算逐次提交（确认 → 回填索引），旧脚本走段末扫描回退。
          const attPause = await attk().then((t) => t.settle(logicalRec, runId, logicalRec.segments.length)).catch(() => null)
          if (!attPause) recordNodeAttempts(logicalRec, v.sanitized, beforeResultKeys, ck.results, null)
          // 中断语义：进行中/待执行的检查点节点 Attempt 记 INTERRUPTED（不产生正式成功
          // 结果，恢复后整体重跑）；降级现场（无检查点）无法定位节点，登记为已知限制。
          // 逐次提交段由 Store close 已把进行中 attempt 记为 interrupted，不重复入档。
          if (pauseAction === 'interrupt' && ck.entry && !attPause) {
            const snap = activeSnapshot(logicalRec)
            const eff = effectiveProviderModel(logicalRec, ck.entry)
            logicalRec.node_attempts.push({
              node: ck.entry, segment: logicalRec.segments.length,
              snapshot_revision: snap ? snap.revision : null,
              provider: String((eff && eff.provider) || 'default'), model: String((eff && eff.model) || 'default'),
              outcome: 'INTERRUPTED', completed_at: Date.now(),
            })
          }
          logicalSetState(logicalRec, 'PAUSED', logicalReason(pauseAction === 'interrupt' ? 'USER_INTERRUPT' : 'USER_PAUSE', ck.degraded ? '该段无可用检查点，恢复需人工指定 entry' : ''))
          controlEvent(logicalRec, pauseAction === 'interrupt' ? 'interrupted' : 'paused', { run_id: runId, checkpoint_entry: ck.entry || null, checkpoint_degraded: ck.degraded === true })
          // LOC-027：暂停/中断前已发出的冻结请求照常结算（成功→入档已核验引用，
          // 恢复段经 ebBaselineArgs 携带；失败→如实留痕，不阻断暂停收束）
          const ebcPause = ebRuns.get(runId)
          if (ebcPause && ebcPause.pending.size) {
            for (const [, p] of [...ebcPause.pending]) {
              try {
                const fz = await p.promise
                const ref = fz && fz.ok === true && fz.match !== false ? ebcPause.kernel.baselineRefOf(fz, p.req, ebcPause.taskId) : null
                if (ref) {
                  logicalRec.evaluation_baseline = ref
                  logicalRec.evaluation_baselines = (logicalRec.evaluation_baselines || []).concat([ref])
                  controlEvent(logicalRec, 'evaluation_baseline_frozen', { version: ref.version, digest: ref.digest, artifact_path: ref.artifact_path })
                } else {
                  controlEvent(logicalRec, 'evaluation_baseline_freeze_failed', { version: p.req.version, code: String((fz && fz.code) || 'FREEZE_FAILED'), error: String((fz && fz.error) || '') })
                }
              } catch (e) { /* 冻结结果不可得：留待后续核验定位，不伪装成功 */ }
            }
            ebcPause.pending.clear()
          }
          await refreshWorkspaceContext(logicalRec, wsIdentity)
          requestLogicalPersist(logicalRec.logical_run_id)
          onRun(runId, (r) => { r.status = 'PAUSED'; r.reason = pauseAction === 'interrupt' ? 'USER_INTERRUPT' : 'USER_PAUSE' })
          if (ws) await markWorkspaceLifecycle(wsIdentity, 'PAUSED')
          return JSON.stringify({ runId: runId, stopReason: 'paused', paused: true, action: pauseAction, logical_run_id: logicalRec.logical_run_id, checkpoint_entry: ck.entry || null, checkpoint_degraded: ck.degraded === true, engine_stop_reason: 'cancelled', value: result.value, agentsStarted: result.agentsStarted })
        }
        if (logicalRec && logicalRec.pause_state) {
          // 取消请求下发后段仍正常收束（abort 与完成竞速）：请求失效，按正常终态走
          logicalRec.pause_state = null
          controlEvent(logicalRec, 'control_voided', { run_id: runId })
        }
        // ── LOC-027 评价基线冻结闸门 ────────────────────────────────────────────
        // 冻结失败（原评价文件缺失/不可读/摘要与模型声称值不符）→ 结构化 BLOCKED，不进入
        // 执行/不放行；成功且段在检查点被中止 → 注入已核验基线引用自动恢复。恢复段内再次
        // 确认（RECONFIRM→新版本）按序继续闸门循环（EB_GATE_MAX_RESUMES 防循环）。
        let currentRunId = runId
        let baselineGateBlocked = null
        if (logicalRec && !pauseAction) {
          for (let gateIter = 0; gateIter < EB_GATE_MAX_RESUMES; gateIter++) {
            const g = await runBaselineGate({ logicalRec, engineRunId: currentRunId, result, execScript, meta: c.meta, scriptArgs, parent, segCtl, taskId: logicalTaskId, ws, wsIdentity, engine: engineNow })
            if (!g) break
            if (g.blocked) { baselineGateBlocked = g; break }
            if (!g.resumed) break
            currentRunId = g.runId
            result = g.result
            canon = g.canon
            if (g.seededKeys) beforeResultKeys = g.seededKeys
          }
        }
        if (baselineGateBlocked) {
          logicalSetState(logicalRec, 'BLOCKED', logicalReason(baselineGateBlocked.code, baselineGateBlocked.message))
          controlEvent(logicalRec, 'evaluation_baseline_gate', { decision: 'blocked', code: baselineGateBlocked.code, message: baselineGateBlocked.message, version: baselineGateBlocked.version === undefined ? null : baselineGateBlocked.version })
          endLogicalSegment(logicalRec, currentRunId, result && result.stopReason === 'cancelled' ? 'CANCELLED_BASELINE_FREEZE' : (canon || String((result && result.stopReason) || '')))
          await refreshWorkspaceContext(logicalRec, wsIdentity)
          requestLogicalPersist(logicalRec.logical_run_id)
          onRun(currentRunId, (r) => { r.status = 'BLOCKED'; r.reason = baselineGateBlocked.code })
          if (ws) await markWorkspaceLifecycle(wsIdentity, 'BLOCKED')
          return JSON.stringify({
            runId: currentRunId,
            stopReason: result && result.stopReason,
            value: {
              status: 'BLOCKED',
              code: baselineGateBlocked.code,
              message: baselineGateBlocked.message,
              recovery_hint: baselineGateBlocked.recovery_hint || null,
              evaluation_baseline_version: baselineGateBlocked.version === undefined ? null : baselineGateBlocked.version,
            },
            agentsStarted: (result && result.agentsStarted) || 0,
            evaluation_baseline_gate: { decision: 'blocked', code: baselineGateBlocked.code },
          })
        }
        if (currentRunId !== runId) {
          // 基线恢复段接管：权威终态回写到恢复段运行记录
          if (canon) onRun(currentRunId, (r) => { r.status = canon; applyHdValue(r, result.value) })
        }
        // #79 逻辑运行收尾：八态映射 + 完成类型镜像 + 节点实际修订/模型/业务结果
        // 记录 + 工作区上下文入档。Lifecycle 闸门不改写专业结果（R7）。
        let gateOutcome = null
        let evidenceFailed = false
        if (logicalRec) {
          const value = result && result.value
          endLogicalSegment(logicalRec, currentRunId, canon || String((result && result.stopReason) || ''))
          if (!canon && result && result.error) {
            // 引擎错误详情进逻辑运行摘要，看板与归档可追溯
            logicalRec.last_engine_error = String(result.error).slice(0, 500)
          }
          if (canon === 'DONE') {
            const comp = value && value.completion
            if (comp && typeof comp === 'object' && typeof comp.type === 'string' && comp.type.trim()) {
              logicalRec.completion = {
                type: comp.type,
                node: comp.node !== undefined && comp.node !== null ? String(comp.node) : '',
                path: comp.path !== undefined && comp.path !== null ? String(comp.path) : '',
              }
            }
            // LOC-028：记录已消费的人工决定，供幂等恢复与候选变化拦截
            const consumed = value && value.consumed_decision
            if (consumed && consumed.decision_id) {
              logicalRec.consumed_decisions = Object.assign({}, logicalRec.consumed_decisions || {}, {
                [String(consumed.decision_id)]: {
                  candidate_digest: consumed.candidate_digest || null,
                  completion: consumed.completion || logicalRec.completion || null,
                  consumed_at: Date.now(),
                },
              })
            }
          }
          // LOC-029 完成顺序：保存结果（脚本）→ 逐次提交确认（Store）→ 更新最新索引
          // 与检查点 → 推进。确认失败的段 fail-closed：保留专业结论与既有证据，
          // 但不宣布完成、不重签 Proof，恢复后重放/续跑按提交键幂等补齐。
          const att = await attk().then((t) => t.settle(logicalRec, runId, logicalRec.segments.length)).catch(() => null)
          evidenceFailed = !!(att && att.x.length)
          if (!att) recordNodeAttempts(logicalRec, v.sanitized, beforeResultKeys, value && value.results, value && value.control_event)
          if (evidenceFailed) {
            logicalSetState(logicalRec, 'FAILED', logicalReason('EVIDENCE_COMMIT_FAILED', att.x.join(';').slice(0, 300)))
          }
          const trans = evidenceFailed ? null : logicalTransitionFor(canon, result && result.stopReason, value)
          if (trans) logicalSetState(logicalRec, trans.state, trans.reason)
          // #80：基线修订在恢复段正常收束（脚本权威终态，含 WAITING_HUMAN）时消费——
          // ENGINE_ERROR/取消不消费，回跳会在下次恢复时重新发生
          if (isPauseResume && canon) {
            const lastApplied = (logicalRec.baseline_revisions || [])[logicalRec.baseline_revisions.length - 1]
            if (lastApplied && (logicalRec.baseline_applied_upto || 0) < lastApplied.revision) {
              logicalRec.baseline_applied_upto = lastApplied.revision
              controlEvent(logicalRec, 'baseline_rebase', { revision: lastApplied.revision, entry: args.entry })
            }
          }
          // LOC-008：节点收尾产物经 vwf.records.commit 单一通道入 Formal Records
          // Store（非阻断）。段号与 recordNodeAttempts 同源；摘要互相引用随之刷新。
          // LOC-029：逐次提交段已在调用时入 Store，跳过段末扫描（避免重复 Revision）。
          const resultsNow = value && typeof value.results === 'object' && value.results ? value.results : null
          if (resultsNow && !att) {
            const newKeys = Object.keys(resultsNow).filter((k) => !beforeResultKeys.has(k))
            if (newKeys.length) {
              const entries = await nodeRecordEntries(logicalRec, v.sanitized, resultsNow, newKeys, logicalRec.segments.length, ws, activeSnapshot(logicalRec), value.control_event)
              if (entries.length) await commitNodeRecords(logicalRec, entries)
            }
          }
          await refreshWorkspaceContext(logicalRec, wsIdentity)
          // LOC-027：已核验基线的事后核验——原路径被改写/删除或核验证据缺失=基线冲突，
          // BLOCKED 交人工（冻结副本已保留，可从确认节点重建新版本基线；不静默更新摘要）
          if (canon && logicalRec.evaluation_baseline && logicalRec.evaluation_baseline.status === 'verified') {
            const ebkV = await ebKernel()
            const vb = ebkV ? await verifyBaselineOriginal(ebkV, logicalRec) : null
            const conflict = ebkV ? ebkV.conflictOf(vb, logicalRec.evaluation_baseline, ebDecl ? ebDecl.producerNode : 'confirm') : null
            if (conflict) {
              const conflictCode = conflict.detail_code
              const conflictVersion = logicalRec.evaluation_baseline.version
              logicalRec.evaluation_baseline = Object.assign({}, logicalRec.evaluation_baseline, {
                status: 'conflict',
                conflict: { code: conflictCode, expected: conflict.expected, observed: conflict.observed, at: Date.now() },
              })
              controlEvent(logicalRec, 'evaluation_baseline_conflict', { version: conflictVersion, code: conflictCode, expected: conflict.expected, observed: conflict.observed })
              logicalSetState(logicalRec, 'BLOCKED', logicalReason('EVALUATION_BASELINE_CONFLICT', conflict.message))
              await refreshWorkspaceContext(logicalRec, wsIdentity)
              requestLogicalPersist(logicalRec.logical_run_id)
              onRun(currentRunId, (r) => { r.status = 'BLOCKED'; r.reason = 'EVALUATION_BASELINE_CONFLICT'; r.decision_id = ''; r.decision_package = null })
              if (ws) await markWorkspaceLifecycle(wsIdentity, 'BLOCKED')
              return JSON.stringify({
                runId: currentRunId,
                stopReason: result && result.stopReason,
                value: {
                  status: 'BLOCKED',
                  code: conflict.code,
                  message: conflict.message,
                  recovery_hint: conflict.recovery_hint,
                  evaluation_baseline: { version: conflictVersion, artifact_path: logicalRec.evaluation_baseline.artifact_path, digest: logicalRec.evaluation_baseline.digest, conflict_code: conflictCode },
                },
                agentsStarted: (result && result.agentsStarted) || 0,
                evaluation_baseline_gate: { decision: 'blocked', code: conflict.code },
              })
            }
          }
          // LOC-035：材料就绪闸门——WAITING_HUMAN 前检查节点产物 manifest；必需缺失
          // 则 BLOCKED（专业结果保留在 value.results，不宣称验收材料就绪）。
          if (canon === 'WAITING_HUMAN' && value && value.node) {
            const ag = artifactGateOf(currentRunId, value.node)
            if (ag) {
              logicalSetState(logicalRec, 'BLOCKED', logicalReason(ag.code, ag.message))
              controlEvent(logicalRec, ag.event, { node: value.node, code: ag.code, manifest_revision: ag.manifest_revision })
              await refreshWorkspaceContext(logicalRec, wsIdentity)
              requestLogicalPersist(logicalRec.logical_run_id)
              onRun(currentRunId, (r) => { r.status = 'BLOCKED'; r.reason = ag.code })
              if (ws) await markWorkspaceLifecycle(wsIdentity, 'BLOCKED')
              return JSON.stringify({
                runId: currentRunId,
                stopReason: result && result.stopReason,
                value: {
                  status: 'BLOCKED',
                  code: ag.code,
                  message: ag.message,
                  recovery_hint: ag.recovery_hint || null,
                  node: value.node,
                  results: value.results,
                  artifact_manifest: ag.entries || null,
                },
                agentsStarted: (result && result.agentsStarted) || 0,
                artifact_manifest_gate: { decision: 'blocked', code: ag.code },
              })
            }
          }
          // LOC-017 集成闸门（B2）：Git ISOLATED_WRITE 运行在人工等待结算前自动执行。
          // 放行 → 维持人工等待；目标前进 → 同一逻辑运行内自动同步+重跑；失败 → BLOCKED。
          // 证据提交失败的段不得重签 Proof（fail-closed），先恢复证据再过闸门。
          if (canon === 'WAITING_HUMAN' && !evidenceFailed && ws && ws.workspace_mode === 'ISOLATED_WRITE') {
            gateOutcome = await runIntegrationGate({ logicalRec, ws, wsIdentity, dsl: v.sanitized, scriptArgs, meta: c.meta, execScript, parent, segCtl, resultsNow, taskId, outerRunId: currentRunId, engine: engineNow })
            if (gateOutcome && gateOutcome.blocked) {
              logicalSetState(logicalRec, 'BLOCKED', logicalReason(gateOutcome.code, gateOutcome.message))
              controlEvent(logicalRec, 'integration_gate', { decision: 'blocked', code: gateOutcome.code, message: gateOutcome.message, iterations: gateOutcome.trace ? gateOutcome.trace.iterations : 0, observed_head: gateOutcome.trace ? gateOutcome.trace.observed_head : null })
              onRun(currentRunId, (r) => { r.status = 'BLOCKED'; r.reason = gateOutcome.code; r.decision_id = ''; r.decision_package = null; r.results = null })
            } else if (gateOutcome && gateOutcome.trace) {
              controlEvent(logicalRec, 'integration_gate', {
                decision: gateOutcome.trace.decision,
                iterations: gateOutcome.trace.iterations,
                proofs_state: gateOutcome.trace.proofs_state || null,
                observed_head: gateOutcome.trace.observed_head || null,
                syncs: gateOutcome.trace.syncs.length,
                reruns: gateOutcome.trace.reruns.length,
                rerun_terminal: gateOutcome.trace.rerun_terminal || null,
              })
            }
            // 闸门窗口内发生过锁获取/释放与同步：收尾再刷一次工作区上下文留痕（B12）
            await refreshWorkspaceContext(logicalRec, wsIdentity)
          }
          requestLogicalPersist(logicalRec.logical_run_id)
        }
        if (ws) {
          const blockedGate = !!(gateOutcome && gateOutcome.blocked)
          const finalCanon = gateOutcome && gateOutcome.finalCanon !== undefined ? gateOutcome.finalCanon : canon
          // LOC-029：证据提交失败的段不以完成态放行 workspace
          const lc = blockedGate ? 'BLOCKED' : (evidenceFailed ? 'FAILED' : lifecycleFor(finalCanon, (gateOutcome && gateOutcome.finalStopReason) || (result && result.stopReason)))
          if (lc) await markWorkspaceLifecycle(wsIdentity, lc)
        }
        const outRunId = gateOutcome && gateOutcome.finalRunId ? gateOutcome.finalRunId : currentRunId
        const outStop = gateOutcome && gateOutcome.finalStop !== undefined ? gateOutcome.finalStop : result.stopReason
        // 闸门拦截：返回 BLOCKED 现场（不携带原 decision_package，杜绝 HD 续跑绕过闸门，fail-open 封堵）
        const outValue = gateOutcome && gateOutcome.blocked
          ? { status: 'BLOCKED', code: gateOutcome.code, message: gateOutcome.message, recovery_hint: '从 uat 节点续跑同一逻辑运行（wf_run entry=uat）以重新通过集成闸门；人工决策续跑已被拒绝', integration_gate: gateOutcome.trace }
          : (gateOutcome && gateOutcome.finalValue !== undefined ? gateOutcome.finalValue : result.value)
        const outAgents = (result.agentsStarted || 0) + (gateOutcome && gateOutcome.trace ? gateOutcome.trace.reruns.reduce((n, r) => n + (r.agents_started || 0), 0) : 0)
        return JSON.stringify({ runId: outRunId, stopReason: outStop, value: outValue, agentsStarted: outAgents, integration_gate: gateOutcome ? gateOutcome.trace : undefined })
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
      name: 'wf_control',
      description: '对 Logical Run 下发运行控制（#80）：action=pause 安全暂停（等待最近完成节点的检查点后生效，最坏等待一个节点完成；检查点后已启动的下一节点将被中止并在恢复后整体重跑）；action=interrupt 立即中断当前 Node Attempt（记 INTERRUPTED，不产生正式成功结果；等待中的暂停请求会升级为中断）；action=guidance 暂停期间提交用户指导（mode=coach 普通指导，不改基线；mode=baseline 实质基线变更，必须提供 new_baseline 要点，恢复后回基线负责节点整体重跑）。恢复同一逻辑运行：wf_run + resume_paused=true。',
      parameters: {
        action: { type: 'string', required: true, description: 'pause | interrupt | guidance' },
        logical_run_id: { type: 'string', required: true, description: 'Logical Run id（看板「同一次运行」卡片或 wf_run 返回中的 logical_run_id）' },
        text: { type: 'string', description: 'guidance：指导内容（可多轮提交）' },
        mode: { type: 'string', description: 'guidance：coach（默认，仅指导）| baseline（实质基线变更）' },
        new_baseline: { type: 'string', description: 'guidance mode=baseline 必填：新基线要点（目标/范围/硬性要求的变化说明）' },
      },
      async execute(rawArgs) {
        const fn = rpcRoutes.get('vwf.run.control')
        if (typeof fn !== 'function') return JSON.stringify({ ok: false, errors: [{ at: '$', message: '控制面不可用' }] })
        try { const res = await fn(rawArgs || {}); return typeof res === 'string' ? res : JSON.stringify(res) } catch (e) { return JSON.stringify({ ok: false, errors: [{ at: '$', message: errMsg(e) }] }) }
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
          pluginRoot: PLUGIN_ROOT, codeRoot: CODE_ROOT, dist: DIST, generator: GENERATOR, workspaceHost: WS_HOST, recordsHost: RECORDS_HOST, operationsHost: OPERATIONS_HOST, deliveryCloseoutHost: DELIVERY_CLOSEOUT_HOST,
          projectRoot: projectRoot(), dshHome: await dshHome(), generatedRoots: generatedRoots(), userDir: d && d.userDir, skillRoot: d && d.skillRoot, runsDir: d && d.runsDir, recordsDir: d && d.recordsDir,
          fsAvailable: fs !== undefined, subprocessAvailable: subprocess !== undefined, nodePath: await resolveNode(),
        }, null, 2)
      },
    }))
  },
}
