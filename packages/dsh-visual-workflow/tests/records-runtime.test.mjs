// Formal Records 运行时集成（LOC-008）：宿主侧接线验收（fake fs/subprocess + 真实内核）
// records-host 子进程边界用 makeSubprocess 回调替身，但回调内驱动真实的
// records-host.mjs 命令函数（仅伪造进程边界，不伪造内核语义）。覆盖：
//   W1 vwf.records.commit / list / get RPC 接线（含重启后按 logical_run_id 直查磁盘）
//   W2 RPC 参数校验 fail-closed
//   W3 wf_run 收尾单一通道：node_result 逐节点 + verifyBranch 强制 Proof（绑定
//      verified_* / workspace）+ 摘要 formal_records 互相引用落盘
//   W4 提交失败非阻断：records host 业务错误不推翻运行专业结果
//   W5 vwf.artifacts.ingest 双写：legacy formalRecords 保留 + 正式 Store 入库，响应兼容
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'
import { recordsCommit, recordsList, recordsGet } from '../../../scripts/records-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const RECORDS_COMMANDS = { commit: recordsCommit, list: recordsList, get: recordsGet }
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }

// 规格图：impl（实现）→ review（verifyBranch 可信度闸门）→ closeout（收口）。
// review 的 schema 必填 verified_branch / verified_head（校验内核对 verifyBranch 的硬约束）。
const BP = {
  id: 'records-spec', displayName: 'Formal Records 规格图', description: '', entry: 'impl',
  control: { maxRounds: 9 },
  bindings: { models: { impl: { provider: 'p1', model: 'm1' }, review: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p1', model: 'm1' } } },
  nodes: [
    { id: 'impl', profile: 'developer', label: '实现', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'review', profile: 'reviewer', label: '审核', goal: 'g', verifyBranch: true, output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS'] }, verified_branch: { type: 'string' }, verified_head: { type: 'string' } }, required: ['verdict', 'verified_branch', 'verified_head'] }, outcomePath: '$.verdict' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
  ],
  edges: [
    { from: 'impl', to: 'review', outcome: 'PASS' },
    { from: 'review', to: 'closeout', outcome: 'PASS' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}

const RUN_VALUE = {
  status: 'DONE',
  results: {
    impl: { verdict: 'PASS', patch: 'v1' },
    review: { verdict: 'PASS', verified_branch: 'dev-loc-008-r1', verified_head: 'head-A' },
    closeout: { result: 'done' },
  },
  history: [],
}

const WS_HOST_STUB = '// workspace-isolation-host stub（测试种子）'

// records-host 进程边界替身：把宿主给的 fake records_dir 重映射到真实临时目录，
// 命令逻辑走真实 records-host.mjs（磁盘权威，天然覆盖「重启后可查」）
const realRecordsHost = (dir) => (cmd, input) => RECORDS_COMMANDS[cmd]({ ...input, records_dir: dir })
const wsHostStub = (cmd) => {
  if (cmd === 'allocate') {
    return { ok: true, workspace: { workspace_id: 'ws-1', workspace_path: '/tmp/ws-1', source_path: '/tmp/ws-1/source', records_path: '/tmp/ws-1/records', work_branch: 'dev-x', source_revision: 'rev-1', workspace_mode: 'ISOLATED_WRITE' } }
  }
  if (cmd === 'context') return { ok: true, workspace: null, events: [] }
  return { ok: true }
}

const RECORDS_HOST_SRC = readFileSync(join(here, '..', '..', '..', 'scripts', 'records-host.mjs'), 'utf8')

function env({ value = RUN_VALUE, recordsHost = null, wsHost = null, seed = {}, engineCapture = null } = {}) {
  const base = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [REPO + '/scripts/workspace-isolation-host.mjs']: WS_HOST_STUB,
    [REPO + '/scripts/records-host.mjs']: RECORDS_HOST_SRC,
    [USER_DIR + '/records-spec.json']: JSON.stringify(BP, null, 2) + '\n',
    [SKILL_ROOT + '/records-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  Object.assign(base, seed)
  const fs = makeFs(base)
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT', recordsHost, wsHost })
  const engine = {
    start: (spec) => {
      if (engineCapture) engineCapture(spec)
      return { id: 'run-1', result: Promise.resolve({ stopReason: 'completed', value, agentsStarted: 2 }) }
    },
  }
  const { handlers, definedTools, ctx, events } = loadHost({
    fs, subprocess: sub, sandboxPolicy, workflowEngine: engine,
    agents: { requireInitiator: () => ({}) },
  })
  const tool = definedTools.find((t) => t.name === 'wf_run')
  return { handlers, tool, ctx, events, fs, sub }
}

const readLogical = (fs, id) => JSON.parse(fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'))

test('W3 wf_run 收尾单一通道：逐节点 Record + verifyBranch 强制 Proof（workspace 绑定）+ 摘要互相引用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-records-host-'))
  const { tool, sub, fs } = env({ recordsHost: realRecordsHost(dir), wsHost: wsHostStub })
  const out = JSON.parse(await tool.execute({ templateId: 'records-spec', taskId: 'task-1' }))
  assert.equal(out.stopReason, 'completed')
  assert.equal(out.value.status, 'DONE')
  await drain()

  // 提交载荷：3 个 node_result + review 的 proof（顺序与节点完成顺序一致）
  const commitCall = sub._calls.map((a) => a.join(' ')).find((s) => s.includes('records-host.mjs') && s.includes(' commit '))
  assert.ok(commitCall, 'wf_run 收尾发起了 records-host commit')
  const payload = JSON.parse(sub._calls.find((a) => a.join(' ') === commitCall)[sub._calls.find((a) => a.join(' ') === commitCall).length - 1])
  assert.equal(payload.logical_run_id, 'task-1')
  assert.deepEqual(payload.entries.map((e) => e.type + ':' + e.record_id), [
    'node_result:node:task-1:impl',
    'node_result:node:task-1:review',
    'proof:proof:task-1:review',
    'node_result:node:task-1:closeout',
  ], 'verifyBranch 节点在收尾强制加发 Proof')
  const proof = payload.entries.find((e) => e.type === 'proof')
  assert.equal(proof.body_value.verified_head, 'head-A')
  assert.equal(proof.body_value.verified_branch, 'dev-loc-008-r1')
  assert.equal(proof.body_value.workspace.source_path, '/tmp/ws-1/source', 'Proof 记录 workspace 绑定')
  assert.equal(payload.entries[0].provenance.produced_by, 'vwf:runtime')
  assert.ok(payload.entries[0].provenance.attempt >= 1)

  // Store 真实落盘 + 摘要互相引用落盘
  const list = recordsList({ records_dir: dir, logical_run_id: 'task-1' })
  assert.equal(list.record_count, 4)
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.formal_records.record_count, 4, '运行摘要 formal_records 引用已刷新')
})

test('W1 vwf.records.list / get：重启后按 logical_run_id 查询磁盘 Store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-records-host-'))
  const { handlers } = env({ recordsHost: realRecordsHost(dir) })
  const c = await handlers.get('vwf.records.commit')({
    logical_run_id: 'task-9',
    entries: [{ type: 'node_result', record_id: 'node:task-9:impl', provenance: { logical_run_id: 'task-9', node: 'impl', attempt: 1, snapshot_revision: '1', provider: 'p', model: 'm', produced_by: 't', node_business_outcome: null }, body_value: { verdict: 'PASS' } }],
  })
  assert.equal(c.ok, true, JSON.stringify(c))
  const l = await handlers.get('vwf.records.list')({ logical_run_id: 'task-9' })
  assert.equal(l.found, true)
  assert.equal(l.record_count, 1)
  assert.equal(l.records[0].record_id, 'node:task-9:impl')
  const g = await handlers.get('vwf.records.get')({ logical_run_id: 'task-9', record_id: 'node:task-9:impl' })
  assert.equal(g.found, true)
  assert.equal(g.current_revision, 1)
  const miss = await handlers.get('vwf.records.list')({ logical_run_id: 'ghost' })
  assert.equal(miss.found, false)
})

