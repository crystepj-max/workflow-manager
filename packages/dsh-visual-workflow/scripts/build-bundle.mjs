#!/usr/bin/env node
// 把 src/ 的动态插件闭包体（return {name, inject?, apply}）编译为 bundle 安装产物：
//   dist/host-entry.mjs — ESM 入口（cordis.patch.yml 的 name 经包 main/exports 解析）
//   dist/client.js      — 自包含经典脚本（向 DSH ModuleLoader 注册 factory），供浏览器 /plugins/<id>/client.js 加载
//   dist/dynamic/*.js   — esbuild 压缩后的闭包体，供开发态 cordis_define 粘贴（不要粘 src/）
//   dist/locales / dist/roles — 语言资源与内置角色正文
//   dist/.src-stamp.json — 源码哈希戳：既供 check-dist-fresh 校验「源码变更后必须重建」，
//   也用于源码未变时跳过重建（#179）
// 单一事实源仍是 src/*.js；本脚本只做形态包装与压缩，不做逻辑转换。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
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
  // charset:'utf8'：默认 ascii 会把中文展开成 \uXXXX（每字 6 字节 vs UTF-8 3 字节），
  // 动态载荷白涨 ~7KB。产物全程以 UTF-8 文本读写（粘贴 / fs 读取 / vm 求值），无二次转码。
  const out = transformSync(wrapped, { minify: true, legalComments: 'none', target: 'es2020', charset: 'utf8' }).code
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
const selfPath = fileURLToPath(import.meta.url)
const force = process.argv.includes('--force')

const hostPath = join(root, 'src', 'host.js')
const clientPath = join(root, 'src', 'client.js')
const formalArtifactsSrc = join(root, '..', '..', 'scripts', 'formal-artifacts.cjs')
const attemptLedgerSrc = join(root, '..', '..', 'scripts', 'attempt-ledger.cjs')
const roleLibrarySrc = join(root, '..', '..', 'scripts', 'role-library.cjs')
const projectionCoreSrc = join(root, '..', '..', 'scripts', 'projection-core.cjs')
const validateCoreSrc = join(root, '..', '..', 'scripts', 'validate-core.cjs')
const roleManifestSrc = join(root, '..', '..', 'dsh', 'roles', 'builtin-roles.json')
const localesSrc = join(root, 'locales')
const rolesSrc = join(root, '..', '..', 'dsh', 'roles')

const hostBody = readFileSync(hostPath, 'utf8')
const clientBody = readFileSync(clientPath, 'utf8')
const roleLibraryBody = readFileSync(roleLibrarySrc, 'utf8')
const projectionCoreBody = readFileSync(projectionCoreSrc, 'utf8')
const roleManifestBody = readFileSync(roleManifestSrc, 'utf8')
const formalArtifactsBody = readFileSync(formalArtifactsSrc, 'utf8')
const attemptLedgerBody = readFileSync(attemptLedgerSrc, 'utf8')
const validateCoreBody = readFileSync(validateCoreSrc, 'utf8')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const listNames = (dir, ext) => readdirSync(dir).filter((n) => n.endsWith(ext)).sort()
// 目录级输入按「文件名 + 大小 + 修改时间」聚合：改名、增删文件、改内容都能被捕获。
// 这里刻意不读文件内容（#179）：本机实测逐个 readFileSync 这些小文件要 1.6 秒
// （每个 open 约 0.1 秒），而 statSync 几乎零成本；文件一旦被改写，mtime 必然变化。
// 万一遇到「内容改了但 mtime 未变」的极端情况，可用 --force 强制重建兜底。
const dirStamp = (dir, ext) =>
  sha256(
    listNames(dir, ext)
      .map((n) => {
        const st = statSync(join(dir, n))
        return `${n}:${st.size}:${st.mtimeMs}`
      })
      .join('|'),
  )
