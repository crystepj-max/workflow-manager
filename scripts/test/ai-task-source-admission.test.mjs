import test from 'node:test'
import assert from 'node:assert/strict'

import {
  planTaskSourceAdmission,
  pendingLabelSync,
  STAGE_TASK_SOURCE,
} from '../ai-task-candidate-collect.mjs'

const REG = [
  { task_id: 'FIX-224', remote: 'github#224' },
  { task_id: 'FIX-225', remote: 'github#225' },
  { task_id: 'FIX-226', remote: 'github#226' },
  { task_id: 'LOC-020', remote: 'none' },
  { task_id: 'CHORE-111', remote: 'cnb#111 + github#215' },
]
const CAND = [
  { id: 'FIX-224', name: 'A' },
  { id: 'FIX-225', name: 'B' },
  { id: 'FIX-226', name: 'C' },
  { id: 'LOC-020', name: 'D' },
]
const READY = [{ number: 224, title: 'ready 224' }, { number: 225, title: 'claimed 225' }, { number: 999, title: 'orphan 999' }]

test('准入：ready / claimed / no-anchor / not-ready 四态分流', () => {
  const r = planTaskSourceAdmission({
    registryTasks: REG,
    candidates: CAND,
    readyIssues: READY,
    claimedBy: new Map([[225, 'someone@host']]),
  })
  assert.equal(r.available, true)
  assert.equal(r.verdicts.get('FIX-224').status, 'ready')
  assert.equal(r.verdicts.get('FIX-225').status, 'claimed')
  assert.equal(r.verdicts.get('FIX-225').holder, 'someone@host')
  assert.equal(r.verdicts.get('FIX-226').status, 'not-ready') // 有锚点但远端未打标签
  assert.equal(r.verdicts.get('LOC-020').status, 'no-anchor') // remote=none
  assert.deepEqual(r.tally, { ready: 1, notReady: 1, claimed: 1, noAnchor: 1 })
})

test('准入：他人已认领是硬排除（防重复施工），理由带 issue 号与认领人', () => {
  const r = planTaskSourceAdmission({
    registryTasks: REG, candidates: CAND, readyIssues: READY,
    claimedBy: new Map([[225, 'someone@host']]),
  })
  assert.deepEqual(r.preExcluded.map((e) => e.id), ['FIX-225'])
  assert.equal(r.preExcluded[0].stage, STAGE_TASK_SOURCE)
  assert.match(r.preExcluded[0].reason, /#225/)
  assert.match(r.preExcluded[0].reason, /someone@host/)
})

test('准入：无锚点默认放行（历史 LOC-/离线仓依赖此路径），只在报告标注', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, readyIssues: READY })
  assert.equal(r.verdicts.get('LOC-020').status, 'no-anchor')
  assert.ok(!r.preExcluded.some((e) => e.id === 'LOC-020'))
  assert.ok(!r.orphans.some((o) => o.id === 'LOC-020'))
})

test('准入：requireAnchor=true 时无锚点任务也排除', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, readyIssues: READY, requireAnchor: true })
  const ex = r.preExcluded.find((e) => e.id === 'LOC-020')
  assert.ok(ex)
  assert.match(ex.reason, /requireAnchor/)
})

test('准入：远端就绪但本地无对应任务 → 归因「缺本地定义」', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, readyIssues: READY })
  const orphan = r.orphans.find((o) => o.id === 'github#999')
  assert.ok(orphan)
  assert.match(orphan.reason, /缺本地定义/)
  assert.equal(orphan.stage, STAGE_TASK_SOURCE)
})

test('准入：远端就绪但本地任务未进候选 → 归因「本地采集闸门未过」', () => {
  const r = planTaskSourceAdmission({
    registryTasks: REG,
    candidates: CAND.filter((c) => c.id !== 'FIX-226'),
    readyIssues: [...READY, { number: 226, title: 'ready 226' }],
  })
  const orphan = r.orphans.find((o) => o.id === 'github#226')
  assert.ok(orphan)
  assert.match(orphan.reason, /FIX-226/)
  assert.match(orphan.reason, /本地采集闸门未过/)
})

test('准入：双锚点取值按 github 一侧匹配（cnb#111 + github#215）', () => {
  const r = planTaskSourceAdmission({
    registryTasks: REG,
    candidates: [{ id: 'CHORE-111', name: 'E' }],
    readyIssues: [{ number: 215, title: 'chore111' }],
  })
  assert.equal(r.verdicts.get('CHORE-111').status, 'ready')
})

test('远端不可达 + block（默认）：全体硬排除并标记 blocked', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, remoteError: 'gh: not logged in' })
  assert.equal(r.available, false)
  assert.equal(r.blocked, true)
  assert.deepEqual(r.preExcluded.map((e) => e.id).sort(), ['FIX-224', 'FIX-225', 'FIX-226', 'LOC-020'])
  assert.match(r.note, /gh: not logged in/)
  assert.match(r.note, /阻断/)
})

test('远端不可达 + local-only：不排除，但 note 显著标注降级（不静默）', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, remoteError: 'boom', onUnavailable: 'local-only' })
  assert.equal(r.blocked, false)
  assert.deepEqual(r.preExcluded, [])
  assert.match(r.note, /local-only/)
  assert.match(r.note, /降级/)
})

test('准入：非法 onUnavailable 直接抛错（不猜）', () => {
  assert.throws(
    () => planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, onUnavailable: 'whatever' }),
    /onUnavailable/,
  )
})

test('pendingLabelSync：只挑「门禁已过但远端缺标签」的任务', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, readyIssues: READY })
  const need = pendingLabelSync([{ id: 'FIX-224' }, { id: 'FIX-226' }, { id: 'LOC-020' }], r.verdicts)
  assert.deepEqual(need, [{ id: 'FIX-226', issueNumber: 226 }])
})

test('pendingLabelSync：未参与准入判定的任务不补标（不误伤）', () => {
  const r = planTaskSourceAdmission({ registryTasks: REG, candidates: CAND, readyIssues: READY })
  assert.deepEqual(pendingLabelSync([{ id: 'UNKNOWN-1' }], r.verdicts), [])
})
