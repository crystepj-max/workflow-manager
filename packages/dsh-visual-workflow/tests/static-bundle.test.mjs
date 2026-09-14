// issue-33 / T3：无 harness 全局的静态 Host / bundle 场景
// 断言 apply() 不抛 ReferenceError，并走 webServer 前缀路由（而非 harness.handle）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStaticHost, loadHost } from './helpers/load-host.mjs'
import { REPO, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distEntry = join(here, '..', 'dist', 'host-entry.mjs')
const distClient = join(here, '..', 'dist', 'client.js')

function invokeStaticRpc(route, method, payload = {}) {
  return new Promise((resolve, reject) => {
    const listeners = {}
    const req = { method: 'POST', on(name, fn) { listeners[name] = fn } }
    const res = {
      writeHead() {},
      end(text) {
        try { resolve(JSON.parse(text).result) } catch (e) { reject(e) }
      },
    }
    route.handler(req, res)
    if (listeners.data) listeners.data(JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method, payload }))
    if (listeners.end) listeners.end()
  })
}

test('T3：静态 bundle dist 含 formal-artifacts.cjs（#69 正式安装路径）', () => {
  const formalDist = join(here, '..', 'dist', 'formal-artifacts.cjs')
  assert.ok(existsSync(formalDist), 'dist/formal-artifacts.cjs 必须存在（build 时从 scripts/ 复制）')
})

test('静态 bundle dist 含 validate-core.cjs（浏览器保存无仓库 cwd 时的内核副本）', () => {
  const kernelDist = join(here, '..', 'dist', 'validate-core.cjs')
  assert.ok(existsSync(kernelDist), 'dist/validate-core.cjs 必须存在（build 时从 scripts/ 复制）')
})

test('静态 bundle dist 含 projection-core.cjs 且两个投影入口可加载', () => {
  const coreDist = join(here, '..', 'dist', 'projection-core.cjs')
  assert.ok(existsSync(coreDist), 'dist/projection-core.cjs 必须存在（build 时从 scripts/ 复制）')
  const module = { exports: {} }
  new Function('module', 'exports', readFileSync(coreDist, 'utf8'))(module, module.exports)
  assert.equal(typeof module.exports.projectToVwf, 'function', 'dist 投影内核必须导出 projectToVwf')
  assert.equal(typeof module.exports.projectToBlueprint, 'function', 'dist 投影内核必须导出 projectToBlueprint')
})

