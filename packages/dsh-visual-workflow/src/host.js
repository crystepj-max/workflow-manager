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
        if (tools && typeof tools.register === 'function') {
          if (ctx2 && typeof ctx2.effect === 'function') {
            ctx2.effect(() => tools.register(t), 'vwf: tool ' + (t && t.name))
          } else {
            tools.register(t)
          }
        } else console.log('[vwf] tools 服务缺失，工具未注册：' + (t && t.name))
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
            stdout: { maxBytes: (opts && opts.maxBytes) || 64 * 1024 },
            stderr: { maxBytes: (opts && opts.maxBytes) || 64 * 1024 },
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
      const packageRepo = (typeof __VWF_REPO_ROOT__ === 'string' && __VWF_REPO_ROOT__) ? __VWF_REPO_ROOT__ : null
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
        // runs 运行记录持久化目录（#40）：<runId>.json 一条一文件
        runsDir: home ? home + '/visual-workflow/runs' : null,
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
      // 源根：会话 cwd（动态模式）优先，运行时 bundle 根（import.meta.url 推导）
      // 与进程 cwd 兜底（web profile 无 agent 会话）
      const sources = []
      if (p.repo) sources.push(p.builtinDir)
      if (p.packageBuiltinDir && sources.indexOf(p.packageBuiltinDir) < 0) sources.push(p.packageBuiltinDir)
      if (typeof __VWF_REPO_ROOT__ === 'string' && __VWF_REPO_ROOT__) {
        const pkgRoot = __VWF_REPO_ROOT__ + '/.generated'
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
    async function loadBuiltins(strict) {
      const out = new Map()
      if (fs === undefined) {
        if (strict) throw new Error('宿主文件能力不可用：无法扫描内置模板')
        return out
      }
      const p = await rootPaths()
      const roots = [p.builtinDir, p.packageBuiltinDir, p.homeBuiltinDir].filter(Boolean)
      for (const root of roots) {
        let entries = null
        try {
          const dir = await fs.resolve(root)
          entries = await fs.listDir(dir)
        } catch (e) {
          // 可选根目录确认不存在（ENOENT）→ 跳过继续下一个根；其余错误 strict 抛出
          if (strict && !isMissingErr(e)) throw new Error('内置模板清单读取失败：' + String((e && e.message) || e))
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
            if (strict) throw new Error('内置模板读取失败：' + String((e && e.message) || e))
            /* 单个生成物损坏不影响其余 */
          }
        }
      }
      return out
    }

    // 用户根：~/.dsh/visual-workflow/templates/<id>.json（蓝图 JSON）
    // strict=true：清单/单文件读取失败即抛出（角色引用扫描等破坏性前置必须区分
    // 「完整清单」与「失败清单」，不得把失败当空清单放行）。
    async function loadUserTemplates(strict) {
      const out = new Map()
      if (fs === undefined) {
        if (strict) throw new Error('宿主文件能力不可用：无法扫描用户模板')
        return out
      }
      const p = await rootPaths()
      if (!p.userDir) {
        if (strict) throw new Error('无法解析用户模板目录')
        return out
      }
      let entries = null
      try {
        const dir = await fs.resolve(p.userDir)
        entries = await fs.listDir(dir)
      } catch (e) {
        // 用户模板目录确认不存在（ENOENT）= 空清单；其余错误 strict 抛出
        if (strict && !isMissingErr(e)) throw new Error('用户模板清单读取失败：' + String((e && e.message) || e))
        return out
      }
      for (const ent of entries || []) {
        if (!ent || typeof ent.name !== 'string' || !/\.json$/i.test(ent.name)) continue
        try {
          const bp = JSON.parse(await fs.readText(ent.target))
          if (bp && typeof bp.id === 'string' && bp.id) out.set(bp.id, bp)
        } catch (e) {
          if (strict) throw new Error('用户模板读取失败：' + String((e && e.message) || e))
          /* 损坏的模板文件跳过 */
        }
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
          const o = { id: n.id, profile: n.profile, label: n.label || n.id }
          // lossless-JSON 守卫：undefined 键会被拒绝；与 generate.mjs 的
          // JSON.stringify（剥除 undefined/null）语义保持逐键一致
          if (n.goal !== undefined && n.goal !== null) o.goal = n.goal
          if (n.kind !== undefined) o.kind = n.kind
          if (n.items !== undefined) o.items = n.items
          if (n.failOn !== undefined) o.failOn = n.failOn
          if (n.output) o.output = n.output
          if (n.manualCheck) o.manualCheck = true
          if (models[n.id]) o.model = models[n.id]
          return o
        }),
        edges: bp.edges.map((e) => {
          const o = { from: e.from, to: e.to }
          if (e.on !== undefined) o.on = e.on
          if (e.when !== undefined) o.when = e.when
          if (e.result !== undefined) o.result = e.result
          if (e.outcome !== undefined) o.outcome = e.outcome
          if (e.countRound !== undefined) o.countRound = e.countRound
          return o
        }),
      }
      // 业务规则字段（候选二 Q7，与 generate.mjs projectToVwf 一致）
      if (bp.onMaxRounds !== undefined) out.onMaxRounds = bp.onMaxRounds
      if (bp.heteroCheck) out.heteroCheck = true
      if (bp.humanDecision !== undefined) out.humanDecision = bp.humanDecision
      return out
    }
    // 逆投影（save 落盘格式：蓝图 JSON；候选二 Q7：业务规则字段 onMaxRounds/
    // heteroCheck 已在 DSL 中（前端可配置），原样带回蓝图；verifyBranch 节点级
    // 字段无编辑器 UI、不在 DSL，自然不产生）
    function projectToBlueprint(dsl) {
      const models = {}
      const nodes = (dsl.nodes || []).map((n) => {
        const o = { id: n.id, profile: n.profile, label: n.label || n.id, goal: n.goal || '' }
        if (n.kind !== undefined) o.kind = n.kind
        if (n.items !== undefined) o.items = n.items
        if (n.failOn !== undefined) o.failOn = n.failOn
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
          const o = { from: e.from, to: e.to }
          if (e.on !== undefined) o.on = e.on
          if (e.when !== undefined) o.when = e.when
          if (e.result !== undefined) o.result = e.result
          if (e.outcome !== undefined) o.outcome = e.outcome
          if (e.countRound !== undefined) o.countRound = e.countRound
          return o
        }),
      }
      if (dsl.description) bp.description = dsl.description
      if (dsl.control && dsl.control.maxRounds != null) bp.control = { maxRounds: dsl.control.maxRounds }
      if (dsl.onMaxRounds !== undefined) bp.onMaxRounds = dsl.onMaxRounds
      if (dsl.heteroCheck) bp.heteroCheck = true
      if (dsl.humanDecision !== undefined) bp.humanDecision = dsl.humanDecision
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
            (typeof __VWF_REPO_ROOT__ === 'string' && __VWF_REPO_ROOT__) ? __VWF_REPO_ROOT__ : null,
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
        // lossless-JSON 守卫：所有键都必须有值，sanitized 早退时显式给 null
        return { ok: false, errors: [{ at: '$', message: '校验内核不可用：缺少 scripts/validate-core.cjs（请确认仓库完整）' }], fieldErrors: {}, sanitized: null, warnings: [] }
      }
      if (!dsl || typeof dsl !== 'object') {
        return { ok: false, errors: [{ at: '$', message: 'dsl 必须是对象' }], fieldErrors: {}, sanitized: null, warnings: [] }
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
      // 编译 stdout 传输上限提到 1MB（Codex PR#130 第二轮 P1）：合法的「12 内置角色各
      // 一节点」图的 JSON 响应约 66KB 已超默认 64KB——支持的图必须能被传输，不能静默截断。
      // 引用过滤（generate.mjs ROLE_DEFS）已减小典型图体积，1MB 兜底覆盖全角色最坏情况。
      const r = await runNode([p.generator, 'compile', tmp], { cwd: p.generatorRoot, graceMs: 30000, maxBytes: 1024 * 1024 })
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
      out.sort((a, b) => (a.builtin === b.builtin ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.builtin ? -1 : 1))
      return out
    }

    // ── 多 run 并行三约束（#19，P2-T4）──────────────────────────────────────
    // workflow/start 载荷 WorkflowRunInfo = { id, meta } 不含 taskId/模板来源
    // （taskId 只在引擎 start() 的 args 里），因此由 wf_run 启动边界自登记
    // runTag（runId → { taskId, workflowId, startedAt, active }）。平台 workflow
    // 工具直起的 run 无 tag，看板列表照常展示（taskId 列留空），不参与互斥。
    // 约束②（同 taskId 互斥）：该 taskId 最新未接管的记录处于活跃态时拒绝新
    // 启动。活跃判定不依赖 workflow/start 事件到达时机（start() 返回与 worker
    // 线程事件投递之间有空窗）：登记时即置 tag.active=true，workflow/end 清除；
    // AWAITING_HUMAN_* 终态由 runs 记录状态兜住。WAITING_HUMAN 仅匹配的
    // decision_id 续跑放行；残留 AWAITING_HUMAN_* 仍靠 entry 续跑放行；并把同
    // taskId 前序等待记录标记 supersededBy（旧卡片自动退出门禁队列）。
    // 约束①③（并行隔离 / closeout 串行）在客户端看板呈现：数据本就按 runId
    // 隔离，列表 + 门禁队列 + 并行警示条见 client.js Dashboard。
    const runTags = new Map()
    function isHumanWaitStatus(status) {
      const s = String(status || '')
      return s === 'WAITING_HUMAN' || s.indexOf('AWAITING_HUMAN_') === 0
    }
    function isActiveStatus(status) {
      const s = String(status || '')
      return s === 'running' || isHumanWaitStatus(s)
    }
    function dslUsesHumanDecision(dsl) {
      if (!dsl || typeof dsl !== 'object') return false
      if (dsl.humanDecision !== undefined) return true
      const edges = Array.isArray(dsl.edges) ? dsl.edges : []
      return edges.some((e) => e && (e.to === '$human-decision' || e.from === '$human-decision'))
    }
    function applyHumanDecisionValue(rec, val) {
      if (!rec || !val || typeof val !== 'object') return
      if (typeof val.decision_id === 'string' && val.decision_id) rec.decisionId = val.decision_id
      if (typeof val.reason === 'string' && val.reason) rec.reason = val.reason
      if (val.decision_package && typeof val.decision_package === 'object') rec.decisionPackage = val.decision_package
      if (val.control_event && typeof val.control_event === 'object') rec.controlEvent = val.control_event
      if (val.blocked_edge && typeof val.blocked_edge === 'object') rec.blockedEdge = val.blocked_edge
      if (val.results && typeof val.results === 'object') rec.results = val.results
      if (Array.isArray(val.history)) rec.history = val.history
      if (typeof val.node === 'string' && val.node) rec.node = val.node
      if (typeof val.round === 'number') rec.round = val.round
      if (typeof val.budgetUsed === 'number') rec.budgetUsed = val.budgetUsed
      if (typeof val.maxRounds === 'number') rec.maxRounds = val.maxRounds
      if (typeof val.decisionSeq === 'number') rec.decisionSeq = val.decisionSeq
    }
    async function parkedHumanDecision(taskId) {
      const hit = latestTagByTaskId(taskId)
      if (!hit) return null
      let rec = runs.get(hit.runId)
      if (!rec) rec = await loadRunFromDisk(hit.runId)
      if (!rec || rec.status !== 'WAITING_HUMAN') return null
      return rec
    }
    // Map 保持插入序 = 启动序：取同 taskId 最后插入且未被续跑接管的记录
    function latestTagByTaskId(taskId) {
      let found = null
      for (const [rid, tag] of runTags) {
        if (tag && tag.taskId === taskId && !tag.supersededBy) found = { runId: rid, tag: tag }
      }
      return found
    }
    function taskMutexBlocker(taskId) {
      const hit = latestTagByTaskId(taskId)
      if (!hit) return null
      const rec = runs.get(hit.runId)
      // 重启中断的 running 快照（评审 PRRT_kwDOT57Tec6b6Iuv）：进程已死且无门禁
      // 语义，不得永久占用 taskId——放行新启动；旧记录保留展示，真实恢复走
      // entry 续跑或直接重跑。
      const staleRunning = !!(hit.tag && hit.tag.restoredRunning === true)
      // 幽灵门禁（评审 PRRT_kwDOT57Tec6b6Iuz）：未水合进内存的窗口外记录，
      // 以回载时的 lastStatus 参与互斥判定。兜底用 '' 而非 'running'——
      // 运行期 tag 可能没有 lastStatus（execute 自登记早于任何落盘点），且
      // runs 也可能无 rec（workflow/start 未投递）；此时状态由 tag.active 裁决，
      // 若 active 已解除（终态），绝不能假想仍在运行而误判占用。
      const status = rec ? rec.status : (hit.tag && hit.tag.lastStatus) || ''
      const active = !staleRunning && ((hit.tag && hit.tag.active === true) || isActiveStatus(status))
      return active ? { runId: hit.runId, status: status || 'running' } : null
    }
    function supersedeParked(taskId, newRunId) {
      for (const [rid, tag] of runTags) {
        if (rid === newRunId || !tag || tag.taskId !== taskId || tag.supersededBy) continue
        const rec = runs.get(rid)
        const parked = rec
          ? isHumanWaitStatus(rec.status)
          : isHumanWaitStatus(tag.lastStatus)
        if (parked) {
          tag.supersededBy = newRunId
          requestRunPersist(rid)
          // 幽灵门禁（内存无完整记录）：按需水合后把接管标记回写磁盘
          if (!rec) supersedeGhostOnDisk(rid, newRunId)
        }
      }
    }
    // 幽灵门禁接管回写：从磁盘水合完整记录→补写 supersededBy→落盘（异步，
    // 失败仅终端留痕，不影响续跑本身）
    function supersedeGhostOnDisk(runId, newRunId) {
      loadRunFromDisk(runId)
        .then((rec) => {
          if (!rec) return
          const tag = runTags.get(runId)
          if (tag) tag.supersededBy = newRunId
          requestRunPersist(runId)
        })
        .catch((e) => console.log('[vwf] 幽灵门禁接管回写失败：' + runId + '：' + String((e && e.message) || e)))
    }
    // 引擎契约（dsh workflow types.ts）：WorkflowStopReason 只有
    // 'completed' | 'cancelled' | 'error'，且 workflow/end 事件故意剥掉 value——
    // 脚本终态（DONE / AWAITING_HUMAN_* / FAILED_* 等）只在 result.value 里，
    // 恰好只有持有 run 并 await 的 wf_run 能看到。事件层的 'completed' 对门禁/
    // 互斥语义不够：wf_run 收尾后用 value.status 回写权威终态。
    // 终态集合（评审 PRRT_kwDOT57Tec6bfXfm/6b6ZN3）：节点 id 允许非 ASCII/
    // 空白/标点（AWAITING_HUMAN_验收、FAILED_AT_调度A 等），前缀类用 .+ 宽匹配；
    // fanout cap 失败态（FAILED_ITEM_CAP/FAILED_AGENT_CAP）同为脚本终态
    const TERMINAL_STATUS_RE = /^(DONE|STOPPED|WAITING_HUMAN|AWAITING_HUMAN_.+|FAILED_AT_.+|FAILED_MAX_ROUNDS|FAILED_ITEM_CAP|FAILED_AGENT_CAP|TECHNICAL_FAILURE|ENDED_NO_SUCCESS_EDGE|ENDED_NO_FAILURE_EDGE|ENDED_NO_OUTCOME_EDGE|ROUTE_HALTED|ERROR)$/
    function canonicalStop(result) {
      const v = result && result.value
      const cand = v && typeof v === 'object' && typeof v.status === 'string' ? v.status : (typeof v === 'string' ? v : '')
      return TERMINAL_STATUS_RE.test(cand) ? cand : ''
    }
    // #93 A5（Codex Round 1）：脚本终态 → Core LIFECYCLE 映射，覆盖全部终态。
    // 人工等待（WAITING_HUMAN / AWAITING_HUMAN_*）→ 保留态；成功（DONE）→
    // COMPLETED；显式 STOPPED → STOPPED；其余失败/取消（FAILED_*、
    // TECHNICAL_FAILURE、ENDED_*、ROUTE_HALTED、ERROR、cancelled、error）→ FAILED。
    // 返回 Core 的 LIFECYCLE 枚举值字符串，无法归类时返回 null（保持原状态）。
    function canonicalLifecycleFor(canon, stopReason) {
      if (canon === 'DONE') return 'COMPLETED'
      if (canon === 'STOPPED') return 'STOPPED'
      if (canon === 'WAITING_HUMAN' || canon.indexOf('AWAITING_HUMAN_') === 0) return 'WAITING_HUMAN'
      if (canon) return 'FAILED'
      // canon 为空：引擎层 cancelled / error
      if (stopReason === 'cancelled' || stopReason === 'error') return 'FAILED'
      return null
    }

    const runs = new Map()
    ctx.on('workflow/start', (info) => {
      runs.set(info.id, { meta: { name: (info.meta && info.meta.name) || '', description: (info.meta && info.meta.description) || '' }, status: 'running', phase: '', logs: [], agents: [], startedAt: Date.now() })
      requestRunPersist(info.id)
    })
    ctx.on('workflow/phase', (info, title) => { const r = runs.get(info.id); if (r) { r.phase = String(title); r.logs.push('[phase] ' + title); if (r.logs.length > 50) r.logs.shift(); requestRunPersist(info.id) } })
    ctx.on('workflow/log', (info, message) => { const r = runs.get(info.id); if (r) { r.logs.push(String(message)); if (r.logs.length > 50) r.logs.shift(); requestRunPersist(info.id) } })
    ctx.on('workflow/agent-start', (info, agent) => { const r = runs.get(info.id); if (r) { r.agents.push({ seq: agent.seq, label: String(agent.label || ''), phase: agent.phase ? String(agent.phase) : '', outcome: 'running' }); requestRunPersist(info.id) } })
    // 按 seq 精确匹配：pipeline 并发下 agent-start/agent-end 可能交错到达，
    // 只看数组末位会把非最新项的结局事件丢掉（行卡在 running）
    ctx.on('workflow/agent-end', (info, agent) => { const r = runs.get(info.id); if (!r) return; const a = r.agents.find((x) => x.seq === agent.seq); if (a) { a.outcome = String(agent.outcome); requestRunPersist(info.id) } })
    // workflow/end 同时清 runTag.active（终态落定，含 AWAITING_HUMAN_*——门禁占用
    // 由 isActiveStatus(runs 状态) 继续兜住），互斥的解除与维持由此统一裁决。
    // 终态归一（#18 验收发现）：运行已终局却仍处 running 的子代理不可能再有结果
    // 回报——引擎对「启动即失败」的项可能不投递 agent-end（如 provider 无法解析），
    // 若保持 running，看板会把已失败项永久显示为进行中造成误判；统一按 failed
    // 收口。迟到的 agent-end（乱序投递）仍会按 seq 覆盖回真实结果。
    ctx.on('workflow/end', (info, result) => {
      const r = runs.get(info.id)
      if (r) {
        r.status = String(result.stopReason)
        for (const a of r.agents) { if (a.outcome === 'running') a.outcome = 'failed' }
        requestRunPersist(info.id)
      }
      const t = runTags.get(info.id); if (t) t.active = false
    })

    // ── runs 运行记录持久化（#40，P2-T2b）────────────────────────────────────
    // 内存 runs/runTags 进程重启即失：事件流驱动的记录落盘到
    // ~/.dsh/visual-workflow/runs/<runId>.json；插件启动回载最近 RUNS_RELOAD 条
    // 进内存，其余留在磁盘由 vwf.state 按需回落读取；磁盘总量按 RUNS_RETAIN
    // 淘汰最旧。落盘内容以事件流为界（meta/状态/阶段/日志/子代理 label+outcome
    // + 启动边界登记的 taskId/workflowId/supersededBy），不含子代理返回内容。
    // 所有落盘路径异常仅终端日志留痕，runs 内存态不受损（验收 AC4）。
    const RUNS_RELOAD = 20
    const RUNS_RETAIN = 50

    function runFileName(runId) {
      // 注入式编码（评审 PRRT_kwDOT57Tec6b6it5）：run/a 与 run:a 若都替换为 _
      // 会碰撞成同一文件互相覆盖历史；encodeURIComponent 保持 runId→文件一一对应
      return encodeURIComponent(String(runId || '')) + '.json'
    }

    // 事件流快照：只取叶子字段构造自有 JSON（logs 上限 50 已在事件层收紧；
    // 数组在 stringify 同步执行期间无并发插入，无需深拷贝）
    function runRecordPayload(runId) {
      const rec = runs.get(runId)
      if (!rec) return null
      const tag = runTags.get(runId) || null
      return {
        id: String(runId),
        meta: { name: (rec.meta && rec.meta.name) || '', description: (rec.meta && rec.meta.description) || '' },
        status: String(rec.status || ''),
        phase: String(rec.phase || ''),
        logs: rec.logs || [],
        agents: (rec.agents || []).map((a) => ({ seq: a.seq, label: a.label || '', phase: a.phase || '', outcome: a.outcome || '' })),
        taskId: tag ? String(tag.taskId || '') : '',
        workflowId: tag ? String(tag.workflowId || '') : '',
        startedAt: rec.startedAt != null ? rec.startedAt : (tag && tag.startedAt != null ? tag.startedAt : null),
        supersededBy: tag && tag.supersededBy ? String(tag.supersededBy) : '',
        decision_id: rec.decisionId ? String(rec.decisionId) : '',
        reason: rec.reason ? String(rec.reason) : '',
        decision_package: rec.decisionPackage || null,
        control_event: rec.controlEvent || null,
        blocked_edge: rec.blockedEdge || null,
        results: rec.results || null,
        history: rec.history || null,
        node: rec.node ? String(rec.node) : '',
        round: typeof rec.round === 'number' ? rec.round : null,
        budgetUsed: typeof rec.budgetUsed === 'number' ? rec.budgetUsed : null,
        maxRounds: typeof rec.maxRounds === 'number' ? rec.maxRounds : null,
        decisionSeq: typeof rec.decisionSeq === 'number' ? rec.decisionSeq : null,
        updatedAt: Date.now(),
      }
    }

    async function writeRunFile(runId) {
      if (fs === undefined) return
      const p = await rootPaths()
      if (!p.runsDir) return
      const payload = runRecordPayload(runId)
      if (!payload) return
      const file = runFileName(runId)
      const target = await fs.resolve(p.runsDir + '/' + file)
      await fs.writeText(target, JSON.stringify(payload, null, 2) + '\n', undefined, undefined, writePolicy())
      runsDiskIndex.set(file, { file: file, id: payload.id, ts: payload.updatedAt || payload.startedAt || 0 })
    }

    // 无定时器节流（动态 vm 沙箱无真 setTimeout）：每个 run 至多一个飞行中
    // 写入，期间的变更只置 dirty，当前写入完成后按最新内存态补一次尾写——
    // start/phase/log/agent/end 全部走此队列，天然合并且终态不落空。
    const runWriteQueues = new Map()
    function requestRunPersist(runId) {
      const id = String(runId || '')
      if (!id) return
      let q = runWriteQueues.get(id)
      if (!q) { q = { dirty: false, pending: null }; runWriteQueues.set(id, q) }
      q.dirty = true
      if (!q.pending) drainRunWrite(id)
    }
    function drainRunWrite(id) {
      const q = runWriteQueues.get(id)
      if (!q) return
      if (!q.dirty) { runWriteQueues.delete(id); return }
      q.dirty = false
      q.pending = writeRunFile(id)
        .catch((e) => { console.log('[vwf] 运行记录落盘失败（不影响运行）：' + id + '：' + String((e && e.message) || e)) })
        .then(() => { q.pending = null; drainRunWrite(id); evictRunsSoon() })
    }

    // 磁盘容量淘汰：启动回载重建索引，写入后增量更新；超出 RUNS_RETAIN 时
    // 删除最旧（fs 服务无删除面，经子进程 rm；子进程缺失则暂停淘汰并仅记
    // 一次日志——永不删除索引外的未知文件，方向安全）。
    const runsDiskIndex = new Map()
    let evictChain = Promise.resolve()
    let evictWarned = false
    function evictRunsSoon() {
      evictChain = evictChain.then(evictRunsDisk).catch((e) => {
        console.log('[vwf] 运行记录淘汰失败（不影响运行）：' + String((e && e.message) || e))
      })
    }
    async function evictRunsDisk() {
      if (fs === undefined) return
      const p = await rootPaths()
      if (!p.runsDir || runsDiskIndex.size <= RUNS_RETAIN) return
      if (subprocess === undefined) {
        if (!evictWarned) { evictWarned = true; console.log('[vwf] subprocess 服务不可用：运行记录淘汰暂停（磁盘条数 ' + runsDiskIndex.size + ' 超过上限 ' + RUNS_RETAIN + '）') }
        return
      }
      const items = Array.from(runsDiskIndex.values()).sort((a, b) => (a.ts - b.ts) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      const victims = items.slice(0, items.length - RUNS_RETAIN)
      for (const v of victims) {
        // 活跃 run 不淘汰（保险带：按时间序正常轮不到；防止淘汰把进行中快照删掉）。
        // 未接管的门禁同样不淘汰（评审 PRRT_kwDOT57Tec6b7RDw）：窗口外幽灵门禁
        // 只在 runTags 登记、runs 无 rec——若被删，重启后门禁与互斥一并消失，
        // 同 taskId 会被继续放行且丢失续跑历史
        const rec = runs.get(v.id)
        const tag = runTags.get(v.id)
        const status = rec ? rec.status : (tag && tag.lastStatus) || ''
        const unsuperseded = !(tag && tag.supersededBy)
        if (unsuperseded && isActiveStatus(status)) continue
        const r = await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{force:true})", p.runsDir + '/' + v.file])
        if (r.ok) runsDiskIndex.delete(v.file)
        else console.log('[vwf] 运行记录淘汰删除失败：' + v.file + '：' + r.detail)
      }
    }

    // 磁盘 → 内存水合：live 优先（runs 已有同 id 记录则不动）。回载的 runTag
    // 以 active:false 恢复——进程重启后不存在执行中的 run；AWAITING_HUMAN_*
    // 门禁状态经 isActiveStatus(runs) 继续保持 taskId 占用与接管语义。
    function hydrateRunFromDisk(data) {
      if (!data || typeof data !== 'object') return false
      const id = typeof data.id === 'string' && data.id ? data.id : null
      if (!id || runs.has(id)) return false
      runs.set(id, {
        meta: { name: (data.meta && data.meta.name) || '', description: (data.meta && data.meta.description) || '' },
        status: typeof data.status === 'string' && data.status ? data.status : 'unknown',
        phase: typeof data.phase === 'string' ? data.phase : '',
        logs: Array.isArray(data.logs) ? data.logs.map((l) => String(l)).slice(-50) : [],
        agents: Array.isArray(data.agents) ? data.agents.filter((a) => a && typeof a === 'object').map((a) => ({ seq: a.seq, label: String(a.label || ''), phase: a.phase ? String(a.phase) : '', outcome: String(a.outcome || '') })) : [],
        startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
        decisionId: typeof data.decision_id === 'string' && data.decision_id ? data.decision_id : null,
        reason: typeof data.reason === 'string' && data.reason ? data.reason : '',
        decisionPackage: data.decision_package && typeof data.decision_package === 'object' ? data.decision_package : null,
        controlEvent: data.control_event && typeof data.control_event === 'object' ? data.control_event : null,
        blockedEdge: data.blocked_edge && typeof data.blocked_edge === 'object' ? data.blocked_edge : null,
        results: data.results && typeof data.results === 'object' ? data.results : null,
        history: Array.isArray(data.history) ? data.history : null,
        node: typeof data.node === 'string' ? data.node : '',
        round: typeof data.round === 'number' ? data.round : null,
        budgetUsed: typeof data.budgetUsed === 'number' ? data.budgetUsed : null,
        maxRounds: typeof data.maxRounds === 'number' ? data.maxRounds : null,
        decisionSeq: typeof data.decisionSeq === 'number' ? data.decisionSeq : null,
      })
      if (data.taskId || data.workflowId) {
        const status = typeof data.status === 'string' && data.status ? data.status : 'unknown'
        const tag = {
          taskId: typeof data.taskId === 'string' ? data.taskId : '',
          workflowId: typeof data.workflowId === 'string' ? data.workflowId : '',
          startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
          active: false,
          // 重启中断的 running 快照标记（评审 PRRT_kwDOT57Tec6b6Iuv）：
          // 进程死亡时该 run 不可能再有结果，互斥判定对其放行（见 taskMutexBlocker）
          restoredRunning: status === 'running',
          lastStatus: status,
        }
        if (typeof data.supersededBy === 'string' && data.supersededBy) tag.supersededBy = data.supersededBy
        runTags.set(id, tag)
      }
      return true
    }

    // vwf.state 内存 miss 的磁盘回落：命中即水合进内存（后续列表/互斥照常工作）
    async function loadRunFromDisk(runId) {
      if (fs === undefined) return null
      const p = await rootPaths()
      if (!p.runsDir) return null
      try {
        const target = await fs.resolve(p.runsDir + '/' + runFileName(runId))
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return null
        const data = JSON.parse(await fs.readText(target))
        // 并发水合（评审 PRRT_kwDOT57Tec6b6it7）：另一请求可能抢先水合同一冷记录，
        // hydrateRunFromDisk 返回 false；此时该记录已在 runs 中，属成功 cache hit
        hydrateRunFromDisk(data)
        return runs.get(data.id) || null
      } catch (e) { return null }
    }

    // 启动回载：按时间升序插入（保持 runs Map 插入序=时间序，vwf.runs.list
    // 反转后最新在前）；单文件损坏仅跳过留痕（验收 AC5）；回载后补一次淘汰
    // （前序进程可能死在淘汰前）。
    async function loadPersistedRuns() {
      // fs 可能在 apply 后注入（静态 bundle 仅等待 webServer/tools，评审
      // PRRT_kwDOT57Tec6b7RDu）：与 syncBuiltins 相同的轮询策略等待 fs 出现，
      // 避免 runsHydration 在无 fs 时提前 resolve 而门禁从未加载
      for (let attempt = 0; attempt < 10; attempt++) {
        if (fs !== undefined) break
        fs = ctx.get('fs')
        if (fs !== undefined) break
        try { await new Promise((r) => setTimeout(r, 100 * (attempt + 1))) } catch (e) { break }
      }
      if (fs === undefined) { console.log('[vwf] fs 服务不可用，运行记录回载未完成（本次互斥以内存态为准）'); return }
      const p = await rootPaths()
      if (!p.runsDir) return
      let entries = null
      try {
        entries = await fs.listDir(await fs.resolve(p.runsDir))
      } catch (e) { return } // 目录不存在 = 首次运行
      const loaded = []
      for (const ent of entries || []) {
        if (!ent || ent.type !== 'file' || !/\.json$/i.test(ent.name)) continue
        try {
          const data = JSON.parse(await fs.readText(await fs.resolve(p.runsDir + '/' + ent.name)))
          if (!data || typeof data.id !== 'string' || !data.id) throw new Error('缺少 id 字段')
          const ts = (typeof data.updatedAt === 'number' && data.updatedAt) || (typeof data.startedAt === 'number' && data.startedAt) || 0
          loaded.push({ file: ent.name, id: data.id, ts: ts, data: data })
        } catch (e) {
          console.log('[vwf] 跳过损坏的运行记录：' + ent.name + '（' + String((e && e.message) || e) + '）')
        }
      }
      loaded.sort((a, b) => (a.ts - b.ts) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      for (const it of loaded) runsDiskIndex.set(it.file, { file: it.file, id: it.id, ts: it.ts })
      const hydrated = new Set()
      for (const it of loaded.slice(-RUNS_RELOAD)) { if (hydrateRunFromDisk(it.data)) hydrated.add(it.id) }
      // 幽灵门禁（评审 PRRT_kwDOT57Tec6b6Iuz）：回载窗口之外的未接管 AWAITING_*
      // 记录以 lastStatus 轻量登记进 runTags——taskMutexBlocker/supersedeParked
      // 据此保持同 taskId 互斥与接管语义，完整记录仍留在磁盘按需水合
      for (const it of loaded) {
        if (hydrated.has(it.id) || runs.has(it.id)) continue
        const d = it.data
        const st = typeof d.status === 'string' ? d.status : ''
        if (!isHumanWaitStatus(st)) continue
        if (typeof d.supersededBy === 'string' && d.supersededBy) continue
        if (!d.taskId && !d.workflowId) continue
        runTags.set(d.id, {
          taskId: typeof d.taskId === 'string' ? d.taskId : '',
          workflowId: typeof d.workflowId === 'string' ? d.workflowId : '',
          startedAt: typeof d.startedAt === 'number' ? d.startedAt : null,
          active: false,
          ghost: true,
          lastStatus: st,
        })
      }
      evictRunsSoon()
    }
    // 与 apply 时序解耦的异步回载：不阻塞 apply，失败仅在终端日志留痕；
    // 回载 promise 暴露给 wf_run 边界 await（评审 PRRT_kwDOT57Tec6b6Iu1：
    // 互斥判定必须看到完整门禁状态，不能与回载竞速）
    let runsHydration = null
    runsHydration = loadPersistedRuns().catch((e) => console.log('[vwf] 运行记录回载失败（不影响本次运行）：' + String((e && e.message) || e)))


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
      return { ok: true, id: id, dsl: v.sanitized, warnings: v.warnings || [] }
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
      return { ok: v.ok, errors: v.errors, fieldErrors: v.fieldErrors, sanitized: v.sanitized, warnings: v.warnings || [] }
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
      const id = a && a.runId
      let s = id ? runs.get(id) : null
      // 内存 miss 回落磁盘（#40）：重启后未回载进内存的历史记录按 runId 直查
      if (!s && id) s = await loadRunFromDisk(id)
      if (!s) return { found: false, state: null }
      const tag = runTags.get(id) || null
      return { found: true, state: { id: id, meta: s.meta, status: s.status, phase: s.phase, logs: s.logs, agents: s.agents,
        taskId: tag ? tag.taskId : '', workflowId: tag ? tag.workflowId : '', startedAt: s.startedAt != null ? s.startedAt : (tag ? tag.startedAt : null),
        supersededBy: tag && tag.supersededBy ? tag.supersededBy : '',
        decision_id: s.decisionId || '', reason: s.reason || '',
        decision_package: s.decisionPackage || null, control_event: s.controlEvent || null,
        blocked_edge: s.blockedEdge || null, results: s.results || null,
        budgetUsed: typeof s.budgetUsed === 'number' ? s.budgetUsed : null,
        maxRounds: typeof s.maxRounds === 'number' ? s.maxRounds : null,
        decisionSeq: typeof s.decisionSeq === 'number' ? s.decisionSeq : null } }
    })
    // 多 run 并行（#19）：运行清单（最新在前），看板列表/门禁队列/并行警示的数据源
    registerRpc('vwf.runs.list', async () => {
      const out = []
      for (const [rid, rec] of runs) {
        const tag = runTags.get(rid) || null
        out.push({ id: rid, name: (rec.meta && rec.meta.name) || '', status: rec.status, phase: rec.phase || '',
          taskId: tag ? tag.taskId : '', workflowId: tag ? tag.workflowId : '', startedAt: rec.startedAt != null ? rec.startedAt : (tag ? tag.startedAt : null),
          supersededBy: tag && tag.supersededBy ? tag.supersededBy : '',
          decision_id: rec.decisionId || '', reason: rec.reason || '' })
      }
      // 按时间倒序（评审 PRRT_kwDOT57Tec6b6it9）：按需水合会把窗口外旧记录追加到
      // runs map 尾部，若依赖插入序反转，选中的旧 run 会跳到清单最前并驻留；按
      // startedAt 降序可稳定呈现真实时间序，同刻用 id 降序兜底
      out.sort((a, b) => ((b.startedAt || 0) - (a.startedAt || 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      return { runs: out }
    })
    // 磁盘全量运行清单（#40：运行历史浏览）。只读磁盘返回元数据，**不**水合进
    // 内存——保持「启动回载最近 RUNS_RELOAD 条」的内存上限语义；用户点击某条
    // 历史时仍走 vwf.state 磁盘回落按需水合。最新在前；损坏文件跳过。
    registerRpc('vwf.runs.history', async () => {
      if (fs === undefined) return { runs: [] }
      const p = await rootPaths()
      if (!p.runsDir) return { runs: [] }
      let entries = null
      try {
        entries = await fs.listDir(await fs.resolve(p.runsDir))
      } catch (e) { return { runs: [] } }
      const out = []
      for (const ent of entries || []) {
        if (!ent || ent.type !== 'file' || !/\.json$/i.test(ent.name)) continue
        try {
          const data = JSON.parse(await fs.readText(await fs.resolve(p.runsDir + '/' + ent.name)))
          if (!data || typeof data.id !== 'string' || !data.id) continue
          const ts = (typeof data.updatedAt === 'number' && data.updatedAt) || (typeof data.startedAt === 'number' && data.startedAt) || 0
          out.push({ id: data.id, name: (data.meta && data.meta.name) || '', status: data.status || '', phase: data.phase || '',
            taskId: data.taskId || '', workflowId: data.workflowId || '', startedAt: data.startedAt != null ? data.startedAt : null,
            supersededBy: data.supersededBy || '', ts: ts })
        } catch (e) { /* 损坏文件跳过 */ }
      }
      out.sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { runs: out }
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

    // ── 角色库（issue-58：内置/自定义分类 + 生命周期管理）─────────────────────
    // 模型：内置角色 = 系统正式角色（issue-81 的 12 角色），
    // 常驻、只读、可查看/选择/基于其创建自定义变体；自定义角色 = 工作区
    // dsh/roles/ 下不属于内置集合的 *.md（与运行时 profile→<roleDir>/<id>.md
    // 的消费契约一致：保存即被 wf_run 产出的脚本按原机制读取，无需运行时改造）。
    // 引用 = 全部工作流（内置模板 + 用户模板）节点 profile 命中该角色 id 的计数，
    // 删除/重命名前的安全保护以引用数裁决；内容修改则天然全局生效（引用按 id）。
    //
    // issue-81：旧 `dispatcher` 已退出内置身份，迁为自定义角色。其定义文件保留在
    // dsh/roles/ 原位，因此引用它的历史工作流无需任何改动即可继续工作。
    // issue-81 正式 12 角色：通用基础能力 8 个 + 专业能力 4 个。
    // 顺序即角色库「内置」分组的展示顺序，与产品规格 §8 名单一致。
    const BUILTIN_ROLES = [
      // ── 通用基础能力 ──
      { id: 'requirements', name: '需求分析', summary: '需求分析角色：三要素门禁，产出需求基线' },
      { id: 'designer', name: '方案设计', summary: '方案设计角色：实施路径、关键取舍与风险' },
      { id: 'dev', name: '开发', summary: '开发角色：测试驱动施工，满足质量闸门' },
      { id: 'review', name: '审核', summary: '审核角色：规范与需求符合性、代码质量双轴审查' },
      { id: 'test', name: '测试', summary: '测试角色：运行态验证，证据驱动判定' },
      { id: 'evaluator', name: '评估', summary: '评估角色：按节点评价契约独立评估，场景差异由节点表达' },
      { id: 'accept', name: '验收助手', summary: '验收助手角色：对照验收标准最终核验并等待人工签字' },
      { id: 'closeout', name: '收口', summary: '收口角色：一致性收口与交接产物汇总' },
      // ── 专业能力 ──
      { id: 'diagnose', name: '缺陷诊断', summary: '缺陷诊断角色：先取证后结论，收敛到根因' },
      { id: 'orchestrator', name: '探索统筹', summary: '探索统筹角色：设计研究方案与专家任务书' },
      { id: 'researcher', name: '专家研究', summary: '专家研究角色：按任务书独立取证，含反证' },
      { id: 'synthesizer', name: '综合分析', summary: '综合分析角色：把独立判断整合为可决策的观点地图' },
    ]
    const BUILTIN_ROLE_IDS = BUILTIN_ROLES.map((r) => r.id)
    const ROLE_NAME_MAX = 64
    // 名称唯一性键：NFC 规范化 + 小写（macOS/Windows 默认文件系统对规范化/大小写
    // 不敏感，未归一化会令等价名称指向同一文件而互相覆盖）。
    const roleKey = (s) => String(s || '').normalize('NFC').toLowerCase()
    // fs.resolve 句柄 → 子进程 argv 可用的绝对路径字符串（真实句柄含 displayPath）
    const pathOf = (h) => (typeof h === 'string') ? h : (h && (h.displayPath || h.targetKey)) || null
    // 只有「确认不存在」（ENOENT 类）才算缺失目录；其余错误按瞬时 I/O 失败 fail-closed
    const isMissingErr = (e) => /ENOENT|no such file|not exist|不存在/i.test(String((e && e.message) || e))
    // 目录优先级（与 vwf.roles 旧版一致）：发起会话仓库根（动态模式，即会话工作区）
    // → fs 服务默认 cwd 相对 'dsh/roles'（静态/web 模式无 agent 会话时兜底尝试）。
    async function roleDirPath() {
      const p = await rootPaths()
      return p.repo ? p.repo + '/dsh/roles' : 'dsh/roles'
    }
    // 角色正文摘要：取首个有意义行（跳过 frontmatter 键/标题），截 80 字符；空则回退 fallback。
    // readRoleFiles 与 getRoleDetail 共用，保证「列表摘要/详情摘要/展示正文」口径一致。
    const summarizeRole = (content, fallback = '') => {
      if (typeof content !== 'string') return fallback
      const firstLine = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('---') && !l.startsWith('id:') && !l.startsWith('name:') && !l.startsWith('summary') && !l.startsWith('createdAt') && !l.startsWith('updatedAt') && !l.startsWith('dynamicTemplate') && !l.startsWith('#'))[0]
      return (firstLine || fallback).slice(0, 80)
    }
    // 内置角色打包快照（#129 遗留项 1）：__VWF_REPO_ROOT__/dsh/roles/<id>.md——与运行时
    // roleRef 编译期内联同源（generate.mjs DEFAULT_ROLES_DIR 即同一目录）。读不到返回 null。
    async function readBuiltinRoleSnapshot(id) {
      const roots = [(typeof __VWF_REPO_ROOT__ === 'string' && __VWF_REPO_ROOT__) ? __VWF_REPO_ROOT__ : null].filter(Boolean)
      for (const root of roots) {
        try {
          const target = await fs.resolve(root + '/dsh/roles/' + id + '.md')
          const info = await fs.stat(target)
          if (info && info.type === 'file') return String(await fs.readText(target))
        } catch (e) { /* 尝试下一个根 */ }
      }
      return null
    }
    // 读取角色目录：返回 { files: Map<id,{summary,content}>, state: ok|missing|error, message }。
    // fail-closed：读取失败（而非目录缺失）必须阻断后续唯一性校验与变更。
    async function readRoleFiles() {
      const out = new Map()
      if (fs === undefined) return { files: out, state: 'error', message: '宿主文件能力不可用' }
      const roleDir = await roleDirPath()
      // 只有「确认不存在」才归为 missing（可作为空清单放行）；resolve 失败可能是
      // 瞬时路径错误、stat 失败是瞬态读错误——都按 error fail-closed，避免创建/
      // 重命名把失败当空库放行而覆盖既有角色。
      let dir = null
      try {
        dir = await fs.resolve(roleDir)
      } catch (e) {
        // 只有确认不存在（ENOENT）归 missing；resolve 的瞬时/宿主错误按 error fail-closed
        if (isMissingErr(e)) return { files: out, state: 'missing', message: '角色目录不存在：' + roleDir }
        return { files: out, state: 'error', message: '角色目录解析失败：' + String((e && e.message) || e) }
      }
      let info = null
      try {
        info = await fs.stat(dir)
      } catch (e) {
        return { files: out, state: 'error', message: '角色目录状态读取失败：' + String((e && e.message) || e) }
      }
      try {
        if (!info) return { files: out, state: 'missing', message: '角色目录不存在：' + roleDir }
        if (info.type !== 'directory') return { files: out, state: 'error', message: '角色目录不是目录：' + roleDir }
        const entries = (await fs.listDir(dir) || [])
          .filter(e => e && typeof e.name === 'string' && /\.md$/i.test(e.name))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const ent of entries) {
          const id = ent.name.replace(/\.md$/i, '')
          let summary = ''
          let content = null
          try {
            content = String(await fs.readText(await fs.resolve(roleDir + '/' + ent.name)))
            summary = summarizeRole(content)
          } catch (e) { /* 单文件读取失败跳过摘要 */ }
          out.set(id, { summary, content })
        }
        return { files: out, state: 'ok' }
      } catch (e) {
        return { files: out, state: 'error', message: '角色目录读取失败：' + String((e && e.message) || e) }
      }
    }
    // 统一角色清单：内置六角色常驻（内容/摘要优先取工作区文件，缺失回退内置元数据），
    // 自定义 = 角色目录中不属于内置集合的 *.md（按 id 字母序）。
    // includeContent = true 时携带 content（null 值剔除，lossless-JSON 守卫）。
    async function listLibraryRoles(includeContent) {
      const inv = await readRoleFiles()
      const files = inv.files
      const roles = []
      for (const b of BUILTIN_ROLES) {
        // 内置角色摘要/内容与详情、运行时 roleRef 同序（#129 遗留项 1）：打包快照优先、
        // 工作区回退——否则旧版 dsh/roles/<id>.md 会以旧版摘要/正文出现在角色列表，
        // 与详情/执行口径不一致。
        const snap = await readBuiltinRoleSnapshot(b.id)
        const f = files.get(b.id)
        const entry = { id: b.id, name: b.name, summary: snap != null ? summarizeRole(snap, b.summary) : ((f && f.summary) || b.summary), builtin: true }
        if (includeContent) {
          const content = snap != null ? snap : (f && f.content != null ? f.content : null)
          if (content != null) entry.content = content
        }
        roles.push(entry)
      }
      // 打包回退（Codex PR#124 第二轮 P1）：产品工作区无 dsh/roles/dispatcher.md 时，
      // 迁出内置但被 bundleRoles 模板引用的历史角色从打包快照只读回退到自定义分组，
      // 不写入 .generated。用户编辑时种子到工作区 dsh/roles/。
      let bundledLegacy = null
      try { bundledLegacy = await bundledLegacyRoles() } catch (e) { bundledLegacy = new Map() }
      const customIds = Array.from(files.keys()).filter(id => BUILTIN_ROLE_IDS.indexOf(id) < 0).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const seenCustom = new Set(customIds)
      for (const id of customIds) {
        const f = files.get(id)
        const entry = { id, name: id, summary: f.summary || '', builtin: false }
        if (includeContent) entry.content = f.content
        roles.push(entry)
      }
      // 打包回退角色排在已落盘自定义角色之后（可见但非首选）
      const bundledIds = Array.from(bundledLegacy.keys()).filter(id => !seenCustom.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      for (const id of bundledIds) {
        const content = bundledLegacy.get(id) || ''
        const firstLine = content.split('\n').find(l => l.trim()) || ''
        const entry = { id, name: id, summary: firstLine, builtin: false }
        if (includeContent) entry.content = content
        roles.push(entry)
      }
      return roles
    }
    // 单个角色详情：内置角色定义来源顺序与运行时 roleRef 对齐（#129 遗留项 1）——
    // 打包快照（__VWF_REPO_ROOT__/dsh/roles，编译期内联同源）→ 工作区 dsh/roles 回退
    // → 内置元数据合成占位正文。否则工作区一份旧版/本地改过的同名文件会盖过模板自带
    // 的版本化定义，编辑器展示与执行口径不一致。自定义角色仍以工作区为准（打包只读兜底）。
    async function getRoleDetail(id) {
      const inv = await readRoleFiles()
      const files = inv.files
      if (BUILTIN_ROLE_IDS.indexOf(id) >= 0) {
        const meta = BUILTIN_ROLES.find(r => r.id === id)
        // 内置角色定义来源顺序与运行时 roleRef 对齐（#129 遗留项 1）：打包快照 →
        // 工作区 dsh/roles 回退 → 元数据占位兜底。否则工作区一份旧版/本地改过的
        // 同名文件会盖过模板自带的版本化定义，编辑器展示与执行口径不一致。
        let content = await readBuiltinRoleSnapshot(id)
        if (content == null) {
          const f = files.get(id)
          content = f && f.content
        }
        if (content == null) content = '# ' + meta.name + '（' + id + '）\n\n' + meta.summary + '\n\n> 当前工作区未包含该内置角色的完整定义（dsh/roles/' + id + '.md），角色仍可正常选择使用。'
        // 摘要与展示正文同源（summarizeRole），占位正文回退注册表摘要
        return { id, name: meta.name, summary: summarizeRole(content, meta.summary), builtin: true, content }
      }
      const f = files.get(id)
      if (f) return { id, name: id, summary: f.summary || '', builtin: false, content: f.content != null ? f.content : '' }
      // 打包回退（Codex PR#124 第二轮 P1）：工作区无文件时，从打包快照只读回退
      let bundledLegacy = null
      try { bundledLegacy = await bundledLegacyRoles() } catch (e) { return null }
      const content = bundledLegacy.get(id)
      if (content == null) return null
      const firstLine = content.split('\n').find(l => l.trim()) || ''
      return { id, name: id, summary: firstLine, builtin: false, content }
    }
    // 引用扫描：全部工作流（内置模板 + 用户模板）+ 可选的开放草稿 DSL。草稿引用按
    // workflowId 去重替换（打开编辑器编辑既有模板时其持久化版本已被统计，草稿内容
    // 才是当前真实状态）；新草稿（无 id）以 draft: 前缀键独立计入——未保存但引用该
    // 角色时禁止删除/重命名（P1：草稿随后保存会引用已删除的角色文件）。
    async function roleUsage(id, draftDsl) {
      // strict：内置/用户模板清单或单文件读取失败时抛出（破坏性变更前置：失败 ≠ 零引用）
      const [builtins, users] = await Promise.all([loadBuiltins(true), loadUserTemplates(true)])
      const wfRefs = new Map()
      const add = (workflowId, workflowName, builtin, dsl, draft) => {
        const nodes = []
        for (const n of (dsl.nodes || []) || []) {
          // 与文件名唯一性同一基准（roleKey：NFC + 小写）：大小写/规范化不敏感
          // 文件系统上 profile 'Analyst' 同样引用 analyst.md 角色文件
          if (n && typeof n.profile === 'string' && roleKey(n.profile) === roleKey(id)) nodes.push({ id: n.id, label: n.label || n.id })
        }
        if (!nodes.length) {
          // 草稿里已移除全部引用 → 草稿状态取代持久化快照（否则会将「将要保存的
          // 状态」误判为仍被引用而阻止删除/重命名，直到保存后才解除）
          if (draft) wfRefs.delete(String(workflowId))
          return
        }
        const ref = { workflowId: String(workflowId), workflowName: String(workflowName), builtin: !!builtin, nodes }
        if (draft) ref.draft = true
        wfRefs.set(ref.workflowId, ref)
      }
      for (const dsl of builtins.values()) add(dsl.id, dsl.name, true, dsl, false)
      for (const bp of users.values()) add(bp.id, bp.displayName, false, projectToVwf(bp), false)
      if (draftDsl && Array.isArray(draftDsl.nodes)) {
        const draftId = draftDsl.id || ('draft:' + String(draftDsl.name || '未保存草稿'))
        add(draftId, draftDsl.name || '未保存草稿', false, draftDsl, true)
      }
      const refs = Array.from(wfRefs.values())
      const count = refs.reduce((sum, r) => sum + (r.nodes || []).length, 0)
      return { count, refs }
    }
    // 角色名称校验：非空 / 长度 / 文件系统安全字符 / 首尾点 / Windows 保留设备名；
    // 唯一性单列（需排除自身）。
    function validateRoleName(name) {
      const v = String(name || '').trim()
      if (!v) return '角色名称不能为空'
      if (v.length > ROLE_NAME_MAX) return '角色名称过长（最多 ' + ROLE_NAME_MAX + ' 字符）'
      if (/[\\/:*?"<>|\x00-\x1F\x7F]/.test(v)) return '角色名称包含非法字符'
      if (/^\./.test(v) || /\.$/.test(v)) return '角色名称不能以点开头或结尾'
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v)) return '角色名称是系统保留名（如 CON/NUL/AUX），请换一个名称'
      return null
    }
    // 名称唯一性（NFC 归一 + 大小写不敏感，兼容 macOS/Windows 文件系统）：内置 + 现有自定义
    // + 打包回退角色（Codex PR#124 第三轮 P2，评论 3889725486）。fail-closed：角色目录读取
    // 失败（非目录缺失）时抛错，调用方阻断变更。
    async function roleNameTaken(name, excludeId) {
      const key = roleKey(name)
      if (!key) return true
      for (const b of BUILTIN_ROLES) {
        const bId = roleKey(b.id)
        if (excludeId && roleKey(excludeId) === bId) continue
        if (bId === key) return true
      }
      const inv = await readRoleFiles()
      if (inv.state === 'error') throw new Error('角色库读取失败，无法验证名称唯一性：' + inv.message)
      for (const id of inv.files.keys()) {
        const idKey = roleKey(id)
        if (excludeId && roleKey(excludeId) === idKey) continue
        if (idKey === key) return true
      }
      // 打包回退角色（Codex PR#124 第三轮 P2）：迁移角色经 bundledLegacyRoles 只读回退
      // 可见时，同名 create 必须返回冲突——否则用户在角色库看到 dispatcher 已列出，
      // create({name:'dispatcher'}) 却静默成功，绕过唯一性校验创建同名工作区文件。
      // 打包回退读取失败不影响主校验（已覆盖内置 + 工作区，fail-closed 已在上文处理）。
      try {
        const bundled = await bundledLegacyRoles()
        for (const id of bundled.keys()) {
          const idKey = roleKey(id)
          if (excludeId && roleKey(excludeId) === idKey) continue
          if (idKey === key) return true
        }
      } catch (e) { /* 打包回退读取失败不影响主校验链路 */ }
      return false
    }

    // 角色列表（节点表单的角色选择器 + 角色管理列表数据源）：内置常驻 + 自定义。
    registerRpc('vwf.roles', async () => ({ roles: await listLibraryRoles(false) }))
    // 角色详情（查看内置/编辑自定义前的完整配置）
    registerRpc('vwf.roles.get', async (a) => {
      const id = a && a.id
      const role = id ? await getRoleDetail(id) : null
      if (!role) return { ok: false, errors: [{ at: '$', message: '角色不存在：' + (id || '') }] }
      return { ok: true, role }
    })
    // 引用统计（删除/修改前的保护提示数据源）：可携带开放草稿 DSL 一并计数
    registerRpc('vwf.roles.usage', async (a) => {
      const id = a && a.id
      if (!id || typeof id !== 'string') return { ok: false, errors: [{ at: '$.id', message: '缺少角色 id' }] }
      let u
      try {
        u = await roleUsage(id, a && a.draftDsl)
      } catch (e) {
        return { ok: false, errors: [{ at: '$', message: '引用统计失败：' + String((e && e.message) || e) }] }
      }
      return { ok: true, id, count: u.count, refs: u.refs }
    })
    // 空白新增 / 基于角色创建：校验名称与内容 → 写入工作区 dsh/roles/<name>.md
    // 打包角色包回退（Codex PR#124 第二轮 P1）：bundleRoles 模板自带 roles/ 快照，
    // 其中可能包含已迁出内置集合的历史自定义角色（如 dispatcher）。产品工作区没有
    // 仓库 dsh/roles/，这类角色必须仍以「自定义」身份可见、可编辑，否则从角色库消失。
    // 权威来源仍是工作区 dsh/roles/（用户状态）；打包快照只读回退，**绝不回写**——
    // .generated 是生成产物，写入会变成可被重生成覆盖的用户状态（第二轮 P1 撤销项）。
    async function bundledLegacyRoles() {
      const out = new Map()
      if (fs === undefined) return out
      let p = null
      try { p = await rootPaths() } catch (e) { return out }
      const spots = [p && p.builtinDir, p && p.packageBuiltinDir, p && p.homeBuiltinDir, p && p.skillRoot]
      for (const spot of spots) {
        if (!spot) continue
        let entries = null
        try { entries = await fs.listDir(await fs.resolve(spot)) } catch (e) { continue }
        for (const ent of entries || []) {
          if (!ent || ent.type !== 'directory' || !ent.name || ent.name === 'roles') continue
          let roleEnts = null
          try { roleEnts = await fs.listDir(await fs.resolve(spot + '/' + ent.name + '/roles')) } catch (e) { continue }
          for (const rf of roleEnts || []) {
            if (!rf || rf.type !== 'file' || !rf.name || !rf.name.endsWith('.md')) continue
            const id = rf.name.slice(0, -3)
            if (!id || BUILTIN_ROLE_IDS.indexOf(id) >= 0 || out.has(id)) continue
            try {
              out.set(id, String(await fs.readText(await fs.resolve(spot + '/' + ent.name + '/roles/' + rf.name))))
            } catch (e) { /* 单文件读取失败不影响其余 */ }
          }
        }
      }
      return out
    }

    registerRpc('vwf.roles.create', async (a) => {
      const name = String((a && a.name) || '').trim()
      const content = a && typeof a.content === 'string' ? a.content : ''
      if (fs === undefined) return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法创建角色' }] }
      const badName = validateRoleName(name)
      if (badName) return { ok: false, errors: [{ at: 'name', message: badName }] }
      if (!content.trim()) return { ok: false, errors: [{ at: 'content', message: '角色配置不能为空' }] }
      let conflict = false
      try {
        conflict = await roleNameTaken(name, null)
      } catch (e) {
        return { ok: false, errors: [{ at: '$', message: String((e && e.message) || e) }] }
      }
      if (conflict) {
        return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
      }
      const roleDir = await roleDirPath()
      try {
        const target = await fs.resolve(roleDir + '/' + name + '.md')
        await fs.writeText(target, content + (content.endsWith('\n') ? '' : '\n'), undefined, undefined, writePolicy())
      } catch (e) {
        return { ok: false, errors: [{ at: '$', message: '角色文件写入失败：' + String((e && e.message) || e) }] }
      }
      const role = await getRoleDetail(name)
      return { ok: true, role }
    })
    // 编辑自定义角色：内容修改全局生效（引用按 id 天然共享）；重命名仅零引用时允许
    // （引用按 id 字符串，重命名会令所有引用失效——服务端强制，客户端也先提示）。
    // 仅重命名路径需要 subprocess（删除旧文件）；纯内容编辑只依赖 fs。
    registerRpc('vwf.roles.update', async (a) => {
      const id = a && a.id
      const content = a && typeof a.content === 'string' ? a.content : null
      const newName = String((a && a.name) || '').trim()
      if (fs === undefined) return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法更新角色' }] }
      if (!id || typeof id !== 'string') return { ok: false, errors: [{ at: '$.id', message: '缺少角色 id' }] }
      if (BUILTIN_ROLE_IDS.indexOf(id) >= 0) {
        return { ok: false, errors: [{ at: '$', message: '内置角色只读：' + id + ' 属于系统标准角色，不能修改；可基于其创建自定义角色。' }] }
      }
      const inv = await readRoleFiles()
      if (inv.state === 'error') return { ok: false, errors: [{ at: '$', message: '角色库读取失败：' + inv.message }] }
      // 存在性判定：工作区有文件，或打包回退可见（Codex PR#124 第二轮 P1）。
      // 后者代表产品工作区无 dsh/roles/<id>.md 但 bundleRoles 模板自带该角色快照——
      // 编辑时种子到工作区，.generated 不被改写。
      let bundledLegacy = null
      if (!inv.files.has(id)) {
        try { bundledLegacy = await bundledLegacyRoles() } catch (e) { bundledLegacy = new Map() }
        if (!bundledLegacy.has(id)) return { ok: false, errors: [{ at: '$', message: '自定义角色不存在：' + id }] }
      }
      const target = newName && newName !== id ? newName : id
      let isRename = target !== id
      if (isRename) {
        // 大小写/Unicode 规范化差异（NFC 归一后相同）指向同一文件：拒绝，避免
        // 写后删把自己的文件删掉（P1）。
        if (roleKey(target) === roleKey(id)) {
          return { ok: false, errors: [{ at: 'name', message: '新名称与当前名称仅大小写或写法不同（指向同一文件），请保留原名称或改用不同名称。' }] }
        }
        const badName = validateRoleName(target)
        if (badName) return { ok: false, errors: [{ at: 'name', message: badName }] }
        try {
          if (await roleNameTaken(target, id)) {
            return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
          }
        } catch (e) {
          return { ok: false, errors: [{ at: '$', message: String((e && e.message) || e) }] }
        }
        let u
        try {
          u = await roleUsage(id, a && a.draftDsl)
        } catch (e) {
          return { ok: false, errors: [{ at: '$', message: '引用统计失败：' + String((e && e.message) || e) }] }
        }
        if (u.count > 0) {
          return { ok: false, errors: [{ at: 'name', message: '该角色仍被 ' + u.count + ' 个节点使用，重命名会导致这些引用全部失效；请先解除引用，或使用「基于此角色创建自定义角色」新建变体。' }] }
        }
        if (subprocess === undefined) return { ok: false, errors: [{ at: '$', message: '重命名需要子进程服务（删除旧角色文件）；当前宿主不可用，可先编辑内容或新建同名新角色。' }] }
      }
      if (content == null || !content.trim()) return { ok: false, errors: [{ at: 'content', message: '角色配置不能为空' }] }
      const roleDir = await roleDirPath()
      let newAbs = null
      try {
        newAbs = await fs.resolve(roleDir + '/' + target + '.md')
        await fs.writeText(newAbs, content + (content.endsWith('\n') ? '' : '\n'), undefined, undefined, writePolicy())
      } catch (e) {
        return { ok: false, errors: [{ at: '$', message: '角色文件写入失败：' + String((e && e.message) || e) }] }
      }
      if (isRename) {
        // 删除旧文件前经 fs 服务解析为绝对路径（避免相对 'dsh/roles' 在子进程 cwd=/ 下
        // 指向错误位置）；删除失败则回滚刚写入的新文件，保持角色库原状。
        let oldAbs = null
        try { oldAbs = pathOf(await fs.resolve(roleDir + '/' + id + '.md')) } catch (e) { oldAbs = null }
        const rmOld = oldAbs ? await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", oldAbs], { cwd: repoRoot() || '/' }) : { ok: false, detail: '旧角色文件路径解析失败' }
        if (!rmOld.ok) {
          const newPath = pathOf(newAbs)
          const rmNew = newPath ? await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", newPath], { cwd: repoRoot() || '/' }) : null
          return { ok: false, errors: [{ at: '$', message: '旧角色文件删除失败（已回滚新文件' + (rmNew && rmNew.ok ? '' : '，回滚失败，请手动清理 ') + '）：' + rmOld.detail }] }
        }
      }
      // 编辑打包回退角色（工作区无文件、定义来自内置模板角色包）时，此处写入
      // 即完成「种子到自定义角色库」；运行时经 roleRef 的工作区优先链路读到新内容，
      // .generated 打包快照保持生成产物身份、不被改写（Codex PR#124 第二轮 P1）。
      const role = await getRoleDetail(target)
      return { ok: true, role }
    })
    // 删除自定义角色：内置拒绝；存在任意引用 → 阻止并提供引用详情（无强制删除）。
    registerRpc('vwf.roles.remove', async (a) => {
      const id = a && a.id
      if (fs === undefined || subprocess === undefined) return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法删除角色' }] }
      if (!id || typeof id !== 'string') return { ok: false, errors: [{ at: '$.id', message: '缺少角色 id' }] }
      if (BUILTIN_ROLE_IDS.indexOf(id) >= 0) {
        return { ok: false, errors: [{ at: '$', message: '内置角色只读：' + id + ' 属于系统标准角色，不能删除' }] }
      }
      const inv = await readRoleFiles()
      if (inv.state === 'error') return { ok: false, errors: [{ at: '$', message: '角色库读取失败：' + inv.message }] }
      let u
      try {
        u = await roleUsage(id, a && a.draftDsl)
      } catch (e) {
        return { ok: false, errors: [{ at: '$', message: '引用统计失败，已阻止删除：' + String((e && e.message) || e) }] }
      }
      if (u.count > 0) {
        const draftHint = u.refs.some(r => r.draft) ? '（含未保存草稿的引用）' : ''
        return { ok: false, errors: [{ at: '$', message: '「' + id + '」仍被 ' + u.count + ' 个节点使用' + draftHint + '。请先将这些节点更换为其他角色，解除全部引用后再删除。' }], usage: { count: u.count, refs: u.refs } }
      }
      // 打包回退角色（Codex PR#124 第四轮 P2，评论 3889756925）：工作区无文件、
      // 定义来自内置模板角色包，只能读取不能删除——删它等于改生成产物。此前在统计
      // 引用前就返回「自定义角色不存在」，界面上可点删除却必然失败且提示不准确。
      if (!inv.files.has(id)) {
        let bundledLegacy = null
        try { bundledLegacy = await bundledLegacyRoles() } catch (e) { bundledLegacy = new Map() }
        if (bundledLegacy.has(id)) {
          return { ok: false, errors: [{ at: '$', message: '「' + id + '」的定义来自内置模板自带的角色包（生成产物），不在自定义角色库中，无法在此删除；如需停用，请在模板中把引用替换为其他角色。' }] }
        }
        return { ok: false, errors: [{ at: '$', message: '自定义角色不存在：' + id }] }
      }
      const roleDir = await roleDirPath()
      let abs = null
      try { abs = pathOf(await fs.resolve(roleDir + '/' + id + '.md')) } catch (e) { abs = null }
      const rm = abs ? await runNode(['-e', "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true})", abs], { cwd: repoRoot() || '/' }) : { ok: false, detail: '角色文件路径解析失败' }
      if (!rm.ok) return { ok: false, errors: [{ at: '$', message: '角色删除失败：' + rm.detail }] }
      return { ok: true, id }
    })

    // ── 静态 bundle 模式：webServer RPC 路由（动态模式走 harness.handle）────
    // 信封与平台一致：POST /dsh-visual-workflow/<method>
    //   请求 {type:'client-request', rpcId, method, payload}
    //   响应 {rpcId, result}（result = 各 handler 的原样返回值）
    // 加载时序：静态组合包的 webServer 服务可能晚于本插件激活（bundle 声明
    // inject:['webServer'] 已让行级激活等待；此处对未声明 inject 的旧安装位
    // 再兜底 ctx.inject 延迟注册，避免「路由未注册 → 浏览器 RPC 全 404/405」）。
    if (!isDynamicHost) {
      const vwfRoute = {
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
        },
      }
      const registerOn = (owner, ws) => {
        if (!ws || typeof ws.register !== 'function') return false
        if (owner && typeof owner.effect === 'function') owner.effect(() => ws.register(vwfRoute), 'vwf: rpc route')
        else ws.register(vwfRoute)
        return true
      }
      const webServer = ctx.get('webServer')
      if (!registerOn(ctx, webServer) && typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (wctx) => {
          registerOn(wctx, (wctx && typeof wctx.get === 'function' ? wctx.get('webServer') : wctx) || wctx)
        })
      }
      if (ctx.get('webServer') === undefined) {
        console.log('[vwf] webServer 服务当前不可用：静态 RPC 路由延迟到 webServer 激活（bundle 已声明 inject）；若仍未注册请检查组合包版本')
      }
    }

    // ── Workspace Isolation 包装脚本路径（#93 Runtime Integration）──
    // Core 实现单一来源 = scripts/workspace-isolation.mjs；宿主通过 runNode 调用
    // 包装脚本 scripts/workspace-isolation-host.mjs，禁止平行实现 Git/lock。
    let _workspaceHostPath = null
    async function workspaceHostPath() {
      if (_workspaceHostPath) return _workspaceHostPath
      const p = await rootPaths()
      // 优先组合包注入的仓库根（静态 bundle），其次动态会话 cwd
      const roots = [p.generatorRoot, p.repo].filter(Boolean)
      for (const root of roots) {
        const candidate = root + '/scripts/workspace-isolation-host.mjs'
        if (fs !== undefined) {
          try {
            const st = await fs.stat(await fs.resolve(candidate))
            if (st && st.type === 'file') { _workspaceHostPath = candidate; break }
          } catch (e) { /* 尝试下一个根 */ }
        }
      }
      return _workspaceHostPath
    }
    // workspace 根目录：开发 DSH 用 ~/.dsh-workflow-dev/workspaces/，产品 DSH 用 ~/.dsh/workspaces/
    async function workspaceRoot() {
      const home = await dshHome()
      if (!home) return null
      return home + '/workspaces'
    }
    // 调用 workspace-isolation-host.mjs；返回解析后的 JSON 结果。
    // 包装脚本不存在时返回 { ok:false, error, notFound:true }——调用方据此区分
    // 「宿主未部署 #93 集成（回退旧行为）」与「脚本存在但隔离建立失败（fail closed）」。
    async function wsHostCall(cmd, input, opts) {
      const host = await workspaceHostPath()
      if (!host) return { ok: false, notFound: true, error: 'workspace-isolation-host.mjs 未找到（宿主未部署 #93 集成）' }
      const wsr = await workspaceRoot()
      if (!wsr) return { ok: false, notFound: true, error: '无法解析 workspace 根目录' }
      const payload = { ...input, work_root: input.work_root || wsr }
      const r = await runNode([host, cmd, JSON.stringify(payload)], { cwd: opts && opts.cwd ? opts.cwd : (await rootPaths()).generatorRoot, graceMs: (opts && opts.graceMs) || 30000, maxBytes: (opts && opts.maxBytes) || 256 * 1024 })
      if (!r.ok) return { ok: false, error: 'workspace host 调用失败：' + r.detail }
      try {
        const parsed = JSON.parse(r.stdout)
        if (!parsed.ok) return { ok: false, error: parsed.error || 'workspace host 业务错误', detail: parsed.detail }
        return parsed
      } catch (e) {
        return { ok: false, error: 'workspace host 输出不可解析：' + String((e && e.message) || e), raw: r.stdout }
      }
    }
    // 模板 id → TEMPLATE_ID 映射（#93 Policy 解析器消费）
    function mapTemplateId(id) {
      if (!id || typeof id !== 'string') return null
      const lower = id.toLowerCase()
      if (lower.indexOf('construction') >= 0 || lower.indexOf('bootstrap') >= 0) return 'construction'
      if (lower.indexOf('optimize') >= 0 || lower.indexOf('optim') >= 0) return 'optimize'
      if (lower.indexOf('diagnose') >= 0 || lower.indexOf('debug') >= 0) return 'diagnose'
      if (lower.indexOf('explore') >= 0 || lower.indexOf('research') >= 0) return 'explore'
      // 默认：建设类工作流（含 dev-workflow）走 ISOLATED_WRITE
      if (lower.indexOf('dev-workflow') >= 0 || lower.indexOf('dev_') >= 0) return 'construction'
      return 'construction'
    }

    // ── Workspace RPC 能力令牌（A3-2，Codex Round 2）───────────────────────
    // logical_run_id → capability 映射：allocate 成功时由宿主生成不可伪造令牌，
    // 注入 script args；RPC 调用必须携带匹配的 capability，否则拒绝。防止调用方
    // 猜出另一个 Run 的可猜测 taskId 越权读写对方 workspace（注册表解析只验证
    // ID 存在，不证明属于当前调用者）。
    const workspaceCaps = new Map()
    function genCapability() {
      // vm 沙箱无 crypto；用高熵拼接（时间 + 随机 + 计数器）防猜测
      const rand = () => Math.random().toString(36).slice(2)
      return 'cap-' + rand() + rand() + rand() + Date.now().toString(36) + '-' + (workspaceCaps.size + 1)
    }
    // RPC handler 内调用：校验 payload 携带的 capability 与宿主登记的 Run 一致
    function requireWorkspaceCapability(runId, cap) {
      const expected = workspaceCaps.get(String(runId || ''))
      if (!expected) return '该 Run 未登记 workspace capability（可能未经 wf_run 分配或已释放）'
      if (typeof cap !== 'string' || cap !== expected) return 'workspace capability 不匹配，拒绝越权访问'
      return null
    }

    // ── Workspace Isolation RPC（#93）──────────────────────────────────────
    // 这些 RPC 供编译后的 workflow 脚本在节点内调用，获取 workspace 现场、
    // 写 source/scratch、构建 provenance、管理集成锁。
    registerRpc('vwf.workspace.allocate', async (a) => {
      const templateId = mapTemplateId(a && a.templateId)
      const spec = {
        logical_run_id: String((a && a.taskId) || ''),
        template_id: templateId,
        repository_path: (a && a.repository_path) || null,
        repository: (a && a.repository) || null,
        base_ref: (a && a.baseBranch) || 'main',
        base_commit: (a && a.base_commit) || null,
        work_branch: (a && a.work_branch) || null,
        task_identity: String((a && a.taskId) || ''),
        allow_parallel: !!(a && a.allow_parallel),
      }
      return wsHostCall('allocate', spec)
    })
    registerRpc('vwf.workspace.get', async (a) => {
      const runId = String((a && a.logical_run_id) || (a && a.workspace_id) || (a && a.taskId) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('get', { logical_run_id: runId })
    })
    registerRpc('vwf.workspace.setLifecycle', async (a) => {
      const runId = String((a && a.logical_run_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('setLifecycle', {
        logical_run_id: runId,
        lifecycle: String((a && a.lifecycle) || ''),
        extra: (a && a.extra) || {},
      })
    })
    registerRpc('vwf.workspace.recordSourceSync', async (a) => {
      const runId = String((a && a.logical_run_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('recordSourceSync', {
        logical_run_id: runId,
        current_head: (a && a.current_head) || undefined,
        source_revision: (a && a.source_revision) || undefined,
      })
    })
    registerRpc('vwf.workspace.buildProvenance', async (a) => {
      // A4（Codex Round 1）：只接收 Run 身份，权威 workspace 由包装脚本从注册表解析，
      // 不信任调用方传入的 workspace 对象（防伪造路径越权写其他 Run）。
      // A3-2（Codex Round 2）：校验不可伪造 capability，防猜测 taskId 跨 Run 越权。
      const runId = String((a && a.logical_run_id) || (a && a.workspace_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('buildAttemptProvenance', {
        logical_run_id: runId, node: String((a && a.node) || ''), attempt: Number((a && a.attempt) || 1),
      })
    })
    registerRpc('vwf.workspace.acquireLock', async (a) => {
      const runId = String((a && a.logical_run_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('acquireLock', {
        logical_run_id: runId,
        resource_key: String((a && a.resource_key) || ''),
        owner: String((a && a.owner) || ''),
        ttl_ms: (a && a.ttl_ms) || undefined,
      })
    })
    registerRpc('vwf.workspace.releaseLock', async (a) => {
      const runId = String((a && a.logical_run_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('releaseLock', {
        lock_id: String((a && a.lock_id) || ''),
        owner: String((a && a.owner) || ''),
        logical_run_id: runId,
        reason: (a && a.reason) || undefined,
      })
    })
    registerRpc('vwf.workspace.cleanup', async (a) => {
      const runId = String((a && a.logical_run_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('cleanup', {
        logical_run_id: runId,
        opts: (a && a.opts) || {},
      })
    })
    registerRpc('vwf.workspace.writeSource', async (a) => {
      // A4：只接收 Run 身份；包装脚本内 resolveWorkspaceFromRegistry 取权威 workspace
      const runId = String((a && a.logical_run_id) || (a && a.workspace_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('writeSourceFile', { logical_run_id: runId, rel: String((a && a.rel) || ''), content: String((a && a.content) || '') })
    })
    registerRpc('vwf.workspace.readSource', async (a) => {
      const runId = String((a && a.logical_run_id) || (a && a.workspace_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('readSourceFile', { logical_run_id: runId, rel: String((a && a.rel) || '') })
    })
    registerRpc('vwf.workspace.writeWorker', async (a) => {
      const runId = String((a && a.logical_run_id) || (a && a.workspace_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('writeWorkerFile', { logical_run_id: runId, worker_id: String((a && a.worker_id) || ''), rel: String((a && a.rel) || ''), content: String((a && a.content) || '') })
    })
    registerRpc('vwf.workspace.readWorker', async (a) => {
      const runId = String((a && a.logical_run_id) || (a && a.workspace_id) || '')
      if (!runId) return { ok: false, error: '缺少 logical_run_id / workspace_id' }
      const capErr = requireWorkspaceCapability(runId, a && a.capability)
      if (capErr) return { ok: false, error: capErr }
      return wsHostCall('readWorkerFile', { logical_run_id: runId, worker_id: String((a && a.worker_id) || ''), rel: String((a && a.rel) || '') })
    })
    registerRpc('vwf.workspace.checkpoint', async (a) => {
      return wsHostCall('computeIntegrationCheckpointFromRepo', {
        base_ref: String((a && a.base_ref) || ''),
        base_commit: String((a && a.base_commit) || ''),
        repository_path: String((a && a.repository_path) || ''),
        target_ref: (a && a.target_ref) || undefined,
      })
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
      const tool = dtools.define({
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
        },
        output: { schema: { type: 'string' }, render: (a, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          // 约束②（同 taskId 互斥）：最新记录进行中/AWAITING_HUMAN 且非 entry 续跑 → 拒绝。
          // 校验放最前（fail-fast），不浪费校验/编译开销。
          // 先等启动回载完成（评审 PRRT_kwDOT57Tec6b6Iu1）：否则互斥判定可能与
          // 磁盘门禁水合竞速，重启后立刻续跑会漏判占用
          try { if (runsHydration) await runsHydration } catch (e) { /* 回载失败已留痕 */ }
          const isHdResume = !!(args && args.decision_id)
          const isLegacyResume = !!(args && args.entry)
          const isResume = isHdResume || isLegacyResume
          const blocker = taskMutexBlocker(String((args && args.taskId) || ''))
          if (blocker) {
            const st = String(blocker.status || '')
            let allow = false
            if (st === 'WAITING_HUMAN') {
              let rec = runs.get(blocker.runId)
              if (!rec) rec = await loadRunFromDisk(blocker.runId)
              const parkedId = rec && rec.decisionId ? String(rec.decisionId) : ''
              allow = isHdResume && (!parkedId || parkedId === String(args.decision_id))
            } else if (st.indexOf('AWAITING_HUMAN_') === 0) {
              allow = isLegacyResume
            } else {
              allow = isResume
            }
            if (!allow) {
              return '错误：任务 ' + args.taskId + ' 已有进行中的运行 ' + blocker.runId + '（状态 ' + blocker.status +
                '）：同 taskId 串行互斥。WAITING_HUMAN 请带 decision_id 与 user_choice 续跑；残留门禁请带 entry=<节点id> 与 approved；并行任务请换一个 taskId。'
            }
          }
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
          if (dslUsesHumanDecision(dsl) && args && args.approved !== undefined) {
            return '错误：Human Decision 续跑禁止 approved，请传 decision_id 与 user_choice'
          }
          if (isHdResume) {
            const parked = await parkedHumanDecision(String((args && args.taskId) || ''))
            if (parked) {
              if (args.blocked_edge == null && parked.blockedEdge) args.blocked_edge = parked.blockedEdge
              if (args.results == null && parked.results) args.results = parked.results
              if (args.history == null && parked.history) args.history = parked.history
              if (args.startRound == null && parked.round != null) args.startRound = parked.round
              if (args.budgetUsed == null && parked.budgetUsed != null) args.budgetUsed = parked.budgetUsed
              if (args.maxRounds == null && parked.maxRounds != null) args.maxRounds = parked.maxRounds
              if (args.decisionSeq == null && parked.decisionSeq != null) args.decisionSeq = parked.decisionSeq
              if (!args.entry && parked.node) args.entry = parked.node
            }
          }
          const v = await validatePipeline(dsl)
          if (!v.ok) return 'DSL 校验失败：' + JSON.stringify(v.errors)
          const c = await compileViaPipeline(v.sanitized, { fromTemplate })
          if (!c.ok) return '编译失败：' + c.detail
          const engineNow = resolveEngine()
          if (engineNow === undefined) return '错误：当前宿主平面无法访问 workflowEngine（wf_run 需要 agent preset 挂载的工作流引擎）。可改用内置 workflow 工具执行 vwf.script 编译产物。'
          const parent = agents.requireInitiator()

          // ── #93 Workspace Isolation 集成：启动前分配 Workspace ───────────────
          // 用 taskId 作为 portable run_id 占位 logical_run_id；模板类型决定 Policy。
          // A2（Codex Round 1）：脚本存在但分配失败必须 fail closed——隔离是本 PR
          // 交付的核心保证，瞬时故障静默降级会让两个 Run 重新写入共享现场。
          // 例外：包装脚本不存在（宿主未部署 #93 集成，如旧安装/测试环境）→ 回退
          // 旧行为（不注入 workspace，脚本自行管理路径），不把「未部署」当故障。
          let workspaceInfo = null
          let workspaceCap = null
          let workspaceDegraded = false
          const repoPath = repoRoot() || ''
          let allocError = null
          try {
            const templateId = mapTemplateId(args.templateId || (dsl && dsl.id) || '')
            const alloc = await wsHostCall('allocate', {
              logical_run_id: String(args.taskId || ''),
              template_id: templateId,
              repository_path: repoPath || null,
              repository: repoPath ? null : null,
              base_ref: args.baseBranch || 'main',
              task_identity: String(args.taskId || ''),
            })
            if (alloc.ok && alloc.workspace) {
              workspaceInfo = alloc.workspace
              // A3-2（Codex Round 2）：分配成功后登记不可伪造 capability，注入
              // script args；RPC 调用必须携带匹配令牌，防猜测 taskId 跨 Run 越权。
              const cap = genCapability()
              workspaceCaps.set(String(args.taskId || ''), cap)
              workspaceCap = cap
              console.log('[vwf] workspace allocated: ' + workspaceInfo.workspace_id + ' at ' + workspaceInfo.workspace_path)
            } else if (alloc.notFound) {
              workspaceDegraded = true
              console.log('[vwf] workspace 集成未部署（workspace-isolation-host.mjs 缺失），回退旧行为：' + (alloc.error || ''))
            } else {
              allocError = alloc.error || 'workspace 分配失败（未知原因）'
            }
          } catch (e) {
            allocError = String((e && e.message) || e)
          }
          if (allocError) {
            console.log('[vwf] workspace allocate 失败（fail closed，拒绝启动）：' + allocError)
            return '错误：Run Workspace 分配失败，隔离保证无法建立，工作流拒绝启动：' + allocError + '（请检查仓库根可访问性、~/.dsh*/workspaces 目录权限与 workspace-isolation-host.mjs 是否存在）'
          }

          // 注入 workspace 路径到 script args（#93）：脚本通过 host.call('vwf.workspace.get')
          // 获取现场，而非猜路径。旧脚本无此字段时行为不变。
          const scriptArgs = {
            taskId: args.taskId, runDir: args.runDir, roleDir: args.roleDir || c.roleDir, baseBranch: args.baseBranch,
            issueRef: args.issueRef, issueTitle: args.issueTitle, issueBody: args.issueBody, issueComments: args.issueComments,
            requirement: args.requirement, entry: args.entry, approved: args.approved, feedback: args.feedback, startRound: args.startRound, history: args.history,
            decision_id: args.decision_id, user_choice: args.user_choice, blocked_edge: args.blocked_edge, results: args.results,
            budgetUsed: args.budgetUsed, maxRounds: args.maxRounds, decisionSeq: args.decisionSeq,
            // #93: workspace 现场注入
            workspace_id: workspaceInfo ? workspaceInfo.workspace_id : undefined,
            workspace_path: workspaceInfo ? workspaceInfo.workspace_path : undefined,
            source_path: workspaceInfo ? workspaceInfo.source_path : undefined,
            records_path: workspaceInfo ? workspaceInfo.records_path : undefined,
            work_branch: workspaceInfo ? workspaceInfo.work_branch : undefined,
            source_revision: workspaceInfo ? workspaceInfo.source_revision : undefined,
            // A3-2: RPC 越权防护——脚本节点调用 workspace RPC 必须携带此令牌
            workspace_capability: workspaceCap || undefined,
          }
          // 剔除 undefined 键（lossless-JSON 守卫）
          for (const k of Object.keys(scriptArgs)) {
            if (scriptArgs[k] === undefined) delete scriptArgs[k]
          }

          const run = engineNow.start({ script: c.script, meta: c.meta, args: scriptArgs, parent: parent })
          // 启动边界自登记（workflow/start 事件无 taskId，见 runTags 注释）；
          // entry / decision_id 续跑把同 taskId 前序门禁记录标记接管，旧卡片退出门禁队列
          runTags.set(String(run.id), {
            taskId: String(args.taskId || ''),
            workflowId: String(args.templateId || (v.sanitized && v.sanitized.id) || ''),
            startedAt: Date.now(),
            active: true,
            // #93: 绑定 workspace 到 runTag，供后续节点通过 taskId 获取
            workspace_id: workspaceInfo ? workspaceInfo.workspace_id : undefined,
          })
          // 启动边界同步落一份快照：workflow/start 事件可能晚于 tag 登记到达，
          // 这里保证进行中的 run 后即有含 taskId 的可见快照（#40 AC2）
          requestRunPersist(String(run.id))
          if (isResume) supersedeParked(String(args.taskId), String(run.id))
          const result = await run.result
          // 权威终态回写（见 canonicalStop 注释）：completed 时以脚本返回为准
          // （DONE / WAITING_HUMAN / AWAITING_HUMAN_* / FAILED_*），cancelled/error 保持事件原样。
          // 注意：wf_run 回执保持引擎原样 stopReason/value 不做翻译（runtime-host
          // 套件 H1/H2 钉住该契约）；看板/互斥语义只消费这里回写的 runs 状态
          const canon = result && result.stopReason === 'completed' ? canonicalStop(result) : ''
          if (canon) {
            const rec = runs.get(String(run.id))
            if (rec) {
              rec.status = canon
              applyHumanDecisionValue(rec, result && result.value)
              requestRunPersist(String(run.id))
            }
          }
          // #93: 终态时更新 workspace lifecycle（非阻断）。
          // A5（Codex Round 1）：覆盖 canonicalStop 全部终态 + cancelled/error 兜底。
          // 人工等待类映射为保留态（cleanup 拒绝、可 Resume）；失败/取消类映射为
          // FAILED（cleanup 可回收），避免 workspace 永久留在 READY 泄漏资源。
          if (workspaceInfo) {
            const canonLc = canonicalLifecycleFor(canon, result && result.stopReason)
            if (canonLc) {
              try { await wsHostCall('setLifecycle', { logical_run_id: String(args.taskId || ''), lifecycle: canonLc }) } catch (e) { /* 忽略 */ }
            }
          }
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
//probe
