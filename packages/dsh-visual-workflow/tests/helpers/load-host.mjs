// host 半共享加载器（候选三：消除 host.test.mjs 与对拍套件的重复加载逻辑）
// 动态包形态：return { apply(ctx) {...} } 闭包体——new Function + 假 ctx/harness。
// 默认注入内存假 fs/subprocess/sandboxPolicy：缺省 Overrides 可显式覆盖任一服务。
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeFs, makeSubprocess, sandboxPolicy, HOME, DSH_HOME, REPO } from './fake-services.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')
const src = readFileSync(join(here, '..', '..', 'src', 'host.js'), 'utf8')
const PLUGIN_ROOT = REPO + '/packages/dsh-visual-workflow'
const DIST = PLUGIN_ROOT + '/dist'

const roleCoreSrc = readFileSync(join(repoRoot, 'scripts', 'role-library.cjs'), 'utf8')
const roleManifestSrc = readFileSync(join(repoRoot, 'dsh', 'roles', 'builtin-roles.json'), 'utf8')
const validatorCoreSrc = readFileSync(join(repoRoot, 'scripts', 'validate-core.cjs'), 'utf8')
const schemaProtocolCoreSrc = readFileSync(join(repoRoot, 'scripts', 'schema-protocol-core.cjs'), 'utf8')
const projectionCoreSrc = readFileSync(join(repoRoot, 'scripts', 'projection-core.cjs'), 'utf8')
const formalArtifactsSrc = readFileSync(join(repoRoot, 'scripts', 'formal-artifacts.cjs'), 'utf8')
const evaluationBaselineSrc = readFileSync(join(repoRoot, 'scripts', 'evaluation-baseline.cjs'), 'utf8')
const stateRecoveryCoreSrc = readFileSync(join(repoRoot, 'scripts', 'state-recovery-core.cjs'), 'utf8')

export const ROLE_CORE_SEED = {
  [DIST + '/role-library.cjs']: roleCoreSrc,
  [DIST + '/builtin-roles.json']: roleManifestSrc,
  [HOME + '/.dsh/visual-workflow/role-library.cjs']: roleCoreSrc,
  [HOME + '/.dsh/visual-workflow/builtin-roles.json']: roleManifestSrc,
  [REPO + '/scripts/role-library.cjs']: roleCoreSrc,
  [REPO + '/dsh/roles/builtin-roles.json']: roleManifestSrc,
}

export const DIST_KERNEL_SEED = {
  [DIST + '/validate-core.cjs']: validatorCoreSrc,
  [DIST + '/schema-protocol-core.cjs']: schemaProtocolCoreSrc,
  [DIST + '/projection-core.cjs']: projectionCoreSrc,
  [DIST + '/role-library.cjs']: roleCoreSrc,
  [DIST + '/builtin-roles.json']: roleManifestSrc,
  [DIST + '/formal-artifacts.cjs']: formalArtifactsSrc,
  [DIST + '/evaluation-baseline.cjs']: evaluationBaselineSrc,
  [DIST + '/state-recovery-core.cjs']: stateRecoveryCoreSrc,
}

const localeDir = join(here, '..', '..', 'locales')
for (const name of readdirSync(localeDir)) {
  if (!name.endsWith('.json')) continue
  DIST_KERNEL_SEED[DIST + '/locales/' + name] = readFileSync(join(localeDir, name), 'utf8')
}
const rolesDir = join(repoRoot, 'dsh', 'roles')
for (const name of readdirSync(rolesDir)) {
  if (!name.endsWith('.md')) continue
  DIST_KERNEL_SEED[DIST + '/roles/' + name] = readFileSync(join(rolesDir, name), 'utf8')
}

function seedDistKernels(fs) {
  if (!fs || !fs._files) return
  for (const [k, v] of Object.entries(DIST_KERNEL_SEED)) if (!fs._files.has(k)) fs._files.set(k, v)
}

export function loadHost(overrides = {}) {
  const handlers = new Map()
  const definedTools = []
  const events = new Map()
  // 测试必须显式注入假 process：当前 DSH 会话自身可能携带真实 DSH_HOME，若让
  // host.js 读取全局 process.env 会把测试写入开发/产品真实 Home。形态与动态 loader 相同。
  const { processValue = { env: { DSH_HOME, HOME }, cwd: () => REPO }, ...serviceOverrides } = overrides
  const svc = { fs: makeFs({}), subprocess: makeSubprocess({}), sandboxPolicy, ...serviceOverrides }
  if (overrides.roleCoreSeed !== false && svc.fs && svc.fs._files) {
    for (const [k, v] of Object.entries(ROLE_CORE_SEED)) if (!svc.fs._files.has(k)) svc.fs._files.set(k, v)
  }
  if (overrides.distKernelSeed !== false) seedDistKernels(svc.fs)
  const ctx = {
    get: (name) => (svc[name] === undefined ? undefined : svc[name]),
    on: (name, fn) => { events.set(name, fn) },
  }
  const harness = {
    handle: (method, fn) => { handlers.set(method, fn) },
    defineTool: (tool) => { definedTools.push(tool); return tool },
    registerTool: () => {},
  }
  const pluginRoot = serviceOverrides.pluginRoot === undefined ? PLUGIN_ROOT : serviceOverrides.pluginRoot
  const repoRootInject = serviceOverrides.repoRoot === undefined ? REPO : serviceOverrides.repoRoot
  const fn = new Function('ctx', 'harness', '__VWF_PLUGIN_ROOT__', '__VWF_REPO_ROOT__', 'process', `${src}`)
  const plugin = fn(ctx, harness, pluginRoot, repoRootInject, processValue)
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
  if (overrides.distKernelSeed !== false) seedDistKernels(svc.fs)
  const ctx = {
    get: (name) => {
      if (name === 'webServer' && svc.webServer === undefined) return defaultWebServer
      return svc[name] === undefined ? undefined : svc[name]
    },
    on: (name, fn) => { events.set(name, fn) },
    effect: (fn) => { fn(); return () => {} },
  }
  const pluginRoot = serviceOverrides.pluginRoot === undefined ? PLUGIN_ROOT : serviceOverrides.pluginRoot
  const repoRootInject = serviceOverrides.repoRoot === undefined ? REPO : serviceOverrides.repoRoot
  const fn = new Function('ctx', 'process', '__VWF_PLUGIN_ROOT__', '__VWF_REPO_ROOT__', `${src}`)
  const plugin = fn(ctx, processValue, pluginRoot, repoRootInject)
  plugin.apply(ctx)
  return { registered, definedTools, events, ctx }
}
