// host 半共享加载器（候选三：消除 host.test.mjs 与对拍套件的重复加载逻辑）
// 动态包形态：return { apply(ctx) {...} } 闭包体——new Function + 假 ctx/harness。
// 默认注入内存假 fs/subprocess/sandboxPolicy：syncBuiltins（apply 异步触发）只在假 fs
// 内存写入，绝不触碰真实 ~/.dsh；缺省 Overrides 可显式覆盖任一服务。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeFs, makeSubprocess, sandboxPolicy } from './fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', '..', 'src', 'host.js'), 'utf8')

export function loadHost(overrides = {}) {
  const handlers = new Map()
  const definedTools = []
  const events = new Map()
  const svc = { fs: makeFs({}), subprocess: makeSubprocess({}), sandboxPolicy, ...overrides }
  const ctx = {
    get: (name) => (svc[name] === undefined ? undefined : svc[name]),
    on: (name, fn) => { events.set(name, fn) },
  }
  const harness = {
    handle: (method, fn) => { handlers.set(method, fn) },
    defineTool: (tool) => { definedTools.push(tool); return tool },
    registerTool: () => {},
  }
  const pluginRoot = overrides.pluginRoot ?? null
  const fn = new Function('ctx', 'harness', '__VWF_PLUGIN_ROOT__', `${src}`)
  const plugin = fn(ctx, harness, pluginRoot)
  plugin.apply(ctx)
  return { handlers, definedTools, events, ctx }
}

// 静态 Host / Minke bundle：不注入 harness 自由变量，走 webServer 前缀路由。
export function loadStaticHost(overrides = {}) {
  const registered = []
  const definedTools = []
  const events = new Map()
  const defaultWebServer = {
    register(route, label) { registered.push({ route, label }) },
  }
  const svc = { fs: makeFs({}), subprocess: makeSubprocess({}), sandboxPolicy, ...overrides }
  const ctx = {
    get: (name) => {
      if (name === 'webServer' && svc.webServer === undefined) return defaultWebServer
      return svc[name] === undefined ? undefined : svc[name]
    },
    on: (name, fn) => { events.set(name, fn) },
    effect: (fn) => { fn(); return () => {} },
  }
  const fn = new Function('ctx', `${src}`)
  const plugin = fn(ctx)
  plugin.apply(ctx)
  return { registered, definedTools, events, ctx }
}
