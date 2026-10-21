import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('M4 本地登记册定时触发器已退役', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/ai-task-scheduled-m4-check.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'historical')
  assert.equal(out.cli, 'legacy_scheduler_disabled')
})
