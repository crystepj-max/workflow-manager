// Integration Gate 宿主编排验收（LOC-017）：fake engine + 真内核（workspace-isolation /
// records-host / integration-gate 全部真实，仅伪造进程边界与引擎）。覆盖：
//   W1 UAT-01 主场景：目标前进 → 自动锁 → 自动同步 → 同步证据新 Revision → 自动重跑
//      审核/测试 → 新 Proof 覆盖 → 放行进入人工验收（同一逻辑运行追加段）
//   W2 UAT-03 / B10：集成锁被占用 → BLOCKED 提示占用方，不重跑，锁释放后可恢复
//   W3 UAT-05 / B3：目标未前进 → 直接放行，不重跑不产生新产物版本
//   W4 §11 冲突：自动同步冲突 → fail closed BLOCKED + 冲突清单，锁不悬挂
//   W5 B1：非 Git ISOLATED_WRITE（SANDBOX）不触发闸门
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'
import { recordsCommit, recordsList, recordsGet, recordsAssertIntegration, recordsAssertCandidates } from '../../../scripts/records-host.mjs'
import {
  createRegistry, allocateWorkspace, getRunWorkspace, setLifecycle,
  recordSourceSync, computeIntegrationCheckpointFromRepo,
  acquireLock, releaseLock, activeLockFor, integrationResourceKey,
  captureCandidate, compareCandidate,
} from '../../../scripts/workspace-isolation.mjs'
import { planTargetSync, mergeTarget, buildSyncRecordEntry, integrationSyncRecordId } from '../../../scripts/integration-gate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const RUNS_DIR = DSH_HOME + '/visual-workflow/runs'
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')
const RECORDS_HOST_SRC = readFileSync(join(here, '..', '..', '..', 'scripts', 'records-host.mjs'), 'utf8')
const WS_HOST_STUB = '// workspace-isolation-host stub（测试种子：进程边界由 fake subprocess 顶替）'
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

// 真实 git 临时仓库（目标分支 main 的载体）
function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'vwf-gate-repo-'))
  git(['init', '-q', '-b', 'main', '--template='], root)
  git(['config', 'user.email', 't@t'], root)
  git(['config', 'user.name', 't'], root)
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', 'init'], root)
  const cleanups = []
  after(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  return root
}

function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content)
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', message], repo)
  return git(['rev-parse', 'HEAD'], repo)
}

function commitInWorktree(ws, file, content, message) {
  writeFileSync(join(ws.source_path, file), content)
  git(['add', '-A'], ws.source_path)
  git(['commit', '-q', '-m', message], ws.source_path)
  return git(['rev-parse', 'HEAD'], ws.source_path)
}

// LOC-026：与宿主同口径的候选捕获摘要（排除项=Run 产物目录），供 fixture 自报 candidate_sha256
function captureSha(realWs, runId) {
  return captureCandidate(getRunWorkspace(realWs.registry, runId), { exclude: ['.agent-runs/' + runId] }).version.content_sha256
}

