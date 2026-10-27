// 仅用于 SDK 初始化回归的本地 JSON-RPC 夹具，不加载 DSH 或访问模型。
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = (entry) => appendFileSync(process.env.WFM_FIXTURE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
let initializeTimer

// 只模拟迟到的准备阶段，不模拟操作系统或归因磁盘 I/O；实际等待不使用父进程虚拟时钟。
if (process.env.WFM_FIXTURE_MODE === 'slow-boot-never') await new Promise((resolve) => setTimeout(resolve, 6000))
if (process.env.WFM_FIXTURE_MODE === 'never-boot') await new Promise((resolve) => setTimeout(resolve, 30000))

log({ event: 'boot', mode: process.env.WFM_FIXTURE_MODE, argv: process.argv.slice(2) })
process.on('exit', (code) => log({ event: 'exit', code }))
process.on('SIGTERM', () => {
  log({ event: 'signal', signal: 'SIGTERM' })
  process.exit(0)
})

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  log({ event: 'request', method: request.method, id: request.id })
  if (request.method === 'initialize') {
    if (process.env.WFM_FIXTURE_MODE === 'slow-boot-never') return
    const delay = process.env.WFM_FIXTURE_MODE === 'over-limit' ? 60001 : 11000
    initializeTimer = setTimeout(() => {
      log({ event: 'initialize-reply', delay })
      reply(request.id, { serverInfo: { name: 'synthetic-initialize-only', version: '1' } })
    }, delay)
  } else if (request.method === 'shutdown') {
    clearTimeout(initializeTimer)
    reply(request.id, {})
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'initialize/shutdown only; no sessions or prompts' } }) + '\n')
  }
})
lines.on('close', () => {
  clearTimeout(initializeTimer)
  log({ event: 'stdin-eof' })
  process.exit(0)
})
