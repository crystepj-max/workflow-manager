import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('M3 机械验收脚本通过', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/ai-task-execution-plan-m3-check.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
