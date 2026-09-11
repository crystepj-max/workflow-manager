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
import { recordsCommit, recordsList, recordsGet, recordsAssertIntegration } from '../../../scripts/records-host.mjs'
import {
  createRegistry, allocateWorkspace, getRunWorkspace, setLifecycle,
  recordSourceSync, computeIntegrationCheckpointFromRepo,
  acquireLock, releaseLock, activeLockFor, integrationResourceKey,
} from '../../../scripts/workspace-isolation.mjs'
import { planTargetSync, mergeTarget, integrationSyncRecordId } from '../../../scripts/integration-gate.mjs'

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
          return wrap(() => computeIntegrationCheckpointFromRepo(input))
        default:
          return { ok: false, error: '未知 ws 命令: ' + cmd }
      }
    },
  }
}

const realRecordsHost = (dir) => (cmd, input) => {
  const fns = { commit: recordsCommit, list: recordsList, get: recordsGet, assertIntegration: recordsAssertIntegration }
  const fn = fns[cmd]
  if (!fn) throw new Error('未知 records 命令: ' + cmd)
  return fn({ ...input, records_dir: dir })
}

function env({ value, wsHost, recordsHostDir, engineCapture = null } = {}) {
  const base = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [REPO + '/scripts/workspace-isolation-host.mjs']: WS_HOST_STUB,
    [REPO + '/scripts/records-host.mjs']: RECORDS_HOST_SRC,
    [USER_DIR + '/gate-spec.json']: JSON.stringify(BP, null, 2) + '\n',
    [SKILL_ROOT + '/gate-spec/script.mjs']: '//MOCK-SCRIPT',
  }
  const fs = makeFs(base)
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT', recordsHost: realRecordsHost(recordsHostDir), wsHost: wsHost.wsHost })
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
        return {
          status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1',
          decision_package: hdPackage('hd-1'),
          results: {
            impl: { verdict: 'READY' },
            review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: head },
            test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: head },
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
          review: { verdict: 'APPROVE', verified_branch: 'vwf/run/task-1', verified_head: 'post-sync' },
          test: { verdict: 'PASS', verified_branch: 'vwf/run/task-1', verified_head: 'post-sync' },
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
  const staleRows = list.coverage.filter((c) => c.proof.record_id === 'proof:task-1:review' && c.proof.record_revision === 1 && c.status === 'not_covering_current')
  assert.ok(staleRows.length > 0, '旧 HEAD 的 Proof 不为新集成背书')
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
      return { status: 'WAITING_HUMAN', node: 'uat', decision_id: 'hd-1', decision_package: hdPackage('hd-1'), results: { impl: { verdict: 'READY' }, review: { verdict: 'APPROVE', verified_branch: ws.work_branch, verified_head: ws.base_commit }, test: { verdict: 'PASS', verified_branch: ws.work_branch, verified_head: ws.base_commit }, uat: { status: 'READY_FOR_HUMAN' } }, history: [] }
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
