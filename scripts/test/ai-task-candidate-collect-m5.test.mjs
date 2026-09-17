import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectLocalCandidates,
  scanOpenRuns,
  slugForTaskId,
} from '../ai-task-candidate-collect.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nb-collect-'))
}

function writeRegistry(repo, tasks) {
  fs.mkdirSync(path.join(repo, 'docs/tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'docs/tasks/registry.json'),
    JSON.stringify({ version: 1, tasks }, null, 2) + '\n',
  )
}

function rec(id, status, extra = {}) {
  return { task_id: id, name: `任务${id}`, status, slug: id.toLowerCase(), deps: [], env_group: id, env_role: '独立', ...extra }
}

test('slugForTaskId 产出 run_id 安全形态', () => {
  assert.equal(slugForTaskId('LOC-031'), 'loc-031')
  assert.equal(slugForTaskId('FIX-72'), 'fix-72')
  assert.equal(slugForTaskId('CHORE_36 X'), 'chore-36-x')
})

test('采集：状态闸门（仅本地已定义/已定义入围）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [
    rec('PASS-001', '本地已定义'),
    rec('DEF-001', '已定义'),
    rec('DEFINING-001', '定义中'),
    rec('MERGED-001', '已合并'),
    rec('WAIT-001', '等待验收'),
  ])
  const r = collectLocalCandidates({ repo })
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['DEF-001', 'PASS-001'])
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.id, e.reason]))
  assert.match(reasons['DEFINING-001'], /状态=定义中/)
  assert.match(reasons['MERGED-001'], /已合并/)
  assert.match(reasons['WAIT-001'], /等待验收/)
  assert.equal(r.excluded.every((e) => e.stage === '采集闸门'), true)
})

test('采集：已有未收口 run 排除（run.json 为权威事实）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [
    rec('RUN-001', '本地已定义'),
    rec('CLEAN-001', '本地已定义'),
  ])
  const runDir = path.join(repo, '.agent-runs/run-001-r1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'run-001-r1', issue_or_task_identity: '#RUN-001', stage: 'human_acceptance' }))
  const r = collectLocalCandidates({ repo })
  assert.deepEqual(r.candidates.map((c) => c.id), ['CLEAN-001'])
  assert.match(r.excluded[0].reason, /已有未收口 run（run-001-r1 stage=human_acceptance/)
})

test('采集：已收口 run 不再排除（stage=closed 视为收口）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [rec('DONE-001', '本地已定义')])
  const runDir = path.join(repo, '.agent-runs/done-001-r1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'done-001-r1', issue_or_task_identity: '#DONE-001', stage: 'closed' }))
  assert.equal(scanOpenRuns(repo).filter((r) => r.open).length, 0)
  const r = collectLocalCandidates({ repo })
  assert.deepEqual(r.candidates.map((c) => c.id), ['DONE-001'])
})

test('采集：依赖未满足与环境组先导排除，黑名单生效', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [
    rec('DEP-OK-001', '本地已定义', { deps: ['MERGED-001'] }),
    rec('DEP-BAD-001', '本地已定义', { deps: ['DEFINING-001'] }),
    rec('MERGED-001', '已合并'),
    rec('DEFINING-001', '定义中'),
    rec('ENV-M-001', '本地已定义', { env_group: 'G-1', env_role: '成员' }),
    rec('ENV-I-001', '已合并', { env_group: 'G-1', env_role: '独立' }),
    rec('ENV-M-002', '本地已定义', { env_group: 'G-2', env_role: '成员' }),
    rec('ENV-I-002', '定义中', { env_group: 'G-2', env_role: '独立' }),
    rec('BLACK-001', '本地已定义'),
  ])
  const r = collectLocalCandidates({ repo, blacklist: ['BLACK-001'] })
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['DEP-OK-001', 'ENV-M-001'])
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.id, e.reason]))
  assert.match(reasons['DEP-BAD-001'], /依赖未满足（DEFINING-001/)
  assert.match(reasons['ENV-M-002'], /环境组先导未完成（env_group=G-2/)
  assert.match(reasons['BLACK-001'], /黑名单/)
})

test('采集：候选携带 issue/spec 路径与优先级（供 M3 机械门禁用）', () => {
  const repo = tmpRepo()
  writeRegistry(repo, [
    rec('PASS-001', '本地已定义', { priority: 'P1', spec_path: 'docs/tasks/specs/pass-001/task-spec-V1.md' }),
  ])
  const r = collectLocalCandidates({ repo })
  const c = r.candidates[0]
  assert.equal(c.issueBasics, path.join('docs/tasks', 'PASS-001-pass-001.md'))
  assert.equal(c.taskSpec, 'docs/tasks/specs/pass-001/task-spec-V1.md')
  assert.equal(c.priority, 'P1')
})
