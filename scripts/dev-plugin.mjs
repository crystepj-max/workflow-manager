#!/usr/bin/env node
// 开发 DSH 单实例管理（约定 §决策六：唯一实例 + 固定端口 + 任务命名隔离）。
//
// 与 #185 时代的区别：不再为每个 Run 分配独占 Home。开发 DSH 只有一个、端口固定；
// 任务之间靠「插件注册名带任务命名空间」+「同一时刻只允许一个任务激活插件」隔离。
//
// 命令：
//   status [--task <命名空间>]      查看固定地址、运行状态、当前激活任务与插件注册名
//   start  --task <命名空间>        确保开发 DSH 在固定端口上运行，并把本任务登记为当前激活任务
//                                  （若上一个任务仍激活 → 重启开发环境清空其动态插件并提示）
//   stop   --task <命名空间> [--unresolved <原因>]   登记本任务插件「已停用注销」（收口回收的前置）
//   stop   --all                   停止开发 DSH 进程
//
// 命名空间 = run_id（与分支 dev-<run_id>、工作树、产物目录同源，由 workspace-paths.mjs 出口）。
// 裸名（无命名空间前缀）在结构上被禁止：见 pluginNamespaceFor。

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DEV_DSH_PORT, pluginNamespaceFor, pluginNameFor,
  readActiveTask, writeActiveTask, releaseFor,
} from './workspace-paths.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginRoot = join(repoRoot, 'packages', 'dsh-visual-workflow')
const defaultDevHome = join(homedir(), '.dsh-workflow-dev')
const defaultProductHome = join(homedir(), '.dsh')
const devHome = resolve(process.env.VWF_DEV_DSH_HOME || defaultDevHome)
const configuredHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : null
const productHome = resolve(process.env.VWF_PRODUCT_DSH_HOME || defaultProductHome)
const dshBin = process.env.VWF_DEV_DSH_BIN || 'dsh'
const lsofBin = process.env.VWF_DEV_LSOF_BIN || (existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof')
const runsDir = resolve(process.env.VWF_RUNS_DIR || join(repoRoot, '.agent-runs'))
const webProfile = join(devHome, 'profiles', 'web')
const profilePackage = join(webProfile, 'package.json')
const pidFile = join(devHome, '.vwf-dev-dsh.pid')

/** 开发 DSH 固定端口（实例唯一 ⇒ 端口不漂移）。测试可用 VWF_DEV_DSH_PORT 改道。 */
function devPort() {
  const raw = process.env.VWF_DEV_DSH_PORT
  if (raw === undefined || raw === '') return DEV_DSH_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) fail(`非法 VWF_DEV_DSH_PORT: ${raw}`)
  return n
}

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

/**
 * 读取各 Run 登记的插件命名空间（决策六后 run.json.env_resources 的新语义）。
 * 只用于提示与唯一性推导，不改变任何默认；run.json 损坏不阻断开发状态检查。
 */
export function registeredTaskNamespaces(root = runsDir) {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runPath = join(root, entry.name, 'run.json')
    if (!existsSync(runPath)) continue
    try {
      const run = JSON.parse(readFileSync(runPath, 'utf8'))
      const ns = run?.env_resources?.plugin_namespace
      if (ns) out.push({ run_id: run.run_id || entry.name, plugin_namespace: ns })
    } catch {
      // 提示性扫描：忽略不可解析的 run.json
    }
  }
  return out
}

