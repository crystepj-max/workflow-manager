import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { prototypeDir, packageRoot, loadSeed, syncStatus, validateDraft } from './seed.data.mjs'

if (process.env.NODE_ENV === 'production') {
  console.error('拒绝在 production 下启动原型。')
  process.exit(1)
}
const oldDir = path.resolve(prototypeDir, '../ui-workbench')
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' }
const staticFiles = new Set(['/index.html', '/app.js', '/app.css', '/shell.css', '/reference/host-base.css', '/reference/host-theme.css'])
const oldFiles = new Set(['/prototype.css', '/prototype-v2.css', '/prototype-v2.js', '/prototype.js'])
const respond = (res, status, type, body) => {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
  })
  res.end(body)
}
async function bundle(source) {
  const file = source === 'current' ? path.join(packageRoot, 'src/client.js') : path.join(prototypeDir, 'client.prototype.js')
  const code = await readFile(file, 'utf8')
  const entry = "import * as React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {mountPreview} from './runtime.js';\nfunction clientFactory(React, host, styles) {\n" + code + "\n}\nmountPreview(React,createRoot,clientFactory);\n"
  const result = await build({ stdin: { contents: entry, resolveDir: prototypeDir, sourcefile: source + '-client-entry.js' }, bundle: true, write: false, format: 'esm', target: 'es2020', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
  return result.outputFiles[0].contents
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/api/validate') {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return respond(res, 403, 'text/plain', 'Origin not allowed')
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 2 * 1024 * 1024) return respond(res, 413, 'text/plain', 'Draft too large')
      }
      return respond(res, 200, mime['.json'], JSON.stringify(validateDraft(JSON.parse(body).dsl)))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, 'text/plain', 'Read-only preview')
    if (url.pathname === '/api/seed') return respond(res, 200, mime['.json'], JSON.stringify(await loadSeed()))
    if (url.pathname === '/api/sync-status') return respond(res, 200, mime['.json'], JSON.stringify(await syncStatus()))
    if (url.pathname === '/ui-bundle.js') return respond(res, 200, mime['.js'], await bundle(url.searchParams.get('source')))
    if (url.pathname === '/reference') {
      url.searchParams.set('source', 'current')
      res.writeHead(302, { location: '/?' + url.searchParams }); res.end(); return
    }
    if (url.pathname === '/frame') {
      const html = await readFile(path.join(prototypeDir, 'frame.html'), 'utf8')
      return respond(res, 200, mime['.html'], html.replace('__BUNDLE_SOURCE__', '/ui-bundle.js?source=' + (url.searchParams.get('source') === 'current' ? 'current' : 'preview')))
    }
    if (url.pathname === '/prototype-data') {
      const seed = await loadSeed()
      const rows = seed.workflows.filter((w) => w.builtin).map((w) => ({
        id: w.id, name: w.name, nodes: w.dsl.nodes.map((n) => ({ ...n, role: n.profile, kind: n.kind || 'worker' })),
        edges: w.dsl.edges, control: w.dsl.control, bindings: { models: Object.fromEntries(w.dsl.nodes.filter((n) => n.model).map((n) => [n.id, n.model])) },
      }))
      return respond(res, 200, mime['.json'], JSON.stringify(rows))
    }
    if (url.pathname === '/previous' || oldFiles.has(url.pathname)) {
      const file = url.pathname === '/previous' ? 'index.html' : url.pathname.slice(1)
      return respond(res, 200, mime[path.extname(file)], await readFile(path.join(oldDir, file)))
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    if (staticFiles.has(pathname) || /^\/evidence\/[a-z0-9-]+\.png$/.test(pathname)) {
      return respond(res, 200, mime[path.extname(pathname)], await readFile(path.join(prototypeDir, pathname.slice(1))))
    }
    return respond(res, 404, 'text/plain; charset=utf-8', 'Not found')
  } catch (error) {
    console.error(error.message)
    return respond(res, error.code === 'ENOENT' ? 404 : 500, 'text/plain; charset=utf-8', error.message)
  }
})
const index = process.argv.indexOf('--port')
const port = Number(index >= 0 ? process.argv[index + 1] : process.env.VWF_PROTOTYPE_PORT || 4179)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效端口')
server.listen(port, '127.0.0.1', () => {
  console.log('工作流主界面原型：http://127.0.0.1:' + port + '/?theme=light')
  console.log('当前正式源码对照：/?source=current；旧原型：/?source=previous。所有写入只在内存。')
})
