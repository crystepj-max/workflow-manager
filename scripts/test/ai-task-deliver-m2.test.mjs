import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('M2 机械验收脚本通过', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/ai-task-deliver-m2-check.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /"auto_rework_limit": 3/)
  assert.match(r.stdout, /conditional_pass/)
})
