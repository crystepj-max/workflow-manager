#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginRoot = join(repoRoot, 'packages', 'dsh-visual-workflow')
const defaultDevHome = join(homedir(), '.dsh-workflow-dev')
const defaultProductHome = join(homedir(), '.dsh')
const devHome = resolve(process.env.VWF_DEV_DSH_HOME || defaultDevHome)
const configuredHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : null
const productHome = resolve(process.env.VWF_PRODUCT_DSH_HOME || defaultProductHome)
const webProfile = join(devHome, 'profiles', 'web')
const profilePackage = join(webProfile, 'package.json')
const pidFile = join(devHome, '.vwf-dev-dsh.pid')

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

if (devHome === productHome) {
  fail(`开发 DSH Home 与产品 Home 相同：${devHome}`)
}
if (configuredHome && configuredHome !== devHome) {
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
  } catch {
    return false
  }
}

function sourceVersion() {
  const host = readFileSync(join(pluginRoot, 'src', 'host.js'))
  const client = readFileSync(join(pluginRoot, 'src', 'client.js'))
  const hash = createHash('sha256')
    .update(host)
    .update('\0')
    .update(client)
    .digest('hex')
    .slice(0, 12)
  return `vwf-dev-${hash}`
}

const profile = readJson(profilePackage)
const formalBundleInstalled = hasFormalBundle(profile)
const pid = readPid()
const running = isRunning(pid)
const version = sourceVersion()

console.log('VWF 开发模式（动态插件，不是发布证据）')
console.log(`- 开发 DSH Home：${devHome}`)
console.log(`- web Profile：${profile ? '已初始化' : '未初始化（首次 start 时由 DSH 默认模板创建）'}`)
console.log(`- 正式 VWF 组合包：${formalBundleInstalled ? '已安装（冲突）' : '未安装'}`)
console.log(`- 开发 DSH：${running ? `运行中（PID ${pid}）` : '未运行'}`)
console.log(`- 当前联合版本：${version}（host + client）`)

if (formalBundleInstalled) {
  fail(
    `开发 web Profile 中检测到正式 dsh-visual-workflow 组合包。` +
      `请先通过公开命令清理开发 Profile；脚本不会自动修改 ${profilePackage}。`,
  )
}

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
  console.log('✅ 开发 DSH 已在运行，无需重复启动。')
  printSyncGuide()
  process.exit(0)
}

mkdirSync(devHome, { recursive: true })
const child = spawn('dsh', ['web'], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: devHome },
  stdio: 'inherit',
})
if (!Number.isSafeInteger(child.pid)) {
  fail('开发 DSH 进程未能创建。')
}
writeFileSync(pidFile, `${child.pid}\n`)
console.log(`已使用隔离 Home 启动开发 DSH（PID ${child.pid}）。`)

const cleanup = () => {
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
