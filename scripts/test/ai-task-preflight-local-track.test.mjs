import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/ai-task-preflight-check.mjs')

test('旧任务卡 preflight CLI 已停用并明确转向 Multica 门禁', (t) => {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'preflight-retired-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  fs.mkdirSync(path.join(repo, 'docs/tasks'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs/tasks/registry.json'), '{"version":1,"tasks":[]}\n')
  fs.writeFileSync(path.join(repo, 'docs/tasks/BOARD.md'), '# historical board\n')

  const result = spawnSync(process.execPath, [
    script,
    path.join(repo, 'task-basics.md'),
    path.join(repo, 'task-spec-V1.md'),
    '--repo', repo,
  ], { encoding: 'utf8', cwd: repo })

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
  const out = JSON.parse(result.stderr)
  assert.equal(out.code, 'legacy_task_preflight_disabled')
  assert.match(out.reason, /construction-preflight-gate\.mjs/)
  assert.match(out.effects, /未读取任务卡或 registry\.json/)
  assert.equal(fs.readFileSync(path.join(repo, 'docs/tasks/registry.json'), 'utf8'), '{"version":1,"tasks":[]}\n')
  assert.equal(fs.readFileSync(path.join(repo, 'docs/tasks/BOARD.md'), 'utf8'), '# historical board\n')
})
