// dev-plugin.mjs（决策六：单实例 + 固定端口 + 任务命名隔离）
// 覆盖：固定端口、单实例发现与拒绝、端口占用不改端口、命名空间强制与拒绝裸名、
//       单激活纪律（切换任务重启开发环境）、激活登记写入
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const scriptPath = fileURLToPath(new URL('../dev-plugin.mjs', import.meta.url))
// 测试用固定端口而非真实 9527：避免测试结果依赖本机该端口当下是否空闲。
// 默认值 9527 由 workspace-paths 的常量与 run-init 测试独立锚定。
const TEST_PORT = '19527'

/** 标准测试环境：隔离的开发/产品 Home + 测试端口 + 显式任务命名空间 */
function baseEnv(extra = {}) {
  return {
    ...process.env,
    VWF_DEV_DSH_PORT: TEST_PORT,
    DSH_HOME: undefined,
    // dev-plugin.mjs 在模块顶层即调用 resolvePortState()；不注入探针就会退化为依赖宿主机
    // lsof——CI runner 无此工具，脚本按 fail-closed 设计直接报「无法核验端口」而中止。
    // 故默认注入「无监听进程」的确定性替身；需要特定监听结果的用例在 extra 里显式覆盖。
    VWF_DEV_LSOF_BIN: defaultLsofProbe(),
    ...extra,
  }
}

function fakeDsh(root, { marker = null, argsFile = null } = {}) {
  const dshPath = join(root, 'fake-dsh')
  const lines = ['#!/bin/sh']
  if (argsFile) lines.push(`printf '%s\\n' "$@" > '${argsFile}'`)
  if (marker) lines.push(`: > '${marker}'`)
  lines.push('exit 0')
  writeFileSync(dshPath, lines.join('\n') + '\n')
  chmodSync(dshPath, 0o755)
  return dshPath
}

/** 假的 lsof：-iTCP 报告监听端口；-p <pid> 报告该进程打开的开发 Home 文件 */
function fakeLsof(root, { listenLines = '', homeFiles = '' } = {}) {
  const lsofPath = join(root, 'fake-lsof')
  writeFileSync(lsofPath, `#!/bin/sh
case "$*" in
  *-iTCP*) printf '${listenLines}' ;;
  *) printf '${homeFiles}' ;;
esac
`)
  chmodSync(lsofPath, 0o755)
  return lsofPath
}

/** 默认探针（空监听结果）：整个测试文件共用一份，进程退出时清理其临时目录。 */
let defaultLsofProbePath = null
function defaultLsofProbe() {
  if (!defaultLsofProbePath) {
    const dir = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-lsof-'))
    defaultLsofProbePath = fakeLsof(dir)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  }
  return defaultLsofProbePath
}

