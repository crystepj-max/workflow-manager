#!/usr/bin/env node
// DSH SDK 自定义 dshBin：将真实 DSH Node 进程放进节点 Seatbelt 边界。

import { spawn } from 'node:child_process'
import { buildSandboxedDshLaunchSpec } from './node-isolation.mjs'

const CONFIG_ENV = 'WFM_NODE_ISOLATION_LAUNCH_SPEC'
const SDK_KILL_GRACE_MS = 2500
let child = null
let killTimer = null

function groupSignal(signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill(signal) } catch { /* SDK 的 SIGKILL rung 会兜底结束 wrapper */ }
    }
  }
}

function forwardSignal(signal) {
  groupSignal(signal)
  if (!killTimer) {
    // SDK 默认在 SIGTERM 后 3000ms 升级为 SIGKILL；先清理整个嵌套进程组。
    killTimer = setTimeout(() => groupSignal('SIGKILL'), SDK_KILL_GRACE_MS)
    killTimer.unref()
  }
}

function exitCodeFromSignal(signal) {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}

try {
  const rawConfig = process.env[CONFIG_ENV]
  if (!rawConfig) throw new Error(`缺少 ${CONFIG_ENV}`)
  const config = JSON.parse(rawConfig)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('launch spec 必须是对象')

  const spec = buildSandboxedDshLaunchSpec(config.context, {
    dsh_entry: config.dsh_entry,
    runtime_roots: config.runtime_roots,
    runtime_files: config.runtime_files,
    dsh_home: config.dsh_home,
    loopback_port: config.loopback_port,
    api_key: process.env.DEEPSEEK_API_KEY,
    argv: process.argv.slice(2),
  })

  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))
  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: 'inherit',
  })
  child.once('error', (error) => {
    console.error(`node-isolation-launcher: ${error.message}`)
    process.exitCode = 1
  })
  child.once('close', (code, signal) => {
    if (killTimer) clearTimeout(killTimer)
    process.exitCode = code === null ? exitCodeFromSignal(signal) : code
  })
} catch (error) {
  console.error(`node-isolation-launcher: ${error?.message || error}`)
  process.exitCode = 78
}