// 规格图：impl → review(verifyBranch) → test(verifyBranch) → uat → $human-decision
const BP = {
  id: 'gate-spec', displayName: '集成闸门规格图', description: '', entry: 'preflight',
  control: { maxRounds: 9 },
  bindings: { models: { preflight: { provider: 'p1', model: 'm1' }, impl: { provider: 'p1', model: 'm1' }, review: { provider: 'p1', model: 'm1' }, test: { provider: 'p1', model: 'm1' }, uat: { provider: 'p1', model: 'm1' }, closeout: { provider: 'p1', model: 'm1' } } },
  nodes: [
    { id: 'preflight', profile: 'evaluator', label: '实施前检查', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['PASS', 'BLOCKED'] } }, required: ['route'] }, outcomePath: '$.route' } },
    { id: 'impl', profile: 'developer', label: '实现', goal: 'g', output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['READY'] } }, required: ['verdict'] }, outcomePath: '$.verdict' } },
    { id: 'review', profile: 'reviewer', label: '收敛审查', goal: 'g', verifyBranch: true, output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['APPROVE', 'RETURN_DEV'] }, verified_branch: { type: 'string' }, verified_head: { type: 'string' } }, required: ['verdict', 'verified_branch', 'verified_head'] }, outcomePath: '$.verdict' } },
    { id: 'test', profile: 'tester', label: '测试', goal: 'g', verifyBranch: true, output: { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['PASS', 'RETURN_DEV'] }, verified_branch: { type: 'string' }, verified_head: { type: 'string' } }, required: ['verdict', 'verified_branch', 'verified_head'] }, outcomePath: '$.verdict' } },
    { id: 'uat', profile: 'uat', label: 'UAT 准备', goal: 'g', output: { schema: { type: 'object', properties: { status: { type: 'string', enum: ['READY_FOR_HUMAN'] } }, required: ['status'] }, outcomePath: '$.status' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
  ],
  edges: [
    { from: 'preflight', to: 'impl', outcome: 'PASS' },
    { from: 'preflight', to: '$end', outcome: 'BLOCKED' },
    { from: 'impl', to: 'review', outcome: 'READY' },
    { from: 'review', to: 'test', outcome: 'APPROVE' },
    { from: 'review', to: 'impl', outcome: 'RETURN_DEV' },
    { from: 'test', to: 'uat', outcome: 'PASS' },
    { from: 'test', to: 'impl', outcome: 'RETURN_DEV' },
    { from: 'uat', to: '$human-decision', outcome: 'READY_FOR_HUMAN' },
    { from: '$human-decision', to: 'closeout', outcome: 'ACCEPT' },
    { from: '$human-decision', to: 'impl', outcome: 'REJECT' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}

const hdPackage = (decisionId) => ({ question: '验收？', options: ['ACCEPT', 'REJECT'], chosen: null, rationale: '', decided_by: 'human', decided_at: '', decision_id: decisionId })

// 真实内核的 ws 进程边界替身：注册表常驻内存，git/锁/同步全走真内核
function makeRealWsHost({ repo, sandboxMode = false } = {}) {
  const registry = createRegistry()
  const workRoot = mkdtempSync(join(tmpdir(), 'vwf-gate-workroot-'))
  after(() => { try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* ignore */ } })
  return {
    registry,
    workRoot,
    wsHost(cmd, input) {
      const wrap = (fn) => { try { return fn() } catch (e) { return { ok: false, error: String((e && e.message) || e) } } }
      switch (cmd) {
        case 'allocate':
          return wrap(() => {
            const ws = allocateWorkspace(registry, {
              logical_run_id: input.logical_run_id,
              workspace_id: 'ws-' + input.logical_run_id,
              mode: sandboxMode ? 'SANDBOX' : 'ISOLATED_WRITE',
              work_root: workRoot,
              repository_path: repo,
              base_ref: input.base_ref || 'main',
              task_identity: input.task_identity || input.logical_run_id,
              allow_parallel: !!input.allow_parallel,
            })
            return { ok: true, workspace: ws }
          })
        case 'get':
          return wrap(() => ({ ok: true, workspace: getRunWorkspace(registry, input.logical_run_id) }))
        case 'context':
          return wrap(() => {
            let ws = null
            try { ws = getRunWorkspace(registry, input.logical_run_id) } catch (e) { /* 未分配 */ }
            return { ok: true, workspace: ws, events: registry.timeline.slice(), cleanup: null }
          })
        case 'setLifecycle':
          return wrap(() => ({ ok: true, workspace: setLifecycle(registry, input.logical_run_id, input.lifecycle, input.extra || {}) }))
        case 'gatePlan':
          return wrap(() => planTargetSync(registry, input.logical_run_id, input.target_ref))
        case 'gateSyncEntry':
          return wrap(() => ({ ok: true, entry: buildSyncRecordEntry({ logicalRunId: input.logical_run_id, target_head: input.target_head, previous_synced_head: input.previous_synced_head, integrated_before: input.integrated_before, merge_result: input.merge_result, attempt: input.attempt, snapshot_revision: input.snapshot_revision }) }))
        case 'syncTarget':
          return wrap(() => {
            const plan = planTargetSync(registry, input.logical_run_id, input.target_ref)
            if (!plan.ok) return plan
            const merged = mergeTarget(plan)
            if (!merged.ok) return merged
            const ws = recordSourceSync(registry, input.logical_run_id, {})
            return { ok: true, target_head: merged.target_head, integrated_before: merged.integrated_before, merge_result: merged.merge_result, current_head: ws.current_head, source_revision: ws.source_revision, resource_key: plan.resource_key }
          })
        case 'acquireLock':
          return wrap(() => ({ ok: true, lock: acquireLock(registry, { logical_run_id: input.logical_run_id, resource_key: input.resource_key, owner: input.owner, ttl_ms: input.ttl_ms }) }))
        case 'releaseLock':
          return wrap(() => ({ ok: true, lock: releaseLock(registry, { lock_id: input.lock_id, owner: input.owner, logical_run_id: input.logical_run_id, reason: input.reason }) }))
        case 'activeLockFor':
          return wrap(() => ({ ok: true, lock: activeLockFor(registry, input.resource_key) || null }))
        case 'computeIntegrationCheckpointFromRepo':
          // 与真实 wrapper 同形状：checkpoint 嵌套一层（防 fake 与真实契约脱节）
          return wrap(() => ({ ok: true, checkpoint: computeIntegrationCheckpointFromRepo(input) }))
        case 'captureCandidate':
          // LOC-026：真实内核候选捕获（范围选项由宿主注入，与真实 wrapper 同契约）
          return wrap(() => ({ ok: true, candidate: captureCandidate(getRunWorkspace(registry, input.logical_run_id), input.options || {}) }))
        case 'compareCandidate':
          return wrap(() => ({ ok: true, compare: compareCandidate(input.current, input.expected) }))
        default:
          return { ok: false, error: '未知 ws 命令: ' + cmd }
      }
    },
  }
}

const realRecordsHost = (dir) => (cmd, input) => {
  const fns = { commit: recordsCommit, list: recordsList, get: recordsGet, assertIntegration: recordsAssertIntegration, assertCandidates: recordsAssertCandidates }
  const fn = fns[cmd]
  if (!fn) throw new Error('未知 records 命令: ' + cmd)
  return fn({ ...input, records_dir: dir })
}

function env({ value, wsHost, recordsHostDir, engineCapture = null, recordsWrap = null, recordsHost: recordsHostOverride = null } = {}) {
  const base = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [REPO + '/scripts/workspace-isolation-host.mjs']: WS_HOST_STUB,
    [REPO + '/scripts/records-host.mjs']: RECORDS_HOST_SRC,
    [USER_DIR + '/gate-spec.json']: JSON.stringify(BP, null, 2) + '\n',
    [SKILL_ROOT + '/gate-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  const fs = makeFs(base)
  const recordSvc = recordsHostOverride
    ? (cmd, input) => recordsHostOverride(cmd, input, realRecordsHost(recordsHostDir)(cmd, input))
    : recordsWrap
      ? (cmd, input) => recordsWrap(cmd, input, realRecordsHost(recordsHostDir)(cmd, input))
      : realRecordsHost(recordsHostDir)
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT', recordsHost: recordSvc, wsHost: wsHost.wsHost })
  const engine = {
    starts: [],
    start(spec) {
      this.starts.push(spec)
      if (engineCapture) engineCapture(spec, this.starts.length)
      const v = typeof value === 'function' ? value(this.starts.length, spec) : value
      return { id: 'run-' + this.starts.length, result: Promise.resolve({ stopReason: 'completed', value: v, agentsStarted: 2 }) }
    },
  }
  const { handlers, definedTools, ctx, events } = loadHost({
    fs, subprocess: sub, sandboxPolicy, workflowEngine: engine,
    agents: { requireInitiator: () => ({}) },
  })
  const tool = definedTools.find((t) => t.name === 'wf_run')
  return { handlers, tool, ctx, events, fs, sub, engine }
}

const readLogical = (fs, id) => JSON.parse(fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'))
const readRun = (fs, id) => JSON.parse(fs._files.get(RUNS_DIR + '/' + encodeURIComponent(id) + '.json'))

test('W1 主场景：目标前进 → 自动锁/同步/新 Revision/重跑 → 全覆盖放行（同逻辑运行追加段）', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  const runIdCapture = []
  const { tool, fs } = env({
    wsHost: realWs,
    recordsHostDir,
    engineCapture: (spec, n) => runIdCapture.push({ n, entry: spec.args.entry, seedKeys: Object.keys(spec.args.results || {}) }),
    value: (n) => {
      if (n === 1) {
        // 第一段：分支完成开发/审查/测试并停人工门；期间目标 main 前进
        const ws = getRunWorkspace(realWs.registry, 'task-1')
        const head = commitInWorktree(ws, 'feat.txt', 'work\n', 'branch work')
        commitFile(repo, 'main.txt', 'main advance\n', 'advance main')
        const candSha = captureSha(realWs, 'task-1')
        return {
          status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1',
          decision_package: hdPackage('hd-1'),
          results: {
            impl: { verdict: 'READY' },
            review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: head, candidate_sha256: candSha },
            test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: head, candidate_sha256: candSha },
            uat: { status: 'READY_FOR_HUMAN' },
          },
          history: [],
        }
      }
      // 重跑段：review/test 基于同步后的工作分支重新完成
      return {
        status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-2',
        decision_package: hdPackage('hd-2'),
        results: {
          impl: { verdict: 'READY' },
          review: { verdict: 'APPROVE', verified_branch: 'vwf/run/task-1', verified_head: 'post-sync', candidate_sha256: captureSha(realWs, 'task-1') },
          test: { verdict: 'PASS', verified_branch: 'vwf/run/task-1', verified_head: 'post-sync', candidate_sha256: captureSha(realWs, 'task-1') },
          uat: { status: 'READY_FOR_HUMAN' },
        },
        history: [{ round: 1, stage: 'integration_gate' }],
      }
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()

  // 返回值：放行 + 重跑事实随 wf_run 返回
  assert.equal(out.stopReason, 'completed')
  assert.equal(out.value.decision_id, 'hd-2', '返回的是重跑段的人工等待现场')
  assert.equal(out.runId, 'run-2')
  assert.equal(out.agentsStarted, 4)
  const gate = out.integration_gate
  assert.equal(gate.decision, 'pass')
  assert.equal(gate.syncs.length, 1, '目标前进恰好触发一次同步')
  assert.equal(gate.syncs[0].record_revision, 1, '同步证据产生新 Revision（B4）')
  assert.equal(gate.syncs[0].merge_result, 'merged')
  assert.equal(gate.reruns.filter((r) => r.run_id).length, 1, '自动重跑一段（B5/B6）')
  assert.equal(gate.reruns[gate.reruns.length - 1].canon, 'WAITING_HUMAN')
  assert.equal(gate.proofs_state, 'still_valid', '重跑后以同步头为基线判定未再前进')

  // 重跑入口与种子：从 review 重入；种子剔除将重新执行的节点
  assert.equal(runIdCapture[1].entry, 'review')
  assert.ok(runIdCapture[1].seedKeys.indexOf('impl') >= 0, '上游实现结果带入重跑段')
  assert.ok(runIdCapture[1].seedKeys.indexOf('review') < 0 && runIdCapture[1].seedKeys.indexOf('test') < 0, 'verify 节点不进种子（保证重签 Record）')

  // 真实 git：工作分支已含前进后的 main（自动同步落地）
  const ws = getRunWorkspace(realWs.registry, 'task-1')
  const mainHead = git(['rev-parse', 'main'], repo)
  git(['merge-base', '--is-ancestor', mainHead, 'HEAD'], ws.source_path)
  assert.equal(git(['rev-parse', 'HEAD'], ws.source_path), ws.current_head, '注册表 current_head 与实况一致')
  assert.notEqual(ws.current_head, ws.base_commit)
  assert.ok(git(['log', '--oneline'], ws.source_path).includes('Merge'), '沿用普通 merge 策略')

  // 锁已释放、全程持有痕迹在 workspace 事件里（B9/B10/B11）
  const key = integrationResourceKey({ repository: ws.repository, target_ref: 'main' })
  assert.equal(activeLockFor(realWs.registry, key), undefined, '闸门窗口结束锁已释放')
  const logical = readLogical(fs, 'task-1')
  const locks = logical.workspace.resource_locks.map((e) => e.type)
  assert.ok(locks.includes('lock_acquired') && locks.includes('lock_released'))

  // 同一逻辑运行追加段（B10 语义基础）+ control_events 落盘（B12）
  assert.equal(logical.segments.length, 2)
  assert.equal(logical.segments[1].trigger, 'integration_gate_rerun')
  assert.equal(logical.lifecycle.state, 'WAITING_HUMAN')
  const gateEvents = logical.control_events.filter((e) => e.type === 'integration_gate')
  assert.equal(gateEvents.length, 1)
  assert.equal(gateEvents[0].decision, 'pass')
  assert.equal(logical.node_attempts.filter((a) => a.node === 'test').length, 2, '重跑节点再次入档（段号区分）')

  // Formal Records：旧 Proof stale 保留，新 Proof 覆盖同步 Revision（B6/B7/UAT-02）
  const list = recordsList({ records_dir: recordsHostDir, logical_run_id: 'task-1' })
  const reviewProofRevs = list.records.filter((r) => r.record_id === 'proof:task-1:review')
  assert.equal(reviewProofRevs.length, 2)
  const oldAssert = recordsAssertIntegration({
    records_dir: recordsHostDir, logical_run_id: 'task-1',
    target_record_id: integrationSyncRecordId('task-1'),
    proofs: [{ record_id: 'proof:task-1:review', record_revision: 1 }, { record_id: 'proof:task-1:test', record_revision: 1 }],
    target_advanced: true,
  })
  assert.equal(oldAssert.ok, false, '旧 HEAD 的 Proof 不为新集成背书')
  const syncRecord = recordsGet({ records_dir: recordsHostDir, logical_run_id: 'task-1', record_id: integrationSyncRecordId('task-1') })
  assert.equal(syncRecord.current_revision, 1)
  const okAssert = recordsAssertIntegration({
    records_dir: recordsHostDir, logical_run_id: 'task-1',
    target_record_id: integrationSyncRecordId('task-1'),
    proofs: [{ record_id: 'proof:task-1:review', record_revision: 2 }, { record_id: 'proof:task-1:test', record_revision: 2 }],
    target_advanced: true,
  })
  assert.equal(okAssert.ok, true, '重跑后的新 Proof 全覆盖同步 Revision')
  assert.equal(okAssert.proofs_state, 'rerun_completed')
})

test('W2 锁被占用（B10/UAT-03）：BLOCKED 提示占用方、不重跑、锁可恢复', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    value: (n) => {
      if (n === 1) {
        const ws = getRunWorkspace(realWs.registry, 'task-1')
        commitInWorktree(ws, 'feat.txt', 'work\n', 'branch work')
        commitFile(repo, 'main.txt', 'main advance\n', 'advance main')
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      throw new Error('闸门不应重跑（锁被占用）')
    },
  })
  // 他人先持有同一目标的集成锁
  const ws = allocateWorkspace(realWs.registry, { logical_run_id: 'run-other', workspace_id: 'ws-other', mode: 'ISOLATED_WRITE', work_root: realWs.workRoot, repository_path: repo, base_ref: 'main', task_identity: 'run-other', allow_parallel: true })
  const key = integrationResourceKey({ repository: ws.repository, target_ref: 'main' })
  acquireLock(realWs.registry, { logical_run_id: 'run-other', resource_key: key, owner: 'other-gate', ttl_ms: 60000 })

  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.blocked.code, 'GATE_LOCK_BUSY')
  assert.equal(gate.blocked.holder, 'run-other', '提示占用方')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'BLOCKED')
  assert.equal(logical.lifecycle.reason.code, 'GATE_LOCK_BUSY')
  const outer = readRun(fs, 'run-1')
  assert.equal(outer.status, 'BLOCKED')
  assert.equal(gate.decision, 'blocked')
  assert.equal(activeLockFor(realWs.registry, key).logical_run_id, 'run-other', '他人锁不受影响')
  // 释放后可恢复：不再 BLOCKED 于锁（恢复语义由 wf_run entry=uat 承接，本测只验证锁事实）
  releaseLock(realWs.registry, { lock_id: activeLockFor(realWs.registry, key).lock_id, owner: 'other-gate', logical_run_id: 'run-other', reason: 'done' })
  assert.equal(activeLockFor(realWs.registry, key), undefined)
})

