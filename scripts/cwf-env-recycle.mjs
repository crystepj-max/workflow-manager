#!/usr/bin/env node
// 任务环境回收（#185 切片 2）：只处理本 Run 登记的独占开发 DSH Home；GC 兜底扫描残留。
// 用法：
//   node scripts/cwf-env-recycle.mjs recycle <runDir> [--stop] [--report <cleanup-report.md>]
//       —— 读 run.json.env_resources.dev_dsh_home，核对 Home 内 marker 归属（run.json 与 marker 双证一致才动）；
//          --stop 先按 Home 内 .vwf-dev-dsh.pid 终止本 Run 的开发 DSH；仍有进程占用则拒绝删除。
//          结果 JSON 输出到 stdout，--report 时追加「环境回收」小节。exit 0 = 已回收 / 无登记 / 已回收过；exit 1 = 拒绝或未完成
//   node scripts/cwf-env-recycle.mjs gc [--root <tasksRoot>] [--max-age-days <n>] [--force]
//       —— 扫描 tasksRoot 下所有 Home：凭 marker 识别归属，默认只列清单（dry-run）；
//          --force 才删除「已过期且无占用且有 marker」的项；无 marker 的项永远只列出并标注请人工确认

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEV_DSH_HOME_MARKER, devDshTasksRoot } from './cwf-run-init.mjs'

export const DEFAULT_MAX_AGE_DAYS = 14
const PID_FILE = '.vwf-dev-dsh.pid'
const DAY_MS = 24 * 60 * 60 * 1000

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export function readMarker(home) {
  const markerPath = join(home, DEV_DSH_HOME_MARKER)
  if (!existsSync(markerPath)) return null
  try {
    return readJson(markerPath)
  } catch {
    return { corrupt: true }
  }
}

