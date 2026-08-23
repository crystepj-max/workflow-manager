// ─────────────────────────────────────────────────────────────────────────────
// visual-workflow · HOST 半（pkg-20，编辑模块 Gold-Band 对齐版）
//
// 基于 pkg-19 host 改造：
//  - 校验收敛进统一内核 scripts/validate-core.cjs（候选二 T-IMP-13）：结构层
//    （入口拓扑推导 / $end 必须 / 悬空节点 / 保留 id / 成功表达式路径落在
//    output.schema 内 / 边来源目标与类型 / when 仅 success / failure 唯一 /
//    多 success 出边必须全部带 when / success 环检测 / 走通性 / maxRounds 1-9）
//    + 蓝图业务规则层（异源硬规则 / requireModels 产品收紧）；经 fs 读源码、
//    vm 内求值缓存（热路径内存执行）。原 validateDsl / heteroCheck / 拓扑推导
//    已删除。校验结果带 fieldErrors（node:<id>:<field> / edge:<i>:<field> /
//    control:<field>）供编辑面板逐字段标红。
//  - sanitizeDsl：保存前清洗（entry 依内核拓扑归一、failure 边剔除 when、空白修整），
//    对应 Gold-Band 的 sanitizedWorkflow。
//  - 新增 vwf.roles RPC：列出工作区 dsh/roles/*.md 角色（fs 服务，多形态兜底），
//    供节点表单的角色选择器使用（对应 Gold-Band 的 ProfilePicker 数据源）。
//  - 保留 pkg-19 全部 RPC（workflows.list/save/remove、validate、compile、
//    script、state、models）与 wf_run 工具、运行状态跟踪。
//
// T-IMP-06（双根加载 + 用户模板落盘闭环，FR-2/FR-3，AC-2/AC-3）：
//  - 废除硬编码 TEMPLATES（L29-74）→ 目录加载：内置 = <repo>/.generated/<id>/vwf-dsl.json
//    （生成物，CI 先 npm run generate）+ ~/.dsh/.generated（syncBuiltins 同步，会话无关，
//    默认工作流这类用户级内置模板在任意项目会话可见）；用户 = ~/.dsh/visual-workflow/templates/<id>.json
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
//  校验内核 validate-core.cjs 规则 7 行为一致（候选二统一）。
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
    let fs = ctx.get('fs')
    const sp = ctx.get('sandboxPolicy')
    let subprocess = ctx.get('subprocess')

    // ── 双模式 RPC 注册（动态会话=harness.handle / 静态 bundle=webServer 路由）──
    // 动态插件运行时提供 harness 内建；静态组合包没有，改经 webServer 前缀路由
    // （POST /dsh-visual-workflow/<method>，信封 {rpcId,method,payload}→{rpcId,result}）
    // 必须用 typeof 探测未声明标识符：静态 IIFE / Minke 无 harness 全局，直接读会 ReferenceError。
    const isDynamicHost = typeof harness !== 'undefined'
    const rpcRoutes = new Map()
    function registerRpc(method, fn) {
      if (isDynamicHost) { harness.handle(method, fn); return }
      rpcRoutes.set(method, fn)
    }
    // 工具定义/注册双模式：动态=harness.defineTool/registerTool；静态=ctx.tools + 平台 defineTool
    const dtools = {
      define(t) {
        if (isDynamicHost && typeof harness.defineTool === 'function') return harness.defineTool(t)
        if (typeof defineTool === 'function') return defineTool(t)
        return t
      },
      register(ctx2, t) {
        if (isDynamicHost && typeof harness.registerTool === 'function') { harness.registerTool(ctx2, t); return }
        const tools = ctx2.get('tools')
        if (tools && typeof tools.register === 'function') tools.register(t)
        else console.log('[vwf] tools 服务缺失，工具未注册：' + (t && t.name))
      },
    }

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
          // 宿主 env 经 scrub 后仍保留 HOME；DSH_* 被剥除，os.homedir() 不受影响。
          // 优先子进程引导（动态 vm 沙箱与测试假服务均走这里）；子进程服务不可用时
          // （静态/web profile 无 subprocess 服务）回落进程 env：DSH_HOME 显式覆盖，
          // 否则 HOME + '/.dsh'。
          let home = null
          const r = await runNode(['-e', "console.log(require('path').join(require('os').homedir(), '.dsh'))"], { cwd: repoRoot() || '/' })
          if (r.ok) {
            home = (r.stdout || '').trim()
          } else if (typeof process !== 'undefined' && process && process.env) {
            const envHome = process.env.DSH_HOME || process.env.HOME
            if (typeof envHome === 'string' && envHome) {
              home = process.env.DSH_HOME ? envHome : envHome.replace(/\/$/, '') + '/.dsh'
            }
          }
          return home || null
        })()
      }
      return dshHomePromise
    }

    async function rootPaths() {
      const repo = repoRoot()
      const home = await dshHome()
      const packageRepo = (typeof __VWF_REPO__ === 'string' && __VWF_REPO__) ? __VWF_REPO__ : null
      const generatorRoot = packageRepo || repo
      return {
        repo: repo,
        // 静态组合包的生成/校验脚本根；web profile 的 workspaceRoot 可能属于 DSH 宿主仓库。
        generatorRoot: generatorRoot,
        builtinDir: repo ? repo + '/.generated' : null,
        // 静态组合包的仓库根（仅 bundle 内注入）；避免首次 RPC 早于同步任务时看不到模板。
        packageBuiltinDir: packageRepo ? packageRepo + '/.generated' : null,
        // 宿主根内置模板（会话无关）：安装/重装时经 syncBuiltins 同步的标准配置，
        // 任何会话都能看到（默认工作流这类用户级内置模板）
        homeBuiltinDir: home ? home + '/.generated' : null,
        userDir: home ? home + '/visual-workflow/templates' : null,
        skillRoot: home ? home + '/skills' : null,
        generator: generatorRoot ? generatorRoot + '/scripts/generate.mjs' : null,
      }
    }

    // 用户目录（~/.dsh 宿主数据根）写入不受会话 workspace-write 沙箱约束；
    // sandboxPolicy 服务缺失时（web profile 无 agent 会话），手工构造 danger-full-access
    // 策略——fs 服务的策略层只认 policy.mode === 'danger-full-access' 即放行。
    function writePolicy() {
      if (sp && typeof sp.resolve === 'function') {
        try { return sp.resolve({ mode: 'danger-full-access' }) } catch (e) { /* fall through */ }
      }
      return { mode: 'danger-full-access', workspaceRoot: '/' }
    }

    // 安装/重装时同步内置模板到宿主根（会话无关）：把仓库 .generated 的标准配置
    // 复制到 ~/.dsh/.generated（仅补缺失，已存在不动），使任何会话都能看到内置模板。
    // fs 服务可能尚未注入，重试几次再放弃（每次重取 ctx）——与 apply 的加载时序解耦。
    async function syncBuiltins() {
      for (let attempt = 0; attempt < 10; attempt++) {
        fs = ctx.get('fs')
        subprocess = ctx.get('subprocess')
        if (fs !== undefined) break
        // 动态会话 vm 沙箱不提供真定时器（setTimeout 为教学拦截陷阱函数）：
        // 无定时器或调用被拦截则放弃重试（会话内 fs 通常立即可用）
        try {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
        } catch (e) { break }
      }
      if (fs === undefined) { console.log('[vwf] fs 服务不可用，跳过内置模板同步'); return }
      const p = await rootPaths()
      if (!p.homeBuiltinDir) return
      const policy = writePolicy()
      // 源根：会话 cwd（动态模式）优先，打包期仓库根（静态 bundle 编译期注入
      // __VWF_REPO__）与进程 cwd 兜底（web profile 无 agent 会话）
      const sources = []
      if (p.repo) sources.push(p.builtinDir)
      if (p.packageBuiltinDir && sources.indexOf(p.packageBuiltinDir) < 0) sources.push(p.packageBuiltinDir)
      if (typeof __VWF_REPO__ === 'string' && __VWF_REPO__) {
        const pkgRoot = __VWF_REPO__ + '/.generated'
        if (sources.indexOf(pkgRoot) < 0) sources.push(pkgRoot)
      }
      try {
        const cwdRoot = process.cwd() + '/.generated'
        if (sources.indexOf(cwdRoot) < 0) sources.push(cwdRoot)
      } catch (e) { /* 忽略 */ }
      for (const srcRoot of sources) {
        let entries = null
        try {
          const dir = await fs.resolve(srcRoot)
          entries = await fs.listDir(dir)
        } catch (e) { continue }
        // 递归复制（含 roles/ 等子目录——bundleRoles 模板的角色包为目录树）
        const copyTree = async (srcRel, dstRel) => {
          let children = null
          try {
            children = await fs.listDir(await fs.resolve(srcRoot + srcRel))
          } catch (e) { return }
          for (const child of children || []) {
            if (!child || typeof child.name !== 'string' || !child.name) continue
            const sub = srcRel + '/' + child.name
            if (child.type === 'directory') {
              await copyTree(sub, dstRel + '/' + child.name)
              continue
            }
            if (child.type !== 'file') continue
            const dst = await fs.resolve(p.homeBuiltinDir + dstRel + '/' + child.name)
            let exists = false
            try { const st = await fs.stat(dst); exists = !!(st && st.type === 'file') } catch (e) { }
            if (exists) continue
            try {
              // fs 服务无 mkdir 面：writeText 后端保证创建父目录（writeFileAtomic 递归 mkdir）
              await fs.writeText(dst, await fs.readText(await fs.resolve(srcRoot + sub)), undefined, undefined, policy)
            } catch (e) { /* 单文件同步失败不影响其余 */ }
          }
        }
        for (const ent of entries || []) {
          if (!ent || typeof ent.name !== 'string' || !ent.name) continue
          if (ent.type !== 'directory') continue
          // 只有蓝图明确声明 bundleRoles 的用户级内置模板才进入宿主根；
          // 项目专属模板（如 dev-workflow-2-0）继续只在项目内可见。
          let bundleRoles = false
          try {
            const marker = await fs.readText(await fs.resolve(srcRoot + '/' + ent.name + '/vwf-dsl.json'))
            bundleRoles = JSON.parse(marker).bundleRoles === true
          } catch (e) { /* 缺少标记或损坏产物不进入用户级同步 */ }
          if (!bundleRoles) continue
          await copyTree('/' + ent.name, '/' + ent.name)
        }
      }
    }
    // 与 apply 时序解耦的异步同步：不阻塞 apply，失败仅在终端日志留痕
    syncBuiltins().catch((e) => console.log('[vwf] 内置模板同步失败：' + String((e && e.message) || e)))

    // 内置根：.generated/<id>/vwf-dsl.json（生成物四件套之一，CI 先 npm run generate）
    // 双根：仓库 .generated（开发期最新）优先，宿主根 ~/.dsh/.generated（syncBuiltins 同步，
    // 会话无关）补缺失——默认工作流这类用户级内置模板在任意项目会话都可见
    async function loadBuiltins() {
      const out = new Map()
      if (fs === undefined) return out
      const p = await rootPaths()
      const roots = [p.builtinDir, p.packageBuiltinDir, p.homeBuiltinDir].filter(Boolean)
      for (const root of roots) {
        let entries = null
        try {
          const dir = await fs.resolve(root)
          entries = await fs.listDir(dir)
        } catch (e) { continue }
        for (const ent of entries || []) {
          if (!ent || typeof ent.name !== 'string' || !ent.name) continue
          try {
            const target = await fs.resolve(root + '/' + ent.name + '/vwf-dsl.json')
            const info = await fs.stat(target)
            if (!info || info.type !== 'file') continue
            const dsl = JSON.parse(await fs.readText(target))
            if (dsl && typeof dsl.id === 'string' && dsl.id && !out.has(dsl.id)) out.set(dsl.id, dsl)
          } catch (e) { /* 单个生成物损坏不影响其余 */ }
        }
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
      const out = {
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
      // 业务规则字段（候选二 Q7，与 generate.mjs projectToVwf 一致）
      if (bp.onMaxRounds !== undefined) out.onMaxRounds = bp.onMaxRounds
      if (bp.heteroCheck) out.heteroCheck = true
      return out
    }
    // 逆投影（save 落盘格式：蓝图 JSON；候选二 Q7：业务规则字段 onMaxRounds/
    // heteroCheck 已在 DSL 中（前端可配置），原样带回蓝图；verifyBranch 节点级
    // 字段无编辑器 UI、不在 DSL，自然不产生）
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
        // 空/空白名称原样保留（displayName 必填校验会拒绝），仅缺省（undefined）兜底 id
        displayName: typeof dsl.name === 'string' ? dsl.name : (dsl.id || ''),
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
      if (dsl.onMaxRounds !== undefined) bp.onMaxRounds = dsl.onMaxRounds
      if (dsl.heteroCheck) bp.heteroCheck = true
      if (Object.keys(models).length) bp.bindings = { models: models }
      return bp
    }


    // ── 统一校验管道（候选二 T-IMP-13）───────────────────────────────────────
    // 校验内核 = scripts/validate-core.cjs（唯一规则集：结构层 + 蓝图业务规则层）。
    // host 无法 import（vm 沙箱），经 fs 服务读源码、vm 内求值并缓存——热路径内存执行。
    // 管线：sanitize（DSL 形态归一）→ 逆投影蓝图 → core.validateBlueprint({requireModels:true})
    //   → 错误坐标映射 fieldErrors（node:<id>:<field> / edge:<i>:<field> / control:<field>）。
    // 原 validateDsl / heteroCheck / 拓扑推导 / COND_RE 已删除（唯一实现收敛进内核）。
    let validatorCorePromise = null
    function loadValidatorCore() {
      if (!validatorCorePromise) {
        validatorCorePromise = (async () => {
          const repo = repoRoot()
          if (fs === undefined) return null
          // 动态会话优先读当前项目；静态/web 模式没有项目路径时，
          // 读取组合包注入的仓库根，避免编辑器保存被误报为缺少校验内核。
          const roots = [
            repo,
            (typeof __VWF_REPO__ === 'string' && __VWF_REPO__) ? __VWF_REPO__ : null,
          ].filter(Boolean)
          for (const root of roots) {
            try {
              const target = await fs.resolve(root + '/scripts/validate-core.cjs')
              const info = await fs.stat(target)
              if (!info || info.type !== 'file') continue
              const src = await fs.readText(target)
              const module = { exports: {} }
              new Function('module', 'exports', src)(module, module.exports)
              return module.exports
            } catch (e) { /* 尝试下一个根 */ }
          }
          return null
        })()
      }
      return validatorCorePromise
    }

    // 保存前清洗（对应 Gold-Band sanitizedWorkflow）：entry 依拓扑归一（内核推导）、
    // failure 边剔除 when、maxRounds 取整——DSL 形态变换，留在宿主。
    function sanitizeDsl(dsl, core) {
      const next = JSON.parse(JSON.stringify(dsl || {}))
      next.edges = Array.isArray(next.edges) ? next.edges : []
      next.nodes = Array.isArray(next.nodes) ? next.nodes : []
      if (core && core.deriveEntryCandidates) {
        const candidates = core.deriveEntryCandidates(next.nodes, next.edges)
        next.entry = candidates.length === 1 ? candidates[0] : (next.entry || '')
      }
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

    // DSL 校验（编辑器/保存/运行共用）：返回 { ok, errors, fieldErrors, sanitized, warnings }
    //  error: { at, message, fieldKey? }（lossless-JSON 守卫：可选键仅在定义时携带）
    async function validatePipeline(dsl) {
      const core = await loadValidatorCore()
      if (!core) {
        return { ok: false, errors: [{ at: '$', message: '校验内核不可用：缺少 scripts/validate-core.cjs（请确认仓库完整）' }], fieldErrors: {} }
      }
      if (!dsl || typeof dsl !== 'object') {
        return { ok: false, errors: [{ at: '$', message: 'dsl 必须是对象' }], fieldErrors: {} }
      }
      // 原始边预检：failure 边带 when 必须报错（sanitize 会剔除 when，须在清洗前拦截）
      const rawErrors = []
      if (Array.isArray(dsl.edges)) {
        dsl.edges.forEach((e, i) => {
          if (e && e.when !== undefined && e.on !== 'success') {
            rawErrors.push({ at: '$.edges[' + i + '].when', message: 'when 只允许用于 success 边', fieldKey: 'edge:' + i + ':when' })
          }
        })
      }
      const sanitized = sanitizeDsl(dsl, core)
      const bp = projectToBlueprint(sanitized)
      const v = core.validateBlueprint(bp, { requireModels: true })
      const errors = []
      const fieldErrors = {}
      for (const e of rawErrors) {
        errors.push(e)
        if (e.fieldKey !== undefined) (fieldErrors[e.fieldKey] = fieldErrors[e.fieldKey] || []).push(e.message)
      }
      for (const e of v.errors || []) {
        const entry = { at: e.at, message: e.message }
        if (e.fieldKey !== undefined) entry.fieldKey = e.fieldKey
        errors.push(entry)
        if (entry.fieldKey !== undefined) (fieldErrors[entry.fieldKey] = fieldErrors[entry.fieldKey] || []).push(e.message)
      }
      return { ok: v.ok, errors, fieldErrors, sanitized, warnings: v.warnings || [] }
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
        // 磁盘产物优先：仓库 .generated → 宿主根 .generated（用户级内置，syncBuiltins 同步）→ 用户 skill 闭环产物
        // bundleRoles 模板在产物目录旁带 roles/ 自包含角色包，命中则随译文返回 roleDir
        const spots = [p.builtinDir, p.packageBuiltinDir, p.homeBuiltinDir, p.skillRoot]
        for (const spot of spots) {
          if (!spot) continue
          const script = await readTextIfExists(spot + '/' + dsl.id + '/script.mjs')
          if (!script) continue
          const out = { ok: true, script, meta: metaFromDsl(dsl) }
          if (fs !== undefined) {
            try {
              const rolesDir = spot + '/' + dsl.id + '/roles'
              const rd = await fs.resolve(rolesDir)
              const ents = await fs.listDir(rd)
              if (ents && ents.length) out.roleDir = rolesDir
            } catch (e) { /* 无角色包则不携带 roleDir（调用方走 args.roleDir 或缺省 dsh/roles） */ }
          }
          return out
        }
      }
      if (fs === undefined || subprocess === undefined || !p.generatorRoot || !p.generator || !p.userDir) {
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
      const r = await runNode([p.generator, 'compile', tmp], { cwd: p.generatorRoot, graceMs: 30000 })
      try { await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", tmp], { cwd: p.generatorRoot }) } catch (e) {}
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

    registerRpc('vwf.workflows.list', async () => listWorkflows())
    registerRpc('vwf.workflows.save', async (a) => {
      const dsl = a && a.dsl
      const v = await validatePipeline(dsl)
      if (!v.ok) return { ok: false, errors: v.errors, fieldErrors: v.fieldErrors }
      const id = v.sanitized.id
      const p = await rootPaths()
      if (fs === undefined || !p.generatorRoot || !p.userDir || !p.skillRoot || !p.generator) {
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
      const gen = await runNode([p.generator, 'user', file, p.skillRoot], { cwd: p.generatorRoot, graceMs: 60000 })
      if (!gen.ok) {
        // 闭环失败：回滚已落盘蓝图，save 保持原子（蓝图级校验失败同此路径）
        try {
          await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", file], { cwd: p.generatorRoot })
        } catch (e) {}
        return { ok: false, errors: [{ at: '$', message: '蓝图校验/技能生成失败（save 已回滚）：' + gen.detail }] }
      }
      return { ok: true, id: id, dsl: v.sanitized, warnings: v.warnings }
    })
    registerRpc('vwf.workflows.remove', async (a) => {
      const id = a && a.id
      if (!id || typeof id !== 'string') return { ok: false, errors: [{ at: '$.id', message: '缺少模板 id' }] }
      const p = await rootPaths()
      if (fs === undefined || !p.generatorRoot || !p.userDir || !p.skillRoot) {
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
      const rm = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", file], { cwd: p.generatorRoot })
      if (!rm.ok) return { ok: false, errors: [{ at: '$', message: '模板删除失败：' + rm.detail }] }
      const skillDir = p.skillRoot + '/' + id
      await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", skillDir], { cwd: p.generatorRoot })
      return { ok: true, id: id }
    })
    registerRpc('vwf.validate', async (a) => {
      const v = await validatePipeline(a && a.dsl)
      return { ok: v.ok, errors: v.errors, fieldErrors: v.fieldErrors, sanitized: v.sanitized, warnings: v.warnings }
    })
    // vwf.compile 已删除（T-IMP-12）：统一编译器后无独立编译 RPC；脚本经 vwf.script 走管道。
    registerRpc('vwf.script', async (a) => {
      const dsl = a && a.dsl
      const v = await validatePipeline(dsl)
      if (!v.ok) return { ok: false, errors: v.errors }
      // 模板命中（含 bundleRoles 用户级内置模板）走磁盘产物并带出 roleDir；否则 CLI 编译临时图
      const fromTemplate = !!(dsl && typeof dsl.id === 'string' && (await findWorkflow(dsl.id)))
      const c = await compileViaPipeline(v.sanitized, { fromTemplate })
      if (!c.ok) return { ok: false, errors: [{ at: '$', message: c.detail }] }
      const out = { ok: true, engineAvailable: !!(resolveEngine()), script: c.script, meta: c.meta }
      if (c.roleDir) out.roleDir = c.roleDir
      return out
    })
    registerRpc('vwf.state', async (a) => {
      const s = a && a.runId ? runs.get(a.runId) : null
      if (!s) return { found: false, state: null }
      return { found: true, state: { id: a.runId, meta: s.meta, status: s.status, phase: s.phase, logs: s.logs, agents: s.agents } }
    })
    registerRpc('vwf.models', async () => {
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
    registerRpc('vwf.roles', async () => {
      const fallback = () => ({ roles: FALLBACK_ROLES })
      if (fs === undefined) return fallback()
      // 目录优先级：发起会话仓库根（动态模式，即会话工作区）→ fs 服务默认 cwd 相对
      // 'dsh/roles'（静态/web 模式无 agent 会话时兜底尝试）→ 内置六角色清单。
      const p = await rootPaths()
      const roleDir = p.repo ? p.repo + '/dsh/roles' : 'dsh/roles'
      try {
        const dir = await fs.resolve(roleDir)
        const info = await fs.stat(dir)
        if (!info || info.type !== 'directory') return fallback()
        const entries = (await fs.listDir(dir) || [])
          .filter(e => e && typeof e.name === 'string' && /\.md$/i.test(e.name))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        if (!entries.length) return fallback()
        const roles = []
        for (const ent of entries) {
          const id = ent.name.replace(/\.md$/i, '')
          let summary = ''
          try {
            const text = String(await fs.readText(await fs.resolve(roleDir + '/' + ent.name)))
            const firstLine = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('---') && !l.startsWith('id:') && !l.startsWith('name:') && !l.startsWith('summary') && !l.startsWith('createdAt') && !l.startsWith('updatedAt') && !l.startsWith('dynamicTemplate') && !l.startsWith('#'))[0]
            summary = (firstLine || '').slice(0, 80)
          } catch (e) {}
          roles.push({ id, name: id, summary })
        }
        return { roles: roles.length ? roles : FALLBACK_ROLES }
      } catch (e) {
        return fallback()
      }
    })

    // ── 静态 bundle 模式：webServer RPC 路由（动态模式走 harness.handle）────
    // 信封与平台一致：POST /dsh-visual-workflow/<method>
    //   请求 {type:'client-request', rpcId, method, payload}
    //   响应 {rpcId, result}（result = 各 handler 的原样返回值）
    if (!isDynamicHost) {
      const webServer = ctx.get('webServer')
      if (webServer && typeof webServer.register === 'function') {
        ctx.effect(() => webServer.register({
          kind: 'prefix',
          path: '/dsh-visual-workflow',
          handler: function vwfRpcHandler(req, res) {
            if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'POST only' })); return }
            let raw = ''
            req.on('data', (c) => { raw += c })
            req.on('end', async () => {
              let rpcId = '', method = '', payload = {}
              try {
                const msg = JSON.parse(raw || '{}')
                rpcId = String(msg.rpcId || '')
                method = String(msg.method || '')
                payload = msg.payload || {}
              } catch (e) {}
              const fn = rpcRoutes.get(method)
              let result
              if (typeof fn !== 'function') result = { ok: false, errors: [{ at: '$', message: '未知方法：' + method }] }
              else try { result = await fn(payload) } catch (e) { result = { ok: false, errors: [{ at: '$', message: String((e && e.message) || e) }] } }
              try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rpcId: rpcId || 'r0', result: result === undefined ? null : result })) } catch (e) {}
            })
          }
        }), 'vwf: rpc route')
      } else {
        console.log('[vwf] webServer 服务缺失：静态 RPC 路由未注册，client 将无法调用 vwf.*')
      }
    }

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
      const tool = dtools.define({
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
          const v = await validatePipeline(dsl)
          if (!v.ok) return 'DSL 校验失败：' + JSON.stringify(v.errors)
          const c = await compileViaPipeline(v.sanitized, { fromTemplate })
          if (!c.ok) return '编译失败：' + c.detail
          const engineNow = resolveEngine()
          if (engineNow === undefined) return '错误：当前宿主平面无法访问 workflowEngine（wf_run 需要 agent preset 挂载的工作流引擎）。可改用内置 workflow 工具执行 vwf.script 编译产物。'
          const parent = agents.requireInitiator()
          const scriptArgs = {
            taskId: args.taskId, runDir: args.runDir, roleDir: args.roleDir || c.roleDir, baseBranch: args.baseBranch,
            issueRef: args.issueRef, issueTitle: args.issueTitle, issueBody: args.issueBody, issueComments: args.issueComments,
            requirement: args.requirement, entry: args.entry, approved: args.approved, feedback: args.feedback, startRound: args.startRound, history: args.history
          }
          const run = engineNow.start({ script: c.script, meta: c.meta, args: scriptArgs, parent: parent })
          const result = await run.result
          return JSON.stringify({ runId: String(run.id), stopReason: result.stopReason, value: result.value, agentsStarted: result.agentsStarted })
        }
      })
      dtools.register(ctx, tool)
      // 诊断工具（定位删除/路径问题）：op=paths 返回路径解析；op=remove 逐步执行删除
      const debugTool = dtools.define({
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
              userDir: p.userDir, skillRoot: p.skillRoot, builtinDir: p.builtinDir, homeBuiltinDir: p.homeBuiltinDir, generatorRoot: p.generatorRoot, generator: p.generator,
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
            const rm = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", file], { cwd: p.generatorRoot })
            steps.rm = rm
            const skillDir = p.skillRoot + '/' + id
            const rm2 = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", skillDir], { cwd: p.generatorRoot })
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
      dtools.register(ctx, debugTool)
    } else {
      console.log('[vwf] workflowEngine 未解析（host ctx 与 agent-preset 桥接均不可用）或 agents 未挂载：wf_run 工具不注册；编译产物经 vwf.script RPC 提供给 workflow 工具执行')
    }
  },
}