test('W3 目标未前进（B3/UAT-05）：直接放行，不重跑、不产生新产物版本', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  let engineCalls = 0
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    engineCapture: () => { engineCalls++ },
    value: (n) => {
      const ws = getRunWorkspace(realWs.registry, 'task-1')
      const candSha = captureSha(realWs, 'task-1')
      return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit, candidate_sha256: candSha }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit, candidate_sha256: candSha }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.decision, 'pass')
  assert.equal(gate.proofs_state, 'still_valid')
  assert.equal(gate.iterations, 1)
  assert.equal(engineCalls, 1, '未前进不触发重跑')
  assert.equal(gate.syncs.length, 0, '未前进不产生新产物版本')
  assert.ok(Array.isArray(gate.candidate_checks) && gate.candidate_checks.every((c) => c.state === 'match'), '快速路径也做候选核验且全部匹配（LOC-026）')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'WAITING_HUMAN')
  assert.equal(logical.segments.length, 1)
  assert.equal(logical.workspace.resource_locks.length, 0, '快速路径不取锁')
  assert.equal(recordsList({ records_dir: recordsHostDir, logical_run_id: 'task-1' }).records.some((r) => r.record_id === integrationSyncRecordId('task-1')), false, '无同步证据记录')
})

test('W4 同步冲突（§11）：fail closed BLOCKED + 冲突清单，锁不悬挂', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    value: (n) => {
      if (n === 1) {
        const ws = getRunWorkspace(realWs.registry, 'task-1')
        commitInWorktree(ws, 'shared.txt', 'branch version\n', 'branch edits shared')
        commitFile(repo, 'shared.txt', 'main version\n', 'main edits shared')
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      throw new Error('冲突时不应重跑')
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.blocked.code, 'GATE_SYNC_CONFLICT')
  assert.deepEqual(gate.blocked.conflicts, ['shared.txt'])
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'BLOCKED')
  assert.equal(logical.lifecycle.reason.code, 'GATE_SYNC_CONFLICT')
  const ws = getRunWorkspace(realWs.registry, 'task-1')
  const key = integrationResourceKey({ repository: ws.repository, target_ref: 'main' })
  assert.equal(activeLockFor(realWs.registry, key), undefined, '冲突路径锁不悬挂')
  assert.equal(recordsList({ records_dir: recordsHostDir, logical_run_id: 'task-1' }).records.some((r) => r.record_id === integrationSyncRecordId('task-1')), false, '冲突不产生同步证据')
})

