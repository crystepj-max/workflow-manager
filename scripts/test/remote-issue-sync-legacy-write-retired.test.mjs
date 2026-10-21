import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { guessType, pendingTasks } from '../remote-issue-sync.mjs'

const SCRIPT = path.resolve(import.meta.dirname, '../remote-issue-sync.mjs')

test('旧 GitHub Task 同步命令全部 fail-closed，不读取登记册或调用 GitHub', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'remote-task-sync-retired-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ghDir = path.join(dir, 'bin')
  const ghLog = path.join(dir, 'gh.log')
  fs.mkdirSync(ghDir)
  const gh = path.join(ghDir, 'gh')
  fs.writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALL_LOG"\nexit 0\n')
  fs.chmodSync(gh, 0o755)
  const env = { ...process.env, PATH: `${ghDir}:${process.env.PATH || ''}`, GH_CALL_LOG: ghLog }

  for (const args of [['plan'], ['apply'], ['reissue', '--task', 'LOC-901']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args, '--repo', dir], {
      encoding: 'utf8',
      cwd: dir,
      env,
    })
    assert.equal(result.status, 2, `args=${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`)
    const out = JSON.parse(result.stderr)
    assert.equal(out.code, 'legacy_github_task_sync_disabled')
    assert.match(out.effects, /未读取 registry\.json/)
    assert.match(out.effects, /未查询或写入 GitHub Issue/)
  }
  assert.equal(fs.existsSync(ghLog), false)
})

test('历史纯函数导出仍可供归档与兼容测试使用', () => {
  assert.equal(guessType({ name: '清理缓存残留' }), 'CHORE')
  assert.equal(guessType({ name: '新增交付看板' }), 'FEAT')
  const registry = {
    tasks: [
      { task_id: 'LOC-001', status: '本地已定义', remote: null },
      { task_id: 'LOC-002', status: '已合并', remote: null },
      { task_id: 'LOC-003', status: '本地已定义', remote: 'github#8' },
      { task_id: 'TMP-a-260916a', status: '定义中', remote: 'pending' },
    ],
  }
  assert.deepEqual(pendingTasks(registry).map((task) => task.task_id), ['LOC-001', 'TMP-a-260916a'])
  assert.deepEqual(pendingTasks(registry, ['LOC-001']).map((task) => task.task_id), ['LOC-001'])
})
