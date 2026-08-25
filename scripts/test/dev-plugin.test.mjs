import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const scriptPath = fileURLToPath(new URL('../dev-plugin.mjs', import.meta.url))

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

function readArgs(path) {
  return readFileSync(path, 'utf8').trim().split('\n')
}
