import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
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

// ===== FIX-76：依赖判定结合主干合并事实（双源判定）=====
// collectMergeFacts 仅识别 LOC-/FEAT-/FIX-/CHORE- 前缀任务号，故依赖号用这些前缀；
// 该判定需仓库为 git 且有主干历史，故本组用独立 git 夹具（与上面仅登记册判定的 tmpRepo 区分）。
function gitTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-76-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
  return dir
}

function gitCommit(repo, message) {
  const f = path.join(repo, `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`)
  fs.writeFileSync(f, message)
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', message])
}

test('FIX-76 验收#1：依赖已 git 合并但登记册滞后 → 依赖方进候选', () => {
  const repo = gitTmpRepo()
  gitCommit(repo, 'feat: 依赖任务已合并 (FEAT-900 V1)') // 制造主干合并事实
  writeRegistry(repo, [
    rec('FEAT-900', '本地已定义', { deps: [] }), // 登记册滞后：未记合并
    rec('TASK-001', '本地已定义', { deps: ['FEAT-900'] }),
  ])
  const r = collectLocalCandidates({ repo })
  assert.ok(r.candidates.some((c) => c.id === 'TASK-001'), '依赖方应进入候选（不被依赖排除）')
  assert.ok(!r.excluded.some((e) => e.id === 'TASK-001'), '依赖方不应出现在排除列表')
})

test('FIX-76 验收#2：依赖无合并痕迹且非已合并 → 排除并标注', () => {
  const repo = gitTmpRepo()
  // 不提交任何合并事实
  writeRegistry(repo, [
    rec('FEAT-901', '本地已定义', { deps: [] }),
    rec('TASK-002', '本地已定义', { deps: ['FEAT-901'] }),
  ])
  const r = collectLocalCandidates({ repo })
  assert.ok(!r.candidates.some((c) => c.id === 'TASK-002'), '依赖方应被排除')
  const ex = r.excluded.find((e) => e.id === 'TASK-002')
  assert.ok(ex, '依赖方应出现在排除列表')
  assert.match(ex.reason, /依赖未满足/)
  assert.match(ex.reason, /主干无合并痕迹/)
})

test('FIX-76 回归：依赖登记册已合并（无 git 事实）→ 仍进候选', () => {
  const repo = gitTmpRepo()
  writeRegistry(repo, [
    rec('FEAT-902', '已合并', { deps: [] }),
    rec('TASK-003', '本地已定义', { deps: ['FEAT-902'] }),
  ])
  const r = collectLocalCandidates({ repo })
  assert.ok(r.candidates.some((c) => c.id === 'TASK-003'), '依赖方应进入候选')
})
