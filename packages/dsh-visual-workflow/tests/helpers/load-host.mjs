// host 半共享加载器（候选三：消除 host.test.mjs 与对拍套件的重复加载逻辑）
// 动态包形态：return { apply(ctx) {...} } 闭包体——new Function + 假 ctx/harness。
// 默认注入内存假 fs/subprocess/sandboxPolicy：syncBuiltins（apply 异步触发）只在假 fs
// 内存写入，绝不触碰真实 ~/.dsh；缺省 Overrides 可显式覆盖任一服务。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeFs, makeSubprocess, sandboxPolicy, HOME, DSH_HOME, REPO } from './fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', '..', 'src', 'host.js'), 'utf8')
// 角色库内核种子（role-library.cjs + manifest）：默认注入 home 对与 repo 对两个候选根——
// 有 subprocess 时 dshHome 探针解析到假 HOME（home 对优先命中）；无 subprocess 时回落
// 真实 HOME，repo 对兜底。readRoleFiles 只收 .md，manifest 的 .json 种子不影响角色目录语义。
const roleCoreSrc = readFileSync(join(here, '..', '..', '..', '..', 'scripts', 'role-library.cjs'), 'utf8')
const roleManifestSrc = readFileSync(join(here, '..', '..', '..', '..', 'dsh', 'roles', 'builtin-roles.json'), 'utf8')
export const ROLE_CORE_SEED = {
  [HOME + '/.dsh/visual-workflow/role-library.cjs']: roleCoreSrc,
  [HOME + '/.dsh/visual-workflow/builtin-roles.json']: roleManifestSrc,
  [REPO + '/scripts/role-library.cjs']: roleCoreSrc,
  [REPO + '/dsh/roles/builtin-roles.json']: roleManifestSrc,
}

export function loadHost(overrides = {}) {
  const handlers = new Map()
  const definedTools = []
  const events = new Map()
  // 测试必须显式注入假 process：当前 DSH 会话自身可能携带真实 DSH_HOME，若让
  // host.js 读取全局 process.env 会把测试写入开发/产品真实 Home。形态与动态 loader 相同。
  const { processValue = { env: { DSH_HOME, HOME }, cwd: () => REPO }, ...serviceOverrides } = overrides
  const svc = { fs: makeFs({}), subprocess: makeSubprocess({}), sandboxPolicy, ...serviceOverrides }
  // 默认注入角色库内核种子（显式缺省时可通过 roleCoreSeed:false 关闭）
  if (overrides.roleCoreSeed !== false && svc.fs && svc.fs._files) {
    for (const [k, v] of Object.entries(ROLE_CORE_SEED)) if (!svc.fs._files.has(k)) svc.fs._files.set(k, v)
  }
  const ctx = {
    get: (name) => (svc[name] === undefined ? undefined : svc[name]),
    on: (name, fn) => { events.set(name, fn) },
  }
  const harness = {
    handle: (method, fn) => { handlers.set(method, fn) },
    defineTool: (tool) => { definedTools.push(tool); return tool },
    registerTool: () => {},
  }
  const pluginRoot = serviceOverrides.pluginRoot ?? null
  const fn = new Function('ctx', 'harness', '__VWF_PLUGIN_ROOT__', 'process', `${src}`)
  const plugin = fn(ctx, harness, pluginRoot, processValue)
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
  const { processValue = { env: { DSH_HOME, HOME }, cwd: () => REPO }, ...serviceOverrides } = overrides
  const svc = { fs: makeFs({}), subprocess: makeSubprocess({}), sandboxPolicy, ...serviceOverrides }
  const ctx = {
    get: (name) => {
      if (name === 'webServer' && svc.webServer === undefined) return defaultWebServer
      return svc[name] === undefined ? undefined : svc[name]
    },
    on: (name, fn) => { events.set(name, fn) },
    effect: (fn) => { fn(); return () => {} },
  }
  const pluginRoot = serviceOverrides.pluginRoot ?? null
  const fn = new Function('ctx', 'process', '__VWF_PLUGIN_ROOT__', `${src}`)
  const plugin = fn(ctx, processValue, pluginRoot)
  plugin.apply(ctx)
  return { registered, definedTools, events, ctx }
}