const stamp = {
  host: sha256(hostBody),
  client: sha256(clientBody),
  roleLibrary: sha256(roleLibraryBody),
  projectionCore: sha256(projectionCoreBody),
  roleManifest: sha256(roleManifestBody),
  formalArtifacts: sha256(formalArtifactsBody),
  attemptLedger: sha256(attemptLedgerBody),
  validateCore: sha256(validateCoreBody),
  locales: dirStamp(localesSrc, '.json'),
  roles: dirStamp(rolesSrc, '.md'),
  // 打包脚本自身也计入：改了包装/压缩逻辑后产物必须重建
  builder: sha256(readFileSync(selfPath, 'utf8')),
  builtAt: new Date().toISOString(),
}

// 源码未变则跳过重建（#179）：发布/校验与开发启动器都会调用本脚本，
// 无条件重建会让 dev:plugin 每次多花约 1.5s。判据是「全部产物齐全 + 源码戳逐项一致」；
// builtAt 不参与比较，否则永远不可能命中。
const requiredArtifacts = [
  join(dist, 'host-entry.mjs'),
  join(dist, 'client.js'),
  join(dist, 'formal-artifacts.cjs'),
  join(dist, 'attempt-ledger.cjs'),
  join(dist, 'validate-core.cjs'),
  join(dist, 'projection-core.cjs'),
  join(dist, 'role-library.cjs'),
  join(dist, 'builtin-roles.json'),
  join(dist, 'dynamic', 'host.js'),
  join(dist, 'dynamic', 'client.js'),
  ...listNames(localesSrc, '.json').map((n) => join(dist, 'locales', n)),
  ...listNames(rolesSrc, '.md').map((n) => join(dist, 'roles', n)),
]

function distUpToDate() {
  const stampPath = join(dist, '.src-stamp.json')
  if (!existsSync(stampPath)) return false
  if (!requiredArtifacts.every(existsSync)) return false
  let prev = null
  try {
    prev = JSON.parse(readFileSync(stampPath, 'utf8'))
  } catch (e) {
    return false
  }
  for (const [key, value] of Object.entries(stamp)) {
    if (key === 'builtAt') continue
    if (prev[key] !== value) return false
  }
  return true
}

if (!force && distUpToDate()) {
  console.log('up-to-date: 源码未变，跳过构建（强制重建：node scripts/build-bundle.mjs --force）')
  process.exit(0)
}

mkdirSync(dist, { recursive: true })

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
// LOC-029 逐次 attempt 提交内核：段收尾固定顺序推进的宿主侧编排（不占 dynamic 载荷预算）
copyFileSync(attemptLedgerSrc, join(dist, 'attempt-ledger.cjs'))
// 校验内核与其引用的投影内核必须同时随 dist 分发：validate-core 声明
// require('./projection-core.cjs')，宿主加载器求值前按源码预解析同目录引用。
copyFileSync(validateCoreSrc, join(dist, 'validate-core.cjs'))
copyFileSync(projectionCoreSrc, join(dist, 'projection-core.cjs'))
// 角色库内核 + 内置角色清单：静态安装的可信加载源（host.js 只从 pluginRoot/dist 加载）
copyFileSync(roleLibrarySrc, join(dist, 'role-library.cjs'))
copyFileSync(roleManifestSrc, join(dist, 'builtin-roles.json'))
mkdirSync(join(dist, 'locales'), { recursive: true })
for (const name of listNames(localesSrc, '.json')) {
  copyFileSync(join(localesSrc, name), join(dist, 'locales', name))
}
mkdirSync(join(dist, 'roles'), { recursive: true })
for (const name of listNames(rolesSrc, '.md')) {
  copyFileSync(join(rolesSrc, name), join(dist, 'roles', name))
}