export function recordedPid(home) {
  const p = join(home, PID_FILE)
  if (!existsSync(p)) return null
  const pid = Number(readFileSync(p, 'utf-8').trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function lsofBin() {
  return process.env.VWF_DEV_LSOF_BIN || (existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof')
}

export function defaultOccupancy(home) {
  // 占用判定：(a) dev-plugin 登记的 PID 仍存活；(b) 监听中的 node 进程打开了 Home 内文件（与 dev-plugin 发现口径一致）
  const pids = new Set()
  const pid = recordedPid(home)
  if (pid && isAlive(pid)) pids.add(pid)
  const listing = spawnSync(lsofBin(), ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  if (!listing.error && listing.status === 0) {
    let current = null
    for (const line of listing.stdout.split('\n')) {
      if (line.startsWith('p')) current = { pid: Number(line.slice(1)), command: '' }
      else if (current && line.startsWith('c')) {
        current.command = line.slice(1)
        if (current.command === 'node' && isAlive(current.pid)) {
          const files = spawnSync(lsofBin(), ['-nP', '-p', String(current.pid), '-Fn'], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
          if (!files.error && files.status === 0 && files.stdout.split('\n').some((l) => l.startsWith('n') && l.slice(1).startsWith(`${home}/`))) {
            pids.add(current.pid)
          }
        }
      }
    }
  }
  return [...pids]
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function stopRecordedDsh(home, { signal = 'SIGTERM', waitMs = 5000, sleep = sleepSync } = {}) {
  // 只终止本 Home 登记的开发 DSH（dev-plugin 以 detached 进程组启动，先杀组再退化为单进程）
  const pid = recordedPid(home)
  if (!pid || !isAlive(pid)) return { stopped: false, pid, reason: pid ? 'pid 已不存活' : '无 pid 登记' }
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* 已退出 */ }
  }
  const deadline = Date.now() + waitMs
  while (isAlive(pid) && Date.now() < deadline) sleep(50)
  return { stopped: !isAlive(pid), pid }
}

/**
 * 定向回收：纯逻辑，可注入 occupancy / remove / now 供测试。
 */
export function recycleRunHome(run, { occupancy = defaultOccupancy, remove = (p) => rmSync(p, { recursive: true, force: true }), now = () => new Date(), stop = false } = {}) {
  const res = run.env_resources?.dev_dsh_home
  if (!res?.path) {
    return { ok: true, status: 'nothing_registered', message: 'run.json 未登记独占开发 Home（早于 #185 的 Run 或未分配），无需回收' }
  }
  const home = resolve(res.path)
  if (res.recycled_at) {
    return { ok: true, status: 'already_recycled', home, recycled_at: res.recycled_at }
  }
  if (!existsSync(home)) {
    return { ok: true, status: 'missing', home, message: 'Home 目录已不存在（可能已被人工清理）；按已回收登记' }
  }
  const marker = readMarker(home)
  if (!marker) {
    return { ok: false, status: 'refused', home, reason: 'Home 内无归属 marker，无法证明属于本 Run：拒绝删除，请人工确认' }
  }
  if (marker.corrupt) {
    return { ok: false, status: 'refused', home, reason: 'Home 内 marker 损坏：拒绝删除，请人工确认' }
  }
  if (marker.run_id !== run.run_id) {
    return { ok: false, status: 'refused', home, reason: `Home marker 归属 ${marker.run_id} ≠ 本 Run ${run.run_id}：拒绝删除他人现场` }
  }
  let stopResult = null
  if (stop) stopResult = stopRecordedDsh(home)
  const occupants = occupancy(home)
  if (occupants.length > 0) {
    return { ok: false, status: 'occupied', home, occupants, stop: stopResult, reason: `仍有进程占用（PID ${occupants.join(', ')}）：未删除；请先停止本 Run 的开发 DSH 后重试` }
  }
  remove(home)
  const recycled_at = now().toISOString()
  return { ok: true, status: 'recycled', home, marker_run_id: marker.run_id, stop: stopResult, recycled_at }
}

export function renderRecycleReport(result) {
  const lines = ['', '## 环境回收（#185 任务环境隔离）', '']
  const label = {
    recycled: '✅ 已回收',
    nothing_registered: 'ℹ️ 无登记资源',
    already_recycled: 'ℹ️ 此前已回收',
    missing: 'ℹ️ 目录已不存在',
    refused: '❌ 拒绝回收',
    occupied: '⚠️ 仍被占用，未删除',
  }[result.status] || result.status
  lines.push(`- 独占开发 DSH Home：${result.home || '—'} —— ${label}`)
  if (result.marker_run_id) lines.push(`- 归属核对：run.json 与 marker 均为 ${result.marker_run_id}`)
  if (result.stop) lines.push(`- 开发 DSH 进程：${result.stop.stopped ? `已停止 PID ${result.stop.pid}` : `未停止（${result.stop.reason || `PID ${result.stop.pid}`}）`}`)
  if (result.occupants?.length) lines.push(`- 占用进程：PID ${result.occupants.join(', ')}（须人工处理，列入收口遗留事项）`)
  if (result.reason) lines.push(`- 原因：${result.reason}`)
  if (result.message) lines.push(`- 说明：${result.message}`)
  if (result.recycled_at) lines.push(`- 时间：${result.recycled_at}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * GC 扫描：纯逻辑，可注入 occupancy / remove / now 供测试。
 */
export function scanTaskHomes(root, { maxAgeDays = DEFAULT_MAX_AGE_DAYS, occupancy = defaultOccupancy, now = () => new Date() } = {}) {
  if (!existsSync(root)) return []
  const nowMs = now().getTime()
  const entries = []
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const home = join(root, dirent.name)
    const marker = readMarker(home)
    const hasMarker = Boolean(marker) && !marker.corrupt
    const registeredMs = hasMarker && marker.registered_at ? Date.parse(marker.registered_at) : NaN
    const ageMs = nowMs - (Number.isFinite(registeredMs) ? registeredMs : statSync(home).mtimeMs)
    const ageDays = Math.floor(ageMs / DAY_MS)
    const occupants = occupancy(home)
    const expired = ageDays >= maxAgeDays
    const entry = {
      home,
      run_id: hasMarker ? marker.run_id : null,
      has_marker: hasMarker,
      registered_at: hasMarker ? marker.registered_at || null : null,
      age_days: ageDays,
      expired,
      occupants,
      eligible: hasMarker && expired && occupants.length === 0,
    }
    if (!hasMarker) entry.needs_human = marker?.corrupt ? 'marker 损坏，请人工确认归属' : '无 marker，请人工确认归属'
    else if (occupants.length > 0) entry.note = '仍有进程占用，不会自动删除'
    else if (!expired) entry.note = `未过期（阈值 ${maxAgeDays} 天）`
    entries.push(entry)
  }
  return entries
}

export function gcTaskHomes(root, { force = false, remove = (p) => rmSync(p, { recursive: true, force: true }), ...opts } = {}) {
  const entries = scanTaskHomes(root, opts)
  const deleted = []
  if (force) {
    for (const e of entries) {
      if (!e.eligible) continue
      remove(e.home)
      deleted.push(e.home)
      e.deleted = true
    }
  }
  return { root, mode: force ? 'force' : 'dry-run', max_age_days: opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS, entries, eligible: entries.filter((e) => e.eligible).map((e) => e.home), deleted }
}

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'recycle') {
    const runDir = rest.find((a) => !a.startsWith('--'))
    if (!runDir) {
      console.error('用法: node scripts/cwf-env-recycle.mjs recycle <runDir> [--stop] [--report <cleanup-report.md>]')
      process.exit(2)
    }
    const runPath = join(resolve(runDir), 'run.json')
    const run = readJson(runPath)
    const result = recycleRunHome(run, { stop: rest.includes('--stop') })
    if (result.status === 'recycled' || result.status === 'missing') {
      run.env_resources.dev_dsh_home.recycled_at = result.recycled_at || new Date().toISOString()
      if (result.status === 'missing') run.env_resources.dev_dsh_home.recycled_note = result.message
      writeFileSync(runPath, JSON.stringify(run, null, 2) + '\n')
    }
    const report = flag(rest, '--report')
    if (report) appendFileSync(report, renderRecycleReport(result))
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  }
  if (cmd === 'gc') {
    const root = resolve(flag(rest, '--root') || devDshTasksRoot())
    const maxAgeRaw = flag(rest, '--max-age-days')
    const maxAgeDays = maxAgeRaw === undefined ? DEFAULT_MAX_AGE_DAYS : Number(maxAgeRaw)
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
      console.error(`非法 --max-age-days: ${maxAgeRaw}（须为非负整数）`)
      process.exit(2)
    }
    const out = gcTaskHomes(root, { force: rest.includes('--force'), maxAgeDays })
    console.log(JSON.stringify(out, null, 2))
    return
  }
  console.error('用法: recycle <runDir> [--stop] [--report <file>] | gc [--root <dir>] [--max-age-days <n>] [--force]')
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
