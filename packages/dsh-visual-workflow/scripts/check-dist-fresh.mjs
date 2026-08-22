#!/usr/bin/env node
// 安装/开发闭环：dist 必须由当前 src 重新生成。
// 失败即阻断——避免 link 安装继续加载过期 host-entry.mjs（issue-33）。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const hostPath = join(root, 'src', 'host.js')
const clientPath = join(root, 'src', 'client.js')
const stampPath = join(root, 'dist', '.src-stamp.json')
const distHost = join(root, 'dist', 'host-entry.mjs')
const distClient = join(root, 'dist', 'client.js')

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const fail = (msg) => {
  console.error('❌ dist 与源码不一致：' + msg)
  console.error('   请在 packages/dsh-visual-workflow 运行：npm run build')
  process.exit(1)
}

if (!existsSync(distHost) || !existsSync(distClient) || !existsSync(stampPath)) {
  fail('缺少 dist/host-entry.mjs、dist/client.js 或 dist/.src-stamp.json')
}

let stamp
try {
  stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
} catch (e) {
  fail('dist/.src-stamp.json 无法解析')
}

const host = sha256(hostPath)
const client = sha256(clientPath)
if (stamp.host !== host || stamp.client !== client) {
  fail('源码哈希与 stamp 不符（host ' + host.slice(0, 12) + ' / client ' + client.slice(0, 12) + '）')
}

const body = readFileSync(distHost, 'utf8')
if (!body.includes("typeof harness !== 'undefined'") || !body.includes('webServer')) {
  fail('dist/host-entry.mjs 缺少双模式守卫（疑似旧产物）')
}

console.log('✅ dist 与 src 一致（builtAt ' + (stamp.builtAt || 'unknown') + '）')
