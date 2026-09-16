// Formal Records 运行时集成（LOC-008）：records-host.mjs 包装脚本验收
// 真实子进程 + 真实临时目录（每次命令调用 = 独立进程 + 磁盘权威状态，
// 因此「重启后可查」由调用形态天然覆盖）。覆盖：
//   R1 节点结果追加成 Record + 同节点重复完成形成 Revision 链（I1 → I2）
//   R2 verifyBranch Proof 签发：绑定 verified_branch / verified_head / workspace，
//      依赖 = 签发时全部节点记录当前 Revision（验收②）
//   R3 产生 I2 后，依赖 I1 的 RV1/T1 被 coverageStatus 判 not_covering_current，
//      旧 Proof 保留不删、标记 stale（验收①）
//   R4 E2E 反例：另一 HEAD（H2）签发后的 Store 里，H1 的 Proof 不为当前 Revision
//      背书（coversRevision 对 I@2 为 false），仍为 I@1 背书
//   R5 多格式产物 artifact 条目经 parseArtifactBody 定 body，record_id 沿 #69 约定
//   R6 与运行摘要互相引用：logical_run_ref 内嵌并随提交刷新
//   R7 CLI 边界：exit code 与 stdout JSON 契约；非法输入报业务错误
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest8 } from '../revision-dependencies.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const RECORDS_HOST = join(here, '..', 'records-host.mjs')

const recordsDir = () => mkdtempSync(join(tmpdir(), 'vwf-records-'))

function prov(extra = {}) {
  return {
    logical_run_id: 'task-1',
    node: 'impl',
    attempt: 1,
    snapshot_revision: '1',
    provider: 'p1',
    model: 'm1',
    produced_by: 'vwf:runtime',
    node_business_outcome: null,
    ...extra,
  }
}

// 每次调用走真实 CLI 子进程：与产品运行形态一致（独立进程 + 磁盘权威）
function cli(cmd, input) {
  const stdout = execFileSync(process.execPath, [RECORDS_HOST, cmd, JSON.stringify(input)], { encoding: 'utf8' })
  return JSON.parse(stdout)
}

function nodeEntry(nodeId, value, extra = {}) {
  return {
    type: 'node_result',
    record_id: 'node:task-1:' + nodeId,
    provenance: prov({ node: nodeId, node_business_outcome: value.verdict ?? null }),
    body_value: value,
    ...extra,
  }
}

function proofEntry(nodeId, head, implBody = { verdict: 'ok' }, extra = {}) {
  return {
    type: 'proof',
    record_id: 'proof:task-1:' + nodeId,
    provenance: prov({ node: nodeId, produced_by: 'vwf:runtime:proof' }),
    body_value: {
      node: nodeId,
      verified_branch: 'dev-loc-008-r1',
      verified_head: head,
      workspace: { workspace_id: 'ws-1', source_path: '/tmp/ws-1/source', work_branch: 'dev-loc-008-r1' },
    },
    resolved_inputs: {
      mode: 'declared',
      items: [{ binding: 'from_impl', producer: 'impl', version_ref: 'tmp-exec:1:' + digest8(implBody) }],
    },
    ...extra,
  }
}

test('R1 节点结果追加成 Record；同节点重复完成形成 Revision 链（I1 → I2）', () => {
  const dir = recordsDir()
  const c1 = cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { verdict: 'ok', patch: 'a' })] })
  assert.equal(c1.ok, true)
  assert.deepEqual(c1.committed, [{ record_id: 'node:task-1:impl', record_revision: 1, kind: 'result' }])
  const c2 = cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { verdict: 'ok', patch: 'b' })] })
  assert.deepEqual(c2.committed, [{ record_id: 'node:task-1:impl', record_revision: 2, kind: 'result' }], '同 record_id 追加分配 Revision 2')
  const list = cli('list', { records_dir: dir, logical_run_id: 'task-1' })
  const implRev2 = list.records.find((r) => r.record_id === 'node:task-1:impl' && r.record_revision === 2)
  assert.deepEqual(implRev2.based_on, { record_id: 'node:task-1:impl', record_revision: 1 }, 'I2 based_on I1（Revision 链）')
  assert.deepEqual(implRev2.dependencies, [{ record_id: 'node:task-1:impl', record_revision: 1 }])
})