test('W2 vwf.records.* 参数校验 fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-records-host-'))
  const { handlers } = env({ recordsHost: realRecordsHost(dir) })
  assert.equal((await handlers.get('vwf.records.commit')({ entries: [{}] })).ok, false)
  assert.equal((await handlers.get('vwf.records.commit')({ logical_run_id: 't' })).ok, false)
  assert.equal((await handlers.get('vwf.records.list')({})).ok, false)
  assert.equal((await handlers.get('vwf.records.get')({ logical_run_id: 't' })).ok, false)
})

test('W4 提交失败非阻断：records host 业务错误不推翻运行结果', async () => {
  const { tool, fs } = env({ recordsHost: () => ({ ok: false, error: 'records 业务故障' }), wsHost: wsHostStub })
  const out = JSON.parse(await tool.execute({ templateId: 'records-spec', taskId: 'task-1' }))
  assert.equal(out.stopReason, 'completed', '记录失败不影响运行完成')
  assert.equal(out.value.status, 'DONE')
  await drain()
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.formal_records, null, '未成功提交时摘要保持 null，不伪造引用')
})

test('W5 vwf.artifacts.ingest 双写：legacy 保留 + 正式 Store 入库，响应兼容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-records-host-'))
  const { handlers, events } = env({ recordsHost: realRecordsHost(dir) })
  events.get('workflow/start')({ id: 'run-art', meta: { name: 'artifact-test' } })
  const res = await handlers.get('vwf.artifacts.ingest')({
    runId: 'run-art',
    nodeId: 'writer',
    artifacts: [{ path: 'out/data.json', kind: 'json', content: '{"n":1}' }],
  })
  assert.equal(res.ok, true, res.errors && res.errors[0] && res.errors[0].message)
  assert.equal(res.produced, 1)
  assert.equal(res.formalRecords.length, 1, 'legacy formalRecords 字段保留')
  assert.equal(res.formalRecords[0].body.value.n, 1)
  assert.equal(res.store_committed.logical_run_id, 'run-art', 'Store 提交按逻辑运行身份入档')
  assert.equal(res.store_committed.committed[0].record_id, 'artifact:run-art:writer:out/data.json')
  const l = await handlers.get('vwf.records.list')({ logical_run_id: 'run-art' })
  assert.equal(l.record_count, 1)
  assert.deepEqual(l.records[0].body, { media_type: 'application/json', value: { n: 1 } })
})

test('W5b artifacts.ingest：records host 不可用时 legacy 行为不受影响', async () => {
  const { handlers, events } = env({ recordsHost: () => ({ ok: false, error: 'boom' }) })
  events.get('workflow/start')({ id: 'run-art2', meta: {} })
  const res = await handlers.get('vwf.artifacts.ingest')({
    runId: 'run-art2',
    nodeId: 'writer',
    artifacts: [{ path: 'a.md', kind: 'markdown', content: '# hi' }],
  })
  assert.equal(res.ok, true)
  assert.equal(res.formalRecords.length, 1)
  assert.equal(res.store_committed, null)
})
