// 一次性 UI 原型：只读模板，所有交互留在浏览器内存中。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

if (process.env.NODE_ENV === 'production') {
  console.error('此入口只用于一次性设计原型，不允许在 production 启动。')
  process.exit(1)
}
const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../../../..')
const files = {
  '/': ['index.html', 'text/html'],
  '/settings/workflow-visual': ['index.html', 'text/html'],
  '/prototype.css': ['prototype.css', 'text/css'],
  '/prototype-v2.js': ['prototype-v2.js', 'text/javascript'],
  '/prototype-v2.css': ['prototype-v2.css', 'text/css'],
  '/prototype.js': ['prototype.js', 'text/javascript'],
}
const ids = ['wf-construction-full-feature', 'wf-diagnose', 'wf-explore', 'wf-optimize']
const catalog = await Promise.all(ids.map(async id => {
  const template = JSON.parse(await readFile(resolve(root, 'templates', id + '.json'), 'utf8'))
  return { id, name: template.displayName, nodes: template.nodes.map(n => ({ id: n.id, label: n.label, role: n.profile, goal: n.goal, kind:n.kind || 'worker', items:n.items, failOn:n.failOn })), edges: template.edges, control:template.control, bindings:template.bindings }
}))
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  res.setHeader('Cache-Control', 'no-store')
  if (url.pathname === '/prototype-data') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(catalog))
    return
  }
  const asset = files[url.pathname]
  if (!asset) { res.writeHead(404); res.end('Not found'); return }
  res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' })
  let body=await readFile(resolve(here, asset[0]))
  if(asset[0]==='index.html' && url.searchParams.get('version')==='1') body=Buffer.from(body.toString().replace('/prototype-v2.js','/prototype.js').replace('<link rel="stylesheet" href="/prototype-v2.css">',''))
  res.end(body)
})
let port = Number(process.env.VWF_PROTOTYPE_PORT || 4178)
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < 4198) { port += 1; server.listen(port, '127.0.0.1') }
  else { console.error(error.message); process.exit(1) }
})
server.listen(port, '127.0.0.1', () => {
  console.log(`一次性 UI 原型：http://127.0.0.1:${port}/settings/workflow-visual?variant=A&theme=light&view=library&surface=settings`)
  console.log('第二轮：编排台；深色 theme=dark；初版对照 version=1。所有操作仅在本页模拟。')
})