test('start：按固定端口启动（不是 --port 0），并把本任务写入激活登记', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-port-'))
  try {
    const argsFile = join(root, 'args.txt')
    const devHome = join(root, 'dev-home')
    const dshPath = fakeDsh(root, { argsFile })
    const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: dshPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readArgs(argsFile), ['web', '--port', TEST_PORT])
    const ledger = JSON.parse(readFileSync(join(devHome, '.vwf-active-task.json'), 'utf8'))
    assert.equal(ledger.current.namespace, 'loc-020-r1')
    assert.match(ledger.current.plugin_name, /^loc-020-r1-vwf-[0-9a-f]{12}$/)
    assert.match(result.stdout, /插件注册名请用 loc-020-r1-vwf-/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start：未给命名空间且 .agent-runs 下无 Run → 拒绝（禁止裸名注册）', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-nons-'))
  try {
    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root),
        VWF_DEV_DSH_HOME: join(root, 'dev-home'),
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
        VWF_RUNS_DIR: join(root, 'no-runs'),
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /插件注册名禁止裸名/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start：.agent-runs 下有多个 Run → 拒绝推断，要求显式指定（不猜）', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-multins-'))
  try {
    const runsDir = join(root, 'agent-runs')
    for (const ns of ['loc-020-r1', 'loc-022-r1']) {
      mkdirSync(join(runsDir, ns), { recursive: true })
      writeFileSync(
        join(runsDir, ns, 'run.json'),
        JSON.stringify({ run_id: ns, env_resources: { plugin_namespace: ns, dev_dsh_port: 9527 } }),
      )
    }
    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root),
        VWF_DEV_DSH_HOME: join(root, 'dev-home'),
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
        VWF_RUNS_DIR: runsDir,
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /有多个 Run（loc-020-r1、loc-022-r1）/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start：.agent-runs 下唯一 Run 可推断命名空间；非法的 --task 直接拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-infer-'))
  try {
    const runsDir = join(root, 'agent-runs')
    mkdirSync(join(runsDir, 'loc-020-r1'), { recursive: true })
    writeFileSync(
      join(runsDir, 'loc-020-r1', 'run.json'),
      JSON.stringify({ run_id: 'loc-020-r1', env_resources: { plugin_namespace: 'loc-020-r1' } }),
    )
    const env = baseEnv({
      VWF_DEV_DSH_BIN: fakeDsh(root),
      VWF_DEV_DSH_HOME: join(root, 'dev-home'),
      VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      VWF_RUNS_DIR: runsDir,
    })
    const inferred = spawnSync(process.execPath, [scriptPath, 'start'], { encoding: 'utf8', env })
    assert.equal(inferred.status, 0, inferred.stderr)
    assert.match(inferred.stdout, /插件注册名请用 loc-020-r1-vwf-/)

    const illegal = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'Not A Name'], {
      encoding: 'utf8',
      env,
    })
    assert.notEqual(illegal.status, 0)
    assert.match(illegal.stderr, /非法任务命名空间/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('端口被其他进程占用 → 报错并指名占用者，不自动改端口', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-portbusy-'))
  try {
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const lsofPath = fakeLsof(root, {
      listenLines: `p${process.pid}\\ncpostgres\\nf19\\nn127.0.0.1:${TEST_PORT}\\n`,
    })
    const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root),
        VWF_DEV_LSOF_BIN: lsofPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`端口 ${TEST_PORT} 已被占用`))
    assert.match(result.stderr, /postgres/)
    assert.match(result.stderr, /不会自动改用其他端口/)
    assert.equal(existsSync(join(devHome, '.vwf-active-task.json')), false, '冲突时不得登记激活')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('端口上已是本开发 Home 的实例 → 复用不重启，仅登记本任务', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-reuse-'))
  let fakePid = null
  try {
    const devHome = join(root, 'dev-home')
    mkdirSync(devHome)
    const canonical = realpathSync(devHome)
    const fakePidPath = join(root, 'fake.pid')
    const lsofPath = fakeLsof(root, {
      listenLines: 'LISTEN_PLACEHOLDER',
      homeFiles: `pFAKEPID\\ncnode\\nf20\\nn${canonical}/profiles/web/cordis.yml\\nf21\\nn${canonical}/profiles/web/package.json\\n`,
    })
    // 用一个真实的存活子进程充当「已在运行的开发 DSH」。
    // `exec` 让记录的 PID 就是 sleep 本身（无 shell 包装），detached 让它自成进程组——
    // 与 dev-plugin 的 `kill(-pid)` 语义一致，且不会误伤测试进程组。
    const holder = spawn('/bin/sh', ['-c', `echo $$ > '${fakePidPath}'; exec /bin/sleep 30`], { detached: true })
    await waitForFile(fakePidPath)
    fakePid = Number(readFileSync(fakePidPath, 'utf8').trim())
    const listen = `p${fakePid}\\ncnode\\nf19\\nn127.0.0.1:${TEST_PORT}\\n`
    writeFileSync(
      lsofPath,
      `#!/bin/sh
case "$*" in
  *-iTCP*) printf '${listen}' ;;
  *) printf 'p${fakePid}\\ncnode\\nf20\\nn${canonical}/profiles/web/cordis.yml\\nf21\\nn${canonical}/profiles/web/package.json\\n' ;;
esac
`,
    )
    // 不写 pidFile：实例已在跑但没登记 → start 应「发现并接管」，补写 pidFile（收口停机依赖它）
    const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root),
        VWF_DEV_LSOF_BIN: lsofPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /无需重复启动/)
    assert.equal(Number(readFileSync(join(devHome, '.vwf-dev-dsh.pid'), 'utf8').trim()), fakePid, '发现接管必须补写 pidFile')
    const ledger = JSON.parse(readFileSync(join(devHome, '.vwf-active-task.json'), 'utf8'))
    assert.equal(ledger.current.namespace, 'loc-020-r1')
    assert.equal(ledger.current.pid, fakePid)
  } finally {
    if (fakePid) {
      try { process.kill(-fakePid, 'SIGTERM') } catch { try { process.kill(fakePid, 'SIGTERM') } catch { /* 已退出 */ } }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('单激活纪律：不在旧插件可能仍激活的情况下启动新任务（不静默接管）', {
  skip: process.platform === 'win32',
}, async () => {
  const ctx = await setupSwitchScene('vwf-dev-plugin-switch-')
  try {
    const result = await spawnSwitch(ctx, 'loc-020-r1')
    const ledger = JSON.parse(readFileSync(join(ctx.devHome, '.vwf-active-task.json'), 'utf8'))
    if (result.status === 0) {
      // 成功切换：必须明确提示停掉了谁、现在跑的是谁，且登记已换成本任务
      assert.match(result.stdout, /已停掉上一个任务（loc-022-r1）的插件，并切换到 loc-020-r1/)
      assert.match(result.stdout, /现在 127\.0\.0\.1:19527 上没有任何插件在激活/)
      assert.equal(ledger.current.namespace, 'loc-020-r1')
    } else {
      // 停不掉时：必须拒绝并给出原因，且**不得**把本任务登记为激活（否则就是静默接管）
      assert.match(result.stderr, /无法停掉上一个任务（loc-022-r1）的插件/)
      assert.match(result.stderr, /不会在旧插件仍激活的情况下启动新任务/)
      assert.equal(ledger.current.namespace, 'loc-022-r1', '拒绝态不得改动激活登记')
    }
  } finally {
    ctx.cleanup()
  }
})

test('单激活纪律：切换成功路径（需平台允许跨进程信号）', {
  skip: process.platform === 'win32' ? 'Windows 不适用' : false,
}, async (t) => {
  // 能力探测须在测试体内做（skip 选项只能同步求值，而探测必须异步轮询：
  // 同步忙等会阻塞事件循环导致子进程无法被回收，探针永远误判「信号不可用」）
  if (!(await signalsSupported())) {
    return t.skip('本环境禁止跨进程信号（kill 不生效），切换成功路径改由人工 UAT 覆盖')
  }
  const ctx = await setupSwitchScene('vwf-dev-plugin-switch-ok-')
  try {
    const result = await spawnSwitch(ctx, 'loc-020-r1')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已停掉上一个任务（loc-022-r1）的插件，并切换到 loc-020-r1/)
    assert.equal(isRunning(ctx.fakePid), false, '上一个任务的开发环境进程应已被停掉')
    const ledger = JSON.parse(readFileSync(join(ctx.devHome, '.vwf-active-task.json'), 'utf8'))
    assert.equal(ledger.current.namespace, 'loc-020-r1')
  } finally {
    ctx.cleanup()
  }
})

test('开发 DSH 在非固定端口上运行 → 拒绝启动，避免出现第二个实例', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-wrongport-'))
  let fakePid = null
  try {
    const devHome = join(root, 'dev-home')
    mkdirSync(devHome)
    const canonical = realpathSync(devHome)
    const fakePidPath = join(root, 'fake.pid')
    const holder = spawn('/bin/sh', ['-c', `echo $$ > '${fakePidPath}'; exec /bin/sleep 30`], { detached: true })
    return waitForFile(fakePidPath).then(() => {
      fakePid = Number(readFileSync(fakePidPath, 'utf8').trim())
      // 实例在别的端口（49248）上，而固定端口 19527 空闲
      const lsofPath = fakeLsof(root, {
        listenLines: `p${fakePid}\\ncnode\\nf19\\nn127.0.0.1:49248\\n`,
        homeFiles: `p${fakePid}\\ncnode\\nf20\\nn${canonical}/profiles/web/cordis.yml\\nf21\\nn${canonical}/profiles/web/package.json\\n`,
      })
      const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
        encoding: 'utf8',
        env: baseEnv({
          VWF_DEV_DSH_BIN: fakeDsh(root, { marker: join(root, 'spawned') }),
          VWF_DEV_LSOF_BIN: lsofPath,
          VWF_DEV_DSH_HOME: devHome,
          VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
        }),
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /未运行在固定端口 19527/)
      assert.match(result.stderr, /stop --all/)
      assert.equal(existsSync(join(root, 'spawned')), false, '不得再起第二个实例')
    }).finally(() => {
      if (fakePid && isRunning(fakePid)) {
        try { process.kill(-fakePid, 'SIGKILL') } catch { try { process.kill(fakePid, 'SIGKILL') } catch { /* 已退出 */ } }
      }
      rmSync(root, { recursive: true, force: true })
    })
  } catch (error) {
    if (fakePid && isRunning(fakePid)) {
      try { process.kill(-fakePid, 'SIGKILL') } catch { /* 已退出 */ }
    }
    rmSync(root, { recursive: true, force: true })
    throw error
  }
})

