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
import { makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distEntry = join(here, '..', 'dist', 'host-entry.mjs')
const distClient = join(here, '..', 'dist', 'client.js')

test('T3：静态 bundle dist 含 formal-artifacts.cjs（#69 正式安装路径）', () => {
  const formalDist = join(here, '..', 'dist', 'formal-artifacts.cjs')
  assert.ok(existsSync(formalDist), 'dist/formal-artifacts.cjs 必须存在（build 时从 scripts/ 复制）')
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

test('T3：静态 bundle dist 导出 inject:[\'webServer\', \'tools\']——行级激活等待必需服务就绪', async (t) => {
  // 回归：host 行无完整 inject 时会在 webServer/tools 激活前 apply，
  // 导致 RPC 路由或工具注册永久错过。
  assert.ok(existsSync(distEntry), 'dist/host-entry.mjs 必须存在')
  try {
    await import('@deepseek-ai/dsh-tools')
  } catch {
    t.skip('未安装 @deepseek-ai/dsh-tools，跳过真实 ESM 加载')
    return
  }
  const mod = await import(pathToFileURL(distEntry).href + '?t=' + Date.now())
  assert.deepEqual(mod.inject, ['webServer', 'tools'], '静态 host 出口必须声明 webServer/tools 依赖')
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
  assert.deepEqual(mod.inject, ['webServer', 'tools'], '静态 bundle 必须声明两个宿主依赖')
  assert.deepEqual([...activeRoutes.keys()], ['/dsh-visual-workflow'])
  assert.deepEqual([...activeTools.keys()].sort(), ['vwf_debug', 'wf_run'])
  assert.equal(routeCalls.length, 1, 'RPC 路由首次只注册一次')
  assert.equal(toolCalls.length, 2, '两个工具首次各注册一次')

  await disposeTools()
  assert.equal(activeRoutes.size, 0, 'tools 卸载时静态 Host 的 RPC 路由应随插件卸载')
  assert.equal(activeTools.size, 0, 'tools 卸载时旧工具应随插件卸载')

  const disposeToolsAgain = ctx.provide('tools', tools)
  await fiber
  assert.equal(activeRoutes.size, 1, 'tools 重现后只能保留一条活动 RPC 路由')
  assert.deepEqual([...activeTools.keys()].sort(), ['vwf_debug', 'wf_run'], 'tools 重现后只能保留两个活动工具')
  assert.equal(routeCalls.length, 2, '重载后是先卸载再重新注册，不发生重复占用')
  assert.equal(toolCalls.length, 4, '重载后是先卸载再重新注册，不发生重复占用')

  await disposeToolsAgain()
  await disposeWebServer()
  await Promise.all(serviceDisposers.map((dispose) => dispose()))
})
