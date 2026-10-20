// WFM-342：分支保留不再由冻结登记册的 branch_retained 字段判定。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'validate-workspace.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'wfm342-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'wfm342-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wfm342-branch-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n')
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  // Malformed legacy data proves this validator does not parse the retired source.
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), '{not-json\n')
  for (const args of [['add', '-A'], ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  return { base, repo }
}

function validate(repo) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--json'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('D-10：忽略旧 branch_retained 字段及坏格式 registry', () => {
  const { repo } = fixture()
  const out = validate(repo)
  const d10 = out.results.find((r) => r.id === 'D-10')
  assert.equal(d10?.ok, null)
  assert.equal(d10?.skipped, true)
  assert.match(d10.details.join(' '), /不读取 registry/)
})
