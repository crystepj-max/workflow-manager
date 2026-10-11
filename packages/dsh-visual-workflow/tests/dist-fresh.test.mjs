// issue-33 / T2+T4：dist 与源码一致性 + dsh-tools 与宿主同源对齐
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const REPO_ROOT = join(pkgRoot, '..', '..')

const resolveDshTools = () => createRequire(DIST_HOST).resolve('@deepseek-ai/dsh-tools')

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

test('T4：dsh-tools 依赖声明可移植，且与宿主同源（调度器符号未错位）', async () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const spec = pkg.dependencies['@deepseek-ai/dsh-tools']
  const sdkClientSpec = pkg.dependencies['@deepseek-ai/dsh-sdk-client']

  // 事故护栏（2026-09-20）：受管依赖写本机路径 → 换机 / CI 上安装成悬空链接。
  // 本机同源属开发环境步骤（node_modules 软链 / npm link），不写进仓库文件。
  assert.doesNotMatch(
    spec,
    /^file:(\/|~)|^[A-Za-z]:[\\/]/,
    '依赖声明不得含本机绝对路径或家目录：本机同源走开发环境软链，不要写进受管 package.json',
  )

  if (spec.startsWith('file:')) {
    // 仓库内相对链接：目标须真实存在，且解析结果与所链接文件一致
    const linked = join(pkgRoot, spec.slice('file:'.length), 'lib', 'index.js')
    assert.ok(existsSync(linked), `file: 链接目标缺少构建产物：${linked}`)
    assert.equal(resolveDshTools(), linked, 'file: 声明必须解析到所链接的文件')
    return
  }

  // 发布态：SDK client / dsh-tools 与宿主发行版使用同一精确版本线。
  assert.equal(sdkClientSpec, '0.2.0-rc.2', 'SDK client 必须与当前宿主 DSH 版本精确对齐')
  assert.equal(spec, sdkClientSpec, '插件 dsh-tools 必须与 SDK client / 宿主发行版对齐')

  const npmLock = JSON.parse(readFileSync(join(pkgRoot, 'package-lock.json'), 'utf8'))
  assert.equal(npmLock.packages[''].dependencies['@deepseek-ai/dsh-sdk-client'], sdkClientSpec, 'npm lock 根依赖须与 manifest 对齐')
  assert.equal(npmLock.packages[''].dependencies['@deepseek-ai/dsh-tools'], spec, 'npm lock 根依赖须与 manifest 对齐')
  assert.equal(npmLock.packages['node_modules/@deepseek-ai/dsh-sdk-client'].version, sdkClientSpec, 'npm lock SDK 解析版本须与 manifest 对齐')
  assert.equal(npmLock.packages['node_modules/@deepseek-ai/dsh-tools'].version, spec, 'npm lock dsh-tools 解析版本须与 manifest 对齐')

  const pnpmLock = readFileSync(join(pkgRoot, 'pnpm-lock.yaml'), 'utf8')
  const importer = pnpmLock.match(/importers:\n\n  \.:[\s\S]*?\n\npackages:/)?.[0] || ''
  assert.match(importer, /'@deepseek-ai\/dsh-sdk-client':\n\s+specifier: 0\.2\.0-rc\.2\n\s+version: 0\.2\.0-rc\.2\(/, 'pnpm lock SDK importer 须与 manifest 对齐')
  assert.match(importer, /'@deepseek-ai\/dsh-tools':\n\s+specifier: 0\.2\.0-rc\.2\n\s+version: 0\.2\.0-rc\.2\(/, 'pnpm lock dsh-tools importer 须与 manifest 对齐')

  // 本机若已软链到宿主工作区副本（开发态），必须与宿主同一符号来源：宿主 v0.1.6 起用
  // Symbol.for 全局注册，旧副本用 Symbol() 实例级 → 查找落空、工具执行报
  // `Cannot read properties of undefined (reading 'prepare')`。
  // 解析落在仓库内（CI 路径）时跳过本段，避免制造假红。
  const resolved = resolveDshTools()
  if (resolved.startsWith(REPO_ROOT)) return
  const host = await import(pathToFileURL(resolved).href)
  assert.equal(
    host.TOOL_RUNTIME_SCHEDULER,
    Symbol.for('@deepseek-ai/dsh-tools.scheduler'),
    '宿主 dsh-tools 必须用 Symbol.for 注册调度器符号，否则与插件携带的副本不同源',
  )
})