test('静态 Host：正式 pluginRoot/dist 的投影内核可驱动校验链路', async () => {
  const pluginRoot = '/plugin/static'
  const validatorSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')
  const projectionSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'projection-core.cjs'), 'utf8')
  const fs = makeFs({
    [REPO + '/scripts/validate-core.cjs']: validatorSrc,
    [pluginRoot + '/dist/validate-core.cjs']: validatorSrc,
    [pluginRoot + '/dist/projection-core.cjs']: projectionSrc,
  })
  const loaded = loadStaticHost({
    fs,
    subprocess: makeSubprocess({ fs }),
    pluginRoot,
    projectionCoreSeed: false,
    roleCoreSeed: false,
    distKernelSeed: false,
    sandboxPolicy,
  })
  const result = await invokeStaticRpc(loaded.registered[0].route, 'vwf.validate', {
    dsl: {
      id: 'static-projection',
      name: '静态投影',
      entry: 'n1',
      control: { maxRounds: 3 },
      nodes: [{ id: 'n1', profile: 'dev', label: '节点', goal: 'g', model: { provider: 'p', model: 'm' } }],
      edges: [{ from: 'n1', to: '$end', on: 'success' }],
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('静态 bundle dist 含语言资源与内置角色正文', () => {
  assert.ok(existsSync(join(here, '..', 'dist', 'locales', 'zh.json')), 'dist/locales/zh.json 必须存在')
  assert.ok(existsSync(join(here, '..', 'dist', 'locales', 'en.json')), 'dist/locales/en.json 必须存在')
  assert.ok(existsSync(join(here, '..', 'dist', 'roles', 'dev.md')), 'dist/roles/dev.md 必须存在')
  assert.ok(existsSync(join(here, '..', 'dist', 'dynamic', 'host.js')), 'dist/dynamic/host.js 必须存在')
  assert.ok(existsSync(join(here, '..', 'dist', 'dynamic', 'client.js')), 'dist/dynamic/client.js 必须存在')
})

test('开发粘贴用 dynamic 闭包合计 ≤ 190KB（一次 cordis_define 载荷），host 自带头部常量与 Buffer 垫片', () => {
  const host = readFileSync(join(here, '..', 'dist', 'dynamic', 'host.js'))
  const client = readFileSync(join(here, '..', 'dist', 'dynamic', 'client.js'))
  // 预算按「同一次 cordis_define 的粘贴总量」计（两半天生不等大）。
  // 160KiB 为瘦身高水位（build-bundle 软上限：超出仅警告）；#80 运行控制 UI 与
  // LOC-001 编辑器 V2 并入后硬顶上调至 176KiB，持续超出仍应回做面板瘦身。
  // LOC-017 集成闸门宿主编排并入后上调至 184KiB（决策 1 载体=产品运行时，host 半不可省）。
  // LOC-014 模型覆盖层（host 合成单点 + RPC 三端点 + 模板库最小覆盖对话框）并入后上调至 188KiB。
  // LOC-021 异源档位三态（校验内核档位判定 + 运行时日志档位/角色口径 + 编辑器三档选择器与中英文案）并入后上调至 190KiB。
  const limit = 190 * 1024
  assert.ok(host.byteLength + client.byteLength <= limit, `host ${host.byteLength} + client ${client.byteLength} > ${limit}`)
  const hostText = host.toString('utf8')
  const clientText = client.toString('utf8')
  // 闭包体形态：前置语句（注入头/垫片）之后必须是 return {...}（宿主以函数体求值）
  assert.match(hostText, /\nreturn\{name:"visual-workflow-host"/, 'host 必须以注入头 + return {...} 闭包体收尾')
  assert.match(clientText, /^return\{/, 'client 必须是 return {...} 闭包体')
  // 动态沙箱缺省注入：插件根常量（loadDist 内核来源）与 Buffer 垫片（validate-core 尺寸检查依赖）
  assert.match(hostText, /const __VWF_PLUGIN_ROOT__ = "/, 'host 必须自注入 __VWF_PLUGIN_ROOT__（动态沙箱不提供）')
  assert.match(hostText, /const __VWF_REPO_ROOT__ = "/, 'host 必须自注入 __VWF_REPO_ROOT__（generate/workspace-host 路径来源）')
  assert.match(hostText, /globalThis\.Buffer/, 'host 必须注入 globalThis.Buffer 垫片（validate-core 尺寸检查依赖）')
})

test('静态 bundle dist 含 role-library.cjs + builtin-roles.json 且内核可加载（角色库正式安装路径）', () => {
  const coreDist = join(here, '..', 'dist', 'role-library.cjs')
  const manifestDist = join(here, '..', 'dist', 'builtin-roles.json')
  assert.ok(existsSync(coreDist), 'dist/role-library.cjs 必须存在（build 时从 scripts/ 复制）')
  assert.ok(existsSync(manifestDist), 'dist/builtin-roles.json 必须存在（build 时从 dsh/roles/ 复制）')
  // 从 dist 路径真实加载内核（与 host.js 静态候选根 __VWF_PLUGIN_ROOT__/dist 同形态）
  const module = { exports: {} }
  new Function('module', 'exports', readFileSync(coreDist, 'utf8'))(module, module.exports)
  assert.equal(typeof module.exports.createRoleLibrary, 'function', 'dist 内核必须导出 createRoleLibrary')
  const lib = module.exports.createRoleLibrary(JSON.parse(readFileSync(manifestDist, 'utf8')))
  assert.equal(lib.describe().builtinIds.length, 12, 'dist 清单必须含 12 个内置角色')
})

test('T3：静态客户端 bundle 注册 dsh-visual-workflow 到网页模块加载器', () => {
  assert.ok(existsSync(distClient), 'dist/client.js 必须存在（源码变更后须重新 build）')
  const registrations = []
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(registration) { registrations.push(registration) },
      },
    },
  })
  vm.runInContext(readFileSync(distClient, 'utf8'), context, { filename: distClient })
  assert.equal(registrations.length, 1, '客户端 bundle 必须注册一次')
  assert.equal(registrations[0].id, 'dsh-visual-workflow')
  const plugin = registrations[0].factory((specifier) => {
    assert.equal(specifier, 'react')
    return {}
  })
  assert.equal(typeof plugin.apply, 'function')
})

test('T3：源码静态 Host 无 harness 时 apply() 不抛 ReferenceError，并注册 webServer 路由', async () => {
  assert.equal(typeof globalThis.harness, 'undefined', '测试进程不得预置 harness 全局')
  let plugin
  assert.doesNotThrow(() => { plugin = loadStaticHost() })
  const routes = plugin.registered.map((r) => r.route)
  assert.equal(routes.length, 1, '静态模式应注册恰好一条 webServer 路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/dsh-visual-workflow')
  assert.equal(typeof routes[0].handler, 'function')
})

test('T3：动态 Host 仍走 harness.handle（回归：双模式互不抢占）', async () => {
  const { handlers, registered } = (() => {
    const loaded = loadHost()
    return { handlers: loaded.handlers, registered: loaded.registered }
  })()
  assert.ok(handlers.has('vwf.workflows.list'), '动态模式 RPC 仍经 harness.handle 注册')
  assert.equal(registered, undefined, '动态加载器不暴露 webServer 注册面')
})

test('角色库 core 加载：正式静态模式优先可信 pluginRoot/dist，不读取 repo 旧清单', async () => {
  const repoRoot = join(here, '..', '..', '..')
  const coreSrc = readFileSync(join(repoRoot, 'scripts', 'role-library.cjs'), 'utf8')
  const base = JSON.parse(readFileSync(join(repoRoot, 'dsh', 'roles', 'builtin-roles.json'), 'utf8'))
  const trusted = JSON.parse(JSON.stringify(base))
  trusted.builtins.find((r) => r.id === 'dev').name = 'DIST 可信开发名'
  const untrusted = JSON.parse(JSON.stringify(base))
  untrusted.builtins.find((r) => r.id === 'dev').name = 'REPO 旧开发名'
  const pluginRoot = '/pkg'
  const fs = makeFs({
    [pluginRoot + '/dist/role-library.cjs']: coreSrc,
    [pluginRoot + '/dist/builtin-roles.json']: JSON.stringify(trusted),
    [REPO + '/scripts/role-library.cjs']: coreSrc,
    [REPO + '/dsh/roles/builtin-roles.json']: JSON.stringify(untrusted),
  })
  const loaded = loadStaticHost({ fs, subprocess: makeSubprocess({ fs }), sandboxPolicy, pluginRoot })
  const result = await invokeStaticRpc(loaded.registered[0].route, 'vwf.roles')
  assert.equal(result.roles.find((r) => r.id === 'dev').name, 'DIST 可信开发名', '静态模式必须优先可信 dist')
})

test('T3：静态 bundle dist/host-entry.mjs 在无 harness 时 apply() 走 webServer', async (t) => {
  assert.ok(existsSync(distEntry), 'dist/host-entry.mjs 必须存在（源码变更后须重新 build）')
  try {
    await import('@deepseek-ai/dsh-tools')
  } catch {
    t.skip('未安装 @deepseek-ai/dsh-tools，跳过真实 ESM 加载（源码静态 Host 用例仍覆盖无 harness 路径）')
    return
  }
  const { apply } = await import(pathToFileURL(distEntry).href + '?t=' + Date.now())
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return { register(route) { registered.push(route) } }
      }
      if (name === 'fs') return makeFs({})
      if (name === 'subprocess') return makeSubprocess({})
      if (name === 'sandboxPolicy') return sandboxPolicy
      return undefined
    },
    on() {},
    effect(fn) { fn(); return () => {} },
  }
  assert.equal(typeof globalThis.harness, 'undefined')
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/dsh-visual-workflow')
})

