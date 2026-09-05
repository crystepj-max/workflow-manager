import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const checker = path.join(root, 'scripts/ai-task-define-m1-check.mjs')

test('M1：公共契约 + 模板 + 双示例落档机械验收', () => {
  const r = spawnSync(process.execPath, [checker], { encoding: 'utf8', cwd: root })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PASSED/)
  assert.match(r.stdout, /auto_rework_limit.: 3/)
  assert.match(r.stdout, /CONDITIONAL_PASS/)
})
