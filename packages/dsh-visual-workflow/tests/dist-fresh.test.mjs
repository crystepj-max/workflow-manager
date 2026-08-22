// issue-33 / T2+T4：dist 与源码一致性 + dsh-tools 与宿主版本对齐
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const HOST = join(pkgRoot, 'src', 'host.js')
const CLIENT = join(pkgRoot, 'src', 'client.js')
const STAMP = join(pkgRoot, 'dist', '.src-stamp.json')
const DIST_HOST = join(pkgRoot, 'dist', 'host-entry.mjs')
const PKG = join(pkgRoot, 'package.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

test('T2：dist/.src-stamp.json 与 src/host.js + src/client.js 哈希一致', () => {
  assert.ok(existsSync(STAMP), '缺少 dist/.src-stamp.json：请运行 npm run build')
  const stamp = JSON.parse(readFileSync(STAMP, 'utf8'))
  assert.equal(stamp.host, sha256(HOST), 'host.js 已变更但 dist 未重建')
  assert.equal(stamp.client, sha256(CLIENT), 'client.js 已变更但 dist 未重建')
})

test('T2：重建后的 dist 含双模式守卫，不再无条件调用 harness.handle', () => {
  assert.ok(existsSync(DIST_HOST), '缺少 dist/host-entry.mjs')
  const body = readFileSync(DIST_HOST, 'utf8')
  assert.match(body, /typeof harness !== 'undefined'/, 'bundle 必须保留 typeof harness 守卫')
  assert.match(body, /webServer/, 'bundle 必须含静态 webServer 路由')
  assert.match(body, /const isDynamicHost = typeof harness !== 'undefined'/, 'harness.handle 仅允许出现在 isDynamicHost 守卫之后')
})

test('T4：@deepseek-ai/dsh-tools 对齐最新宿主 DSH v0.1.1-rc.2', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  assert.equal(
    pkg.dependencies['@deepseek-ai/dsh-tools'],
    '0.1.1-rc.2',
    '插件 dsh-tools 必须与宿主 DSH v0.1.1-rc.2 对齐，消除 rc.7 混用',
  )
})
