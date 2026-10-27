import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, RequestTimeoutError, TransportClosedError } from '@deepseek-ai/dsh-sdk-client'
import { createSdkOptions } from '../../packages/dsh-visual-workflow/src/node-provider-worker.mjs'

const require = createRequire(import.meta.url)
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'node-provider-sdk-cli.mjs')
const realSetTimeout = globalThis.setTimeout
const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const FIXTURE_READY_TIMEOUT_MS = 30000

function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'vwf-sdk-initialize-'))
  const logPath = join(root, 'wire.jsonl')
  const cliPath = join(root, 'cli.mjs')
  const dshHome = join(root, 'home')
  mkdirSync(dshHome)
  copyFileSync(fixturePath, cliPath)
  const payload = {
    context: { agent_cwd: root, scratch_path: root },
    route: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  }
  // 取用真实生产选项；只替换 CLI 和其环境，隔绝凭据与真实 DSH/模型。
  const options = createSdkOptions(payload, { dshHome, patchPath: null }, 0)
  const harness = new DeepSeekHarness({
    ...options,
    dshBin: cliPath,
    env: { WFM_FIXTURE_MODE: mode, WFM_FIXTURE_LOG: logPath },
  })
  const readLog = () => existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const children = []
  const spawned = ({ process: child }) => {
    // 通道发布时 spawnargs 尚未形成；等公开 spawn 事件后按本次唯一 CLI 路径筛选。
    child.once('spawn', () => {
      if (!child.spawnargs?.includes(cliPath)) return
      const record = { pid: child.pid, spawned: true, exited: false, closed: false }
      children.push(record)
      child.once('exit', (code, signal) => { Object.assign(record, { exited: true, code, signal }) })
      child.once('close', () => { record.closed = true })
      child.once('error', (error) => { record.error = { name: error.name, code: error.code, message: error.message } })
    })
  }
  // 公开 ChildProcess 诊断通道独立于子 CLI 的 boot 日志；不读取 SDK 私有字段。
  channel('child_process').subscribe(spawned)
  t.after(async () => {
    let closeError
    try {
      await harness.close()
    } catch (error) {
      closeError = error
    } finally {
      channel('child_process').unsubscribe(spawned)
    }
    const entries = readLog()
    const boots = entries.filter((entry) => entry.event === 'boot')
    const requests = entries.filter((entry) => entry.event === 'request').map((entry) => entry.method)
    for (const child of children) {
      child.absent = false
      if (!Number.isSafeInteger(child.pid)) continue
      try { process.kill(child.pid, 0) } catch (error) { child.absent = error.code === 'ESRCH' }
    }
    const reaped = children.length === 1 && children.every((child) => child.spawned && child.exited && child.absent)
    const cleanupConfirmed = !closeError && reaped
    const diagnostic = { synthetic: true, mode, initializeTimeoutMs: options.initializeTimeoutMs ?? 'SDK default', entries, children, reaped, retainedPath: cleanupConfirmed ? null : root }
    t.diagnostic(JSON.stringify(diagnostic))
    if (process.env.WFM_SDK_TEST_EVIDENCE_DIR) {
      appendFileSync(join(process.env.WFM_SDK_TEST_EVIDENCE_DIR, 'fixture-cleanup.jsonl'), JSON.stringify(diagnostic) + '\n')
    }
    // 退出或证据不明时保留本次目录，不能用空 boot 数组认定回收。
    if (cleanupConfirmed) rmSync(root, { recursive: true, force: true })
    assert.equal(closeError, undefined, '公开 close 应完成；失败时保留本次目录')
    assert.equal(reaped, true, '必须有实际 PID、exit 和 PID 不存在的回收证据')
    assert.equal(boots.length, mode === 'never-boot' ? 0 : 1)
    assert.deepEqual(requests, mode === 'never-boot' ? [] : ['initialize', 'shutdown'], '不得重试握手、创建 Session 或发送 prompt')
    assert.equal(entries.filter((entry) => entry.event === 'exit').length, mode === 'never-boot' ? 0 : 1)
  })
  return { harness, readLog, options, children }
}

