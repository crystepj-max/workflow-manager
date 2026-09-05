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

test('开发启动可显式使用 DSH 测试替身，不依赖 PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-command-'))
  try {
    const bin = join(root, 'bin')
    const markerPath = join(root, 'spawned')
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const dshPath = join(root, 'fake-dsh')
    mkdirSync(bin)
    writeFileSync(dshPath, `#!/bin/sh
: > '${markerPath}'
exit 0
`)
    chmodSync(dshPath, 0o755)

    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin,
        VWF_DEV_DSH_BIN: dshPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
        DSH_HOME: undefined,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(markerPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PID 文件缺失时发现并接管同一开发 Home 的现有 DSH', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-discovery-'))
  try {
    const bin = join(root, 'bin')
    const markerPath = join(root, 'spawned')
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const dshPath = join(root, 'fake-dsh')
    const lsofPath = join(root, 'fake-lsof')
    mkdirSync(bin)
    writeFileSync(dshPath, `#!/bin/sh
: > '${markerPath}'
exit 0
`)
    writeFileSync(lsofPath, `#!/bin/sh
case "$*" in
  *-iTCP*) printf 'p${process.pid}\\ncnode\\nf19\\nn127.0.0.1:53202\\n' ;;
  *) printf 'p${process.pid}\\ncnode\\nf20\\nn${devHome}/settings.yaml\\nf21\\nn${devHome}/profiles/web/cordis.yml\\nf22\\nn${devHome}/profiles/web/package.json\\n' ;;
esac
`)
    chmodSync(dshPath, 0o755)
    chmodSync(lsofPath, 0o755)

    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin,
        VWF_DEV_DSH_BIN: dshPath,
        VWF_DEV_LSOF_BIN: lsofPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
        DSH_HOME: undefined,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已发现.*无需重复启动/)
    assert.equal(existsSync(markerPath), false)
    assert.equal(
      Number(readFileSync(join(devHome, '.vwf-dev-dsh.pid'), 'utf8').trim()),
      process.pid,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('发现多个同一开发 Home 的 DSH 时停止启动', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-multiple-'))
  try {
    const markerPath = join(root, 'spawned')
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const dshPath = join(root, 'fake-dsh')
    const lsofPath = join(root, 'fake-lsof')
    writeFileSync(dshPath, `#!/bin/sh
: > '${markerPath}'
exit 0
`)
    writeFileSync(lsofPath, `#!/bin/sh
case "$*" in
  *-iTCP*) printf 'p${process.pid}\\ncnode\\nf19\\nn127.0.0.1:53202\\np${process.ppid}\\ncnode\\nf19\\nn127.0.0.1:57160\\n' ;;
  *) printf 'n${devHome}/profiles/web/cordis.yml\\nn${devHome}/profiles/web/package.json\\n' ;;
esac
`)
    chmodSync(dshPath, 0o755)
    chmodSync(lsofPath, 0o755)

    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VWF_DEV_DSH_BIN: dshPath,
        VWF_DEV_LSOF_BIN: lsofPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
        DSH_HOME: undefined,
      },
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /检测到多个使用开发 Home 的 DSH/)
    assert.equal(existsSync(markerPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PID 文件指向非开发 DSH 进程时不复用', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-stale-pid-'))
  try {
    const markerPath = join(root, 'spawned')
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const dshPath = join(root, 'fake-dsh')
    const lsofPath = join(root, 'fake-lsof')
    mkdirSync(devHome)
    writeFileSync(join(devHome, '.vwf-dev-dsh.pid'), `${process.pid}\n`)
    writeFileSync(dshPath, `#!/bin/sh
: > '${markerPath}'
exit 0
`)
    writeFileSync(lsofPath, `#!/bin/sh
exit 0
`)
    chmodSync(dshPath, 0o755)
    chmodSync(lsofPath, 0o755)

    const result = spawnSync(process.execPath, [scriptPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VWF_DEV_DSH_BIN: dshPath,
        VWF_DEV_LSOF_BIN: lsofPath,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
        DSH_HOME: undefined,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已使用隔离 Home 启动开发 DSH/)
    assert.equal(existsSync(markerPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
        VWF_DEV_DSH_BIN: dshPath,
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
        VWF_DEV_DSH_BIN: dshPath,
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
    const lsofPath = join(root, 'fake-lsof')
    mkdirSync(devHome)
    const canonicalDevHome = realpathSync(devHome)
    const env = {
      ...process.env,
      VWF_DEV_DSH_BIN: dshPath,
      VWF_DEV_LSOF_BIN: lsofPath,
      VWF_DEV_DSH_HOME: devHome,
      VWF_PRODUCT_DSH_HOME: productHome,
      DSH_HOME: undefined,
    }
    mkdirSync(bin)
    writeFileSync(dshPath, `#!/bin/sh
echo $$ > '${fakePidPath}'
/bin/sleep 30
`)
    writeFileSync(lsofPath, `#!/bin/sh
if [ -f '${fakePidPath}' ]; then
  pid=$(/bin/cat '${fakePidPath}')
  case "$*" in
    *-iTCP*) printf 'p%s\\ncnode\\nf19\\nn127.0.0.1:54321\\n' "$pid" ;;
    *) printf 'p%s\\ncnode\\nf20\\nn${canonicalDevHome}/profiles/web/cordis.yml\\nf21\\nn${canonicalDevHome}/profiles/web/package.json\\n' "$pid" ;;
  esac
fi
`)
    chmodSync(dshPath, 0o755)
    chmodSync(lsofPath, 0o755)

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

test('status 把校验内核与仓库指针同步到开发 Home', () => {
  const root = mkdtempSync(join(tmpdir(), 'vwf-dev-plugin-kernel-'))
  try {
    const devHome = join(root, 'dev-home')
    const productHome = join(root, 'product-home')
    const result = spawnSync(process.execPath, [scriptPath, 'status'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VWF_DEV_DSH_HOME: devHome,
        VWF_PRODUCT_DSH_HOME: productHome,
        DSH_HOME: undefined,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const kernel = join(devHome, 'visual-workflow', 'validate-core.cjs')
    const pointer = join(devHome, 'visual-workflow', 'repo-root')
    assert.equal(existsSync(kernel), true, '应复制 scripts/validate-core.cjs')
    assert.match(readFileSync(kernel, 'utf8'), /validateBlueprint/)
    assert.equal(readFileSync(pointer, 'utf8').trim(), dirname(dirname(scriptPath)))
  } finally {
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
