#!/usr/bin/env node
// 把 src/ 的动态插件闭包体（return {name, inject?, apply}）编译为 bundle 安装产物：
//   dist/host-entry.mjs — ESM 入口（cordis.patch.yml 的 name 经包 main/exports 解析）
//   dist/client.js      — 自包含经典脚本（向 DSH ModuleLoader 注册 factory），供浏览器 /plugins/<id>/client.js 加载
//   dist/.src-stamp.json — 源码哈希戳，供 check-dist-fresh 校验「源码变更后必须重建」
// 单一事实源仍是 src/*.js；本脚本只做形态包装，不做逻辑转换。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

const hostPath = join(root, 'src', 'host.js')
const clientPath = join(root, 'src', 'client.js')
const hostBody = readFileSync(hostPath, 'utf8')
const clientBody = readFileSync(clientPath, 'utf8')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const stamp = {
  host: sha256(hostBody),
  client: sha256(clientBody),
  builtAt: new Date().toISOString(),
}

writeFileSync(
  join(dist, 'host-entry.mjs'),
  `// 由 scripts/build-bundle.mjs 生成——勿手改；源：src/host.js\n` +
  `import { defineTool as __vwfDefineTool } from '@deepseek-ai/dsh-tools';\n` +
  `import { fileURLToPath } from 'node:url';\n` +
  `import { dirname } from 'node:path';\n` +
  `const plugin = (() => {\n` +
  `const defineTool = __vwfDefineTool;\n` +
  `// 运行时从 bundle 自身位置推导仓库根（import.meta.url），不硬编码构建期路径：\n` +
  `// bundle 位于 <repo>/packages/dsh-visual-workflow/dist/host-entry.mjs，向上 4 层即仓库根。\n` +
  `// 动态模式（cordis_define）无此常量，宿主代码 typeof 检查自动回落到 repoRoot()。\n` +
  `const __VWF_REPO_ROOT__ = (() => { try { return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))) } catch (e) { return null } })();\n` +
  `${hostBody}\n})();\n` +
  `export const name = plugin.name;\n` +
  // 静态组合包行级激活必须等 webServer 与 tools 就绪：无 inject 的行会在
  // 这些服务激活前 apply，导致 RPC 路由或工具注册永久错过。
  // 动态会话插件仍走 harness.handle，不受影响（src 闭包体本身不声明 inject）。
  `export const inject = ['webServer', 'tools'];\n` +
  `export function apply(ctx) { return plugin.apply(ctx); }\n`
)

writeFileSync(
  join(dist, 'client.js'),
  `// 由 scripts/build-bundle.mjs 生成——勿手改；源：src/client.js\n` +
  `window.__ModuleLoader__.load({ id: 'dsh-visual-workflow', factory: (require) => {\n` +
  `  var module = { exports: {} };\n` +
  `  var exports = module.exports;\n` +
  `  const React = require('react');\n` +
  `  const host = { call(method, args) {\n` +
  `    return fetch('/dsh-visual-workflow/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: String(Math.random()).slice(2), method, payload: args || {} }) }).then(r => r.json()).then(f => f.result);\n` +
  `  } };\n` +
  `  const styles = { insert(css) { const el = document.createElement('style'); el.dataset.plugin = 'dsh-visual-workflow'; el.textContent = css; document.head.appendChild(el); } };\n` +
  `  module.exports = (function () {\n` +
  clientBody + `\n  })();\n` +
  `  return module.exports;\n` +
  `} });\n`
)

writeFileSync(join(dist, '.src-stamp.json'), JSON.stringify(stamp, null, 2) + '\n')
console.log('built:', join(dist, 'host-entry.mjs'))
console.log('built:', join(dist, 'client.js'))
console.log('stamp:', stamp.host.slice(0, 12), stamp.client.slice(0, 12))