test('W5 非 Git ISOLATED_WRITE 不触发闸门（B1）', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo, sandboxMode: true })
  let engineCalls = 0
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    engineCapture: () => { engineCalls++ },
    value: { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: 'x', verified_head: 'h' }, test: { verdict: 'PASS', verified_branch: 'x', verified_head: 'h' }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  assert.equal(out.integration_gate, undefined, 'SANDBOX 运行不触发闸门')
  assert.equal(engineCalls, 1)
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'WAITING_HUMAN')
})

test('W6 同步证据未落库（B4）：拒绝放行且不得报告 rerun_completed，锁不悬挂', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  let engineCalls = 0
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    recordsWrap: (cmd, input, r) => {
      // 模拟 Store 写入丢失：同步证据 commit 假成功、零落库
      if (cmd === 'commit' && (input.entries || []).some((e) => e.record_id === integrationSyncRecordId('task-1'))) {
        return { ok: true, logical_run_id: String(input.logical_run_id), committed: [], record_count: 0 }
      }
      return r
    },
    engineCapture: () => { engineCalls++ },
    value: (n) => {
      if (n === 1) {
        const ws = getRunWorkspace(realWs.registry, 'task-1')
        commitInWorktree(ws, 'feat.txt', 'work\n', 'branch work')
        commitFile(repo, 'main.txt', 'main advance\n', 'advance main')
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      throw new Error('同步证据未落库时不应重跑（B4）')
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.blocked.code, 'GATE_SYNC_NO_NEW_VERSION', 'B4：同步未产生新产物版本必须拒绝放行')
  assert.equal(gate.blocked.message.includes('不得报告 rerun_completed'), true)
  assert.equal(gate.decision, 'blocked')
  assert.notEqual(gate.proofs_state, 'rerun_completed', '不得谎报 rerun_completed')
  assert.equal(engineCalls, 1, '同步证据未落库不进入重跑')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'BLOCKED')
  const ws = getRunWorkspace(realWs.registry, 'task-1')
  const key = integrationResourceKey({ repository: ws.repository, target_ref: 'main' })
  assert.equal(activeLockFor(realWs.registry, key), undefined, '锁不悬挂')
})

