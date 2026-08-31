// cwf-evidence-verify.mjs 测试：§8.3 九项校验，合成证据链正例 + 九项各一负例
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyEvidenceChain } from '../cwf-evidence-verify.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BASE_ACCEPTANCE = ['验收标准A', '验收标准B']
const HEAD = 'head-final'
const BRANCH = 'dev-cwf-test-01'

function makeRunDir(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'cwf-ev-'))
  const runDir = join(root, '.agent-runs', 'cwf-ev-01')
  mkdirSync(runDir, { recursive: true })
  const run = {
    run_id: 'cwf-ev-01', issue_or_task_identity: '#999', workspace_id: 'wt-ev',
    repository: 'r', base_ref: 'main', base_commit: 'abc', work_branch: BRANCH,
    current_head: HEAD, stage: 'human_acceptance', attempt: 1,
  }
  const env = (record_type, stage, produced_by, payload) => ({
    record_type, record_version: 'v0.1.8', created_at: '2026-08-31T00:00:00Z',
    produced_by, run: { ...run, stage }, payload,
  })
  const records = {
    'requirements_baseline.json': env('requirements_baseline', 'requirements', 'dsh:dev', {
      goal: 'g', scope: { include: ['a'], exclude: ['b'] }, acceptance: BASE_ACCEPTANCE,
      gaps: [], status: 'confirmed', outcome: 'baseline_ready',
      baseline_revision: 'v1', human_confirmation: { confirmed_by: 'human', confirmed_at: '2026-08-31T00:00:00Z' },
    }),
    'design_package.json': env('design_package', 'design', 'dsh:dev', {
      summary: 's', outcome: 'package_ready', decision_required: false,
    }),
    'dev_handoff.json': env('dev_handoff', 'dev', 'dsh:dev', {
      summary: 's', outcome: 'handoff_ready', changes: [], self_check: [{ check: 'c', result: 'pass' }],
    }),
    'review_proof.a1.json': env('review_proof', 'review', 'ext:reviewer', {
      verdict: 'approve', findings: [], verified_branch: BRANCH, verified_head: HEAD, independent_session: true,
    }),
    'test_proof.a1.json': env('test_proof', 'test', 'ext:tester', {
      verdict: 'pass',
      acceptance_mapping: BASE_ACCEPTANCE.map(a => ({ acceptance_item: a, result: 'pass' })),
      findings: [], verified_branch: BRANCH, verified_head: HEAD, independent_session: true,
    }),
  }
  const assembled = {
    requirements_baseline_ref: 'requirements_baseline.json',
    design_package_ref: 'design_package.json',
    dev_handoff_ref: 'dev_handoff.json',
    review_proof_ref: 'review_proof.a1.json',
    test_proof_ref: 'test_proof.a1.json',
    integration_checkpoint: { target_ref: 'main', target_head_at_check: HEAD, target_advanced: false, proofs_state: 'still_valid' },
  }
  records['acceptance_package.a1.json'] = env('acceptance_package', 'human_acceptance', 'dsh:dev', {
    status: 'awaiting_decision', assembled,
  })
  if (mutate) mutate(records, run)
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2))
  writeFileSync(join(runDir, 'index.json'), JSON.stringify({
    acceptance_package: 'acceptance_package.a1.json',
  }, null, 2))
  for (const [f, rec] of Object.entries(records)) {
    writeFileSync(join(runDir, f), JSON.stringify(rec, null, 2))
  }
  return runDir
}

function checkOk(result, id) {
  const c = result.checks.find(c => c.id === id)
  return c ? c.ok : null
}

test('正例：完整合法证据链全部九项通过', () => {
  const result = verifyEvidenceChain(makeRunDir())
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 1))
  assert.equal(result.checks.length, 9)
})

test('① record_type 与 Stage 映射错配被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['review_proof.a1.json'].run.stage = 'dev'
  }))
  assert.equal(checkOk(r, '①'), false)
  assert.equal(r.ok, false)
})

test('② review 非 approve 被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['review_proof.a1.json'].payload.verdict = 'request_changes'
    rs['review_proof.a1.json'].payload.findings = [{ finding: 'f', root_cause: 'dev' }]
  }))
  assert.equal(checkOk(r, '②'), false)
})

test('③ lineage 断裂被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['test_proof.a1.json'].run.run_id = 'other-run'
  }))
  assert.equal(checkOk(r, '③'), false)
})

test('④ Proof HEAD 不一致被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['test_proof.a1.json'].payload.verified_head = 'old-head'
  }))
  assert.equal(checkOk(r, '④'), false)
})

test('⑤ baseline 未 confirmed 被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['requirements_baseline.json'].payload.status = 'draft'
  }))
  assert.equal(checkOk(r, '⑤'), false)
})