test('R2 verifyBranch Proof 签发：绑定 verified_* / workspace，依赖当前节点 Revision', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { verdict: 'ok' })] })
  const cp = cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [proofEntry('review', 'head-A')] })
  assert.equal(cp.committed[0].kind, 'proof_decision')
  const list = cli('list', { records_dir: dir, logical_run_id: 'task-1' })
  const proof = list.records.find((r) => r.record_id === 'proof:task-1:review')
  assert.equal(proof.body.value.verified_head, 'head-A')
  assert.equal(proof.body.value.verified_branch, 'dev-loc-008-r1')
  assert.equal(proof.body.value.workspace.source_path, '/tmp/ws-1/source', 'Proof 记录 workspace 绑定')
  assert.deepEqual(proof.dependencies, [{ record_id: 'node:task-1:impl', record_revision: 1 }], 'Proof 依赖签发时 I 的当前 Revision')
})

test('R3 产生 I2 后，依赖 I1 的 RV1 判 not_covering_current（stale，保留不删）', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { verdict: 'ok', v: 1 })] })
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [proofEntry('review', 'head-A', { verdict: 'ok', v: 1 })] })
  // I2（同节点重新完成）出现后，RV1 仍保留但不再覆盖当前 Revision
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { verdict: 'ok', v: 2 })] })
  const list = cli('list', { records_dir: dir, logical_run_id: 'task-1' })
  assert.equal(list.records.length, 3, '旧 Proof 保留不删（I1/I2/RV1）')
  const cov = list.coverage.filter((c) => c.proof.record_id === 'proof:task-1:review' && c.target_record_id === 'node:task-1:impl')
  assert.equal(cov.length, 1)
  assert.equal(cov[0].status, 'not_covering_current')
  assert.equal(cov[0].stale, true)
  const get = cli('get', { records_dir: dir, logical_run_id: 'task-1', record_id: 'node:task-1:impl' })
  assert.equal(get.current_revision, 2)
  assert.equal(get.coverage.length, 1)
  assert.equal(get.coverage[0].status, 'not_covering_current')
  assert.equal(get.coverage[0].stale, true)
})

test('R3b 审核后再测试：T1 直接依赖 I，I2 后 T1 同判 stale（契约典型链）', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { v: 1 })] })
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [proofEntry('review', 'head-A', { v: 1 })] })
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [proofEntry('test', 'head-A', { v: 1 })] })
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { v: 2 })] })
  const list = cli('list', { records_dir: dir, logical_run_id: 'task-1' })
  for (const pid of ['proof:task-1:review', 'proof:task-1:test']) {
    const cov = list.coverage.find((c) => c.proof.record_id === pid && c.target_record_id === 'node:task-1:impl')
    assert.equal(cov.status, 'not_covering_current', pid + ' 依赖 I1，I2 后 stale')
  }
})

test('R4 E2E 反例：另一 HEAD 的 Proof 不为当前 Revision 背书', () => {
  const dir = recordsDir()
  // head-A 上：I1 + RV1（verified_head=head-A）
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { v: 1 })] })
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [proofEntry('review', 'head-A', { v: 1 })] })
  // head-B 上：I2 重新完成（verified_head=head-B 的新 Proof 另记）
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', entries: [nodeEntry('impl', { v: 2 }), proofEntry('review', 'head-B', { v: 2 })] })
  const get = cli('get', { records_dir: dir, logical_run_id: 'task-1', record_id: 'node:task-1:impl' })
  assert.equal(get.current_revision, 2)
  const byProof = Object.fromEntries(get.coverage.map((c) => [c.proof.record_revision, c]))
  assert.equal(byProof[1].status, 'not_covering_current', 'head-A 的 RV1 不为当前 Revision I@2 背书')
  assert.equal(byProof[2].status, 'covering', 'head-B 的 RV2 才为 I@2 背书')
  const list = cli('list', { records_dir: dir, logical_run_id: 'task-1' })
  const rv1 = list.records.find((r) => r.record_id === 'proof:task-1:review' && r.record_revision === 1)
  assert.equal(rv1.body.value.verified_head, 'head-A', '旧 Proof 的 HEAD 绑定保留可追溯')
  assert.equal(rv1.dependencies.some((d) => d.record_id === 'node:task-1:impl' && d.record_revision === 2), false, 'RV1 依赖不含 I@2')
  assert.equal(rv1.dependencies.some((d) => d.record_id === 'node:task-1:impl' && d.record_revision === 1), true, 'RV1 依赖恰好是 I@1')
})