test('W7 重跑段非人工等待收束（B8 不放行面）：闸门不放行，按段终态收束', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    value: (n) => {
      if (n === 1) {
        const ws = getRunWorkspace(realWs.registry, 'task-1')
        commitInWorktree(ws, 'feat.txt', 'work\n', 'branch work')
        commitFile(repo, 'main.txt', 'main advance\n', 'advance main')
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      // 重跑段以非人工等待终态收束（额度耗尽形态）——闸门不得放行
      return { status: 'FAILED_MAX_ROUNDS', stage: 'review', round: 3, results: { impl: { verdict: 'READY' }, review: { verdict: 'RETURN_DEV', verified_branch: 'vwf/run/task-1', verified_head: 'post-sync' } }, history: [{ round: 2, stage: 'review', verdict: 'RETURN_DEV' }] }
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.decision, null, '重跑未通过不放行')
  assert.notEqual(gate.decision, 'pass')
  assert.equal(gate.reruns.filter((r) => r.run_id).length, 1)
  assert.equal(gate.rerun_terminal, 'FAILED_MAX_ROUNDS', '按重跑段终态收束（B8：不进人工验收）')
  assert.equal(out.value.status, 'FAILED_MAX_ROUNDS', '返回重跑段现场（回开发/失败由既有语义承接）')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'FAILED')
  const ws = getRunWorkspace(realWs.registry, 'task-1')
  const key = integrationResourceKey({ repository: ws.repository, target_ref: 'main' })
  assert.equal(activeLockFor(realWs.registry, key), undefined, '锁已释放')
  assert.equal(recordsList({ records_dir: recordsHostDir, logical_run_id: 'task-1' }).records.some((r) => r.record_id === integrationSyncRecordId('task-1')), true, '同步证据仍在（不放行≠回滚同步事实）')
})

