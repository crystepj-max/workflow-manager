'use strict'

const MAX_WORKER_LINE = 1024 * 1024
const MAX_WORKER_OUTPUT = 4 * 1024 * 1024

function createNodeIsolationHostClient(dependencies = {}) {
  return async function nodeIsolationHostCall(command, input = {}, options = {}) {
    if (command === 'spawnProviderWorker') return startProviderWorker(input, options, dependencies)
    const script = dependencies.scriptPath
    if (!script || (await dependencies.readTextIfExists(script)) === null) {
      return { ok: false, notFound: true, error: 'node-isolation-host.mjs 未找到（LOC-041 集成未部署）' }
    }
    const runNode = dependencies.runNode
    if (typeof runNode !== 'function') throw new Error('node isolation host 子进程能力不可用')
    const result = await runNode([script, command, JSON.stringify(input || {})], {
      graceMs: options.graceMs || 30000,
      maxBytes: options.maxBytes || 256 * 1024,
    })
    if (!result.ok) return { ok: false, error: 'node isolation host 调用失败：' + result.detail }
    try {
      const parsed = JSON.parse(result.stdout)
      return parsed.ok ? parsed : Object.assign({ ok: false, error: parsed.error || 'node isolation host 业务错误', detail: parsed.detail }, parsed)
    } catch {
      return { ok: false, error: 'node isolation host 输出不可解析', raw: result.stdout }
    }
  }
}

async function startProviderWorker(payload, options, dependencies) {
  const subprocess = dependencies.subprocess
  if (!subprocess || typeof subprocess.spawn !== 'function' || typeof dependencies.resolveNode !== 'function'
    || !dependencies.credentials || typeof dependencies.credentials.resolve !== 'function') {
    throw new Error('node provider 子进程能力不可用')
  }
  const resolved = await dependencies.credentials.resolve('DEEPSEEK_API_KEY')
  const apiKey = resolved && resolved.value
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('DeepSeek API 凭据不可用，已拒绝启动隔离节点')
  const node = await dependencies.resolveNode()
  const workerPath = dependencies.workerPath
  const cwd = payload && payload.context && payload.context.agent_cwd
  if (typeof node !== 'string' || !node.startsWith('/') || typeof workerPath !== 'string' || !workerPath.startsWith('/')
    || typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new Error('node provider worker 启动路径无效')
  }
  const serialized = JSON.stringify(payload)
  const handle = subprocess.spawn({
    argv: [node, workerPath],
    cwd,
    env: {
      // 受信 worker 可读取用户的出站代理设置，但只允许通过本地代理连接 DeepSeek API。
      // node-isolation.mjs 启动的 DSH 进程只拿到该 loopback 代理地址。
      NODE_OPTIONS: undefined,
      DSH_HOME: undefined,
      HOME: undefined,
      TMPDIR: undefined,
      OPENAI_API_KEY: undefined,
      // 只有受信 worker 收到凭据；它再交给沙箱内 DSH 进程，工具子进程由 DSH 清除该变量。
      DEEPSEEK_API_KEY: apiKey,
    },
    stdio: {
      stdin: { data: serialized },
      stdout: 'pipe',
      stderr: { maxBytes: 16 * 1024 },
    },
    graceMs: 30000,
    signal: options.signal,
  })
  if (!handle || !handle.stdout || !handle.done || typeof handle.terminate !== 'function' || typeof handle.waitForExit !== 'function') {
    throw new Error('node provider subprocess 未提供受管 stdout/exit/terminate 接口')
  }
  return createWorkerHandle(handle)
}

function createWorkerHandle(handle) {
  let resolveAccepted
  let rejectAccepted
  let resolveResult
  let rejectResult
  const accepted = new Promise((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject })
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  accepted.catch(() => {})
  result.catch(() => {})

  let buffer = ''
  let totalOutput = 0
  let acceptedState = false
  let exited = false
  let finalResult
  let failure
  let disposeTask

  const fail = (error) => {
    if (failure) return
    failure = error instanceof Error ? error : new Error(String(error))
    if (!acceptedState) rejectAccepted(failure)
    rejectResult(failure)
    if (!exited) {
      try { handle.terminate() } catch { /* waitForExit remains the cleanup authority */ }
    }
  }

  const consumeLine = (line) => {
    if (!line) return
    if (line.length > MAX_WORKER_LINE) throw new Error('node provider worker protocol line exceeded limit')
    const message = JSON.parse(line)
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('node provider worker sent an invalid protocol event')
    if (message.type === 'accepted') {
      if (acceptedState) throw new Error('node provider worker sent duplicate acceptance')
      acceptedState = true
      resolveAccepted()
      return
    }
    if (message.type === 'result') {
      if (!acceptedState || finalResult !== undefined) throw new Error('node provider worker sent a result out of order')
      if (!message.result || typeof message.result !== 'object') throw new Error('node provider worker result is missing')
      finalResult = message.result
      return
    }
    if (message.type === 'error') throw new Error(typeof message.message === 'string' ? message.message : 'node provider worker failed')
    throw new Error('node provider worker sent an unknown protocol event')
  }

  handle.stdout.on('data', (chunk) => {
    if (failure) return
    try {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      totalOutput += text.length
      if (totalOutput > MAX_WORKER_OUTPUT) throw new Error('node provider worker output exceeded limit')
      buffer += text
      if (buffer.length > MAX_WORKER_LINE && !buffer.includes('\n')) throw new Error('node provider worker protocol line exceeded limit')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        consumeLine(line)
      }
    } catch (error) { fail(error) }
  })
  handle.stdout.on('error', fail)
  Promise.resolve(handle.done).then((outcome) => {
    exited = true
    if (failure) return
    if (!acceptedState) {
      fail(new Error('node provider worker exited before prompt acceptance'))
      return
    }
    if (outcome.exitCode !== 0) {
      fail(new Error('node provider worker exit ' + (outcome.exitCode === null ? outcome.signal : outcome.exitCode)))
      return
    }
    if (buffer) {
      try { consumeLine(buffer) } catch (error) { fail(error); return }
    }
    if (finalResult === undefined) {
      fail(new Error('node provider worker exited without a result'))
      return
    }
    resolveResult(finalResult)
  }, fail)

  const dispose = () => {
    if (!disposeTask) {
      disposeTask = (async () => {
        if (!exited) handle.terminate()
        const empty = await handle.waitForExit()
        if (!empty) throw new Error('node provider worker process range did not become empty')
      })()
      disposeTask.catch(() => {})
    }
    return disposeTask
  }
  return { accepted, result, dispose }
}

module.exports = { createNodeIsolationHostClient }
