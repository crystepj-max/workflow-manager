// host 半共享加载器（候选三：消除 host.test.mjs 与对拍套件的重复加载逻辑）
// 动态包形态：return { apply(ctx) {...} } 闭包体——new Function + 假 ctx/harness。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', '..', 'src', 'host.js'), 'utf8')

export function loadHost(overrides = {}) {
  const handlers = new Map()
  const definedTools = []
  const events = new Map()
  const ctx = {
    get: (name) => (overrides[name] === undefined ? undefined : overrides[name]),
    on: (name, fn) => { events.set(name, fn) },
  }
  const harness = {
    handle: (method, fn) => { handlers.set(method, fn) },
    defineTool: (tool) => { definedTools.push(tool); return tool },
    registerTool: () => {},
  }
  const fn = new Function('ctx', 'harness', `${src}`)
  const plugin = fn(ctx, harness)
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
  const ctx = {
    get: (name) => {
      if (name === 'webServer' && overrides.webServer === undefined) return defaultWebServer
      return overrides[name] === undefined ? undefined : overrides[name]
    },
    on: (name, fn) => { events.set(name, fn) },
    effect: (fn) => { fn(); return () => {} },
  }
  const fn = new Function('ctx', `${src}`)
  const plugin = fn(ctx)
  plugin.apply(ctx)
  return { registered, definedTools, events, ctx }
}
