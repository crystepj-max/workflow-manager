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
