import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, RequestTimeoutError } from '@deepseek-ai/dsh-sdk-client'
import { createSdkOptions } from '../../packages/dsh-visual-workflow/src/node-provider-worker.mjs'

const require = createRequire(import.meta.url)
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'node-provider-sdk-cli.mjs')
const realSetTimeout = globalThis.setTimeout
const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

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
  t.after(async () => {
    try {
      await harness.close()
      const entries = readLog()
      const boots = entries.filter((entry) => entry.event === 'boot')
      const requests = entries.filter((entry) => entry.event === 'request').map((entry) => entry.method)
      const reaped = boots.every(({ pid }) => {
        try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
      })
      t.diagnostic(JSON.stringify({ synthetic: true, mode, initializeTimeoutMs: options.initializeTimeoutMs ?? 'SDK default', entries, reaped }))
      assert.equal(boots.length, 1, '每个检查只能启动一个本地 CLI')
      assert.deepEqual(requests, ['initialize', 'shutdown'], '不得重试握手、创建 Session 或发送 prompt')
      assert.equal(entries.filter((entry) => entry.event === 'exit').length, 1)
      assert.equal(reaped, true, '公开 close 必须回收测试进程')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  return { harness, readLog, options }
}

async function waitForInitialize(readLog) {
  const deadline = performance.now() + 5000
  while (!readLog().some((entry) => entry.event === 'request' && entry.method === 'initialize')) {
    assert.ok(performance.now() < deadline, '本地夹具应在 5 秒内收到 initialize')
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

for (const mode of ['never', 'over-limit']) {
  test(`生产 60 秒握手上限在 ${mode} 情况有界失败并回收进程（SDK 真实 timer 使用虚拟时钟）`, async (t) => {
    const { harness, readLog } = fixture(t, mode)
    let settled = false
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // 不替换 SDK timer、不缩短生产选项；仅推进父进程的虚拟时钟。
    const starting = harness.start()
    const outcome = starting.then(
      () => { settled = true; return null },
      (error) => { settled = true; return error },
    )
    try {
      await waitForInitialize(readLog)
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
