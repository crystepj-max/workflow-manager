#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginRoot = join(repoRoot, 'packages', 'dsh-visual-workflow')
const defaultDevHome = join(homedir(), '.dsh-workflow-dev')
const defaultProductHome = join(homedir(), '.dsh')
const devHome = resolve(process.env.VWF_DEV_DSH_HOME || defaultDevHome)
const configuredHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : null
const productHome = resolve(process.env.VWF_PRODUCT_DSH_HOME || defaultProductHome)
const dshBin = process.env.VWF_DEV_DSH_BIN || 'dsh'
const lsofBin = process.env.VWF_DEV_LSOF_BIN || (existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof')
const webProfile = join(devHome, 'profiles', 'web')
const profilePackage = join(webProfile, 'package.json')
const pidFile = join(devHome, '.vwf-dev-dsh.pid')

function comparisonPath(path) {
  return existsSync(path) ? realpathSync(path) : path
}

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

if (comparisonPath(devHome) === comparisonPath(productHome)) {
  fail(`开发 DSH Home 与产品 Home 相同：${devHome}`)
}
if (configuredHome && comparisonPath(configuredHome) !== comparisonPath(devHome)) {
  fail(
    `当前 DSH_HOME 指向 ${configuredHome}，不是开发 Home ${devHome}。` +
      '请取消该变量，或将其明确设为开发 Home 后重试。',
  )
}

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`无法读取 ${path}：${error.message}`)
  }
}

function hasFormalBundle(pkg) {
  if (!pkg) return false
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
  }
  return Object.entries(dependencies).some(
    ([name, source]) =>
      name === 'dsh-visual-workflow' ||
      String(source).includes('/dsh-visual-workflow'),
  )
}

function readPid() {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function isRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function inspect(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) return null
  return result.stdout
}

function processNames(pid) {
  const output = inspect(lsofBin, ['-nP', '-p', String(pid), '-Fn'])
  if (output === null) return null
  return output
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
}

function listeningProcesses() {
  const output = inspect(lsofBin, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  if (output === null) return null
  const processes = []
  let current = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      current = { pid: Number(line.slice(1)), command: '', names: [] }
      processes.push(current)
    } else if (current && line.startsWith('c')) {
      current.command = line.slice(1)
    } else if (current && line.startsWith('n')) {
      current.names.push(line.slice(1))
    }
  }
  return processes
}