mkdirSync(join(dist, 'dynamic'), { recursive: true })
// 动态产物头部注入（backlog dev-plugin-sync-gap 方案 A）：cordis 动态沙箱不注入
// __VWF_PLUGIN_ROOT__/__VWF_REPO_ROOT__，也不提供 Buffer（dist/validate-core.cjs 的
// 输入尺寸检查会调用 Buffer.byteLength）——静态 bundle 靠构建期常量与 Node 全局，
// 动态闭包体必须自带。常量指向宿主构建时的真实路径（开发 DSH 单机部署场景成立），
// Buffer 用沙箱已有的 TextEncoder 实现最小垫片（host.js 只用 byteLength 等静态方法）。
const DYN_HOST_PRELUDE = [
  `const __VWF_PLUGIN_ROOT__ = ${JSON.stringify(root)};`,
  `const __VWF_REPO_ROOT__ = ${JSON.stringify(dirname(dirname(root)))};`,
  'if (typeof globalThis.Buffer === "undefined") { const enc = new TextEncoder(); globalThis.Buffer = { from(s, e) { if (e === "base64" && typeof atob === "function") { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; } return enc.encode(String(s)); }, byteLength(s) { return enc.encode(String(s)).length; }, isBuffer() { return false; }, alloc(n) { return new Uint8Array(n); }, concat(list) { const out = []; for (const a of list) out.push(...a); return new Uint8Array(out); } }; }',
  // cordis 动态沙箱同样没有 structuredClone（续跑路径 host.js 会对快照 provider_model
  // 做深拷贝）；被拷贝对象均为 JSON 安全结构，用 JSON 往返兜底即可。产品 Node 运行时
  // 有原生实现，此垫片不会生效（UAT-loc017 真机实证：HD/entry 续跑在沙箱内报
  // structuredClone is not defined，与 LOC-015 交付中的沙箱守卫同一问题域）。
  'if (typeof globalThis.structuredClone === "undefined") { globalThis.structuredClone = function structuredClone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }; }',
].join('\n') + '\n'
const dynHost = DYN_HOST_PRELUDE + minifyDynamicClosure(hostBody)
const dynClient = minifyDynamicClosure(clientBody)
writeFileSync(join(dist, 'dynamic', 'host.js'), dynHost)
writeFileSync(join(dist, 'dynamic', 'client.js'), dynClient)
const hostBytes = Buffer.byteLength(dynHost)
const clientBytes = Buffer.byteLength(dynClient)
// 载荷预算属于「一次 cordis_define 的粘贴总量」（host + client 同时携带），
// 而不是每半各自的 80KiB：两半天然失衡（client 远大于 host），固定每半上限会在
// 总量仍有余量时先撞线（#74 UAT-02 结果条：client 84KB + host 62KB = 146KB，
// 低于合计预算却被拒）。#80-r2 + LOC-001 V2 合并后实测合计 168.5KB，由 160KiB
// 上调至 176KiB（实证 ~184KB 一次转写可行；超限后应优先瘦身，不要继续推高）。
// LOC-017 集成闸门宿主编排并入后上调至 184KiB（决策 1：载体=产品运行时宿主编排，
// 宿主半不可省；client 瘦身仍应优先于继续推高）。
// LOC-014 模型覆盖层（host 合成单点 + RPC 三端点 + 模板库最小覆盖对话框）并入后上调至 188KiB，
// 与 tests/static-bundle.test.mjs 预算保持一致。UAT 反馈轮（未保存退出/清除确认弹窗 + 沿用默认带值）后上调至 189KiB。
// LOC-021 异源档位三态（校验内核档位判定 + 运行时日志档位/角色口径 + 编辑器三档选择器与中英文案）并入后上调至 190KiB。
const PAYLOAD_LIMIT = 190 * 1024
if (hostBytes + clientBytes > PAYLOAD_LIMIT) {
  console.error(`dynamic 载荷超限：host ${hostBytes} + client ${clientBytes} = ${hostBytes + clientBytes}/${PAYLOAD_LIMIT}`)
  process.exit(1)
}

console.log('built:', join(dist, 'host-entry.mjs'))
console.log('built:', join(dist, 'client.js'))
console.log('built:', join(dist, 'projection-core.cjs'))
console.log('built:', join(dist, 'locales'))
console.log('built:', join(dist, 'dynamic/host.js'))
console.log('dynamic host:', hostBytes, 'client:', clientBytes)
console.log('stamp:', stamp.host.slice(0, 12), stamp.client.slice(0, 12))
