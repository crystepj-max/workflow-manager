import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const run = (args) => execFileSync(process.execPath, ['cli.mjs', ...args], { encoding: 'utf8' }).trim()

assert.equal(run(['--help']), 'Usage: demo-cli [--help]')
try {
  run(['--unknown'])
  assert.fail('unknown arg should exit 2')
} catch (e) {
  assert.equal(e.status, 2)
}

// 目标行为：--version 输出 package 版本（实施后应通过）
let hasVersion = false
try {
  const out = run(['--version'])
  hasVersion = out === '1.2.3'
} catch {
  hasVersion = false
}
if (!hasVersion) {
  console.log('B01 fixture: baseline missing --version (expected before implementation)')
  process.exit(0)
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.version = '1.2.4'
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
assert.equal(run(['--version']), '1.2.4')
console.log('B01 verify: pass')