test('W8 fail-open 封堵：闸门 BLOCKED 后人工决策续跑被拒，唯一恢复路径 entry=uat', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    value: (n) => {
      const ws = getRunWorkspace(realWs.registry, 'task-1')
      if (n === 1) {
        commitInWorktree(ws, 'feat.txt', 'work\n', 'branch work')
        commitFile(repo, 'main.txt', 'main advance\n', 'advance main')
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      if (n === 2) {
        // entry=uat 续跑段：重过闸门（锁已释放）→ 闸门同步后再次进入重跑
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-2', decision_package: hdPackage('hd-2'), results: { uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      // n===3：闸门重跑段（review/test 基于同步后分支重新完成）
      return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-3', decision_package: hdPackage('hd-3'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: 'post-sync', candidate_sha256: captureSha(realWs, 'task-1') }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: 'post-sync', candidate_sha256: captureSha(realWs, 'task-1') }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
    },
  })
  // 第一段：闸门因锁被占用而 BLOCKED
  const ws = allocateWorkspace(realWs.registry, { logical_run_id: 'run-other', workspace_id: 'ws-other', mode: 'ISOLATED_WRITE', work_root: realWs.workRoot, repository_path: repo, base_ref: 'main', task_identity: 'run-other', allow_parallel: true })
  const key = integrationResourceKey({ repository: ws.repository, target_ref: 'main' })
  acquireLock(realWs.registry, { logical_run_id: 'run-other', resource_key: key, owner: 'other-gate', ttl_ms: 60000 })
  const out1 = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  assert.equal(out1.integration_gate.blocked.code, 'GATE_LOCK_BUSY')
  // 返回值不得携带原 decision_package（fail-open 的源头封堵）
  assert.equal(out1.value.status, 'BLOCKED')
  assert.equal(out1.value.decision_id, undefined)
  assert.equal(out1.value.decision_package, undefined)
  assert.equal(out1.value.recovery_hint.includes('entry=uat'), true)
  // run 记录的 HD 字段已清空
  const outer = readRun(fs, 'run-1')
  assert.equal(outer.decision_id, '')
  assert.equal(outer.decision_package, null)
  // 携带 hd-1 + ACCEPT 的人工决策续跑必须被拒绝（不得绕过闸门走到收口）
  const hd = await tool.execute({ taskId: 'task-1', templateId: 'gate-spec', decision_id: 'hd-1', user_choice: 'ACCEPT' })
  assert.equal(hd.includes('集成闸门拦截'), true, 'HD 续跑被明确拒绝')
  assert.equal(hd.includes('entry=uat'), true, '指引唯一恢复路径')
  // 锁释放后，entry=uat 的 legacy 续跑仍可用（B10 恢复语义保留）
  releaseLock(realWs.registry, { lock_id: activeLockFor(realWs.registry, key).lock_id, owner: 'other-gate', logical_run_id: 'run-other', reason: 'done' })
  const legacy = await tool.execute({ taskId: 'task-1', templateId: 'gate-spec', entry: 'uat', results: {} })
  const legacyOut = JSON.parse(legacy)
  assert.equal(legacyOut.stopReason, 'completed', 'entry=uat 续跑放行（重过闸门）')
  assert.equal(legacyOut.integration_gate.decision, 'pass', '续跑段重新通过闸门')
})