test('T3：静态 bundle dist 导出 inject:[\'webServer\', \'tools\', \'subprocess\']——行级激活等待必需服务就绪', async (t) => {
  // 回归：host 行无完整 inject 时会在 webServer/tools/subprocess 激活前 apply，
  // 导致 RPC 路由或工具注册永久错过；#122：缺少 subprocess 会让删除/保存模板报
  // 「子进程服务不可用（node 解析失败）」。
  assert.ok(existsSync(distEntry), 'dist/host-entry.mjs 必须存在')
  try {
    await import('@deepseek-ai/dsh-tools')
  } catch {
    t.skip('未安装 @deepseek-ai/dsh-tools，跳过真实 ESM 加载')
    return
  }
  const mod = await import(pathToFileURL(distEntry).href + '?t=' + Date.now())
  assert.deepEqual(mod.inject, ['webServer', 'tools', 'subprocess'], '静态 host 出口必须声明 webServer/tools/subprocess 依赖')
})

test('T3：webServer 晚于 apply 激活时经 ctx.inject 延迟注册路由（无 inject 旧安装位兜底）', () => {
  const src = readFileSync(join(here, '..', 'src', 'host.js'), 'utf8')
  const registered = []
  const lazyCtx = {
    get(name) {
      if (name === 'webServer') return undefined
      if (name === 'fs') return makeFs({})
      if (name === 'subprocess') return makeSubprocess({})
      if (name === 'sandboxPolicy') return sandboxPolicy
      return undefined
    },
    on() {},
    effect(fn) { fn(); return () => {} },
    inject(deps, cb) {
      assert.deepEqual(deps, ['webServer'], '延迟注册等待 webServer 依赖')
      let done = false
      cb({
        get(name) { return name === 'webServer' ? { register(route) { registered.push(route) } } : undefined },
        effect(fn) { if (!done) { done = true; fn() } return () => {} },
      })
    },
  }
  const fn = new Function('ctx', src)
  const plugin = fn(lazyCtx)
  assert.doesNotThrow(() => plugin.apply(lazyCtx))
  assert.equal(registered.length, 1, 'webServer 就绪后路由已注册')
  assert.equal(registered[0].path, '/dsh-visual-workflow')
})

