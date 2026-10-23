// 只在真实文件 IO 边界暂停生产函数，供跨进程交错检查使用。
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { prepareNodeArtifacts, publishNodeArtifacts, failNodeArtifacts } from '../../node-artifacts.mjs'

const args = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const write = fs.writeFileSync
const rename = fs.renameSync
let paused = false
function pause() {
  if (paused) return
  paused = true
  write(args.reached, 'inside old transaction\n')
  const deadline = Date.now() + 10000
  while (!fs.existsSync(args.resume)) {
    if (Date.now() >= deadline) throw new Error('测试调度未释放旧事务')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}
if (args.pause === 'canonical') fs.writeFileSync = (file, ...rest) => {
  if (String(file) === args.canonical) pause()
  return write(file, ...rest)
}
if (args.pause === 'receipt' || args.replaceOwner) fs.renameSync = (source, target) => {
  if (String(target) === args.receipt && args.pause === 'receipt') pause()
  const result = rename(source, target)
  if (String(target) === args.receipt && args.replaceOwner) write(args.lock, JSON.stringify({ version: 1, pid: process.pid, token: 'foreign-owner', created_at: new Date().toISOString() }))
  return result
}
syncBuiltinESMExports()
if (args.started) write(args.started, 'host call started\n')
let result
try {
  let context = args.attempt.context
  if (args.mode === 'begin' || args.mode === 'begin-publish') context = prepareNodeArtifacts(args.workspace, context, args.attempt.bound, args.attempt.node).context
  if (args.mode === 'begin-publish') {
    for (const [path, bytes] of Object.entries(args.files || { 'research-one.md': args.bytes, 'STATE.md': args.bytes })) write(context.artifact_output_path + '/' + path, bytes)
  }
  if (args.mode === 'publish' || args.mode === 'begin-publish') publishNodeArtifacts(args.workspace, context, args.attempt.bound, args.attempt.node, args.report)
  if (args.mode === 'fail') failNodeArtifacts(args.workspace, context, args.attempt.bound, args.attempt.node, '旧调用失败')
  result = { ok: true, pid: process.pid }
} catch (error) {
  result = { ok: false, pid: process.pid, error: String(error.message), code: error.code || null }
} finally {
  fs.writeFileSync = write
  fs.renameSync = rename
  syncBuiltinESMExports()
}
write(args.result, JSON.stringify(result))