test('W9 探针恢复不误伤：PROBE_FAILED 的 BLOCKED 不触发闸门拒绝（GATE_ 前缀收窄）', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  // BP 绑定 p1/m1（探针失败）；恢复用 model_overrides 切到 p2/m2（探针通过）
  const bp = JSON.parse(JSON.stringify(BP))
  const base = {
    [REPO + '/scripts/validate-core.cjs']: readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8'),
    [REPO + '/scripts/workspace-isolation-host.mjs']: WS_HOST_STUB,
    [REPO + '/scripts/records-host.mjs']: RECORDS_HOST_SRC,
    [USER_DIR + '/gate-spec.json']: JSON.stringify(bp, null, 2) + '\n',
    [SKILL_ROOT + '/gate-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  const fs = makeFs(base)
  const llm = {
    listProviders() { return [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2' }] },
    async listModels(id) { return (id === 'p1' ? ['m1'] : ['m2']).map((m) => ({ id: m, name: m })) },
    stream(opts) {
      if (opts.provider === 'p1') {
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'probe fail', code: 'PROBE' } } } })()
      }
      return (async function* () { yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } })()
    },
  }
  let engineCalls = 0
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT', recordsHost: realRecordsHost(recordsHostDir), wsHost: realWs.wsHost })
  const { definedTools } = loadHost({
    fs, subprocess: sub, sandboxPolicy, llm,
    workflowEngine: { start() { engineCalls++; return { id: 'run-' + engineCalls, result: Promise.resolve({ stopReason: 'completed', value: { status: 'DONE', user_choice: 'USER_ACCEPTED', results: {}, history: [] }, agentsStarted: 0 }) } } },
    agents: { requireInitiator: () => ({}) },
  })
  const tool = definedTools.find((t) => t.name === 'wf_run')
  // ① 新启动：探针失败 → BLOCKED（PROBE_FAILED），逻辑运行非终态
  const out1 = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  assert.equal(out1.blocked, true)
  assert.equal(out1.stage, 'preflight_probe')
  // ② HD 续跑形态 + model_overrides：不得被闸门拒绝分支误伤（PROBE_FAILED ≠ GATE_*），
  //    应走既有恢复：新 Snapshot Revision → 重探通过 → 引擎启动
  const out2 = await tool.execute({ templateId: 'gate-spec', taskId: 'task-1', decision_id: 'hd-x', user_choice: 'USER_ACCEPTED', model_overrides: { $default: { provider: 'p2', model: 'm2' } } })
  assert.equal(out2.includes('集成闸门拦截'), false, '探针 BLOCKED 不得触发闸门拒绝')
  const out2j = JSON.parse(out2)
  assert.equal(out2j.value.status, 'DONE', '探针恢复后原地续跑完成')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'COMPLETED')
  assert.equal(logical.snapshots.length, 2, '恢复产生新 Snapshot Revision')
})

// ── LOC-026 候选证明：闸门候选核验（WR-003 / task-spec-V1 §9）────────────────

test('W10 LOC-026 审核期间成果变化（自报 sha ≠ 宿主实况）→ BLOCKED 并指名具体 Proof', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    value: (n) => {
      const ws = getRunWorkspace(realWs.registry, 'task-1')
      // 模型自报的候选摘要是陈旧值（宿主签发时实况捕获与其不一致 → candidate_match=false）
      return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit, candidate_sha256: 'stale-declared-sha' }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit, candidate_sha256: 'stale-declared-sha' }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.blocked.code, 'GATE_CANDIDATE_MISMATCH', '候选证明不匹配必须拒绝放行')
  assert.ok(gate.blocked.message.includes('proof:task-1:review'), '指名具体不匹配 Proof（review）')
  assert.ok(gate.blocked.message.includes('proof:task-1:test'), '指名具体不匹配 Proof（test）')
  assert.ok(Array.isArray(gate.candidate_checks) && gate.candidate_checks.every((c) => c.state === 'mismatch' && c.candidate_match === false))
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'BLOCKED')
  assert.equal(logical.lifecycle.reason.code, 'GATE_CANDIDATE_MISMATCH')
})

