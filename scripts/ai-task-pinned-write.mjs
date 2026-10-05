/**
 * 把报告写入冻结过身份的批次目录。
 * Node 打开目录 fd 并核对 dev/ino；只有身份相符才把该 fd 交给 Python 写入。
 * Python 不得按路径重新打开目录。身份不符则失败，不写文件。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-task-pinned-write.py')

export function writePinnedReport({ directory, basename, content, dev, ino }) {
  if (dev == null || ino == null) return { ok: false, message: '缺少冻结的目录身份' }
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0)
  let dirFd
  try {
    dirFd = fs.openSync(directory, flags)
  } catch (e) {
    return { ok: false, message: `无法打开批次目录：${e.message}` }
  }
  try {
    const st = fs.fstatSync(dirFd)
    if (String(st.dev) !== String(dev) || String(st.ino) !== String(ino)) {
      return {
        ok: false,
        message: `目录身份不符：打开 ${st.dev}:${st.ino}，冻结 ${dev}:${ino}`,
      }
    }
    const pinned = spawnSync('python3', [
      helper, '--dirfd', '3', basename, String(st.dev), String(st.ino),
    ], {
      input: content,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', dirFd],
    })
    if (pinned.error) return { ok: false, message: pinned.error.message }
    if (pinned.status !== 0) {
      return { ok: false, message: String(pinned.stderr || pinned.stdout || '').trim() || `status=${pinned.status}` }
    }
    return { ok: true }
  } finally {
    try { fs.closeSync(dirFd) } catch { /* 子进程结束后关闭父 fd */ }
  }
}