async function waitForInitialize(readLog) {
  const deadline = performance.now() + FIXTURE_READY_TIMEOUT_MS
  while (!readLog().some((entry) => entry.event === 'request' && entry.method === 'initialize')) {
    assert.ok(performance.now() < deadline, `本地夹具应在 ${FIXTURE_READY_TIMEOUT_MS / 1000} 秒内收到 initialize；当前日志：${JSON.stringify(readLog())}`)
    await delay(10)
  }
}

test('固定 SDK 与生产选项允许本地 CLI 在原 10 秒窗口后完成初始化（无模型）', async (t) => {
  for (const packageName of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh']) {
    assert.equal(JSON.parse(readFileSync(require.resolve(packageName + '/package.json'), 'utf8')).version, '0.2.0-rc.2')
  }
  const { harness, readLog } = fixture(t, 'delayed')
  const started = performance.now()
  await harness.start()
  assert.ok(performance.now() - started >= 11000, '夹具必须实际等待超过旧 10 秒窗口')
  assert.equal(readLog().filter((entry) => entry.event === 'initialize-reply').length, 1)
})

for (const mode of ['slow-boot-never', 'over-limit']) {
  test(`生产 60 秒握手上限在 ${mode} 情况有界失败并回收进程（SDK 真实 timer 使用虚拟时钟）`, async (t) => {
    const { harness, readLog } = fixture(t, mode)
    let settled = false
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // 不替换 SDK timer、不缩短生产选项；仅推进父进程的虚拟时钟。
    const preparingStarted = performance.now()
    const starting = harness.start()
    const outcome = starting.then(
      () => { settled = true; return null },
      (error) => { settled = true; return error },
    )
    try {
      await waitForInitialize(readLog)
      const fixtureReadyWaitMs = performance.now() - preparingStarted
      if (mode === 'slow-boot-never') assert.ok(fixtureReadyWaitMs >= 6000, '夹具必须真实等待至少 6 秒才记录 boot 并读取 initialize')
      t.diagnostic(JSON.stringify({ synthetic: true, mode, phase: 'fixture-ready', fixtureReadyWaitMs }))
      t.mock.timers.tick(59999)
      await delay(0)
      assert.equal(settled, false, '59999ms 时 initialize 必须仍在等待')
      t.mock.timers.tick(1)
    } finally {
      // 超时回调已运行；恢复真实时钟，让 SDK 的公开 close 正常走协议/EOF 清理。
      t.mock.timers.reset()
    }
    let guard
    try {
      const error = await Promise.race([
        outcome,
        new Promise((resolve, reject) => {
          guard = realSetTimeout(() => reject(new Error('推进到 60000ms 后 SDK 应及时失败并完成清理')), 5000)
        }),
      ])
      assert.ok(error instanceof RequestTimeoutError)
      assert.match(error.message, /initialize timed out after 60000ms/)
      assert.equal(readLog().filter((entry) => entry.event === 'initialize-reply').length, 0)
    } finally {
      clearTimeout(guard)
    }
  })
}

test('SDK close 在夹具尚无 boot 日志时仍用实际 PID 证明回收', async (t) => {
  const { harness, readLog, children } = fixture(t, 'never-boot')
  const starting = harness.start().then(() => null, (error) => error)
  const deadline = performance.now() + FIXTURE_READY_TIMEOUT_MS
  while (!children.some((child) => child.spawned)) {
    assert.ok(performance.now() < deadline, '应通过公开诊断通道取得本次子 CLI 的 PID')
    await delay(10)
  }
  await harness.close()
  assert.ok(await starting instanceof TransportClosedError)
  assert.deepEqual(readLog(), [], '夹具在记录 boot 前已由 SDK close 回收')
})