function readPid() {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** 登记「这个实例属于本开发 Home」——发现接管与 spawn 后都要写，收口停机依赖它。 */
function writePidFile(pid) {
  mkdirSync(devHome, { recursive: true })
  writeFileSync(pidFile, `${pid}\n`)
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

/** 占用指定端口的进程（支撑「端口被占用即报错，不自动改端口」）。 */
export function portOccupants(port, procs = listeningProcesses()) {
  if (procs === null) return null
  return procs
    .filter((p) => p.names.some((n) => n.endsWith(`:${port}`)))
    .map((p) => ({ pid: p.pid, command: p.command }))
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
  return `vwf-${hash}`
}

function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/**
 * 解析任务命名空间：显式 --task > VWF_TASK_NAMESPACE > .agent-runs 下唯一登记的 Run。
 * 三者都不可得时报错——**不接受裸名**（插件注册名必须带任务命名空间前缀）。
 */
export function resolveTaskNamespace({ explicit, env = {}, registered = [] } = {}) {
  const raw = explicit || env.VWF_TASK_NAMESPACE
  if (raw) return pluginNamespaceFor(raw)
  const unique = [...new Set(registered.map((r) => r.plugin_namespace))]
  if (unique.length === 1) return pluginNamespaceFor(unique[0])
  if (unique.length === 0) {
    throw new Error(
      '未提供任务命名空间，且 .agent-runs/ 下没有登记过任何 Run。' +
        '插件注册名禁止裸名：请显式传 --task <命名空间>（= run_id），或先执行 cwf-run-init.mjs。',
    )
  }
  throw new Error(
    `.agent-runs/ 下有多个 Run（${unique.join('、')}），无法推断当前任务。` +
      '请显式传 --task <命名空间>，避免插件注册名张冠李戴。',
  )
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
      .join('、')}。单实例布局下不应出现；请先人工确认，不会继续启动。`,
  )
}
const active = discovery.matches[0] || null
const pid = active?.pid || null
const running = Boolean(active)
const version = sourceVersion()
const port = devPort()
const activeTask = readActiveTask(devHome)

const command = process.argv[2] || 'status'
const argv = process.argv.slice(3)
const explicitNamespace = argValue(argv, '--task')
if (!['status', 'start', 'stop'].includes(command)) {
  fail(`未知命令 ${command}；可用命令：status、start、stop`)
}

function resolveNamespace({ optional = false } = {}) {
  try {
    return resolveTaskNamespace({
      explicit: explicitNamespace,
      env: process.env,
      registered: registeredTaskNamespaces(),
    })
  } catch (error) {
    if (optional) return null
    fail(error.message)
  }
}

function printSyncGuide(namespace, pluginName) {
  const ns = namespace ?? '<命名空间>'
  const name = pluginName ?? '<命名空间>-vwf-<哈希>'
  console.log(`
下一步：
1. 启动或保持开发 DSH：npm run dev:plugin -- start --task ${ns}
2. 在该 DSH 会话中进入 Cordis 动态插件开发能力。
3. 用 cordis_define 定义 ${name}；同一次定义的 code 必须同时包含压缩产物（不要粘 src/）：
   - host：packages/dsh-visual-workflow/dist/dynamic/host.js
   - client：packages/dsh-visual-workflow/dist/dynamic/client.js
4. 用 cordis_run 将这个完整 Package 作为一次更新激活；不得单独更新任一半。
5. 用 cordis_inspect_self 核对当前 Package 为 ${name}，再查看界面或宿主行为。
6. 下次修改后重新运行 npm run dev:plugin，使用新的联合版本重复步骤 3–5。
7. 结束开发态时：先 cordis_stop、再 cordis_undefine，然后
   npm run dev:plugin -- stop --task ${ns}    # 登记「已停用注销」，收口回收据此放行

纪律：同一时刻只允许一个任务激活插件；注册名必须带任务命名空间前缀（禁止裸名）。
开发 DSH 重启后动态插件消失属于正常行为。不要在产品 DSH 中执行以上同步。`)
}

/** 端口冲突判定：本实例已占用则复用；被别的进程占用则报错（不改端口）。 */
function resolvePortState() {
  const occupants = portOccupants(port)
  if (occupants === null) fail(`无法核验端口 ${port} 占用情况；已停止，避免误判。`)
  if (occupants.length > 0) {
    if (active && occupants.some((o) => o.pid === active.pid)) return { reuse: active }
    fail(
      `端口 ${port} 已被占用：${occupants
        .map((o) => `PID ${o.pid}（${o.command || '未知'}）`)
        .join('、')}。` +
        '固定端口是「地址可预测」的前提，脚本不会自动改用其他端口；请人工处置占用进程后重试。',
    )
  }
  // 端口空着但已存在开发 Home 的实例 → 它不在固定端口上（如本改造前启动的实例）。
  // 此时若继续启动就会出现第二个实例，直接破坏单实例与单激活纪律，故拒绝并给出处置命令。
  if (active) {
    fail(
        `检测到开发 DSH 未运行在固定端口 ${port}（PID ${active.pid} 监听 ${active.urls.join(', ')}）。` +
        `单实例布局要求开发 DSH 固定在 127.0.0.1:${port}；请先执行 ` +
        'npm run dev:plugin -- stop --all（或人工停掉该进程）后重试。',
    )
  }
  return { reuse: null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 停掉开发 DSH 并确认其真正退出。
 * 必须用**异步**轮询：同步忙等（Atomics.wait）会阻塞事件循环，导致子进程退出后无法被
 * 回收（僵尸态），`kill(pid,0)` 仍返回成功 → 误判为「未退出」。
 */
async function stopDevDsh({ signal = 'SIGTERM', waitMs = 5000 } = {}) {
  const target = readPid()
  if (!target || !isRunning(target)) {
    return { stopped: false, pid: target, reason: target ? 'pid 已不存活' : '无 pid 登记' }
  }
  try {
    process.kill(-target, signal)
  } catch {
    try { process.kill(target, signal) } catch { /* 已退出 */ }
  }
  const deadline = Date.now() + waitMs
  while (isRunning(target) && Date.now() < deadline) {
    await sleep(50)
  }
  const stopped = !isRunning(target)
  if (stopped && readPid() === target) rmSync(pidFile, { force: true })
  return { stopped, pid: target }
}

function spawnDevDsh() {
  mkdirSync(devHome, { recursive: true })
  const child = spawn(dshBin, ['web', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: devHome },
    stdio: 'inherit',
    detached: true,
  })
  if (!Number.isSafeInteger(child.pid)) {
    fail('开发 DSH 进程未能创建。')
  }
  try {
    writePidFile(child.pid)
  } catch (error) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    fail(`无法记录开发 DSH PID：${error.message}；已终止本次启动。`)
  }
  return child
}

/** 本进程启动了子进程时才挂载信号转发（沿用既有交互：start 会保持前台）。 */
function attachToChild(child) {
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
}

/** 重建开发态动态产物（内核只信插件 dist，不向开发 Home 复制）。status 也会重建，沿用既有行为。 */
function syncDevKernelAssets() {
  const build = join(pluginRoot, 'scripts', 'build-bundle.mjs')
  const result = spawnSync(process.execPath, [build], { cwd: pluginRoot, stdio: 'inherit' })
  if (result.status !== 0) fail('插件构建失败：请先修复 packages/dsh-visual-workflow 后重试')
}

// 正式组合包存在时不重建产物：沿用既有 fail-fast 语义（各命令自行报错并退出）
if (!formalBundleInstalled) syncDevKernelAssets()

// —— status ——
if (command === 'status') {
  const namespace = resolveNamespace({ optional: true })
  const pluginName = namespace ? pluginNameFor(namespace, version) : null
  const ledgerNs = activeTask.current?.namespace ?? null
  console.log('VWF 开发模式（单实例 · 动态插件，不是发布证据）')
  console.log(`- 开发 DSH Home：${devHome}`)
  console.log(`- 固定端口：${port}（唯一开发入口；不自动漂移）`)
  console.log(`- web Profile：${profile ? '已初始化' : '未初始化（首次 start 时由 DSH 默认模板创建）'}`)
  console.log(`- 正式 VWF 组合包：${formalBundleInstalled ? '已安装（冲突）' : '未安装'}`)
  console.log(`- 开发 DSH：${running ? `运行中（PID ${pid}，${active.urls.join(', ')}）` : '未运行'}`)
  console.log(`- 当前联合版本：${version}（host + client + role-library + role-manifest）`)
  console.log(`- 本任务命名空间：${namespace ?? '未指定（请传 --task，或让 .agent-runs/ 下只留一个 Run）'}`)
  if (pluginName) console.log(`- 本任务插件注册名：${pluginName}`)
  console.log(`- 登记表中当前激活的任务：${ledgerNs ?? '（无）'}`)
  if (namespace) {
    const release = releaseFor(activeTask, namespace)
    console.log(
      `- 本任务插件停用登记：${
        release
          ? release.unresolved
            ? `未完成（${release.unresolved}）`
            : `已登记停用注销（${release.released_at}）`
          : '未登记'
      }`,
    )
  }
  if (ledgerNs && namespace && ledgerNs !== namespace) {
    console.log(`  ⚠️ 登记表中激活的是 ${ledgerNs}；start --task ${namespace} 会重启开发环境以清空它的插件。`)
  }
  if (formalBundleInstalled) {
    fail(
      `开发 web Profile 中检测到正式 dsh-visual-workflow 组合包。` +
        `请先通过公开命令清理开发 Profile；脚本不会自动修改 ${profilePackage}。`,
    )
  }
  printSyncGuide(namespace, pluginName)
  process.exit(0)
}

// —— stop ——
if (command === 'stop') {
  if (argv.includes('--all')) {
    const result = await stopDevDsh()
    writeActiveTask(devHome, { current: null, releases: activeTask.releases })
    console.log(
      result.stopped
        ? `✅ 开发 DSH 已停止（PID ${result.pid}）；动态插件随进程退出全部清空。`
        : `ℹ️ 未停止：${result.reason}。`,
    )
    process.exit(0)
  }
  const namespace = resolveNamespace()
  const unresolved = argValue(argv, '--unresolved')
  const releases = activeTask.releases.filter((r) => r.namespace !== namespace)
  releases.push({
    namespace,
    plugin_name:
      activeTask.current?.namespace === namespace
        ? activeTask.current.plugin_name
        : pluginNameFor(namespace, version),
    released_at: new Date().toISOString(),
    unresolved: unresolved || null,
  })
  writeActiveTask(devHome, {
    current: activeTask.current?.namespace === namespace ? null : activeTask.current,
    releases,
  })
  console.log(
    unresolved
      ? `⚠️ 已登记 ${namespace} 的插件为「停用未完成」：${unresolved}\n   收口回收会把该原因如实写入遗留事项，不会认定为已回收。`
      : `✅ 已登记 ${namespace} 的插件为「已停用并注销」；收口回收将据此放行。`,
  )
  process.exit(0)
}

// —— start ——
const namespace = resolveNamespace()
const pluginName = pluginNameFor(namespace, version)
if (formalBundleInstalled) {
  fail(
    `开发 web Profile 中检测到正式 dsh-visual-workflow 组合包。` +
      `请先通过公开命令清理开发 Profile；脚本不会自动修改 ${profilePackage}。`,
  )
}

const portState = resolvePortState()
const currentNamespace = activeTask.current?.namespace ?? null
const switching = Boolean(currentNamespace) && currentNamespace !== namespace

function recordActivation(pidValue) {
  writeActiveTask(devHome, {
    current: {
      namespace,
      plugin_name: pluginName,
      pid: pidValue,
      port,
      activated_at: new Date().toISOString(),
    },
    releases: activeTask.releases.filter((r) => r.namespace !== namespace),
  })
}

if (portState.reuse) {
  // 端口上已是我们的开发实例
  if (switching) {
    // 单激活纪律的实现：DSH 重启会清空全部动态插件（官方行为），
    // 故「停掉上一个任务的插件」= 重启这唯一的开发实例。这是 shell 侧唯一可靠手段
    // ——动态包绑定定义它的会话，本脚本无权停用他人会话的包。
    const stopped = await stopDevDsh()
    if (!stopped.stopped) {
      fail(
        `无法停掉上一个任务（${currentNamespace}）的插件：开发 DSH（PID ${stopped.pid}）未能在超时内退出（${stopped.reason || '仍在运行'}）。` +
          '请人工处置后重试；不会在旧插件仍激活的情况下启动新任务。',
      )
    }
    const child = spawnDevDsh()
    recordActivation(child.pid)
    console.log(
      `✅ 已停掉上一个任务（${currentNamespace}）的插件，并切换到 ${namespace}。\n` +
        `   停用方式：重启开发环境（DSH 重启会清空全部动态插件）。\n` +
        `   现在 127.0.0.1:${port} 上没有任何插件在激活；请用 ${pluginName} 定义并激活本任务的包。`,
    )
    printSyncGuide(namespace, pluginName)
    attachToChild(child)
  } else {
    // 复用：原「PID 缺失时发现并接管同一开发 Home 的实例」语义——pidFile 是收口停机
    // 与单激活切换（stopDevDsh）的唯一寻址依据，缺了会导致 stop --all 失效。
    try {
      writePidFile(portState.reuse.pid)
    } catch (error) {
      fail(`无法登记开发 DSH PID：${error.message}；已停止，避免后续无法停机。`)
    }
    recordActivation(portState.reuse.pid)
    console.log(`✅ 开发 DSH 已在 127.0.0.1:${port} 运行（PID ${portState.reuse.pid}），无需重复启动。`)
    console.log(`   本任务（${namespace}）已登记为当前激活任务。`)
    printSyncGuide(namespace, pluginName)
    process.exit(0)
  }
} else {
  const child = spawnDevDsh()
  recordActivation(child.pid)
  console.log(`已启动开发 DSH（固定端口 ${port}，DSH PID ${child.pid}）。`)
  console.log(`本任务（${namespace}）已登记为当前激活任务；插件注册名请用 ${pluginName}。`)
  printSyncGuide(namespace, pluginName)
  attachToChild(child)
}
