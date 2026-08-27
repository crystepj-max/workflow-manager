import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const scriptPath = fileURLToPath(new URL('../dev-plugin.mjs', import.meta.url))

test('开发 Home 为产品 Home 的符号链接时拒绝启动', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-symlink-'))
  try {
    const bin = join(root, 'bin')
    const markerPath = join(root, 'spawned')
    const productHome = join(root, 'product-home')
    const devHome = join(root, 'dev-home-link')
    const dshPath = join(bin, 'dsh')
    mkdirSync(bin)
    mkdirSync(productHome)
    symlinkSync(productHome, devHome, 'dir')
    writeFileSync(dshPath, `#!/bin/sh
touch '${markerPath}'
exit 0
`)
    chmodSync(dshPath, 0o755)

    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
      },
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /相同/)
    assert.equal(existsSync(markerPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('开发启动使用空闲端口，避免与产品 DSH 冲突', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-'))
  try {
    const bin = join(root, 'bin')
    const argsPath = join(root, 'args.txt')
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const dshPath = join(bin, 'dsh')
    mkdirSync(bin)
    writeFileSync(dshPath, `#!/bin/sh
printf '%s\\n' "$@" > '${argsPath}'
exit 0
`)
    chmodSync(dshPath, 0o755)

    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
        DSH_HOME: undefined,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      readArgs(argsPath),
      ['web', '--port', '0'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PID 文件记录分离的 DSH 子进程，启动器结束后仍能识别运行状态', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-pid-'))
  let fakePid = null
  try {
    const bin = join(root, 'bin')
    const fakePidPath = join(root, 'fake-dsh.pid')
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const dshPath = join(bin, 'dsh')
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      VWF_DEV_DSH_HOME: devHome,
      VWF_PRODUCT_DSH_HOME: productHome,
      DSH_HOME: undefined,
    }
    mkdirSync(bin)
    writeFileSync(dshPath, `#!/bin/sh
echo $$ > '${fakePidPath}'
sleep 30
`)
    chmodSync(dshPath, 0o755)

    const launcher = spawn(process.execPath, [scriptPath, 'start'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForOutput(launcher, 'DSH PID')
    await waitForFile(fakePidPath)

    fakePid = Number(readFileSync(fakePidPath, 'utf8').trim())
    const recordedPid = Number(
      readFileSync(join(devHome, '.vwf-dev-dsh.pid'), 'utf8').trim(),
    )
    assert.equal(recordedPid, fakePid)
    assert.notEqual(recordedPid, launcher.pid)

    process.kill(launcher.pid, 'SIGKILL')
    await waitForExit(launcher)
    assert.equal(isRunning(fakePid), true)

    const secondStart = spawnSync(process.execPath, [scriptPath, 'start'], {
      cwd: root,
      encoding: 'utf8',
      env,
    })
    assert.equal(secondStart.status, 0, secondStart.stderr)
    assert.match(secondStart.stdout, /无需重复启动/)
    assert.equal(
      Number(readFileSync(join(devHome, '.vwf-dev-dsh.pid'), 'utf8').trim()),
      fakePid,
    )
  } finally {
    if (fakePid && isRunning(fakePid)) {
      try {
        process.kill(-fakePid, 'SIGTERM')
      } catch {
        process.kill(fakePid, 'SIGTERM')
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function readArgs(path) {
  return readFileSync(path, 'utf8').trim().split('\n')
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`未等到启动输出：${expected}\n${output}`))
    }, 5000)
    const onData = (chunk) => {
      output += chunk.toString()
      if (!output.includes(expected)) return
      clearTimeout(timer)
      resolve(output)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`启动器提前结束 code=${code} signal=${signal}\n${output}`))
    })
  })
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
