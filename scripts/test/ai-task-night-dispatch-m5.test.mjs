import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dispatcher = path.join(root, 'scripts/ai-task-dispatcher.mjs')

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function parseStderr(result) {
  try { return JSON.parse(result.stderr) } catch {
    assert.fail(`应返回 JSON 原因，stdout=${result.stdout}\nstderr=${result.stderr}`)
  }
}

test('M5 检查确认本地登记册调度已退役', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/ai-task-night-dispatch-m5-check.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(out.state, 'historical')
  assert.equal(out.blockedReason, 'legacy_registry_dispatcher_disabled')
})

test('M5 dispatcher flags all fail closed without touching ledgers, reports, Runs, or GitHub', (t) => {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'm5-retired-dispatch-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const ledgerDir = path.join(repo, 'docs/tasks')
  fs.mkdirSync(ledgerDir, { recursive: true })
  const registry = path.join(ledgerDir, 'registry.json')
  const board = path.join(ledgerDir, 'BOARD.md')
  fs.writeFileSync(registry, '{"version":1,"tasks":[]}\n')
  fs.writeFileSync(board, '# historical board\n')
  const schedule = path.join(repo, 'schedule.json')
  fs.writeFileSync(schedule, JSON.stringify({
    project: repo,
    batchName: 'must-not-run',
    machineConfig: '.scratch/night-batches/machine.json',
    taskSource: { readyLabel: 'ready-for-agent', labelSync: true },
  }, null, 2) + '\n')

  const ghBin = path.join(repo, 'bin')
  const ghLog = path.join(repo, 'gh.log')
  fs.mkdirSync(ghBin)
  const gh = path.join(ghBin, 'gh')
  fs.writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALL_LOG"\nexit 0\n')
  fs.chmodSync(gh, 0o755)
  const env = {
    ...process.env,
    PATH: `${ghBin}:${process.env.PATH || ''}`,
    GH_CALL_LOG: ghLog,
  }
  const before = [hash(registry), hash(board), hash(schedule)]

  for (const args of [[], [schedule], [schedule, '--now'], [schedule, '--now', '--preview'], [schedule, '--dry-run']]) {
    const result = spawnSync(process.execPath, [dispatcher, ...args], {
      encoding: 'utf8',
      cwd: repo,
      env,
    })
    assert.equal(result.status, 2, `args=${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`)
    const out = parseStderr(result)
    assert.equal(out.code, 'legacy_registry_dispatcher_disabled')
    assert.match(out.effects, /未读取 registry\.json/)
    assert.match(out.effects, /未查询或写入 GitHub/)
    assert.match(out.effects, /未启动 Run/)
  }

  assert.deepEqual([hash(registry), hash(board), hash(schedule)], before)
  assert.equal(fs.existsSync(ghLog), false, 'dispatcher 不得调用 gh')
  assert.equal(fs.existsSync(path.join(repo, '.scratch/night-batches')), false, '不得生成批次报告')
  assert.equal(fs.existsSync(path.join(repo, '.agent-runs')), false, '不得启动 Run')
})