test('stop --all：停掉开发实例、清理 pid 登记与激活登记（等待真正退出）', {
  skip: process.platform === 'win32' ? 'Windows 不适用' : false,
}, async (t) => {
  if (!(await signalsSupported())) {
    return t.skip('本环境禁止跨进程信号（kill 不生效），无法验证真实停机')
  }
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-stopall-'))
  const devHome = join(root, 'dev-home')
  mkdirSync(devHome)
  const canonical = realpathSync(devHome)
  const fakePidPath = join(root, 'fake.pid')
  const holder = spawn('/bin/sh', ['-c', `echo $$ > '${fakePidPath}'; exec /bin/sleep 30`], { detached: true })
  let fakePid = null
  try {
    await waitForFile(fakePidPath)
    fakePid = Number(readFileSync(fakePidPath, 'utf8').trim())
    const lsofPath = fakeLsof(root, {
      listenLines: `p${fakePid}\\ncnode\\nf19\\nn127.0.0.1:${TEST_PORT}\\n`,
      homeFiles: `p${fakePid}\\ncnode\\nf20\\nn${canonical}/profiles/web/cordis.yml\\nf21\\nn${canonical}/profiles/web/package.json\\n`,
    })
    writeFileSync(join(devHome, '.vwf-dev-dsh.pid'), `${fakePid}\n`)
    writeFileSync(
      join(devHome, '.vwf-active-task.json'),
      JSON.stringify({
        current: { namespace: 'loc-020-r1', plugin_name: 'loc-020-r1-vwf-deadbeef0000', pid: fakePid, port: Number(TEST_PORT), activated_at: '2026-09-13T11:00:00.000Z' },
        releases: [],
      }, null, 2),
    )

    const result = await new Promise((resolveResult) => {
      const child = spawn(process.execPath, [scriptPath, 'stop', '--all'], {
        env: baseEnv({
          VWF_DEV_DSH_BIN: fakeDsh(root),
          VWF_DEV_LSOF_BIN: lsofPath,
          VWF_DEV_DSH_HOME: devHome,
          VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
        }),
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.once('exit', (code) => resolveResult({ status: code ?? 1, stdout, stderr }))
      child.once('error', (error) => resolveResult({ status: 1, stdout, stderr: String(error) }))
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /开发 DSH 已停止/)
    assert.equal(isRunning(fakePid), false, '开发实例应已被停掉')
    assert.equal(existsSync(join(devHome, '.vwf-dev-dsh.pid')), false, 'pid 登记应被清理')
    const ledger = JSON.parse(readFileSync(join(devHome, '.vwf-active-task.json'), 'utf8'))
    assert.equal(ledger.current, null, '激活登记应清空')
  } finally {
    // 与 setupSwitchScene.cleanup 同口径：失败路径也要兜底杀掉 holder，
    // 否则残留的 `sleep 30` 会拖住 node 退出（默认 stdio 为 pipe 时更明显）
    if (isRunning(fakePid)) {
      try { process.kill(-fakePid, 'SIGKILL') } catch { try { process.kill(fakePid, 'SIGKILL') } catch { /* 已退出 */ } }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stop --task：登记「已停用注销」；--unresolved 如实记录停用未完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-stop-'))
  try {
    const devHome = join(root, 'dev-home')
    mkdirSync(devHome)
    const env = baseEnv({
      VWF_DEV_DSH_BIN: fakeDsh(root),
      VWF_DEV_LSOF_BIN: fakeLsof(root),
      VWF_DEV_DSH_HOME: devHome,
      VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
    })
    const ok = spawnSync(process.execPath, [scriptPath, 'stop', '--task', 'loc-020-r1'], { encoding: 'utf8', env })
    assert.equal(ok.status, 0, ok.stderr)
    let ledger = JSON.parse(readFileSync(join(devHome, '.vwf-active-task.json'), 'utf8'))
    assert.equal(ledger.releases[0].namespace, 'loc-020-r1')
    assert.equal(ledger.releases[0].unresolved, null)

    const unresolved = spawnSync(
      process.execPath,
      [scriptPath, 'stop', '--task', 'loc-020-r2', '--unresolved', '归属会话已消失'],
      { encoding: 'utf8', env },
    )
    assert.equal(unresolved.status, 0, unresolved.stderr)
    assert.match(unresolved.stdout, /停用未完成/)
    ledger = JSON.parse(readFileSync(join(devHome, '.vwf-active-task.json'), 'utf8'))
    assert.equal(ledger.releases.find((r) => r.namespace === 'loc-020-r2').unresolved, '归属会话已消失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('发现多个同一开发 Home 的 DSH 时停止启动（单实例布局下不应出现）', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-multiple-'))
  try {
    const devHome = join(root, 'dev-home')
    const lsofPath = fakeLsof(root, {
      listenLines: `p${process.pid}\\ncnode\\nf19\\nn127.0.0.1:53202\\np${process.ppid}\\ncnode\\nf19\\nn127.0.0.1:57160\\n`,
      homeFiles: `n${devHome}/profiles/web/cordis.yml\\nn${devHome}/profiles/web/package.json\\n`,
    })
    const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root, { marker: join(root, 'spawned') }),
        VWF_DEV_LSOF_BIN: lsofPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /检测到多个使用开发 Home 的 DSH/)
    assert.equal(existsSync(join(root, 'spawned')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PID 文件指向非开发 DSH 进程时不复用，重新启动', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-stale-pid-'))
  try {
    const markerPath = join(root, 'spawned')
    const devHome = join(root, 'dev-home')
    mkdirSync(devHome)
    writeFileSync(join(devHome, '.vwf-dev-dsh.pid'), `${process.pid}\n`)
    const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root, { marker: markerPath }),
        VWF_DEV_LSOF_BIN: fakeLsof(root),
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已启动开发 DSH（固定端口 19527/)
    assert.equal(existsSync(markerPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('开发 Home 为产品 Home 的符号链接时拒绝启动', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-symlink-'))
  try {
    const productHome = join(root, 'product-home')
    const devHome = join(root, 'dev-home-link')
    mkdirSync(productHome)
    symlinkSync(productHome, devHome, 'dir')
    const result = spawnSync(process.execPath, [scriptPath, 'start', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(root),
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
      }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /相同/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status：给出固定端口、本任务命名空间与插件注册名，并重建开发态动态产物', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-status-'))
  try {
    const devHome = join(root, 'dev-home')
    const result = spawnSync(process.execPath, [scriptPath, 'status', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /固定端口：19527（唯一开发入口；不自动漂移）/)
    assert.match(result.stdout, /本任务命名空间：loc-020-r1/)
    assert.match(result.stdout, /本任务插件注册名：loc-020-r1-vwf-/)
    assert.match(result.stdout, /本任务插件停用登记：未登记/)

    const pluginRoot = join(dirname(dirname(scriptPath)), 'packages', 'dsh-visual-workflow')
    assert.equal(existsSync(join(pluginRoot, 'dist', 'dynamic', 'host.js')), true)
    assert.equal(existsSync(join(pluginRoot, 'dist', 'dynamic', 'client.js')), true)
    const kernel = join(devHome, 'visual-workflow', 'validate-core.cjs')
    assert.equal(existsSync(kernel), false, '内核只信插件 dist，不再向开发 Home 复制')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status：提示登记表中当前激活的任务，并在本任务被登记注销后如实显示', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-ledger-'))
  try {
    const devHome = join(root, 'dev-home')
    mkdirSync(devHome)
    writeFileSync(
      join(devHome, '.vwf-active-task.json'),
      JSON.stringify({
        current: { namespace: 'loc-022-r1', plugin_name: 'loc-022-r1-vwf-deadbeef0000', pid: 1, port: 9527, activated_at: '2026-09-13T11:00:00.000Z' },
        releases: [{ namespace: 'loc-020-r1', released_at: '2026-09-13T12:00:00.000Z', unresolved: null }],
      }, null, 2),
    )
    const result = spawnSync(process.execPath, [scriptPath, 'status', '--task', 'loc-020-r1'], {
      encoding: 'utf8',
      env: baseEnv({
        VWF_DEV_LSOF_BIN: fakeLsof(root),
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: join(root, 'product-home'),
      }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /登记表中当前激活的任务：loc-022-r1/)
    assert.match(result.stdout, /⚠️ 登记表中激活的是 loc-022-r1/)
    assert.match(result.stdout, /本任务插件停用登记：已登记停用注销（2026-09-13T12:00:00.000Z）/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function readArgs(path) {
  return readFileSync(path, 'utf8').trim().split('\n')
}

/** 造「上一个任务仍激活、其开发实例仍在跑」的现场（供单激活纪律用例复用）。 */
async function setupSwitchScene(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const devHome = join(root, 'dev-home')
  mkdirSync(devHome)
  const canonical = realpathSync(devHome)
  const fakePidPath = join(root, 'fake.pid')
  // `exec` 让记录的 PID 就是 sleep 本身（无 shell 包装）；detached 让它自成进程组，
  // 与 dev-plugin 的 `kill(-pid)` 语义一致，且不会误伤测试进程组。
  const holder = spawn('/bin/sh', ['-c', `echo $$ > '${fakePidPath}'; exec /bin/sleep 30`], { detached: true })
  await waitForFile(fakePidPath)
  const fakePid = Number(readFileSync(fakePidPath, 'utf8').trim())
  const lsofPath = fakeLsof(root, {
    listenLines: `p${fakePid}\\ncnode\\nf19\\nn127.0.0.1:${TEST_PORT}\\n`,
    homeFiles: `p${fakePid}\\ncnode\\nf20\\nn${canonical}/profiles/web/cordis.yml\\nf21\\nn${canonical}/profiles/web/package.json\\n`,
  })
  writeFileSync(join(devHome, '.vwf-dev-dsh.pid'), `${fakePid}\n`)
  writeFileSync(
    join(devHome, '.vwf-active-task.json'),
    JSON.stringify({
      current: {
        namespace: 'loc-022-r1',
        plugin_name: 'loc-022-r1-vwf-deadbeef0000',
        pid: fakePid,
        port: Number(TEST_PORT),
        activated_at: '2026-09-13T11:00:00.000Z',
      },
      releases: [],
    }, null, 2),
  )
  return {
    root, devHome, lsofPath, fakePid,
    cleanup: () => {
      if (isRunning(fakePid)) {
        try { process.kill(-fakePid, 'SIGKILL') } catch { try { process.kill(fakePid, 'SIGKILL') } catch { /* 已退出 */ } }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 异步启动 dev-plugin 并收集输出。
 *  必须用异步 spawn 而非 spawnSync：spawnSync 会阻塞本进程事件循环，导致「上一个任务的
 *  开发实例」（本测试的子进程）退出后无法被回收成僵尸态，dev-plugin 的 isRunning 永远为真，
 *  从而误判「未能退出」。 */
async function spawnSwitch(ctx, namespace) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [scriptPath, 'start', '--task', namespace], {
      env: baseEnv({
        VWF_DEV_DSH_BIN: fakeDsh(ctx.root),
        VWF_DEV_LSOF_BIN: ctx.lsofPath,
        VWF_DEV_DSH_HOME: ctx.devHome,
        VWF_PRODUCT_DSH_HOME: join(ctx.root, 'product-home'),
      }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.once('exit', (code) => resolveResult({ status: code ?? 1, stdout, stderr }))
    child.once('error', (error) => resolveResult({ status: 1, stdout, stderr: String(error) }))
  })
}

/**
 * 本平台是否真的能终止另一个进程。
 * 某些受沙箱约束的环境里 `process.kill` 不报错但信号被丢弃——此时「切换成功路径」不可自动验证，
 * 用例应显式跳过而不是给出假绿。
 * 必须异步轮询：同步忙等会阻塞事件循环，导致子进程退出后无法被回收（僵尸态），探针永远误判。
 */
async function signalsSupported() {
  const p = spawn('/bin/sh', ['-c', 'exec /bin/sleep 5'], { detached: true, stdio: 'ignore' })
  try {
    try { process.kill(-p.pid, 'SIGTERM') } catch { process.kill(p.pid, 'SIGTERM') }
  } catch {
    return false
  }
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (!isRunning(p.pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  try { process.kill(-p.pid, 'SIGKILL') } catch { /* 已退出 */ }
  return false
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForFile(path) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const check = () => {
      if (existsSync(path)) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`未等到文件：${path}`))
      setTimeout(check, 20)
    }
    check()
  })
}
