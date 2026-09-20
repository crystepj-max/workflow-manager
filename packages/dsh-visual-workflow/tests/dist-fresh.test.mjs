// issue-33 / T2+T4：dist 与源码一致性 + dsh-tools 与宿主同源对齐
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const HOST = join(pkgRoot, 'src', 'host.js')
const CLIENT = join(pkgRoot, 'src', 'client.js')
const ROLE_LIBRARY = join(pkgRoot, '..', '..', 'scripts', 'role-library.cjs')
const PROJECTION_CORE = join(pkgRoot, '..', '..', 'scripts', 'projection-core.cjs')
const STATE_RECOVERY_CORE = join(pkgRoot, '..', '..', 'scripts', 'state-recovery-core.cjs')
const ROLE_MANIFEST = join(pkgRoot, '..', '..', 'dsh', 'roles', 'builtin-roles.json')
const STAMP = join(pkgRoot, 'dist', '.src-stamp.json')
const DIST_HOST = join(pkgRoot, 'dist', 'host-entry.mjs')
const PKG = join(pkgRoot, 'package.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

test('T2：dist/.src-stamp.json 与 src/host.js + src/client.js + 共享内核/清单哈希一致', () => {
  assert.ok(existsSync(STAMP), '缺少 dist/.src-stamp.json：请运行 npm run build')
  const stamp = JSON.parse(readFileSync(STAMP, 'utf8'))
  assert.equal(stamp.host, sha256(HOST), 'host.js 已变更但 dist 未重建')
  assert.equal(stamp.client, sha256(CLIENT), 'client.js 已变更但 dist 未重建')
  assert.equal(stamp.roleLibrary, sha256(ROLE_LIBRARY), 'scripts/role-library.cjs 已变更但 dist 未重建')
  assert.equal(stamp.projectionCore, sha256(PROJECTION_CORE), 'scripts/projection-core.cjs 已变更但 dist 未重建')
  assert.equal(stamp.stateRecoveryCore, sha256(STATE_RECOVERY_CORE), 'scripts/state-recovery-core.cjs 已变更但 dist 未重建')
  assert.equal(stamp.roleManifest, sha256(ROLE_MANIFEST), 'dsh/roles/builtin-roles.json 已变更但 dist 未重建')
})

test('T2：重建后的 dist 含双模式守卫，不再无条件调用 harness.handle', () => {
  assert.ok(existsSync(DIST_HOST), '缺少 dist/host-entry.mjs')
  const body = readFileSync(DIST_HOST, 'utf8')
  assert.match(body, /typeof harness !== 'undefined'/, 'bundle 必须保留 typeof harness 守卫')
  assert.match(body, /webServer/, 'bundle 必须含静态 webServer 路由')
  assert.match(body, /const isDynamicHost = typeof harness !== 'undefined'/, 'harness.handle 仅允许出现在 isDynamicHost 守卫之后')
})

test('T4：@deepseek-ai/dsh-tools file: 链接宿主工作区副本（进程内单一模块实例）', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const spec = pkg.dependencies['@deepseek-ai/dsh-tools']
  assert.match(
    spec,
    /^file:.+\/packages\/core\/tools$/,
    '插件 dsh-tools 必须 file: 链接到宿主源码工作区 packages/core/tools：宿主 v0.1.6 起调度器按模块 Symbol 键控，npm 双副本会 Symbol 错位导致工具执行崩溃',
  )
  const hostEntry = join(spec.slice('file:'.length), 'lib', 'index.js')
  assert.ok(existsSync(hostEntry), `宿主 dsh-tools 构建产物缺失：${hostEntry}（请在宿主仓库构建 lib）`)
  const resolved = createRequire(join(pkgRoot, 'dist', 'host-entry.mjs')).resolve('@deepseek-ai/dsh-tools')
  assert.equal(
    resolved,
    hostEntry,
    '插件 dist 解析到的 dsh-tools 必须与宿主加载的是同一文件（单一模块实例，Symbol 同源）',
  )
})