function loopbackUrls(names) {
  return names.flatMap((name) => {
    const match = name.match(/^(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/)
    return match ? [`http://127.0.0.1:${match[1]}/`] : []
  })
}

function discoverDevDsh() {
  const candidates = listeningProcesses()
  if (candidates === null) return { available: false, matches: [] }
  const home = comparisonPath(devHome)
  const profileMarkers = [
    join(home, 'profiles', 'web', 'cordis.yml'),
    join(home, 'profiles', 'web', 'package.json'),
  ]
  const matches = []
  for (const candidate of candidates) {
    if (candidate.command !== 'node' || !isRunning(candidate.pid)) continue
    const names = processNames(candidate.pid)
    if (names === null) {
      return { available: false, matches: [] }
    }
    const belongsToHome = profileMarkers.every((marker) =>
      names.some((name) => name === marker || name.startsWith(`${marker} `)),
    )
    const urls = loopbackUrls(candidate.names)
    if (belongsToHome && urls.length > 0) {
      matches.push({ pid: candidate.pid, urls })
    }
  }
  return { available: true, matches }
}

function sourceVersion() {
  const host = readFileSync(join(pluginRoot, 'src', 'host.js'))
  const client = readFileSync(join(pluginRoot, 'src', 'client.js'))
  // 角色库深化后运行时行为还由内核与清单决定：改它们不改 host/client 时
  // 联合版本必须变化，否则动态注入后 cordis_inspect_self 核对会漏掉内核漂移
  const roleLibrary = readFileSync(join(repoRoot, 'scripts', 'role-library.cjs'))
  const roleManifest = readFileSync(join(repoRoot, 'dsh', 'roles', 'builtin-roles.json'))
  const hash = createHash('sha256')
    .update(host)
    .update('\0')
    .update(client)
    .update('\0')
    .update(roleLibrary)
    .update('\0')
    .update(roleManifest)
    .digest('hex')
    .slice(0, 12)
  return `vwf-dev-${hash}`
}

const profile = readJson(profilePackage)
const formalBundleInstalled = hasFormalBundle(profile)
const recordedPid = readPid()
const discovery = discoverDevDsh()
if (recordedPid && isRunning(recordedPid) && !discovery.available) {
  fail(`无法核验 PID ${recordedPid} 是否属于开发 DSH；已停止，避免复用错误进程。`)
}
if (discovery.matches.length > 1) {
  fail(
    `检测到多个使用开发 Home 的 DSH：${discovery.matches
      .map((item) => `${item.pid} (${item.urls.join(', ')})`)
      .join('、')}。请先人工确认，不会继续启动。`,
  )
}
const active = discovery.matches[0] || null
const pid = active?.pid || null
const running = Boolean(active)
const discovered = running && recordedPid !== pid
const version = sourceVersion()

console.log('VWF 开发模式（动态插件，不是发布证据）')
console.log(`- 开发 DSH Home：${devHome}`)
console.log(`- web Profile：${profile ? '已初始化' : '未初始化（首次 start 时由 DSH 默认模板创建）'}`)
console.log(`- 正式 VWF 组合包：${formalBundleInstalled ? '已安装（冲突）' : '未安装'}`)
console.log(
  `- 开发 DSH：${
    running ? `运行中（PID ${pid}，${active.urls.join(', ')}）` : '未运行'
  }`,
)
console.log(`- 当前联合版本：${version}（host + client + role-library + role-manifest）`)

if (formalBundleInstalled) {
  fail(
    `开发 web Profile 中检测到正式 dsh-visual-workflow 组合包。` +
      `请先通过公开命令清理开发 Profile；脚本不会自动修改 ${profilePackage}。`,
  )
}

function syncDevKernelAssets() {
  try {
    const kernelSrc = join(repoRoot, 'scripts', 'validate-core.cjs')
    const roleLibrarySrc = join(repoRoot, 'scripts', 'role-library.cjs')
    const roleManifestSrc = join(repoRoot, 'dsh', 'roles', 'builtin-roles.json')
    const assetDir = join(devHome, 'visual-workflow')
    mkdirSync(assetDir, { recursive: true })
    writeFileSync(join(assetDir, 'repo-root'), `${repoRoot}\n`)
    if (!existsSync(kernelSrc)) {
      fail(`缺少校验内核：${kernelSrc}`)
    }
    copyFileSync(kernelSrc, join(assetDir, 'validate-core.cjs'))
    // 角色库内核 + 内置清单（RoleLibrary 深化）：候选根成对加载需要 home 副本
    if (!existsSync(roleLibrarySrc)) {
      fail(`缺少角色库内核：${roleLibrarySrc}`)
    }
    if (!existsSync(roleManifestSrc)) {
      fail(`缺少内置角色清单：${roleManifestSrc}`)
    }
    copyFileSync(roleLibrarySrc, join(assetDir, 'role-library.cjs'))
    copyFileSync(roleManifestSrc, join(assetDir, 'builtin-roles.json'))
  } catch (e) {
    // sync 是可选便利（浏览器侧候选根兜底）；写 dev home 被沙箱/权限拒绝时
    // 不应让状态检查整体崩溃——插件运行时仍可从仓库根候选路径加载内核。
    console.warn(`⚠️ 内核资产同步到开发 Home 失败（不影响仓库根加载）：${String((e && e.message) || e)}`)
  }
}

syncDevKernelAssets()

function printSyncGuide() {
  console.log(`
下一步：
1. 启动或保持开发 DSH：npm run dev:plugin -- start
2. 在该 DSH 会话中进入 Cordis 动态插件开发能力。
3. 用 cordis_define 定义 ${version}；同一次定义的 code 必须同时包含：
   - host：packages/dsh-visual-workflow/src/host.js
   - client：packages/dsh-visual-workflow/src/client.js
4. 用 cordis_run 将这个完整 Package 作为一次更新激活；不得单独更新任一半。
5. 用 cordis_inspect_self 核对当前 Package/Run 为 ${version}，再查看界面或宿主行为。
6. 下次修改后重新运行 npm run dev:plugin，使用新的联合版本重复步骤 3–5。
7. 结束开发态时，用 DSH 会话公开的 cordis_stop，再用 cordis_undefine 清理动态 Package。

开发 DSH 重启后动态插件消失属于正常行为。不要在产品 DSH 中执行以上同步。`)
}

const command = process.argv[2] || 'status'
if (!['status', 'start'].includes(command)) {
  fail(`未知命令 ${command}；可用命令：status、start`)
}

if (command === 'status') {
  printSyncGuide()
  process.exit(0)
}

if (running) {
  if (discovered) {
    mkdirSync(devHome, { recursive: true })
    writeFileSync(pidFile, `${pid}\n`)
    console.log('✅ 已发现并登记现有开发 DSH，无需重复启动。')
  } else {
    console.log('✅ 开发 DSH 已在运行，无需重复启动。')
  }
  printSyncGuide()
  process.exit(0)
}

mkdirSync(devHome, { recursive: true })
const child = spawn(dshBin, ['web', '--port', '0'], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: devHome },
  stdio: 'inherit',
  detached: true,
})
if (!Number.isSafeInteger(child.pid)) {
  fail('开发 DSH 进程未能创建。')
}
try {
  writeFileSync(pidFile, `${child.pid}\n`)
} catch (error) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  fail(`无法记录开发 DSH PID：${error.message}；已终止本次启动。`)
}
console.log(`已使用隔离 Home 启动开发 DSH（DSH PID ${child.pid}）。`)

let shuttingDown = false
const forwardSignal = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}
const onSigint = () => forwardSignal('SIGINT')
const onSigterm = () => forwardSignal('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

const cleanup = () => {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
  if (readPid() === child.pid) rmSync(pidFile, { force: true })
}
child.once('error', (error) => {
  cleanup()
  fail(`开发 DSH 启动失败：${error.message}`)
})
child.once('exit', (code, signal) => {
  cleanup()
  if (signal) {
    console.error(`开发 DSH 被信号 ${signal} 终止。`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