test('W11 LOC-026 旧候选 Proof 不为新成果放行：候选前进后 entry=uat 不得进 UAT/收口（AC-01/AC-04）', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  let engineCalls = 0
  const { tool, fs } = env({
    wsHost: realWs, recordsHostDir,
    engineCapture: () => { engineCalls++ },
    value: (n) => {
      if (n > 2) throw new Error('候选不匹配时不得重跑到 UAT 之后')
      const ws = getRunWorkspace(realWs.registry, 'task-1')
      if (n === 2) {
        // entry=uat 续跑段：只有 uat 节点重跑，审核/测试 Proof 保持旧候选绑定
        return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-2', decision_package: hdPackage('hd-2'), results: { uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
      }
      const head = commitInWorktree(ws, 'feat.txt', 'work ' + n + '\n', 'branch work ' + n)
      // 自报候选摘要与宿主实况脱节（审核/测试看到的候选 ≠ 签发时实况）：闸门必须拦下
      return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-' + n, decision_package: hdPackage('hd-' + n), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: head, candidate_sha256: 'stale-declared-sha' }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: head, candidate_sha256: 'stale-declared-sha' }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
    },
  })
  // 第一段：审核期间成果变化（自报 sha 过期）→ 闸门拒绝、进入可恢复的 BLOCKED 态
  const out1 = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  assert.equal(out1.integration_gate.blocked.code, 'GATE_CANDIDATE_MISMATCH', '审核期间成果变化 → 不得签发有效证明放行')
  assert.equal(out1.value.status, 'BLOCKED')
  // 候选前进：被审成果在 Proof 之后又变化（新 HEAD、新内容）
  const ws = getRunWorkspace(realWs.registry, 'task-1')
  const newHead = commitInWorktree(ws, 'late-change.txt', 'changed after review\n', 'late change')
  assert.notEqual(newHead, ws.current_head)
  // entry=uat 续跑（BLOCKED 态合法恢复）：旧 Proof 所指候选已不存在 → 再次拒绝并指名 Proof
  const out2 = JSON.parse(await tool.execute({ taskId: 'task-1', templateId: 'gate-spec', entry: 'uat', results: {} }))
  await drain()
  assert.equal(out2.value.status, 'BLOCKED', '旧证明不得为新成果放行进入 UAT')
  assert.equal(out2.integration_gate.blocked.code, 'GATE_CANDIDATE_MISMATCH')
  assert.ok(out2.integration_gate.blocked.message.includes('proof:task-1:review'))
  assert.ok(out2.integration_gate.blocked.message.includes('proof:task-1:test'))
  const mismatches = out2.integration_gate.candidate_checks.filter((c) => c.state === 'mismatch')
  assert.ok(mismatches.length >= 1)
  assert.ok(mismatches.every((c) => c.mismatches.some((m) => m.field === 'version.content_sha256' || m.field === 'version.head')), 'mismatch 明细指出具体字段')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'BLOCKED')
})

test('W12 LOC-026 兼容：无 candidate_ref 的历史 Proof 记 legacy_unverified，不伪造候选绑定（AC-04/兼容）', async () => {
  const repo = initRepo()
  const recordsHostDir = mkdtempSync(join(tmpdir(), 'vwf-gate-records-'))
  after(() => { try { rmSync(recordsHostDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const realWs = makeRealWsHost({ repo })
  // 模拟 LOC-026 之前的运行：Proof 无候选绑定（已启动运行保持冻结快照）。
  // 注意：recordsWrap 形态先执行真实提交再回调，改写入参必须直接包装 recordsHost。
  const { tool, fs } = env({
    wsHost: realWs,
    recordsHostDir,
    // 模拟 LOC-026 之前的运行：Proof 无候选绑定（已启动运行保持冻结快照）。
    // 直接包装 recordsHost（改写入参必须在真实提交之前，env 的 recordsWrap 是事后回调）
    recordsHost: (cmd, input) => {
      if (cmd === 'commit' && Array.isArray(input.entries)) {
        input.entries = input.entries.map((e) => {
          if (e.type !== 'proof' || !e.body_value) return e
          const body = { ...e.body_value }
          delete body.candidate_ref
          delete body.declared_candidate_sha256
          delete body.candidate_match
          return { ...e, body_value: body }
        })
      }
      return realRecordsHost(recordsHostDir)(cmd, input)
    },
    value: (n) => {
      const ws = getRunWorkspace(realWs.registry, 'task-1')
      const candSha = captureSha(realWs, 'task-1')
      return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit, candidate_sha256: candSha }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit, candidate_sha256: candSha }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
    },
  })
  const out = JSON.parse(await tool.execute({ templateId: 'gate-spec', taskId: 'task-1' }))
  await drain()
  const gate = out.integration_gate
  assert.equal(gate.decision, 'pass', '历史 Proof 由既有 Revision 覆盖判定约束，不因缺候选绑定而改写历史')
  assert.ok(Array.isArray(gate.candidate_checks) && gate.candidate_checks.every((c) => c.state === 'legacy_unverified'), '缺绑定 Proof 明确标 legacy_unverified，不静默当作已验证')
  const logical = readLogical(fs, 'task-1')
  assert.equal(logical.lifecycle.state, 'WAITING_HUMAN')
})