test('R5 artifact 条目：#69 record_id 约定 + parseArtifactBody 定 body', () => {
  const dir = recordsDir()
  const c = cli('commit', {
    records_dir: dir,
    logical_run_id: 'task-1',
    entries: [{
      type: 'artifact',
      record_id: 'artifact:run-9:report:report.html',
      provenance: prov({ node: 'report', produced_by: 'vwf:artifacts.ingest' }),
      kind: 'html',
      body_value: '<html>ok</html>',
    }],
  })
  assert.equal(c.ok, true)
  const list = cli('list', { records_dir: dir, logical_run_id: 'task-1' })
  const art = list.records[0]
  assert.equal(art.record_id, 'artifact:run-9:report:report.html')
  assert.deepEqual(art.body, { media_type: 'text/html', value: '<html>ok</html>' })
  // 同路径再次入库 → Revision 2（多格式产物重复入库走正式 Store 链）
  const c2 = cli('commit', {
    records_dir: dir,
    logical_run_id: 'task-1',
    entries: [{
      type: 'artifact',
      record_id: 'artifact:run-9:report:report.html',
      provenance: prov({ node: 'report', produced_by: 'vwf:artifacts.ingest' }),
      kind: 'html',
      body_value: '<html>v2</html>',
    }],
  })
  assert.equal(c2.committed[0].record_revision, 2)
})

test('R6 与运行摘要互相引用：logical_run_ref 内嵌并随提交刷新', () => {
  const dir = recordsDir()
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', logical_run_ref: { state: 'RUNNING', title: 'T', template_id: 'tpl', task_id: 'task-1' }, entries: [nodeEntry('impl', { v: 1 })] })
  const file = join(dir, encodeURIComponent('task-1') + '.json')
  const first = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(first.logical_run_ref.state, 'RUNNING')
  cli('commit', { records_dir: dir, logical_run_id: 'task-1', logical_run_ref: { state: 'COMPLETED', title: 'T', template_id: 'tpl', task_id: 'task-1' }, entries: [nodeEntry('closeout', { v: 1 })] })
  const second = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(second.logical_run_ref.state, 'COMPLETED', '引用随提交刷新')
  assert.equal(second.record_count, 2)
})

test('R7 CLI 边界：未知命令 exit 2；业务错误 exit 1 且 stdout 为 { ok:false }', () => {
  if (process.platform === 'win32') return
  assert.throws(
    () => execFileSync(process.execPath, [RECORDS_HOST, 'nope', '{}'], { encoding: 'utf8' }),
    (e) => e.status === 2,
    '未知命令退出码 2',
  )
  const raw = execFileSync(process.execPath, [RECORDS_HOST, 'list', JSON.stringify({ records_dir: recordsDir(), logical_run_id: 'ghost' })], { encoding: 'utf8' })
  const out = JSON.parse(raw)
  assert.equal(out.found, false, '未提交过的逻辑运行按缺失返回而非报错')
  const bad = (() => {
    try {
      return execFileSync(process.execPath, [RECORDS_HOST, 'commit', JSON.stringify({ records_dir: recordsDir(), logical_run_id: 't', entries: [{ type: 'nope' }] })], { encoding: 'utf8' })
    } catch (e) {
      assert.equal(e.status, 1, '业务错误退出码 1')
      return String(e.stdout || '')
    }
  })()
  const parsed = JSON.parse(bad)
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /非法 entry\.type/)
})
