#!/usr/bin/env node
// 把 src/ 的动态插件闭包体（return {name, inject?, apply}）编译为 bundle 安装产物：
//   dist/host-entry.mjs — ESM 入口（cordis.patch.yml 的 name 经包 main/exports 解析）
//   dist/client.js      — 自包含经典脚本（向 DSH ModuleLoader 注册 factory），供浏览器 /plugins/<id>/client.js 加载
//   dist/dynamic/*.js   — esbuild 压缩后的闭包体，供开发态 cordis_define 粘贴（不要粘 src/）
//   dist/locales / dist/roles — 语言资源与内置角色正文
//   dist/.src-stamp.json — 源码哈希戳，供 check-dist-fresh 校验「源码变更后必须重建」
// 单一事实源仍是 src/*.js；本脚本只做形态包装与压缩，不做逻辑转换。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

// 动态闭包必须保持 `return { name, inject?, apply }` 形态。包一层 IIFE 让 esbuild
// 能缩短局部标识符，再抽出压缩后的函数体。
function minifyCssInStylesInsert(src) {
  return src.replace(/styles\.insert\(`([\s\S]*?)`\)/, (_, css) => {
    const min = String(css)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>+~])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim()
    return 'styles.insert(`' + min + '`)'
  })
}
function minifyDynamicClosure(src) {
  const prepared = minifyCssInStylesInsert(src)
  const wrapped = 'export default (function () {\n' + prepared + '\n})();\n'
  const out = transformSync(wrapped, { minify: true, legalComments: 'none', target: 'es2020' }).code
  const m = out.match(/\(function\(\)\{([\s\S]*)\}\)\(\);?\s*(?:export\{[^}]*\}|export default|$)/)
    || out.match(/function\(\)\{([\s\S]*)\}\(\);?\s*(?:export\{[^}]*\}|export default|$)/)
  if (!m) throw new Error('esbuild 压缩结果无法抽出动态闭包体')
  const body = m[1].trim()
  if (!/^return\{/.test(body) && !/^return\s+\{/.test(body)) {
    throw new Error('压缩后闭包体不是 return {...}：' + body.slice(0, 60))
  }
  return body + '\n'
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

const hostPath = join(root, 'src', 'host.js')
const clientPath = join(root, 'src', 'client.js')
const formalArtifactsSrc = join(root, '..', '..', 'scripts', 'formal-artifacts.cjs')
const roleLibrarySrc = join(root, '..', '..', 'scripts', 'role-library.cjs')
const projectionCoreSrc = join(root, '..', '..', 'scripts', 'projection-core.cjs')
const roleManifestSrc = join(root, '..', '..', 'dsh', 'roles', 'builtin-roles.json')
const hostBody = readFileSync(hostPath, 'utf8')
const clientBody = readFileSync(clientPath, 'utf8')
const roleLibraryBody = readFileSync(roleLibrarySrc, 'utf8')
const projectionCoreBody = readFileSync(projectionCoreSrc, 'utf8')
const roleManifestBody = readFileSync(roleManifestSrc, 'utf8')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const stamp = {
  host: sha256(hostBody),
  client: sha256(clientBody),
  roleLibrary: sha256(roleLibraryBody),
  projectionCore: sha256(projectionCoreBody),
  roleManifest: sha256(roleManifestBody),
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
  `const __VWF_PLUGIN_ROOT__ = (() => { try { return dirname(dirname(fileURLToPath(import.meta.url))) } catch (e) { return null } })();\n` +
  `${hostBody}\n})();\n` +
  `export const name = plugin.name;\n` +
  // 静态组合包行级激活必须等 webServer 与 tools 就绪：无 inject 的行会在
  // 这些服务激活前 apply，导致 RPC 路由或工具注册永久错过。
  // #122: subprocess 必须加入 inject——否则 apply 时 ctx.get('subprocess') 返回 undefined，
  // 导致删除模板/子进程调用等操作失败（子进程服务不可用）。
  // 动态会话插件仍走 harness.handle，不受影响（src 闭包体本身不声明 inject）。
  `export const inject = ['webServer', 'tools', 'subprocess'];\n` +
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
copyFileSync(formalArtifactsSrc, join(dist, 'formal-artifacts.cjs'))
copyFileSync(join(root, '..', '..', 'scripts', 'validate-core.cjs'), join(dist, 'validate-core.cjs'))
copyFileSync(projectionCoreSrc, join(dist, 'projection-core.cjs'))
// 角色库内核 + 内置角色清单：静态安装的可信加载源（host.js 只从 pluginRoot/dist 加载）
copyFileSync(roleLibrarySrc, join(dist, 'role-library.cjs'))
copyFileSync(roleManifestSrc, join(dist, 'builtin-roles.json'))
const localesSrc = join(root, 'locales')
mkdirSync(join(dist, 'locales'), { recursive: true })
for (const name of readdirSync(localesSrc)) {
  if (name.endsWith('.json')) copyFileSync(join(localesSrc, name), join(dist, 'locales', name))
}
const rolesSrc = join(root, '..', '..', 'dsh', 'roles')
mkdirSync(join(dist, 'roles'), { recursive: true })
for (const name of readdirSync(rolesSrc)) {
  if (name.endsWith('.md')) copyFileSync(join(rolesSrc, name), join(dist, 'roles', name))
}

mkdirSync(join(dist, 'dynamic'), { recursive: true })
const dynHost = minifyDynamicClosure(hostBody)
const dynClient = minifyDynamicClosure(clientBody)
const HOST_LIMIT = 80 * 1024
const CLIENT_LIMIT = 80 * 1024
writeFileSync(join(dist, 'dynamic', 'host.js'), dynHost)
writeFileSync(join(dist, 'dynamic', 'client.js'), dynClient)
const hostBytes = Buffer.byteLength(dynHost)
const clientBytes = Buffer.byteLength(dynClient)
if (hostBytes > HOST_LIMIT || clientBytes > CLIENT_LIMIT) {
  console.error(`dynamic 体积超限：host ${hostBytes}/${HOST_LIMIT} client ${clientBytes}/${CLIENT_LIMIT}`)
  process.exit(1)
}

console.log('built:', join(dist, 'host-entry.mjs'))
console.log('built:', join(dist, 'client.js'))
console.log('built:', join(dist, 'projection-core.cjs'))
console.log('built:', join(dist, 'locales'))
console.log('built:', join(dist, 'dynamic/host.js'))
console.log('dynamic host:', hostBytes, 'client:', clientBytes)
console.log('stamp:', stamp.host.slice(0, 12), stamp.client.slice(0, 12))
