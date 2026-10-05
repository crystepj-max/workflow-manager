/**
 * M5 会话监工契约（与调度器同语义，可供隔离假会话回归直接调用）。
 * 真实 CLI 派发入口在 Claim/接管实证前仍 fail-closed；本模块不绕过该闸门。
 *
 * 覆盖：
 * - 看门狗：对挂起子进程发 SIGTERM（必要时 SIGKILL），记 BLOCKED 并释放名额
 * - 释放契约：读 release-event.json；子进程已退出但无释放事件 → BLOCKED
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {object} args
 * @param {string} args.taskId
 * @param {Map<string, { child: import('node:child_process').ChildProcess, watchdogTimer?: NodeJS.Timeout, killTimer?: NodeJS.Timeout }>} args.children
 * @param {Map<string, { runDir?: string }>} args.sites
 * @param {number} args.watchdogMinutes
 * @param {Set<string>} args.watchdogFired
 * @param {(taskId: string, row: object) => void} args.onRelease
 * @param {number} [args.killEscalationMs]
 */
function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * 所有释放路径的唯一出口：子进程仍存活时只发终止信号并占着名额，
 * 确认退出后才调用 onRelease。
 */
export function releaseAfterExit({
  entry,
  taskId,
  row,
  onRelease,
  killEscalationMs = 10_000,
  onFired,
}) {
  if (entry.slotReleased) return { pendingExit: false, already: true }
  if (!entry.pendingRow) entry.pendingRow = row
  const finish = () => {
    if (entry.slotReleased) return
    if (!childHasExited(entry.child)) return
    entry.slotReleased = true
    if (entry.killTimer) clearTimeout(entry.killTimer)
    if (onFired) onFired()
    onRelease(taskId, entry.pendingRow)
  }
  if (childHasExited(entry.child)) {
    finish()
    return { pendingExit: false }
  }
  if (!entry.exitHooked) {
    entry.exitHooked = true
    try { entry.child.kill('SIGTERM') } catch { /* 已退出 */ }
    entry.killTimer = setTimeout(() => {
      if (!childHasExited(entry.child)) {
        try { entry.child.kill('SIGKILL') } catch { /* 已退出 */ }
      }
    }, killEscalationMs)
    entry.child.once('exit', () => finish())
  }
  return { pendingExit: true }
}

export function fireWatchdog({
  taskId,
  children,
  sites,
  watchdogMinutes,
  watchdogFired,
  onRelease,
  killEscalationMs = 10_000,
}) {
  const entry = children.get(taskId)
  if (!entry) return { fired: false, reason: 'not-running' }
  if (entry.watchdogStarted) {
    return { fired: true, pendingExit: !entry.slotReleased }
  }
  entry.watchdogStarted = true
  const s = sites.get(taskId) || {}
  const row = {
    to: 'BLOCKED',
    blockedNode: 'session',
    reason: `看门狗超时（>${watchdogMinutes} 分钟），已终止会话；日志：${path.join(s.runDir || '', 'session.log')}`,
    reworkCount: null,
    nextStep: '人工查看 session.log 判断是否可重试',
  }
  const result = releaseAfterExit({
    entry,
    taskId,
    row,
    onRelease,
    killEscalationMs,
    onFired: () => watchdogFired.add(taskId),
  })
  return { fired: true, pendingExit: result.pendingExit }
}

/**
 * 解析释放事件；非法/不可读时归一为 BLOCKED。
 * @param {string} evPath
 */
export function readReleaseEvent(evPath) {
  if (!fs.existsSync(evPath)) return null
  let ev
  try {
    ev = JSON.parse(fs.readFileSync(evPath, 'utf8'))
  } catch (e) {
    return {
      to: 'BLOCKED',
      blockedNode: 'release-event',
      reason: `释放事件不可解析：${e.message}`,
    }
  }
  if (!['WAITING_HUMAN', 'BLOCKED', 'COMPLETED'].includes(ev.to)) {
    return {
      to: 'BLOCKED',
      blockedNode: 'release-event',
      reason: `释放事件 to 非法：${JSON.stringify(ev.to)}`,
      reworkCount: ev.reworkCount ?? null,
      nextStep: ev.nextStep ?? null,
    }
  }
  return {
    to: ev.to,
    blockedNode: ev.blockedNode ?? null,
    reason: ev.reason ?? null,
    reworkCount: ev.reworkCount ?? null,
    nextStep: ev.nextStep ?? null,
  }
}

/**
 * 一轮监工轮询。释放事件或“已退出但无释放事件”都要等子进程确认退出后才 onRelease。
 * @returns {{ released: string[], pending: string[] }}
 */
export function pollChildrenOnce({ children, sites, onRelease, killEscalationMs = 10_000 }) {
  const released = []
  const pending = []
  for (const [taskId, entry] of [...children]) {
    if (entry.slotReleased) continue
    const runDir = sites.get(taskId)?.runDir || ''
    const evPath = path.join(runDir, 'release-event.json')
    const ev = readReleaseEvent(evPath)
    const gone = childHasExited(entry.child)
    if (!ev && !gone) continue
    const row = ev || {
      to: 'BLOCKED',
      blockedNode: 'session',
      reason: `会话退出但未写释放事件（exit=${entry.child.exitCode}, signal=${entry.child.signalCode}）；日志：${path.join(runDir, 'session.log')}`,
      reworkCount: null,
      nextStep: '人工查看 session.log 判断是否可重试',
    }
    const result = releaseAfterExit({ entry, taskId, row, onRelease, killEscalationMs })
    if (result.pendingExit) pending.push(taskId)
    else if (!result.already) released.push(taskId)
  }
  return { released, pending }
}
