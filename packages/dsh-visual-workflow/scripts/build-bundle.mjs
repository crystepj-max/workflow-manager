#!/usr/bin/env node
// 把 src/ 的动态插件闭包体（return {name, inject?, apply}）编译为 bundle 安装产物：
//   dist/host-entry.mjs — ESM 入口（cordis.patch.yml 的 name 经包 main/exports 解析）
//   dist/client.js      — 自包含经典脚本（CJS：module.exports = 插件对象），供浏览器 /plugins/<id>/client.js 加载
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
  `const plugin = (() => {\n` +
  `const defineTool = __vwfDefineTool;\n` +
  `${hostBody}\n})();\n` +
  `export const name = plugin.name;\n` +
  (pluginHasInject(hostBody) ? `export const inject = plugin.inject;\n` : ``) +
  `export function apply(ctx) { return plugin.apply(ctx); }\n`
)

writeFileSync(
  join(dist, 'client.js'),
  `// 由 scripts/build-bundle.mjs 生成——勿手改；源：src/client.js\n` +
  `module.exports = (function () {\n` +
  `const React = require('react');\n` +
  `const host = { call(method, args) {\n` +
  `  return fetch('/dsh-visual-workflow/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: String(Math.random()).slice(2), method, payload: args || {} }) }).then(r => r.json()).then(f => f.result);\n` +
  `} };\n` +
  `const styles = { insert(css) { const el = document.createElement('style'); el.dataset.plugin = 'dsh-visual-workflow'; el.textContent = css; document.head.appendChild(el); } };\n` +
  clientBody + `\n})();\n`
)

function pluginHasInject(body) {
  // 粗判：闭包体顶层对象是否带 inject 键（形如 inject: ['x'] 或 "inject": [...]）
  return /^\s*inject\s*:/m.test(body)
}

writeFileSync(join(dist, '.src-stamp.json'), JSON.stringify(stamp, null, 2) + '\n')

console.log('built:', join(dist, 'host-entry.mjs'))
console.log('built:', join(dist, 'client.js'))
console.log('stamp:', stamp.host.slice(0, 12), stamp.client.slice(0, 12))