test('⑥ design 命中门未决被拒；chosen 不在呈递候选集被拒', () => {
  const pending = verifyEvidenceChain(makeRunDir(rs => {
    rs['design_package.json'].payload.outcome = 'decision_required'
  }))
  assert.equal(checkOk(pending, '⑥'), false)
  const badChoice = verifyEvidenceChain(makeRunDir(rs => {
    const p = rs['design_package.json'].payload
    p.outcome = 'package_ready'
    p.decision_required = true
    p.decision_required_reasons = ['r']
    p.decision_request = { question: 'q', options: [{ name: 'A', tradeoffs: 't' }], recommendation: 'A' }
    p.decision = { question: 'q', options: [{ name: 'A', tradeoffs: 't' }], chosen: 'B', rationale: 'r', decided_by: 'x', decided_at: '2026-08-31T00:00:00Z' }
  }))
  assert.equal(checkOk(badChoice, '⑥'), false)
})

test('⑦ dev 非 handoff_ready 被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['dev_handoff.json'].payload.outcome = 'blocked'
  }))
  assert.equal(checkOk(r, '⑦'), false)
})

test('⑧ 验收映射缺失基线条目被拒；重复被拒', () => {
  const missing = verifyEvidenceChain(makeRunDir(rs => {
    rs['test_proof.a1.json'].payload.acceptance_mapping = [{ acceptance_item: '验收标准A', result: 'pass' }]
  }))
  assert.equal(checkOk(missing, '⑧'), false)
  const dup = verifyEvidenceChain(makeRunDir(rs => {
    rs['test_proof.a1.json'].payload.acceptance_mapping = [
      { acceptance_item: '验收标准A', result: 'pass' },
      { acceptance_item: '验收标准A', result: 'pass' },
      { acceptance_item: '验收标准B', result: 'pass' },
    ]
  }))
  assert.equal(checkOk(dup, '⑧'), false)
})

test('⑧ user_accepted 例外：完整映射但含 fail，feedback 必填', () => {
  const dir = makeRunDir(rs => {
    rs['test_proof.a1.json'].payload.verdict = 'fail'
    rs['test_proof.a1.json'].payload.findings = [{ finding: 'f', root_cause: 'dev' }]
    rs['test_proof.a1.json'].payload.acceptance_mapping[1].result = 'fail'
    rs['acceptance_package.a1.json'].payload = {
      status: 'decided', assembled: rs['acceptance_package.a1.json'].payload.assembled,
      decision: 'user_accepted', decided_by: 'human', decided_at: '2026-08-31T00:00:00Z',
      feedback: '知情接受：B 未达', verified_branch: BRANCH, verified_head: HEAD,
    }
  })
  const strict = verifyEvidenceChain(dir)
  assert.equal(strict.ok, false) // accept 路径被拒
  const relaxed = verifyEvidenceChain(dir, { relaxedUserAccepted: true })
  assert.equal(relaxed.ok, true, JSON.stringify(relaxed.checks, null, 1)) // 例外通道放行
})

test('④ 实况 HEAD 为准：proof 绑定滞后 run.json 被拒，run.json 缓存滞后实况被拒', () => {
  // 新增提交后实况 HEAD 前进，proof 还绑旧 HEAD → 拒
  const staleProof = verifyEvidenceChain(makeRunDir(), { live: { head: 'head-new', branch: BRANCH } })
  assert.equal(checkOk(staleProof, '④'), false)
  // run.json current_head 落后于实况 → 拒（先 reverify）
  const staleRun = verifyEvidenceChain(makeRunDir((_rs, run) => { run.current_head = 'older' }), { live: { head: HEAD, branch: BRANCH } })
  assert.equal(checkOk(staleRun, '④'), false)
})

test('③ 全部记录同写错误 workspace_id（与 run.json 不符）被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    for (const rec of Object.values(rs)) rec.run.workspace_id = 'ws-wrong'
  }))
  assert.equal(checkOk(r, '③'), false)
})

test('⑥ 命中门但缺 decision_request 被拒（呈递候选集丢失）', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    const p = rs['design_package.json'].payload
    p.outcome = 'package_ready'
    p.decision_required = true
    p.decision_required_reasons = ['r']
    p.decision = { question: 'q', options: [{ name: 'A', tradeoffs: 't' }], chosen: 'A', rationale: 'r', decided_by: 'x', decided_at: '2026-08-31T00:00:00Z' }
    // 注意：无 decision_request
  }))
  assert.equal(checkOk(r, '⑥'), false)
})

test('⑨ review/test 与 dev 同源被拒', () => {
  const r = verifyEvidenceChain(makeRunDir(rs => {
    rs['review_proof.a1.json'].produced_by = 'dsh:dev'
  }))
  assert.equal(checkOk(r, '⑨'), false)
})