test('Issue #37：消费者先进入 Cordis，webServer/tools 后出现时才一次性激活并支持重载', async (t) => {
  let cordisEntry
  try {
    const toolsPackage = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json')
    cordisEntry = createRequire(toolsPackage).resolve('@deepseek-ai/cordis')
  } catch {
    t.skip('未安装 @deepseek-ai/cordis，跳过真实 Cordis 生命周期测试')
    return
  }
  const { Context } = await import(pathToFileURL(cordisEntry).href)
  const mod = await import(pathToFileURL(distEntry).href + '?issue37=' + Date.now())
  const activeRoutes = new Map()
  const routeCalls = []
  const activeTools = new Map()
  const toolCalls = []
  const webServer = {
    register(route) {
      if (activeRoutes.has(route.path)) throw new Error('duplicate route: ' + route.path)
      activeRoutes.set(route.path, route)
      routeCalls.push(route)
      return () => { activeRoutes.delete(route.path) }
    },
  }
  const tools = {
    register(tool) {
      if (activeTools.has(tool.name)) throw new Error('duplicate tool: ' + tool.name)
      activeTools.set(tool.name, tool)
      toolCalls.push(tool)
      return () => { activeTools.delete(tool.name) }
    },
  }
  const ctx = new Context()
  const serviceDisposers = [
    ctx.provide('agents', { currentInitiator: () => null, requireInitiator: () => ({}) }),
    ctx.provide('fs', makeFs({})),
    ctx.provide('subprocess', makeSubprocess({})),
    ctx.provide('sandboxPolicy', sandboxPolicy),
  ]
  const fiber = ctx.plugin(mod)

  assert.equal(activeRoutes.size, 0, '两个必需服务都未就绪时不能注册 RPC')
  assert.equal(activeTools.size, 0, '两个必需服务都未就绪时不能注册工具')

  const disposeWebServer = ctx.provide('webServer', webServer)
  await Promise.resolve()
  assert.equal(activeRoutes.size, 0, '仅 webServer 就绪时仍不能提前激活')
  assert.equal(activeTools.size, 0, '仅 webServer 就绪时不能提前注册工具')

  const disposeTools = ctx.provide('tools', tools)
  await fiber
  assert.deepEqual(mod.inject, ['webServer', 'tools', 'subprocess'], '静态 bundle 必须声明三个宿主依赖')
  assert.deepEqual([...activeRoutes.keys()], ['/dsh-visual-workflow'])
  assert.deepEqual([...activeTools.keys()].sort(), ['vwf_debug', 'vwf_workspace', 'wf_control', 'wf_run'])
  assert.equal(routeCalls.length, 1, 'RPC 路由首次只注册一次')
  assert.equal(toolCalls.length, 4, '四个工具首次各注册一次')

  await disposeTools()
  assert.equal(activeRoutes.size, 0, 'tools 卸载时静态 Host 的 RPC 路由应随插件卸载')
  assert.equal(activeTools.size, 0, 'tools 卸载时旧工具应随插件卸载')

  const disposeToolsAgain = ctx.provide('tools', tools)
  await fiber
  assert.equal(activeRoutes.size, 1, 'tools 重现后只能保留一条活动 RPC 路由')
  assert.deepEqual([...activeTools.keys()].sort(), ['vwf_debug', 'vwf_workspace', 'wf_control', 'wf_run'], 'tools 重现后只能保留四个活动工具')
  assert.equal(routeCalls.length, 2, '重载后是先卸载再重新注册，不发生重复占用')
  assert.equal(toolCalls.length, 8, '重载后是先卸载再重新注册，不发生重复占用')

  await disposeToolsAgain()
  await disposeWebServer()
  await Promise.all(serviceDisposers.map((dispose) => dispose()))
})
