// client.js jsdom 冒烟测试：
// 模板列表 → 打开全局编辑层 → 新增/删除节点 → 拖拽连线 → 边/节点配置面板
// → JSON tab → 保存校验弹窗与字段标红（Gold-Band 对齐交互链路）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = React

const flush = () => new Promise((resolve) => setImmediate(resolve))
// 防抖实时校验（VALIDATE_DEBOUNCE_MS=350）在默认桩下永不触发——因此内核 warnings 的
// 编辑器出口此前完全没有测试覆盖。仅在需要验证防抖通道的用例里打开真实定时器，
// 其余用例保持原语义（delay=0 同步执行、非零丢弃）。
let realDebounceTimer = false
function makeTimeout(fn, delay) {
  if (typeof fn !== 'function') return () => {}
  if (delay === 0) { fn(); return () => {} }
  if (!realDebounceTimer) return () => {}
  const t = setTimeout(fn, delay)
  return () => clearTimeout(t)
}
async function mountPage(targetRoot, el) {
  await act(async () => {
    targetRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
}

function byText(root, text) {
  return Array.from(root.querySelectorAll('*')).find((el) => el.children.length === 0 && (el.textContent || '').includes(text))
}
function byClass(root, cls) {
  return root.querySelector('.' + cls)
}

// FEAT-84 渐进披露（V-11）：技术词（节点类型 / AI 服务与模型 / JSON 结构）收进第三档，
// 默认停在业务词档。需要操作这些字段的用例先切到对应档——切换本身也是被测行为之一
// （见 editor-workbench.test.mjs 的 V-11 用例）。
async function openSection(root, id) {
  const tab = root.querySelector('.vwf-wb-tab[data-vwf-tab="' + id + '"]')
  assert.ok(tab, '存在 ' + id + ' 配置档')
  if (tab.getAttribute('aria-selected') !== 'true') {
    await act(async () => { tab.click(); await flush() })
  }
  return tab
}

const SEED_DSL = {
  id: 'wf1',
  name: '测试流',
  description: 'seed',
  entry: 'node-1',
  control: { maxRounds: 9 },
  nodes: [
    { id: 'node-1', profile: 'dispatcher', label: '节点1' },
  ],
  edges: [
    { from: 'node-1', to: '$end', on: 'success' },
  ],
}

// ── 角色库假数据（issue-58）───────────────────────────────────────────────
const roleState = {
  roles: [
    // issue-81：dispatcher 已退出内置身份，迁为自定义角色
    { id: 'dispatcher', name: '调度', summary: '调度角色', builtin: false, content: '调度角色正文\n职责：调度。\n' },
    { id: 'dev', name: '开发', summary: '开发角色', builtin: true, content: '开发角色正文\n' },
    { id: '需求分析师', name: '需求分析师', summary: '需求拆解', builtin: false, content: '需求分析正文\n' },
  ],
}
// 与内核 scripts/role-library.cjs 同口径的最小镜像：文件顶部前置块的显式简介优先，
// 否则取首个有意义行（跳过前置块键与标题）。角色写入口的 summary 一律经它计算。
function summaryOfContent(content) {
  const c = String(content || '')
  if (c.slice(0, 3) === '---') {
    const end = c.indexOf('\n---', 3)
    if (end >= 0) {
      const m = /(?:^|\n)[ \t]*summary[ \t]*:[ \t]*([^\n]*)/.exec(c.slice(3, end))
      if (m && m[1].trim()) return m[1].trim().slice(0, 80)
    }
  }
  const line = c.split('\n').map((l) => l.trim()).find((l) => l && !/^---|^id:|^name:|^summary|^#/.test(l))
  return (line || '').slice(0, 80)
}

// 模拟「需求分析师」被 node-1 引用（其余角色零引用）
const ROLE_USAGE = {
  '需求分析师': { count: 1, refs: [{ workflowId: 'wf1', workflowName: '测试流', builtin: false, nodes: [{ id: 'node-1', label: '节点1' }] }] },
}

// ── 组装动态客户端运行环境 ─────────────────────────────────────────────────

// ── FEAT-85 运行列表与 Logical Run 详情夹具 ────────────────────────────────
// 覆盖：两个工作空间 + 一个未归属旧记录；同一 Logical Run 两段（含被接管的第 1 段）；
// 返工（实现第 1/2 次、检查退回）；扇出（3 个子任务，2 完成 1 未完成）；受阻运行；
// 逻辑运行读取失败运行；以及 12 条历史运行用于分页。
const RUN_DSL = {
  id: 'wf-runs',
  name: '完整功能开发',
  entry: 'dev',
  control: { maxRounds: 3 },
  nodes: [
    { id: 'dev', label: '实现', profile: 'dev' },
    { id: 'review', label: '检查', profile: 'review' },
    { id: 'test', label: '测试', profile: 'test' },
    { id: 'uat', label: '验收', profile: 'uat' },
    { id: 'explore', label: '多视角研究', profile: 'researcher', kind: 'fanout', items: ['技术可行性', '用户需求', '风险与反证'] },
    { id: 'synth', label: '汇总发现', profile: 'researcher' },
  ],
  edges: [
    { from: 'dev', to: 'review', outcome: 'READY' },
    { from: 'review', to: 'dev', outcome: 'RETURN_DEV', countRound: true },
    { from: 'review', to: 'test', outcome: 'APPROVE' },
    { from: 'test', to: 'dev', outcome: 'RETURN_DEV', countRound: true },
    { from: 'test', to: 'uat', outcome: 'PASS' },
    { from: 'uat', to: '$end', outcome: 'ACCEPT' },
    { from: 'explore', to: 'synth', outcome: 'success' },
  ],
}

const WS_A = { workspace_id: '工作空间A', mode: 'ISOLATED_WRITE', workspace_path: '/tmp/ws-a', source_path: 'crystepj-max/workflow-manager', source_revision: 'r1', work_branch: 'dev-t-a1', current_head: 'aaaa1111bbbb2222', base_commit: 'cccc3333dddd4444', lifecycle: 'ACTIVE', allocated_at: 900, events: [], resource_locks: [{ type: 'lock_acquired' }], integration_checkpoints: [], cleanup: null, refreshed_at: 4100 }
const WS_B = { workspace_id: '工作空间B', mode: 'READ_ONLY', workspace_path: '/tmp/ws-b', source_path: 'crystepj-max/side-project', source_revision: 'r2', work_branch: 'dev-t-b1', current_head: 'eeee5555ffff6666', base_commit: 'aaaa7777bbbb8888', lifecycle: 'ACTIVE', allocated_at: 910, events: [], resource_locks: [], integration_checkpoints: [{ type: 'integration_checkpoint' }], cleanup: { state: 'pending' }, refreshed_at: 5100 }

function attemptRec(logicalRunId, v, rev) {
  return { record_id: 'attempt:' + logicalRunId + ':' + v.attempt_id, record_revision: rev || 1, body: { media_type: 'application/json', value: v }, provenance: { node: v.node, attempt: v.segment, snapshot_revision: v.snapshot_revision, provider: v.provider, model: v.model } }
}
function logicalAttempt(id, node, segment, opts) {
  const o = opts || {}
  return attemptRec(id, {
    schema: 1, attempt_id: o.attempt_id, kind: 'logical', node: node, round: o.round || 0, segment: segment,
    status: o.status || 'completed', snapshot_revision: String(o.revision || segment), provider: 'p1', model: 'm' + segment,
    ended_at: o.ended_at || '2026-09-17T10:00:00Z',
    ...(o.outcome === undefined ? {} : { outcome: o.outcome }),
    ...(o.outcomePath === undefined ? {} : { outcome_path: o.outcomePath }),
    ...(o.result === undefined ? {} : { result: o.result }),
  })
}

const runState = {
  states: {},
  logical: {},
  records: {},
  logicalUnavailable: '',
  recordsFail: false,
  controlCalls: [],
  controlFail: false,
  runs: [],
}

// ── Logical Run lr-a：两段 + 返工（实现 2 次 / 检查退回 1 次）──
runState.runs.push(
  { id: 'run-a1', taskId: 'T-A1', name: '完整功能开发', workflowId: 'wf-runs', status: 'running', phase: '实现', startedAt: 3000, supersededBy: 'run-a2', logical_run_id: 'lr-a', segment: 1, segment_count: 2, logical_state: 'RUNNING' },
  { id: 'run-a2', taskId: 'T-A1', name: '完整功能开发', workflowId: 'wf-runs', status: 'WAITING_HUMAN', phase: '验收', startedAt: 4000, decision_id: 'T-A1:review:1:1', reason: 'HUMAN_ACCEPTANCE', logical_run_id: 'lr-a', segment: 2, segment_count: 2, logical_state: 'WAITING_HUMAN' },
)
runState.logical['lr-a'] = {
  logical_run_id: 'lr-a', schema: 1, task_id: 'T-A1', template_id: 'wf-runs', title: '工作流界面改版', created_at: 2900, updated_at: 4200,
  lifecycle: { state: 'WAITING_HUMAN', reason: { code: 'HUMAN_ACCEPTANCE' } }, terminal: false, completion: null,
  segments: [
    { index: 1, run_id: 'run-a1', trigger: 'start', started_at: 3000, ended_at: 3200, status: 'DONE', active: false },
    { index: 2, run_id: 'run-a2', trigger: 'human_decision', started_at: 4000, status: 'running', active: true, decision_id: 'T-A1:review:1:1' },
  ],
  snapshots: [
    { revision: 1, created_at: 2900, active: false, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: { dev: { provider: 'p1', model: 'm1' } } },
    { revision: 2, created_at: 3900, active: true, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: { dev: { provider: 'p1', model: 'm2' }, review: { provider: 'p1', model: 'm2' } } },
  ],
  node_attempts: [
    { node: 'dev', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'READY', completed_at: 3100 },
    { node: 'review', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'RETURN_DEV', completed_at: 3150 },
    { node: 'test', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'PASS', completed_at: 3180 },
    { node: 'dev', segment: 2, snapshot_revision: 2, provider: 'p1', model: 'm2', outcome: 'READY', completed_at: 4100 },
    { node: 'review', segment: 2, snapshot_revision: 2, provider: 'p1', model: 'm2', outcome: 'APPROVE', completed_at: 4150 },
  ],
  business_outcomes: {
    dev: { outcome: 'READY', path: '$.status', segment: 2, snapshot_revision: 2, at: 4100 },
    review: { outcome: 'APPROVE', path: '$.verdict', segment: 2, snapshot_revision: 2, at: 4150 },
    test: { outcome: 'PASS', path: '$.verdict', segment: 1, snapshot_revision: 1, at: 3180 },
  },
  guidance: [], control_events: [{ type: 'pause_requested', at: 4300, run_id: 'run-a2' }], baseline_revisions: [], baseline_applied_upto: 0,
  last_engine_error: null, pause_state: null, pause_resume: null,
  evaluation_baseline: null, evaluation_baselines: [], formal_records: null, workspace: WS_A,
  human_decisions: [{ decision_id: 'T-A1:review:1:1', user_choice: 'ADD_BUDGET', at: 2800 }], consumed_decisions: {},
}
runState.records['lr-a'] = {
  ok: true, found: true, logical_run_id: 'lr-a',
  records: [
    logicalAttempt('lr-a', 'dev', 1, { attempt_id: 'a1k1', outcome: 'READY', outcomePath: '$.status', result: { summary: '第 1 次实现成果' } }),
    logicalAttempt('lr-a', 'review', 1, { attempt_id: 'a1k2', round: 1, outcome: 'RETURN_DEV', outcomePath: '$.verdict', result: { issues: '配置滚动后主要操作离开视口，需要修改' } }),
    logicalAttempt('lr-a', 'test', 1, { attempt_id: 'a1k3', outcome: 'PASS', result: { note: '第 1 轮测试通过' } }),
    logicalAttempt('lr-a', 'dev', 2, { attempt_id: 'a2k1', outcome: 'READY', outcomePath: '$.status', result: { summary: '第 2 次实现成果' } }),
    logicalAttempt('lr-a', 'review', 2, { attempt_id: 'a2k2', round: 1, outcome: 'APPROVE', result: { note: '检查通过' } }),
    { record_id: 'node:lr-a:dev', record_revision: 2, body: { media_type: 'application/json', value: { summary: '第 2 次实现成果' } }, provenance: { node: 'dev', attempt: 2, snapshot_revision: '2', provider: 'p1', model: 'm2', node_business_outcome: 'READY' }, provenance: { node: 'dev', attempt: 2, snapshot_revision: '2', provider: 'p1', model: 'm2', node_business_outcome: 'READY', resolved_inputs_snapshot: { mode: 'record', items: [{ binding: 'from_preflight', producer: 'preflight' }] } } },
  ], attempts: [],
}

// ── Logical Run lr-b：扇出（3 子任务，2 完成 1 未完成）+ 完成类型 ──
runState.runs.push({ id: 'run-b1', taskId: 'T-B1', name: '完整功能开发', workflowId: 'wf-runs', status: 'DONE', phase: '收口', startedAt: 5000, logical_run_id: 'lr-b', segment: 1, segment_count: 1, logical_state: 'COMPLETED' })
runState.logical['lr-b'] = {
  logical_run_id: 'lr-b', schema: 1, task_id: 'T-B1', template_id: 'wf-runs', title: '多视角探索', created_at: 4900, updated_at: 5200,
  lifecycle: { state: 'COMPLETED', reason: null }, terminal: true, completion: { type: 'DELIVERED', node: 'uat', path: '$.completion.type' },
  segments: [{ index: 1, run_id: 'run-b1', trigger: 'start', started_at: 5000, ended_at: 5200, status: 'DONE', active: false }],
  snapshots: [{ revision: 1, created_at: 4900, active: true, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: { explore: { provider: 'p1', model: 'm1' } } }],
  node_attempts: [
    { node: 'explore', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'success', completed_at: 5100 },
    { node: 'synth', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'SYNTHESIS_READY', completed_at: 5150 },
  ],
  business_outcomes: { synth: { outcome: 'SYNTHESIS_READY', path: '$.status', segment: 1, snapshot_revision: 1, at: 5150 } },
  guidance: [], control_events: [], baseline_revisions: [], baseline_applied_upto: 0,
  last_engine_error: null, pause_state: null, pause_resume: null, evaluation_baseline: null, evaluation_baselines: [],
  formal_records: null, workspace: WS_B, human_decisions: [], consumed_decisions: {},
}
runState.records['lr-b'] = {
  ok: true, found: true, logical_run_id: 'lr-b',
  records: [
    attemptRec('lr-b', { attempt_id: 'a1k10', kind: 'item', node: 'explore', round: 0, segment: 1, status: 'completed', snapshot_revision: '1', provider: 'p1', model: 'm1', item_index: 0, item: '技术可行性', result: { finding: '技术上可行' }, ended_at: '2026-09-17T10:01:00Z' }),
    attemptRec('lr-b', { attempt_id: 'a1k11', kind: 'item', node: 'explore', round: 0, segment: 1, status: 'completed', snapshot_revision: '1', provider: 'p1', model: 'm1', item_index: 1, item: '用户需求', result: { finding: '需求集中在位置感' }, ended_at: '2026-09-17T10:02:00Z' }),
    attemptRec('lr-b', { attempt_id: 'a1k12', kind: 'item', node: 'explore', round: 0, segment: 1, status: 'running', snapshot_revision: '1', provider: 'p1', model: 'm1', item_index: 2, item: '风险与反证', started_at: '2026-09-17T10:03:00Z' }),
    logicalAttempt('lr-b', 'synth', 1, { attempt_id: 'a1k20', outcome: 'SYNTHESIS_READY', result: { summary: '汇总了 2 份研究' } }),
    { record_id: 'node:lr-b:synth', record_revision: 1, body: { media_type: 'application/json', value: { summary: '汇总了 2 份研究' } }, provenance: { node: 'synth', attempt: 1, snapshot_revision: '1', provider: 'p1', model: 'm1', resolved_inputs_snapshot: { mode: 'record', items: [{ binding: 'from_explore', producer: 'explore' }, { binding: 'from_note', producer: 'note' }] } } },
  ], attempts: [],
}

// ── Logical Run lr-c：受阻（BLOCKED，可恢复）──
runState.runs.push({ id: 'run-c2', taskId: 'T-C2', name: '完整功能开发', workflowId: 'wf-runs', status: 'BLOCKED', reason: 'EVALUATION_BASELINE_CONFLICT', node: 'dev', phase: '实现', startedAt: 3500, logical_run_id: 'lr-c', segment: 1, segment_count: 1, logical_state: 'BLOCKED' })
runState.logical['lr-c'] = {
  logical_run_id: 'lr-c', schema: 1, task_id: 'T-C2', template_id: 'wf-runs', title: '受阻任务', created_at: 3400, updated_at: 3600,
  lifecycle: { state: 'BLOCKED', reason: { code: 'EVALUATION_BASELINE_CONFLICT' } }, terminal: false, completion: null,
  segments: [{ index: 1, run_id: 'run-c2', trigger: 'start', started_at: 3500, status: 'running', active: true }],
  snapshots: [{ revision: 1, created_at: 3400, active: true, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: { dev: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, review: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }],
  node_attempts: [], business_outcomes: {}, guidance: [], control_events: [], baseline_revisions: [], baseline_applied_upto: 0,
  last_engine_error: null, pause_state: null, pause_resume: null, evaluation_baseline: null, evaluation_baselines: [],
  formal_records: null, workspace: WS_A, human_decisions: [], consumed_decisions: {},
}
runState.records['lr-c'] = { ok: true, found: true, logical_run_id: 'lr-c', records: [], attempts: [] }

// ── Logical Run lr-p：PAUSED（指导提交走 vwf.run.control）──
runState.runs.push({ id: 'run-p1', taskId: 'T-P1', name: '完整功能开发', workflowId: 'wf-runs', status: 'PAUSED', reason: 'USER_PAUSE', startedAt: 3300, logical_run_id: 'lr-p', segment: 1, segment_count: 1, logical_state: 'PAUSED' })
runState.logical['lr-p'] = {
  logical_run_id: 'lr-p', schema: 1, task_id: 'T-P1', template_id: 'wf-runs', title: '暂停任务', created_at: 3200, updated_at: 3400,
  lifecycle: { state: 'PAUSED', reason: { code: 'USER_PAUSE' } }, terminal: false, completion: null,
  segments: [{ index: 1, run_id: 'run-p1', trigger: 'start', started_at: 3300, status: 'running', active: true }],
  snapshots: [{ revision: 1, created_at: 3200, active: true, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: { dev: { provider: 'p1', model: 'm1' } } }],
  node_attempts: [{ node: 'dev', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'READY', completed_at: 3350 }],
  business_outcomes: {}, guidance: [{ seq: 1, mode: 'coach', text: '先补测试再继续', at: 3380 }], control_events: [], baseline_revisions: [], baseline_applied_upto: 0,
  last_engine_error: null, pause_state: { action: 'pause', requested_at: 3390 }, pause_resume: null, evaluation_baseline: null, evaluation_baselines: [],
  formal_records: null, workspace: WS_A, human_decisions: [], consumed_decisions: {},
}
runState.records['lr-p'] = { ok: true, found: true, logical_run_id: 'lr-p', records: [logicalAttempt('lr-p', 'dev', 1, { attempt_id: 'a1k1', outcome: 'READY', result: { summary: '暂停前成果' } })], attempts: [] }

// ── Logical Run lr-r：运行中（控制面 pause / interrupt 可用）──
runState.runs.push({ id: 'run-r1', taskId: 'T-R1', name: '完整功能开发', workflowId: 'wf-runs', status: 'running', phase: '实现', startedAt: 4500, logical_run_id: 'lr-r', segment: 1, segment_count: 1, logical_state: 'RUNNING' })
runState.logical['lr-r'] = {
  logical_run_id: 'lr-r', schema: 1, task_id: 'T-R1', template_id: 'wf-runs', title: '运行中任务', created_at: 4400, updated_at: 4600,
  lifecycle: { state: 'RUNNING', reason: null }, terminal: false, completion: null,
  segments: [{ index: 1, run_id: 'run-r1', trigger: 'start', started_at: 4500, status: 'running', active: true }],
  snapshots: [{ revision: 1, created_at: 4400, active: true, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: { dev: { provider: 'p1', model: 'm1' } } }],
  node_attempts: [{ node: 'dev', segment: 1, snapshot_revision: 1, provider: 'p1', model: 'm1', outcome: 'READY', completed_at: 4550 }],
  business_outcomes: { dev: { outcome: 'READY', path: '$.status', segment: 1, snapshot_revision: 1, at: 4550 } },
  guidance: [], control_events: [], baseline_revisions: [], baseline_applied_upto: 0,
  last_engine_error: null, pause_state: null, pause_resume: null, evaluation_baseline: null, evaluation_baselines: [],
  formal_records: null, workspace: WS_B, human_decisions: [], consumed_decisions: {},
}
runState.records['lr-r'] = { ok: true, found: true, logical_run_id: 'lr-r', records: [logicalAttempt('lr-r', 'dev', 1, { attempt_id: 'a1k1', outcome: 'READY', result: { summary: '运行中成果' } })], attempts: [] }
runState.states['run-r1'] = { status: 'running', phase: '实现', logs: ['[段1] 正在实现'], agents: [], formalRecords: [] }

// ── 逻辑运行读取失败（工作空间未知）+ 旧记录（无逻辑归属）+ 历史分页 ──
runState.logicalUnavailable = 'lr-err'
runState.runs.push({ id: 'run-err1', taskId: 'T-E1', name: '读取失败任务', workflowId: 'wf-runs', status: 'running', startedAt: 2500, logical_run_id: 'lr-err', segment: 1, segment_count: 1, logical_state: 'RUNNING' })
// 看板 agents 回归用例的诊断运行：走 runId 直查默认 vwf.state（逐项处理 #1–#3）
runState.runs.push({ id: 'run-1', taskId: 'T-DASH', name: '看板回归', workflowId: 'wf-history', status: 'running', phase: '逐项处理', startedAt: 6000 })
runState.runs.push({ id: 'run-c1', taskId: 'T-C1', name: '诊断与修复', workflowId: 'wf-history', status: 'running', phase: '诊断', startedAt: 2000 })
for (let i = 1; i <= 12; i++) {
  runState.runs.push({ id: 'run-x' + i, taskId: 'T-X' + i, name: '历史任务', workflowId: 'wf-history', status: 'DONE', phase: '收口', startedAt: 1000 + i })
}

// 运行现况（vwf.state）：决策包 / 受阻现场 / 完成类型
runState.states['run-a2'] = {
  status: 'WAITING_HUMAN', phase: '验收', logs: ['[段2] 实现完成', '[段2] 检查通过'],
  decision_id: 'T-A1:review:1:1', reason: 'HUMAN_ACCEPTANCE', node: 'uat',
  decision_package: {
    why: '材料齐备，交给你验收。',
    current_state: '实现与检查均已完成，等待人工决定。',
    options: [{ id: 'USER_ACCEPTED' }, { id: 'ADD_BUDGET' }, { id: 'STOP' }],
    subsequent_effects: { USER_ACCEPTED: '按模板完成类型结束本次运行', ADD_BUDGET: '增加 1 轮自动返工额度后继续', STOP: '停止本 Run，保留已有成果' },
    cost: 'UNKNOWN', benefit: 'UNKNOWN', risk: 'UNKNOWN', recommendation: 'UNKNOWN',
  },
  blocked_edge: null,
  agents: [{ seq: 1, label: '实现', phase: '实现', outcome: 'completed' }, { seq: 2, label: '检查', phase: '检查', outcome: 'completed' }],
  formalRecords: [{ record_id: 'node:lr-a:dev', record_revision: 2, body: { media_type: 'application/json', value: { summary: '第 2 次实现成果' } }, provenance: { node: 'dev', attempt: 2, snapshot_revision: '2', provider: 'p1', model: 'm2', node_business_outcome: 'READY' } }],
}
runState.states['run-c2'] = { status: 'BLOCKED', reason: 'EVALUATION_BASELINE_CONFLICT', node: 'dev', phase: '实现', logs: ['[段1] 评价基线冲突，停止推进'], agents: [], formalRecords: [] }
runState.states['run-b1'] = { status: 'DONE', phase: '收口', logs: ['[段1] 收口完成'], agents: [{ seq: 1, label: '多视角研究 #1', phase: '研究', outcome: 'completed' }, { seq: 2, label: '多视角研究 #2', phase: '研究', outcome: 'completed' }, { seq: 3, label: '多视角研究 #3', phase: '研究', outcome: 'failed' }], formalRecords: [] }
runState.states['run-p1'] = { status: 'PAUSED', reason: 'USER_PAUSE', logs: ['[段1] 已暂停'], agents: [], formalRecords: [] }

function makeRuntime() {
  // wfList：FEAT-100 流程库子页签用例需要「内置 + 我的」混合清单（默认单条自定义）
  const state = { failSave: false, failUsage: false, failRoles: false, saved: [], validateWarning: null, wfList: null }
  const rpc = async (method, args) => {
    switch (method) {
      case 'vwf.workflows.list':
        return state.wfList || [{ id: 'wf1', name: '测试流', description: 'seed', builtin: false, dsl: JSON.parse(JSON.stringify(SEED_DSL)) }]
      case 'vwf.models':
        return { providers: [{ id: 'deepseek-official', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }] }
      case 'vwf.roles':
        // FEAT-86：读取失败必须与「没有角色」区分（规格 §11 边界）
        if (state.failRoles) return { ok: false, errors: [{ at: '$', message: '角色服务不可用' }] }
        // 与宿主同口径：列表条目一定带 summary（显式优先，缺失时由职责生成）
        return {
          roles: roleState.roles.map(r => ({
            id: r.id, name: r.name, builtin: r.builtin,
            summary: r.summary || String(r.content || '').split('\n')[0],
          })),
        }
      case 'vwf.roles.get': {
        const role = roleState.roles.find(r => r.id === args.id)
        return role ? { ok: true, role: { ...role } } : { ok: false, errors: [{ at: '$', message: '角色不存在：' + args.id }] }
      }
      case 'vwf.roles.create': {
        const dup = roleState.roles.some(r => String(r.id).toLowerCase() === String(args.name).toLowerCase())
        if (dup) return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
        const role = { id: args.name, name: args.name, summary: summaryOfContent(args.content), builtin: false, content: args.content }
        roleState.roles.push(role)
        return { ok: true, role: { ...role } }
      }
      case 'vwf.roles.update': {
        const idx = roleState.roles.findIndex(r => r.id === args.id)
        if (idx < 0) return { ok: false, errors: [{ at: '$', message: '自定义角色不存在：' + args.id }] }
        const role = { ...roleState.roles[idx], id: args.name || args.id, name: args.name || args.id, content: args.content, summary: summaryOfContent(args.content) }
        roleState.roles.splice(idx, 1, role)
        return { ok: true, role: { ...role } }
      }
      case 'vwf.roles.remove': {
        const idx = roleState.roles.findIndex(r => r.id === args.id)
        if (idx >= 0) roleState.roles.splice(idx, 1)
        return { ok: true, id: args.id }
      }
      // 权威名称校验（与 scripts/role-library.cjs 规则一致的最小镜像）：
      // 非空/长度/非法字符/首尾点/Windows 保留名 + 唯一性（excludeId 排除自身）
      case 'vwf.roles.validate': {
        const name = String((args && args.name) || '').trim()
        const badName = !name ? '角色名称不能为空'
          : name.length > 64 ? '角色名称过长（最多 64 字符）'
          : /[\\/:*?"<>|\x00-\x1F\x7F]/.test(name) ? '角色名称包含非法字符'
          : /^\./.test(name) || /\.$/.test(name) ? '角色名称不能以点开头或结尾'
          : /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name) ? '角色名称是系统保留名（如 CON/NUL/AUX），请换一个名称'
          : null
        if (badName) return { ok: false, errors: [{ at: 'name', message: badName }] }
        const key = (s) => String(s || '').normalize('NFC').toLowerCase()
        const dup = roleState.roles.some(r => key(r.id) === key(name) && r.id !== args.excludeId)
        if (dup) return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
        return { ok: true }
      }
      case 'vwf.roles.usage': {
        if (state.failUsage === 'resolved') return { ok: false, errors: [{ at: '$', message: '引用统计服务不可用' }] }
        if (state.failUsage) return Promise.reject(new Error('引用统计服务不可用'))
        const u = ROLE_USAGE[args.id] || { count: 0, refs: [] }
        const wfRefs = new Map()
        for (const ref of u.refs || []) wfRefs.set(String(ref.workflowId), { ...ref })
        if (args.draftDsl && Array.isArray(args.draftDsl.nodes)) {
          const draftId = args.draftDsl.id || ('draft:' + String(args.draftDsl.name || '未保存草稿'))
          const nodes = args.draftDsl.nodes.filter(n => n && n.profile === args.id).map(n => ({ id: n.id, label: n.label || n.id }))
          if (nodes.length) wfRefs.set(String(draftId), { workflowId: String(draftId), workflowName: String(args.draftDsl.name || args.draftDsl.id || '未保存草稿'), builtin: false, nodes, draft: true })
        }
        const refs = Array.from(wfRefs.values())
        return { ok: true, id: args.id, count: refs.reduce((s, r) => s + (r.nodes || []).length, 0), refs }
      }
      case 'vwf.validate':
        if (state.failSave) {
          return {
            ok: false,
            errors: [{ at: '$.nodes[node-2].profile', message: '测试错误：节点未关联角色', fieldKey: 'node:node-2:profile', nodeId: 'node-2' }],
            fieldErrors: { 'node:node-2:profile': ['测试错误：节点未关联角色'] },
          }
        }
        // LOC-021：内核 warnings 必须有编辑器出口（此前零消费，警示用户完全不可见）
        if (state.validateWarning) return { ok: true, errors: [], fieldErrors: {}, warnings: [state.validateWarning] }
        return { ok: true, errors: [], fieldErrors: {} }
      case 'vwf.workflows.save':
        state.saved.push(args.dsl)
        return { ok: true, id: args.dsl.id, dsl: args.dsl }
      case 'vwf.i18n':
        return { locale: 'zh', messages: JSON.parse(readFileSync(join(here, '..', 'locales', 'zh.json'), 'utf8')) }
      case 'vwf.script':
        return { ok: true, engineAvailable: false, script: '// compiled' }
      case 'vwf.probe':
        if (state.probe) return state.probe
        return {
          ok: true,
          stage: 'probe',
          results: [
            { key: 'p1\u0000m1', provider: 'p1', model: 'm1', nodes: ['node-1'], status: 'available', code: 'OK', message: '', cached: false },
          ],
          cached: false,
        }
      case 'vwf.runs.list':
        return { runs: runState.runs }
      case 'vwf.logicalRuns.get': {
        const id = String((args && args.logical_run_id) || '')
        if (runState.logicalUnavailable === id) return { found: false, record: null }
        const rec = runState.logical[id]
        return rec ? { found: true, record: rec } : { found: false, record: null }
      }
      case 'vwf.records.list': {
        if (runState.recordsFail) return { ok: false, error: 'records-host.mjs 未找到（LOC-008 运行时集成未部署）' }
        return runState.records[String((args && args.logical_run_id) || '')] || { ok: true, found: true, logical_run_id: String((args && args.logical_run_id) || ''), records: [], attempts: [] }
      }
      case 'vwf.run.control':
        runState.controlCalls.push({ action: String((args && args.action) || ''), logical_run_id: String((args && args.logical_run_id) || ''), text: args && args.text })
        if (runState.controlFail) return { ok: false, error: '仅 PAUSED 的逻辑运行可提交 Guidance；当前为 RUNNING' }
        return { ok: true, action: String((args && args.action) || ''), logical_run_id: String((args && args.logical_run_id) || '') }
      case 'vwf.state': {
        const id = String((args && args.runId) || '')
        if (runState.states[id]) return { found: true, state: runState.states[id] }
        return {
          found: true,
          state: {
            status: 'running', phase: '逐项处理', logs: [],
            agents: [
              { seq: 1, label: '逐项处理 #1', phase: '逐项处理', outcome: 'completed' },
              { seq: 2, label: '逐项处理 #2', phase: '逐项处理', outcome: 'failed' },
              { seq: 3, label: '逐项处理 #3', phase: '逐项处理', outcome: 'completed' },
            ],
          },
        }
      }
      default:
        throw new Error('unexpected rpc: ' + method)
    }
  }
  const styleText = []
  const styles = { insert: (css) => { styleText.push(css); return () => {} } }
  const host = { call: (m, a = null) => rpc(m, a) }
  const slotsFake = {
    inject: (name, fn) => {
      const registered = fn()
      if (registered && registered.__register) return
      // 与真实 slots.register 形态一致：返回的注册回调生成组件
      slotsFake.registered = registered
    },
    register: (opts, Component) => {
      slotsFake.component = Component
      return { __register: true }
    },
  }
  const ctxFake = {
    get: (name) => (name === 'slots' ? slotsFake : undefined),
    timeout: (fn, delay) => makeTimeout(fn, delay),
    interval: () => () => {},
  }
  const harnessTrap = {}
  const closure = new Function('React', 'console', 'styles', 'host', 'harness', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'require', 'process', 'Buffer', src)
  const plugin = closure(React, console, styles, host, harnessTrap, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, undefined, undefined)
  return { plugin, slotsFake, state, styleText }
}

const { plugin, slotsFake, state, styleText } = makeRuntime()
plugin.apply({
  get: (n) => (n === 'slots' ? slotsFake : undefined),
  timeout: (fn, delay) => makeTimeout(fn, delay),
  interval: () => () => {},
})

// slots.inject 的回调里调用了 slots.register —— 用上面的 apply 前需要让 register 返回并设置 component
// 注：slotsFake.inject 会同步调用 fn()，fn 内部 ctx.slots.register(...) 设置 component
// apply 里 inject 的 fn 返回 registered；上方 apply 使用同一个 slotsFake
// 但 plugin.apply 内部的 ctx 是我们传的假 ctx，其 get('slots') 返回 slotsFake
// 而 slotsFake.inject 的 fn 签名是 () => ctx.slots.register(...)，ctx 是插件自己的 ctx —— 一致
// 然而 apply 内部是 `slots.inject('settings.section', () => slots.register({...}, () => h(Page)))`：
// 传给 inject 的是无参回调，回调内部引用的 slots 是 apply 作用域里的 slots（= slotsFake）——成立。
// 上面的 plugin.apply(ctxFake-like) 已经执行；component 已挂到 slotsFake.component

// 上面 makeRuntime 与 apply 的执行顺序：plugin.apply 在运行时同步执行 slotsFake.inject，
// 因此 slotsFake.component 现在就绪。Page 组件：slotsFake.component(props) —— 无 props。
const Page = slotsFake.component

const container = document.createElement('div')
document.body.appendChild(container)
let editorShowModalCalls = 0
dom.window.HTMLDialogElement.prototype.showModal = function () {
  editorShowModalCalls += 1
  this.setAttribute('open', '')
}
dom.window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}
const root = createRoot(container)

test('模板列表渲染并打开全局编辑层', async () => {
  await mountPage(root, container)
  const listItem = byText(container, '测试流')
  assert.ok(listItem, '模板列表渲染')
  await act(async () => {
    const editBtn = byText(container, '编辑')
    assert.ok(editBtn, '存在编辑按钮')
    editBtn.click()
    await flush()
  })
  const editorDialog = container.querySelector('dialog.vwf-editor-dialog')
  assert.ok(editorDialog, '编辑器使用原生顶层 dialog 承载')
  assert.equal(editorShowModalCalls, 1, '打开编辑器时调用 showModal 进入 top layer')
  assert.ok(editorDialog.hasAttribute('open'), '编辑层处于打开状态')
  assert.ok(!container.querySelector('.vwf-drawer'), '不再渲染右侧抽屉')
  const css = styleText.join('\n')
  assert.match(css, /\.vwf-editor-dialog::backdrop/, '编辑层带背景弱化 backdrop')
  assert.match(css, /width:min\(1440px/, '编辑层使用大尺寸自适应宽度')
  assert.match(css, /inset:var\(--vwf-editor-safe-gap\)/, '编辑层保留全局安全边距')
  assert.match(css, /\.vwf-canvas-stage/, '画布使用独立 stage 承载内容')
  assert.match(css, /\.vwf-canvas-wrap[^`]*display:flex/, '滚动容器以 flex 提供自动外边距居中')
  assert.match(css, /\.vwf-canvas-stage[^`]*margin:auto/, 'stage 通过 auto margin 纵横居中')
  assert.ok(byText(container, '工作流编辑器'), '编辑层打开，编辑器标题渲染')
  assert.ok(byText(container, '配置面板'), '配置面板渲染')
  assert.ok(byText(container, '节点配置'), '默认选中首节点，节点表单渲染')
})

test('顶部操作区：新增/删除节点使用图标分组样式', async () => {
  const toolbar = container.querySelector('.vwf-canvas-toolbar')
  assert.ok(toolbar, '顶部操作区渲染')
  const actions = Array.from(toolbar.querySelectorAll('.vwf-toolbar-action'))
  assert.ok(actions.length >= 2, '新增/删除节点成组展示')
  const labels = Array.from(toolbar.querySelectorAll('.vwf-toolbar-action-label')).map((el) => el.textContent)
  assert.ok(labels.includes('新增节点'), '新增节点按钮独立存在')
  assert.ok(labels.includes('删除节点'), '删除节点按钮带减号图标')
  assert.ok(toolbar.querySelectorAll('.vwf-toolbar-action-icon').length >= 2, '操作带圆形图标')
  assert.ok(toolbar.querySelector('.vwf-toolbar-hint'), '连接提示使用独立可换行区域')
  const css = styleText.join('\n')
  assert.ok(css.includes('.vwf-canvas-toolbar { display:flex;'), '操作区使用 flex 排布')
  assert.ok(css.includes('flex-wrap:wrap'), '窄屏允许操作区换行')
  assert.ok(css.includes('.vwf-toolbar-actions {'), '操作以分组胶囊承载')
  assert.ok(css.includes('.vwf-toolbar-action.danger:disabled {'), '删除操作禁用态保持完整红色')
})

test('撤销/重做：恢复节点增删并清空重做分支', async () => {
  const undoBtn = container.querySelector('.vwf-history-group .vwf-history-btn:first-child')
  const redoBtn = container.querySelector('.vwf-history-group .vwf-history-btn:last-child')
  assert.ok(undoBtn && redoBtn, '存在撤销/重做按钮')
  assert.equal(undoBtn.disabled, true, '初始撤销禁用')
  assert.equal(redoBtn.disabled, true, '初始重做禁用')
  const addAction = container.querySelector('.vwf-toolbar-action:first-child')
  const nodeLabels = () => Array.from(container.querySelectorAll('text.vwf-node-label')).map((el) => el.textContent)
  await act(async () => {
    addAction.click()
    await flush()
  })
  assert.ok(nodeLabels().includes('节点2'), '新增后可撤销')
  assert.equal(undoBtn.disabled, false, '撤销可用')
  await act(async () => {
    undoBtn.click()
    await flush()
  })
  assert.ok(!nodeLabels().includes('节点2'), '撤销移除刚新增的节点')
  assert.equal(redoBtn.disabled, false, '重做可用')
  await act(async () => {
    redoBtn.click()
    await flush()
  })
  assert.ok(nodeLabels().includes('节点2'), '重做恢复节点')
  await act(async () => {
    undoBtn.click()
    await flush()
  })
  assert.ok(!nodeLabels().includes('节点2'), '再次撤销回到初始状态，供后续测试复用')
  const deleteAction = container.querySelector('.vwf-toolbar-action.danger')
  assert.equal(deleteAction.disabled, false, '撤销后选中真实存在的首节点，删除按钮指向有效节点')
  assert.ok(nodeLabels().includes('节点1'), '撤销后仍选中首个节点')

  // JSON 非法中间态也可回退
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, '{"nodes":')
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  assert.equal(undoBtn.disabled, false, '非法 JSON 输入后也可撤销')
  await act(async () => {
    undoBtn.click()
    await flush()
  })
  const textarea = container.querySelector('textarea.vwf-json-edit')
  assert.ok(textarea.value.includes('"node-1"'), '撤销恢复合法 JSON 草稿')
  await act(async () => {
    redoBtn.click()
    await flush()
  })
  assert.equal(container.querySelector('textarea.vwf-json-edit').value, '{"nodes":', '重做恢复非法 JSON 中间态')
  await act(async () => {
    undoBtn.click()
    await flush()
  })
  assert.ok(container.querySelector('textarea.vwf-json-edit').value.includes('"node-1"'), '再次撤销回到合法 JSON')
  await act(async () => {
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
})

test('撤销历史上限：连续编辑超过上限后撤销不越界（栈封顶 50）', async () => {
  const undoBtn = container.querySelector('.vwf-history-group .vwf-history-btn:first-child')
  const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
  await act(async () => {
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    const base = JSON.parse(textarea.value)
    for (let i = 1; i <= 60; i += 1) {
      const next = JSON.parse(JSON.stringify(base))
      next.control = next.control || {}
      next.control.maxRounds = (i % 9) + 1
      setter.call(textarea, JSON.stringify(next, null, 2))
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    await flush()
  })
  assert.equal(undoBtn.disabled, false, '60 次连续 JSON 编辑后可撤销')
  let clicks = 0
  for (let i = 0; i < 80; i += 1) {
    if (undoBtn.disabled) break
    await act(async () => {
      undoBtn.click()
      await flush()
    })
    clicks += 1
  }
  assert.ok(clicks <= 50, '撤销次数受历史上限约束（实际 ' + clicks + '）')
  assert.ok(clicks >= 1, '至少可撤销一次')
  assert.equal(undoBtn.disabled, true, '到达上限后撤销禁用')
  const textarea = container.querySelector('textarea.vwf-json-edit')
  const restored = JSON.parse(textarea.value)
  assert.equal(restored.id, 'wf1', '撤销终点为封顶时保留的草稿（不越界、不损坏）')
  assert.ok((restored.nodes || []).length > 0, '草稿结构未损坏')
  await act(async () => {
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
})

test('新增节点：画布出现新节点并选中', async () => {
  await act(async () => {
    const addBtn = byText(container, '新增节点')
    assert.ok(addBtn, '存在新增节点按钮')
    addBtn.click()
    await flush()
  })
  const svg = container.querySelector('svg.vwf-svg')
  assert.ok(svg, 'SVG 画布渲染')
  const labels = Array.from(svg.querySelectorAll('text.vwf-node-label')).map((el) => el.textContent)
  assert.ok(labels.includes('节点2'), '新增节点出现在画布：' + labels.join(','))
  assert.ok(byText(container, '节点配置'), '新增节点被选中，节点表单仍在')
})

test('重置视图：内容超出小画布时纵横居中', async () => {
  const wrap = container.querySelector('.vwf-canvas-wrap')
  Object.defineProperty(wrap, 'clientWidth', { value: 1000, configurable: true })
  Object.defineProperty(wrap, 'clientHeight', { value: 120, configurable: true })
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 120, right: 1000, bottom: 120 })
  await act(async () => {
    container.querySelector('.vwf-zoom button[title="适配视图"]').click()
    await flush()
  })
  assert.equal(wrap.scrollLeft, 0, '横向内容不足时由 stage 居中，不产生偏移')
  assert.ok(wrap.scrollTop > 0, '纵向内容超出时重置到纵向中心')
  wrap.scrollLeft = 31
  wrap.scrollTop = 2
  await act(async () => {
    container.querySelector('.vwf-zoom button[title="适配视图"]').click()
    await flush()
  })
  assert.equal(wrap.scrollLeft, 0, '用户移动后点击重置恢复横向中心')
  assert.ok(wrap.scrollTop > 0, '用户移动后点击重置恢复纵向中心')
  Object.defineProperty(wrap, 'clientHeight', { value: 600, configurable: true })
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 })
})

test('拖拽连线：从节点下把手拖到结束节点创建新边', async () => {
  const wrap = container.querySelector('.vwf-canvas-wrap')
  Object.defineProperty(wrap, 'clientWidth', { value: 1000, configurable: true })
  Object.defineProperty(wrap, 'clientHeight', { value: 600, configurable: true })
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 })
  // fitView 已在首帧调用（clientWidth 0 时 scale=0.3）；重新触发一次 fit 以对齐坐标假设
  const before = container.querySelectorAll('.vwf-edge-flow').length
  // 拖动目标：$end 节点的实际屏幕坐标（纵向布局下它在源节点下方，位置随布局变化，按 DOM 实测算）
  const targetCenter = () => {
    const svg = container.querySelector('svg.vwf-svg')
    const rect = svg.getBoundingClientRect()
    const g = container.querySelector('g[data-node-id="$end"]')
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    const box = g.querySelector('rect')
    const scale = Number(svg.getAttribute('width')) / Number(svg.getAttribute('viewBox').split(' ')[2])
    return {
      x: rect.left + (Number(m[1]) + Number(box.getAttribute('width')) / 2) * scale,
      y: rect.top + (Number(m[2]) + Number(box.getAttribute('height')) / 2) * scale,
    }
  }
  const dest = targetCenter()
  await act(async () => {
    const fitBtn = container.querySelector('.vwf-zoom button[title="适配视图"]')
    if (fitBtn) fitBtn.click()
    await flush()
  })
  const dest2 = targetCenter()
  await act(async () => {
    const handles = container.querySelectorAll('.vwf-handle-src')
    assert.ok(handles.length >= 2, '存在源把手（node-1、node-2）')
    const srcHandle = handles[0]
    srcHandle.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 80 }))
    // 拖到 $end 节点实际中心
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: dest2.x, clientY: dest2.y }))
    await flush()
  })
  // act 结束后 React 已提交：拖线指向的目标节点应带高亮标记
  const targetHit = container.querySelector('[data-vwf-connect-target="true"]')
  assert.ok(targetHit, '拖线指向目标节点时高亮标记出现')
  assert.equal(targetHit.closest('g').getAttribute('data-node-id'), '$end', '高亮目标为拖动指向的节点')
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: dest2.x, clientY: dest2.y }))
    await flush()
  })
  const after = container.querySelectorAll('.vwf-edge-flow').length
  assert.ok(after === before + 1, '连线创建新边（' + before + ' → ' + after + '）')
})

test('画布任意非把手区域支持四向拖动且不修改工作流内容', async () => {
  const wrap = container.querySelector('.vwf-canvas-wrap')
  const stage = container.querySelector('.vwf-canvas-stage')
  const nodeCard = container.querySelector('.vwf-node-card')
  const beforeEdges = container.querySelectorAll('.vwf-edge-flow').length
  const beforeNodes = container.querySelectorAll('.vwf-node-card').length
  Object.defineProperty(wrap, 'scrollWidth', { value: 1000, configurable: true })
  Object.defineProperty(wrap, 'scrollHeight', { value: 600, configurable: true })
  wrap.scrollLeft = 120
  wrap.scrollTop = 80
  await act(async () => {
    nodeCard.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 200 }))
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 340, clientY: 150 }))
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 340, clientY: 150 }))
    await flush()
  })
  assert.equal(stage.style.transform, 'translate(40px,-50px)', '无滚动空间时拖动节点区域也会移动画布')
  assert.equal(wrap.scrollLeft, 120, '无横向滚动空间时不写 scrollLeft')
  assert.equal(wrap.scrollTop, 80, '无纵向滚动空间时不写 scrollTop')

  Object.defineProperty(wrap, 'scrollWidth', { value: 1400, configurable: true })
  Object.defineProperty(wrap, 'scrollHeight', { value: 900, configurable: true })
  await act(async () => {
    stage.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 340, clientY: 150 }))
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 210 }))
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 210 }))
    await flush()
  })
  assert.equal(wrap.scrollLeft, 160, '有横向滚动空间时继续走横向滚动')
  assert.equal(wrap.scrollTop, 20, '有纵向滚动空间时支持纵向滚动')
  assert.equal(container.querySelectorAll('.vwf-edge-flow').length, beforeEdges, '拖动浏览不增删边')
  assert.equal(container.querySelectorAll('.vwf-node-card').length, beforeNodes, '拖动浏览不增删节点')
})

test('点击边：成功/失败/选中颜色区分且边配置面板出现', async () => {
  const firstEdge = container.querySelectorAll('.vwf-edge-flow')[0]
  assert.equal(firstEdge.getAttribute('stroke'), 'var(--vwf-accent)', '默认 success 边使用强调语义色（不随品牌色变黑）')
  await act(async () => {
    const hit = container.querySelector('.vwf-edge-hit')
    assert.ok(hit, '存在边命中路径')
    hit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.ok(byText(container, '边配置'), '边配置面板渲染')
  assert.ok(byText(container, '删除边'), '边面板含删除按钮')
  assert.equal(firstEdge.getAttribute('stroke'), 'var(--vwf-text)', '选中边使用主文字语义色')
  assert.equal(firstEdge.getAttribute('stroke-width'), '4.2', '选中边加粗')
  const selectedLabel = Array.from(container.querySelectorAll('text')).find((el) => el.textContent.includes('成功') && el.getAttribute('fill') === 'var(--vwf-text)')
  assert.ok(selectedLabel, '选中边标签同步使用主文字色')
  assert.equal(selectedLabel.getAttribute('font-weight'), '700', '选中边标签加粗')
  assert.equal(selectedLabel.style.stroke, 'var(--vwf-surface)', '选中标签描边取表面语义色（两主题都与画布底成对）')
  assert.equal(container.querySelector('#vwf-arrow-sel path').getAttribute('fill'), 'var(--vwf-text)', '选中边箭头同步使用主文字语义色')
})

test('删除节点：选中节点被移除且画布消失', async () => {
  await act(async () => {
    // 重新选中节点
    const svg = container.querySelector('svg.vwf-svg')
    const node2 = Array.from(svg.querySelectorAll('g')).find((g) => g.textContent.includes('节点2') && g.textContent.includes('worker'))
    assert.ok(node2, '找到节点2')
    node2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
    const delBtn = byText(container, '删除节点')
    assert.ok(delBtn, '删除节点按钮可用')
    delBtn.click()
    await flush()
  })
  const svg = container.querySelector('svg.vwf-svg')
  const labels = Array.from(svg.querySelectorAll('text.vwf-node-label')).map((el) => el.textContent)
  assert.ok(!labels.includes('节点2'), '节点2 已删除：' + labels.join(','))
})

test('JSON tab：双 tab 切换与 JSON 编辑区', async () => {
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    assert.ok(jsonTab, '存在 JSON tab')
    jsonTab.click()
    await flush()
  })
  const textarea = container.querySelector('textarea.vwf-json-edit')
  assert.ok(textarea, 'JSON 编辑区渲染')
  assert.ok(textarea.value.includes('"node-1"'), 'JSON 草稿与工作流同步')
  await act(async () => {
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
})

test('fanout 编辑器：类型切换显示专属字段，画布卡片同步类型', async () => {
  await openSection(container, 'advanced')
  const kindLabel = byText(container, '节点类型')
  assert.ok(kindLabel, '存在节点类型字段')
  const kindSelect = kindLabel.closest('.vwf-field').querySelector('select')
  await act(async () => {
    kindSelect.value = 'fanout'
    kindSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await flush()
  })
  await openSection(container, 'advanced')
  assert.ok(byText(container, 'items 来源'), 'fanout 显示 items 来源')
  await openSection(container, 'outcome')
  assert.ok(byText(container, '失败阈值'), 'fanout 显示失败阈值（结果与去向档）')
  await openSection(container, 'advanced')
  assert.ok(container.querySelector('.vwf-help[title*="该 Schema 校验每个子代理"]'), 'fanout 显示 per-item schema 说明')
  const kinds = Array.from(container.querySelectorAll('text.vwf-node-kind')).map((el) => el.textContent)
  assert.ok(kinds.includes('fanout'), '画布卡片显示 fanout')
})

test('fanout 看板：按节点归组展示三项并保留失败状态', async () => {
  await act(async () => {
    const dashboardTab = container.querySelector('[data-vwf-nav="dashboard"]')
    assert.ok(dashboardTab, '顶部导航有运行页签（FEAT-100 V-1）')
    dashboardTab.click()
    await flush()
    await flush()
    await flush()
  })
  // FEAT-85：详情入口收敛为唯一出口——运行编号输入框 + 「详情」按钮打开该运行详情工作区
  const input = container.querySelector('input[placeholder^="运行编号"]')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'run-1')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  await act(async () => {
    const openBtn = Array.from(input.parentElement.querySelectorAll('button')).find((b) => b.textContent === '详情')
    assert.ok(openBtn, '详情按钮存在')
    openBtn.click()
    await flush()
    await flush()
    await flush()
  })
  assert.ok(container.querySelector('.vwf-rd-main'), '进入详情工作区')
  // FEAT-103 V-3/V-4：节点 / 结果的全貌与并行组归组移到「查看完整经过」链路弹窗；
  // 页面底部不再并列一份重复的节点 / 结果表。
  let chainRowBtn = null
  await act(async () => {
    chainRowBtn = Array.from(container.querySelectorAll('.vwf-rd-strip button')).find((b) => b.textContent.includes('查看完整经过'))
    assert.ok(chainRowBtn, '状态条提供查看完整经过')
    chainRowBtn.click()
    await flush()
  })
  const chain = container.querySelector('.vwf-chain')
  assert.ok(chain, '链路弹窗打开')
  assert.ok(byText(chain, '逐项处理 · fanout · 3 items'), '链路显示 fanout 组标题')
  assert.ok(byText(chain, '逐项处理 #1'), '组内逐项列出（原节点 / 结果表口径）')
  assert.ok(byText(chain, '逐项处理 #2'))
  const failed = Array.from(chain.querySelectorAll('.vwf-badge')).find((el) => el.textContent.includes('failed'))
  assert.ok(failed && failed.textContent === '✕ failed', '失败项状态同时有形状与文字（V-4 双通道）')
  const failedEntry = failed.closest('.vwf-chain-entry')
  assert.ok(failedEntry && failedEntry.className.includes('tone-failed'), '失败项在链路里落到失败语义样式类')
  // 失败（err）与退回修改（warn）在链路上仍是两种语义色，不只靠形状与文字
  const chainCss = styleText.join('\n')
  assert.match(chainCss, /\.vwf-chain-entry\.tone-failed \.vwf-chain-dot \{[^}]*var\(--vwf-err\)/, '失败项用失败语义 token')
  assert.match(chainCss, /\.vwf-chain-entry\.tone-returned \.vwf-chain-dot \{[^}]*var\(--vwf-warn\)/, '退回项用注意语义 token')
  // Escape 逐层：链路弹窗是详情之上的一层，先关它（不把整个工作区带走）
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  assert.ok(!container.querySelector('.vwf-chain'), 'Escape 关闭链路弹窗')
  assert.ok(container.querySelector('.vwf-rd-main'), '工作区详情仍在（Escape 只收一层）')
  assert.ok(dom.window.document.activeElement === chainRowBtn, 'Escape 关闭后焦点回收到触发按钮')
  assert.ok(!container.textContent.includes('逐项处理 · fanout'), '看板页面不再并列一份重复的节点 / 结果表')
  await act(async () => {
    const templatesTab = container.querySelector('[data-vwf-nav="templates"]')
    assert.ok(templatesTab, '顶部导航有流程库页签（FEAT-100 V-1）')
    templatesTab.click()
    await flush()
  })
})

test('保存校验：失败弹窗 → 关闭后字段标红', async () => {
  // 重新加一个节点（id 复用为 node-2）并使其选中，以便字段错误渲染到节点表单
  await act(async () => {
    const addBtn = byText(container, '新增节点')
    addBtn.click()
    await flush()
  })
  state.failSave = true
  await act(async () => {
    const saveBtn = byText(container, '保存工作流')
    assert.ok(saveBtn, '保存按钮存在')
    saveBtn.click()
    await flush()
    await flush()
  })
  assert.ok(byText(container, '工作流无法保存'), '校验失败弹窗出现')
  assert.ok(byText(container, '测试错误：节点未关联角色'), '弹窗列出问题')
  await act(async () => {
    const closeBtn = byText(container, '查看并修正')
    closeBtn.click()
    await flush()
  })
  assert.ok(!byText(container, '工作流无法保存'), '弹窗关闭')
  assert.ok(byText(container, '测试错误：节点未关联角色'), '字段标红显示错误')
  state.failSave = false
})

test('保存成功路径：调用 save RPC', async () => {
  await act(async () => {
    const saveBtn = byText(container, '保存工作流')
    saveBtn.click()
    await flush()
    await flush()
  })
  assert.ok(state.saved.length >= 1, 'save RPC 被调用')
  assert.equal(state.saved[0].id, 'wf1')
})

test('LOC-021 校验警示在编辑器可见（内核 warnings 有用户出口）', async () => {
  // A-1 回归：内核 warnings 此前在编辑器零消费——「无配对时警示即可」的定案会对用户不可见。
  // 走真实防抖实时校验通道（打开编辑器即触发），断言警示渲染到状态区。
  state.validateWarning = '异源档位 strong 已声明，但该蓝图没有开发与审核节点，强档要求无从执行'
  realDebounceTimer = true
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  try {
    await act(async () => {
      freshRoot.render(React.createElement(Page))
      await flush()
      await flush()
    })
    await act(async () => {
      const editBtn = byText(fresh, '编辑')
      assert.ok(editBtn, '存在编辑按钮')
      editBtn.click()
      await flush()
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
    assert.ok(byText(fresh, '异源档位 strong 已声明'), '警示文案必须渲染到编辑器（否则定案对用户不可见）')
    assert.ok(byText(fresh, '条校验提示'), '警示以提示计数呈现')
  } finally {
    state.validateWarning = null
    realDebounceTimer = false
    await act(async () => { freshRoot.unmount() })
    fresh.remove()
  }
})

test('防重叠：跨节点边与回边路走外围车道，标签避开中间节点', async () => {
  const complexDsl = {
    id: 'overlap-flow',
    name: '防重叠测试',
    entry: 'start',
    control: { maxRounds: 9 },
    nodes: [
      { id: 'start', profile: 'dispatcher', label: '开始' },
      { id: 'middle', profile: 'dev', label: '汇总' },
      { id: 'review', profile: 'review', label: '复核' },
    ],
    edges: [
      { from: 'start', to: 'middle', on: 'success', when: '$.normal == true' },
      { from: 'start', to: 'middle', on: 'success', when: '$.alternate == true' },
      { from: 'middle', to: 'review', on: 'success' },
      { from: 'start', to: 'review', on: 'success', when: '$.skip == true' },
      { from: 'review', to: 'middle', on: 'failure' },
      { from: 'review', to: '$end', on: 'success' },
    ],
  }
  await act(async () => {
    byText(container, '编辑').click()
    await flush()
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(complexDsl, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })

  const svg = container.querySelector('svg.vwf-svg')
  const paths = Array.from(svg.querySelectorAll('path.vwf-edge-flow'))
  assert.ok(paths[3].getAttribute('d').includes(' L '), '跨节点 success 边改走正交外围车道')
  assert.ok(paths[4].getAttribute('d').includes(' L '), 'failure 回路边改走正交外围车道')
  // 平行直连边（start→middle 两条条件边）：共享起点槽位但曲线分离（命中路径不重叠，
  // 否则后画的 path 会拦截所有点击，前一条边无法在画布上选中）
  assert.notEqual(paths[0].getAttribute('d'), paths[1].getAttribute('d'), '平行直连边曲线相互分离')

  const middleGroup = Array.from(svg.querySelectorAll('g')).find((g) => g.textContent.includes('汇总') && g.textContent.includes('worker'))
  const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(middleGroup.getAttribute('transform'))
  const middle = { x: Number(match[1]), y: Number(match[2]), w: 220, h: 66 }
  const edgeLabels = Array.from(svg.querySelectorAll('text')).filter((el) => el.textContent.includes('成功') || el.textContent.includes('失败'))
  assert.notEqual(
    edgeLabels[0].getAttribute('x') + ':' + edgeLabels[0].getAttribute('y'),
    edgeLabels[1].getAttribute('x') + ':' + edgeLabels[1].getAttribute('y'),
    '同起终点的多条边标签不得完全重叠'
  )
  const skipLabel = edgeLabels[3]
  const failureLabel = edgeLabels[4]
  for (const label of [skipLabel, failureLabel]) {
    const x = Number(label.getAttribute('x'))
    const y = Number(label.getAttribute('y'))
    const inside = x > middle.x && x < middle.x + middle.w && y > middle.y && y < middle.y + middle.h
    assert.equal(inside, false, '边标签不得覆盖中间节点')
  }

  const groups = Array.from(svg.querySelectorAll('g')).filter((g) => g.querySelector('.vwf-node-card'))
  const rects = groups.map((g) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return { x: Number(m[1]), y: Number(m[2]), w: 220, h: 66 }
  })
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]
      const b = rects[j]
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
      assert.equal(overlap, 0, '节点主体不得互相覆盖')
    }
  }

  // 规则 6（V-12 纵向布局）：所有边终点落在目标节点上边框水平居中（不做目标锚点间隔）
  const endPointOf = (d) => {
    const nums = d.trim().split(/[\s,]+/).map(Number)
    return { x: nums[nums.length - 2], y: nums[nums.length - 1] }
  }
  const nodeCenterX = (g) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    const w = Number(g.querySelector('rect').getAttribute('width'))
    return Number(m[1]) + w / 2
  }
  const nodeTopY = (g) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return Number(m[2])
  }
  // 规则 6：每条边的终点都落在目标节点上边框水平居中（数据驱动，取自 dsl 与 DOM 实测宽度）
  complexDsl.edges.forEach((e, i) => {
    const g = svg.querySelector('g[data-node-id="' + e.to + '"]')
    assert.ok(g, '画布存在目标节点 ' + e.to)
    const end = endPointOf(paths[i].getAttribute('d'))
    assert.equal(end.x, nodeCenterX(g), '边 ' + i + ' 终点在 ' + e.to + ' 上边框水平居中')
    assert.equal(end.y, nodeTopY(g), '边 ' + i + ' 终点落在 ' + e.to + ' 上边框')
  })
  // 规则 5（V-12 纵向布局）：同源起点按「左绕(上绕) → 直连 → 右绕(下绕)」自左而右间隔，
  // 与边在 dsl 中的出现顺序无关；起点圆点与对应边同色，且精确落在源节点下边框。
  const starts = Array.from(svg.querySelectorAll('circle.vwf-edge-start'))
  assert.equal(starts.length, paths.length, '每条边有一个起点圆点')
  const nodeBottomY = (id) => {
    const g = svg.querySelector('g[data-node-id="' + id + '"]')
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return Number(m[2]) + Number(g.querySelector('rect').getAttribute('height'))
  }
  complexDsl.edges.forEach((e, i) => {
    assert.equal(starts[i].getAttribute('fill'), paths[i].getAttribute('stroke'), '边 ' + i + ' 起点圆点与边同色')
    assert.equal(Number(starts[i].getAttribute('cy')), nodeBottomY(e.from), '边 ' + i + ' 起点落在 ' + e.from + ' 下边框')
  })
  const rankOf = { up: 0, direct: 1, down: 2 }
  // 路径类型判定：命令字母 + 数字序列解析（与空格/逗号格式无关）；直连为 C 曲线，绕行为 L 折线。
  // 纵向布局里转置后的路径是 'M 起点x 起点y L 起点x … L 车道x …'，起点槽位与车道都落在横轴上。
  const kindOf = (i) => {
    const d = paths[i].getAttribute('d')
    if (/C/.test(d)) return 'direct'
    const nums = d.match(/-?[\d.]+/g).map(Number)
    const startX = nums[0]
    const laneX = nums[4]
    return laneX < startX ? 'up' : 'down'
  }
  const perSource = new Map()
  complexDsl.edges.forEach((e, i) => {
    const list = perSource.get(e.from) || []
    list.push({ idx: i, kind: kindOf(i) })
    perSource.set(e.from, list)
  })
  for (const [src, list] of perSource) {
    const cxOf = (idx) => Number(starts[idx].getAttribute('cx'))
    const sorted = list.slice().sort((a, b) => rankOf[a.kind] - rankOf[b.kind] || a.idx - b.idx)
    for (let k = 1; k < sorted.length; k += 1) {
      // 优化 3：固定三槽位——同类边共享槽位（相等），跨类严格右移（左绕<直连<右绕）
      assert.ok(cxOf(sorted[k].idx) >= cxOf(sorted[k - 1].idx),
        '源 ' + src + ' 起点按 ' + sorted[k - 1].kind + '→' + sorted[k].kind + ' 自左而右不左移')
      if (sorted[k].kind !== sorted[k - 1].kind) {
        assert.ok(cxOf(sorted[k].idx) > cxOf(sorted[k - 1].idx),
          '源 ' + src + ' 起点按 ' + sorted[k - 1].kind + '→' + sorted[k].kind + ' 跨类严格右移')
      }
    }
    // 直连槽位 = 节点下边框水平居中（与连线源把手位置一致）
    for (const item of sorted) {
      if (item.kind === 'direct') {
        const g = svg.querySelector('g[data-node-id="' + src + '"]')
        const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
        const center = Number(m[1]) + Number(g.querySelector('rect').getAttribute('width')) / 2
        assert.equal(cxOf(item.idx), center, '源 ' + src + ' 直连起点与节点下框水平居中一致')
      }
    }
  }
  // 连接把手：默认隐藏（无对应边的节点右侧不出现无意义灰点），节点悬停时才显示
  const handleCss = styleText.join('\n')
  assert.ok(/\.vwf-handle\s*\{[^}]*opacity:\s*0/i.test(handleCss), '连接把手默认透明（悬停显示）')
  assert.ok(/g:hover\s*>\s*\.vwf-handle\s*\{[^}]*opacity:\s*1/i.test(handleCss), '悬停节点时显示把手')
})

test('防重叠：入口变化会触发画布布局重算', async () => {
  const makeDsl = (entry) => ({
    id: 'entry-layout',
    name: '入口布局测试',
    entry,
    control: { maxRounds: 9 },
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b', profile: 'dev', label: 'B' },
    ],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const setDsl = async (dsl) => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(dsl, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  }
  const xyOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return { x: Number(match[1]), y: Number(match[2]) }
  }
  // V-12 纵向布局：A、B 同属主序号 0（同一行），入口决定谁排在左侧
  await act(async () => { await setDsl(makeDsl('a')) })
  assert.equal(xyOf('a').y, xyOf('b').y, '同一主序号的两个节点排在同一行')
  assert.ok(xyOf('a').x < xyOf('b').x, 'entry=a 时 A 排在 B 左侧')
  await act(async () => { await setDsl(makeDsl('b')) })
  assert.ok(xyOf('b').x < xyOf('a').x, 'entry 改为 b 后 B 排在 A 左侧')
})

test('两级序号：HD 透传后收口主序号在 UAT 右侧，不再与入口同列', async () => {
  const hdDsl = {
    id: 'hd-seq-layout',
    name: 'HD 序号布局',
    entry: 'preflight',
    control: { maxRounds: 3 },
    nodes: [
      { id: 'preflight', profile: 'evaluator', label: '实施前检查' },
      { id: 'dev', profile: 'dev', label: '开发' },
      { id: 'uat', profile: 'accept', label: 'UAT 准备' },
      { id: 'closeout', profile: 'closeout', label: '收口' },
    ],
    edges: [
      { from: 'preflight', to: 'dev', outcome: 'PASS' },
      { from: 'dev', to: 'uat', outcome: 'READY' },
      { from: 'uat', to: '$human-decision', outcome: 'READY_FOR_HUMAN' },
      { from: '$human-decision', to: 'closeout', outcome: 'ACCEPT' },
      { from: '$human-decision', to: 'dev', outcome: 'REJECT' },
      { from: 'closeout', to: '$end', outcome: 'DELIVERED' },
    ],
  }
  // 为 outcome 边补最小 schema，避免编辑器侧校验干扰画布（本测只关心布局）
  hdDsl.nodes.forEach((n) => {
    if (n.id === 'preflight') n.output = { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['PASS'] } }, required: ['route'], additionalProperties: false } }
    if (n.id === 'dev') n.output = { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY'] } }, required: ['route'], additionalProperties: false } }
    if (n.id === 'uat') n.output = { outcomePath: '$.route', schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY_FOR_HUMAN'] } }, required: ['route'], additionalProperties: false } }
    if (n.id === 'closeout') n.output = { outcomePath: '$.status', schema: { type: 'object', properties: { status: { type: 'string', enum: ['DELIVERED'] } }, required: ['status'], additionalProperties: false } }
  })
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(hdDsl, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
  const xyOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    assert.ok(g, '缺少节点 ' + id)
    const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return { x: Number(match[1]), y: Number(match[2]) }
  }
  const seqOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    const badge = g && g.querySelector('[data-node-seq]')
    return badge ? badge.getAttribute('data-node-seq') : null
  }
  const pre = xyOf('preflight')
  const close = xyOf('closeout')
  // V-12 纵向布局：主序号前进 = 在画布上更靠下
  assert.ok(close.y > pre.y + 50, '收口应在实施前检查下方（HD 透传后主序号前进），got pre.y=' + pre.y + ' close.y=' + close.y)
  assert.equal(seqOf('preflight'), '0')
  assert.equal(seqOf('dev'), '1')
  assert.equal(seqOf('uat'), '2')
  assert.equal(seqOf('closeout'), '3')
})

test('两级序号：同级多节点显示 m.1 / m.2 且左右并排（V-12 纵向布局）', async () => {
  const parallelDsl = {
    id: 'parallel-seq',
    name: '同列序号',
    entry: 'a',
    control: { maxRounds: 9 },
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b1', profile: 'dev', label: 'B1' },
      { id: 'b2', profile: 'review', label: 'B2' },
    ],
    edges: [
      { from: 'a', to: 'b1', on: 'success' },
      { from: 'a', to: 'b2', on: 'success' },
      { from: 'b1', to: '$end', on: 'success' },
      { from: 'b2', to: '$end', on: 'success' },
    ],
  }
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(parallelDsl, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
  const xyOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return { x: Number(match[1]), y: Number(match[2]) }
  }
  const seqOf = (id) => container.querySelector('g[data-node-id="' + id + '"] [data-node-seq]').getAttribute('data-node-seq')
  assert.equal(seqOf('a'), '0')
  assert.equal(seqOf('b1'), '1.1')
  assert.equal(seqOf('b2'), '1.2')
  // V-12 纵向布局：同一主序号的兄弟左右并排，1.1 在 1.2 左侧
  assert.ok(Math.abs(xyOf('b1').y - xyOf('b2').y) < 2, '同级兄弟同一行')
  assert.ok(xyOf('b1').x < xyOf('b2').x, '同列 1.1 应在 1.2 左侧')
})

test('自环边：布局不进入死循环，终点仍在节点上边框水平居中', async () => {
  const selfLoopDsl = {
    id: 'self-loop',
    name: '自环测试',
    entry: 'a',
    control: { maxRounds: 9 },
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b', profile: 'dev', label: 'B' },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'a', to: 'a', on: 'success' },
    ],
  }
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(selfLoopDsl, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
  const svg = container.querySelector('svg.vwf-svg')
  const paths = Array.from(svg.querySelectorAll('path.vwf-edge-flow'))
  assert.equal(paths.length, 2, '自环边正常渲染不崩溃')
  const endPointOf = (d) => {
    const nums = d.trim().split(/[\s,]+/).map(Number)
    return { x: nums[nums.length - 2], y: nums[nums.length - 1] }
  }
  const aG = container.querySelector('g[data-node-id="a"]')
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(aG.getAttribute('transform'))
  // V-12 纵向布局：终点落在目标节点上边框水平居中
  const aCenterX = Number(m[1]) + Number(aG.querySelector('rect').getAttribute('width')) / 2
  const end = endPointOf(paths[1].getAttribute('d'))
  assert.equal(end.x, aCenterX, '自环边终点仍在节点上边框水平居中')
  assert.equal(end.y, Number(m[2]), '自环边终点落在目标节点上边框')
})

test('编辑器关闭：未保存草稿使用统一样式确认弹窗', async () => {
  // 用全新渲染隔离前序测试留下的编辑器状态
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  // 打开编辑器
  await act(async () => {
    const editBtn = byText(fresh, '编辑')
    assert.ok(editBtn, '存在编辑按钮')
    editBtn.click()
    await flush()
  })
  const dialog = fresh.querySelector('dialog.vwf-editor-dialog')
  assert.ok(dialog, '编辑器打开')
  // 制造未保存改动
  await act(async () => {
    const addBtn = byText(fresh, '新增节点')
    assert.ok(addBtn, '存在新增节点按钮')
    addBtn.click()
    await flush()
  })
  // 阻断原生 confirm：确认层为产品样式，全程不得调用浏览器原生确认框
  let nativeConfirmCalls = 0
  const origConfirm = dom.window.confirm
  dom.window.confirm = () => { nativeConfirmCalls += 1; return false }
  // Escape → 弹出统一确认层，而不是浏览器原生 confirm
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
  })
  const confirmMask = fresh.querySelector('.vwf-confirm-mask')
  assert.ok(confirmMask, '未保存关闭时显示统一样式确认弹窗')
  assert.ok(confirmMask.querySelector('.vwf-confirm'), '确认层含产品样式对话框')
  // FEAT-84：未保存关闭为三选一（继续编辑 / 放弃修改 / 保存并返回）
  assert.ok(byText(fresh, '继续编辑'), '存在「继续编辑」按钮')
  assert.ok(byText(fresh, '放弃修改'), '存在「放弃修改」按钮')
  assert.ok(byText(fresh, '保存并返回'), '存在「保存并返回」按钮')
  const maskRect = confirmMask.getBoundingClientRect ? confirmMask.getBoundingClientRect() : null
  if (maskRect && maskRect.width) {
    // jsdom 无法布局时跳过位置断言；真实 Chromium 证据另在 docs 中采集
    assert.ok(Math.abs((maskRect.top + maskRect.height / 2) - (window.innerHeight / 2)) < 2, '确认弹窗纵向居中')
    assert.ok(Math.abs((maskRect.left + maskRect.width / 2) - (window.innerWidth / 2)) < 2, '确认弹窗横向居中')
  }
  await act(async () => {
    byText(fresh, '继续编辑').click()
    await flush()
  })
  assert.ok(fresh.querySelector('dialog.vwf-editor-dialog'), '点击我再想想后编辑器仍打开')
  assert.ok(!fresh.querySelector('.vwf-confirm-mask'), '继续编辑关闭确认弹窗')
  // 再次取消 → 点击遮罩空白关闭（编辑器保留）
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
  })
  assert.ok(fresh.querySelector('.vwf-confirm-mask'), '再次取消弹出确认层')
  await act(async () => {
    fresh.querySelector('.vwf-confirm-mask').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.ok(fresh.querySelector('dialog.vwf-editor-dialog'), '点击遮罩后编辑器仍打开')
  assert.ok(!fresh.querySelector('.vwf-confirm-mask'), '点击遮罩关闭确认弹窗')
  // 再次取消 → 点击「放弃修改」关闭
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
    byText(fresh, '放弃修改').click()
    await flush()
  })
  assert.equal(fresh.querySelector('dialog.vwf-editor-dialog'), null, '点击放弃修改后编辑器关闭')
  assert.equal(nativeConfirmCalls, 0, '全程未调用 window.confirm')
  dom.window.confirm = origConfirm
  // 干净状态（无未保存改动）直接关闭，不询问
  await act(async () => {
    byText(fresh, '编辑').click()
    await flush()
    assert.ok(fresh.querySelector('dialog.vwf-editor-dialog'), '重新打开编辑器（干净状态）')
  })
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
    assert.ok(!fresh.querySelector('.vwf-confirm-mask'), '干净状态不显示确认弹窗')
    assert.equal(fresh.querySelector('dialog.vwf-editor-dialog'), null, '干净编辑器直接关闭')
  })
  await act(async () => {
    freshRoot.unmount()
    fresh.remove()
  })
})

test('角色库：管理入口 → 内置/自定义分区 → 查看内置 → 基于内置创建 → 有引用删除阻止 → 零引用删除', async () => {
  // 用全新渲染隔离前序测试留下的编辑器/角色状态
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  // FEAT-100 V-1：角色库入口是设置页的独立「角色」页签，不再嵌在模板编辑画布区域。
  assert.equal(fresh.querySelector('.vwf-role-zone'), null, '画布不再有角色库常驻区')
  assert.ok(fresh.querySelector('[data-vwf-nav="roles"]'), '顶部导航提供「角色」页签')
  // 流程库记录仍可按「编辑」进入模板工作区；工作区内不再有角色库入口
  await act(async () => {
    const editBtn = byText(fresh, '编辑')
    assert.ok(editBtn, '存在编辑按钮')
    editBtn.click()
    await flush()
  })
  const editorDlg = fresh.querySelector('dialog.vwf-editor-dialog[open]')
  assert.ok(editorDlg, '模板工作区已打开')
  assert.equal(byText(editorDlg, '管理角色'), undefined, '模板编辑画布区域不再嵌角色库入口')
  // 节点配置不提供角色管理/新增入口（仅保留角色下拉分组）
  await act(async () => {
    fresh.querySelector('.vwf-node-card').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const inspector = fresh.querySelector('.vwf-inspector')
  assert.ok(inspector, '选中节点后显示节点配置')
  const inspectorBtns = Array.from(inspector.querySelectorAll('button')).map((b) => b.textContent)
  assert.ok(!inspectorBtns.some(s => s.includes('管理角色')), '节点配置不提供管理角色入口')
  assert.ok(!inspectorBtns.some(s => s.includes('新建角色')), '节点配置不提供新建角色入口')
  // 关闭工作区回到设置页，再进入角色页签：内置/自定义分区
  await act(async () => {
    Array.from(editorDlg.querySelectorAll('button')).find(b => b.textContent === '关闭').click()
    await flush()
    await flush()
  })
  assert.equal(fresh.querySelector('dialog.vwf-editor-dialog[open]'), null, '工作区已关闭')
  const mgr = await openRolesTab(fresh)
  assert.ok(mgr, '角色页签渲染角色库列表')
  // 新增角色入口在列表层常驻（不依赖分区列表中的按钮）
  const newRoleBtn = Array.from(mgr.querySelectorAll('button')).find(b => b.textContent === '＋ 新建角色')
  assert.ok(newRoleBtn, '新建角色入口常驻（不随自定义角色数量消失）')
  // FEAT-101 V-1：新建入口在列表头右侧（原型 settings-section-head：标题 + 说明在左，按钮在右），
  // 位置在来源筛选与列表之前
  const head = mgr.querySelector('.vwf-role-tab > .vwf-row')
  assert.ok(head, '列表头存在')
  const headKids = Array.from(head.children)
  assert.ok(headKids.length >= 2, '列表头分左右两块')
  assert.ok(byText(headKids[0], '角色管理'), '左侧是标题与说明')
  assert.ok(Array.from(headKids[headKids.length - 1].querySelectorAll('button')).some(b => b.textContent === '＋ 新建角色'), '新建角色在右侧块')
  const filterGroup = mgr.querySelector('[role="group"][aria-label="角色库"]')
  assert.ok(filterGroup, '存在来源筛选分组')
  assert.ok((head.compareDocumentPosition(filterGroup) & 4) !== 0, '列表头在来源筛选之前')
  await act(async () => {
    newRoleBtn.click()
    await flush()
  })
  const createMgr = fresh.querySelector('.vwf-role-mgr')
  assert.ok(createMgr, '新建角色打开创建表单浮层')
  assert.ok(createMgr.querySelector('input.vwf-input'), '创建表单提供名称输入')
  assert.ok(byText(createMgr, '保存角色'), '创建表单提供保存')
  await act(async () => {
    Array.from(createMgr.querySelectorAll('button')).find(b => b.textContent === '关闭').click()
    await flush()
  })
  assert.ok(!fresh.querySelector('.vwf-role-mgr'), '关闭后创建浮层消失')
  assert.ok(fresh.querySelector('[data-vwf-roles-tab]'), '关闭浮层后仍留在角色页签')
  assert.ok(byText(mgr, '内置角色'), '内置角色分区渲染')
  assert.ok(byText(mgr, '自定义角色'), '自定义角色分区渲染')
  assert.ok(byText(mgr, '需求分析师'), '自定义角色列出')
  // FEAT-101 V-3：单一入口——内置只有「查看」（原「查看详情」），自定义只有「编辑」
  const viewBtns = Array.from(mgr.querySelectorAll('button')).filter(b => b.textContent === '查看')
  assert.ok(viewBtns.length >= 1, '内置角色提供查看入口')
  assert.equal(Array.from(mgr.querySelectorAll('button')).filter(b => b.textContent === '查看详情').length, 0, '不再并列「查看详情」入口')
  const editBtns = Array.from(mgr.querySelectorAll('button')).filter(b => b.textContent === '编辑')
  // issue-81 后自定义角色为 dispatcher + 需求分析师两个；内置仅剩 dev，不提供编辑入口
  assert.ok(editBtns.length === 2, '内置角色不提供编辑入口（仅自定义）')
  // 查看内置角色：只读 + 基于此角色创建
  await act(async () => {
    viewBtns[0].click()
    await flush()
  })
  assert.ok(byText(mgr, '开发角色正文'), '查看内置角色完整配置')
  const createFromBtn = byText(mgr, '基于此角色创建')
  assert.ok(createFromBtn, '内置查看页提供基于此角色创建')
  await act(async () => {
    createFromBtn.click()
    await flush()
  })
  const nameInput = mgr.querySelector('input.vwf-input')
  assert.equal(nameInput.value, 'dev - 自定义', '建议临时名称预填')
  // 改名并保存（零引用 → 直接保存，不弹影响确认）
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(nameInput, '调度变体')
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  await act(async () => {
    const saveBtn = byText(mgr, '保存角色')
    assert.ok(saveBtn, '表单提供保存')
    saveBtn.click()
    await flush()
    await flush()
  })
  assert.ok(byText(mgr, '调度变体'), '新角色立即出现在自定义列表')
  // FEAT-101 V-2：基于内置角色创建落成的是自定义角色，原内置角色内容不被写回
  const created = roleState.roles.find(r => r.id === '调度变体')
  assert.ok(created && created.builtin === false, '基于内置角色创建的是自定义角色')
  assert.equal(roleState.roles.find(r => r.id === 'dev').content, '开发角色正文\n', '原内置角色内容未被写回')
  // 删除被引用角色 → 阻止 + 引用位置详情
  await act(async () => {
    const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, '需求分析师'))
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    delBtn.click()
    await flush()
  })
  let mask = Array.from(fresh.querySelectorAll('.vwf-dialog-mask')).pop()
  assert.ok(byText(mask, '无法删除自定义角色'), '有引用删除被阻止')
  assert.ok(byText(mask, '仍被 1 个节点使用'), '提示引用数量')
  assert.ok(byText(mask, '引用位置'), '展示引用位置详情')
  await act(async () => {
    const close = Array.from(mask.querySelectorAll('button')).find(b => b.textContent === '关闭')
    close.click()
    await flush()
  })
  assert.ok(roleState.roles.some(r => r.id === '需求分析师'), '被引用角色未被删除')
  // 零引用角色 → 二次确认 → 删除成功
  await act(async () => {
    const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, '调度变体'))
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    delBtn.click()
    await flush()
  })
  mask = Array.from(fresh.querySelectorAll('.vwf-dialog-mask')).pop()
  assert.ok(byText(mask, '确定删除「调度变体」吗？'), '零引用删除出现二次确认')
  await act(async () => {
    const del = Array.from(mask.querySelectorAll('button')).find(b => b.textContent === '删除')
    del.click()
    await flush()
    await flush()
  })
  assert.ok(!byText(mgr, '调度变体'), '确认后角色从列表消失')
  // 角色库变更后，节点角色选择器随之刷新（分区 optgroup + 自定义项）：
  // FEAT-100 V-1 起角色库是页签，切回流程库再打开模板工作区验证这条既有能力
  await act(async () => {
    fresh.querySelector('[data-vwf-nav="templates"]').click()
    await flush()
  })
  await act(async () => {
    const editBtn = byText(fresh, '编辑')
    assert.ok(editBtn, '存在编辑按钮')
    editBtn.click()
    await flush()
  })
  const roleSelect = Array.from(fresh.querySelectorAll('select.vwf-select')).find(s => Array.from(s.options).some(o => o.textContent.includes('需求分析师')))
  assert.ok(roleSelect, '节点角色选择器存在')
  const groups = roleSelect.querySelectorAll('optgroup')
  assert.ok(groups.length >= 2, '角色选择器分组：内置/自定义')
  assert.equal(groups[0].getAttribute('label'), '内置角色')
  assert.ok(Array.from(roleSelect.options).some(o => o.textContent.includes('需求分析师')), '自定义角色出现在选择器')
  assert.ok(!Array.from(roleSelect.options).some(o => o.textContent.includes('调度变体')), '已删除角色不在选择器')
  await act(async () => {
    freshRoot.unmount()
    fresh.remove()
  })
})

test('角色库：自定义角色「基于此创建」克隆 + usage 失败时表单 fail-closed', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  const mgr = await openRolesTab(fresh)
  // 自定义行提供「基于此创建」
  const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, '需求分析师'))
  const cloneBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '基于此角色创建')
  assert.ok(cloneBtn, '自定义角色行提供基于此角色创建（与内置同一入口文案）')
  await act(async () => {
    cloneBtn.click()
    await flush()
    await flush()
  })
  const nameInput = mgr.querySelector('input.vwf-input')
  assert.equal(nameInput.value, '需求分析师 - 自定义', '克隆建议名称预填')
  assert.ok(mgr.querySelector('textarea').value.includes('需求分析正文'), '克隆正文预填')
  // 保存走 create（不修改原角色）；存在同名草稿引用时改名后保存仍可创建
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(nameInput, '需求分析师克隆')
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    byText(mgr, '保存角色').click()
    await flush()
    await flush()
  })
  assert.ok(byText(mgr, '需求分析师克隆'), '克隆的新角色出现在列表')
  assert.ok(roleState.roles.some(r => r.id === '需求分析师'), '原自定义角色未被修改')
  // fail-closed：usage 查询失败 → 编辑保存被阻止（保持表单打开），不静默保存
  state.failUsage = true
  await act(async () => {
    const editRow = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, '需求分析师'))
    Array.from(editRow.querySelectorAll('button')).find(b => b.textContent === '编辑').click()
    await flush()
    await flush()
  })
  const contentIdx = roleState.roles.findIndex(r => r.id === '需求分析师')
  const beforeContent = roleState.roles[contentIdx].content
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    const ta = mgr.querySelector('textarea')
    setter.call(ta, '需求分析正文\n改动了\n')
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    byText(mgr, '保存角色').click()
    await flush()
    await flush()
  })
  assert.ok(mgr.querySelector('input.vwf-input'), 'usage 失败时表单保持打开')
  assert.ok(byText(mgr, '引用统计失败'), '展示引用统计失败原因')
  assert.equal(roleState.roles[contentIdx].content, beforeContent, 'usage 失败时不静默保存')
  // 宿主以 ok:false 解析（而非 reject）同样 fail-closed
  state.failUsage = 'resolved'
  await act(async () => {
    const saveBtn = byText(mgr, '保存角色')
    assert.ok(saveBtn, '表单仍在（未被保存重置）')
    saveBtn.click()
    await flush()
    await flush()
  })
  assert.ok(mgr.querySelector('input.vwf-input'), 'ok:false 解析时也保持表单打开')
  assert.ok(byText(mgr, '引用统计失败'), 'ok:false 解析时展示错误原因')
  assert.equal(roleState.roles[contentIdx].content, beforeContent, 'ok:false 解析时不静默保存')
  state.failUsage = false
  await act(async () => {
    freshRoot.unmount()
    fresh.remove()
  })
})

test('角色库 UX 收紧：首尾点/Windows 保留名保存时被 Host 权威校验拦截（此前客户端漏检）', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  await openRolesTab(fresh)
  const mgr = fresh.querySelector('[data-vwf-roles-tab]')
  await act(async () => { byText(mgr, '新建角色').click(); await flush() })
  const nameInput = mgr.querySelector('input.vwf-input')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  const before = roleState.roles.length
  for (const badName of ['.foo', 'foo.', 'CON', 'com1']) {
    await act(async () => {
      setter.call(nameInput, badName)
      nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      const ta = mgr.querySelector('textarea')
      const taSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
      taSetter.call(ta, '正文\n')
      ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      await flush()
      byText(mgr, '保存角色').click()
      await flush()
      await flush()
    })
    assert.ok(mgr.querySelector('input.vwf-input'), `非法名称 ${badName} 保存被拦截（表单保持打开）`)
    assert.ok(byText(mgr, '保留名') || byText(mgr, '以点开头或结尾'), `非法名称 ${badName} 展示 Host 裁决文案`)
  }
  assert.equal(roleState.roles.length, before, '四个非法名称均未落库')
  // 失焦即时提示：合法名称失焦后再次输入非法名，失焦即提示（无需点保存）
  // 注：React onBlur 委托监听 focusout（冒泡），而非不冒泡的 blur 事件
  await act(async () => {
    setter.call(nameInput, '.bad')
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    nameInput.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }))
    await flush()
    await flush()
  })
  assert.ok(byText(mgr, '以点开头或结尾'), '失焦即展示 Host 校验错误')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})

test('角色库删除 fail-closed：usage 返回 ok:false 时不弹出删除确认、角色不删除', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  await openRolesTab(fresh)
  const mgr = fresh.querySelector('[data-vwf-roles-tab]')
  // 用零引用的 dispatcher 行：usage 服务故障（ok:false 解析）时点删除
  state.failUsage = 'resolved'
  const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, 'dispatcher'))
  await act(async () => {
    Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除').click()
    await flush()
    await flush()
  })
  assert.ok(!byText(mgr, '确认删除') && !mgr.querySelector('.vwf-dialog-mask'), 'usage ok:false 时不得进入删除确认')
  assert.ok(byText(mgr, '引用统计失败'), '展示引用统计失败原因')
  assert.ok(roleState.roles.some(r => r.id === 'dispatcher'), '角色未被删除')
  state.failUsage = false
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})

test('粘贴蓝图 JSON：模型投影、唯一入口徽标、主链自上而下', async () => {
  const blueprint = {
    id: 'wf-construction-full-feature',
    displayName: '完整功能开发',
    entry: 'requirements',
    bindings: {
      models: {
        requirements: { provider: 'kimi-coding', model: 'k3' },
        design: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        dev: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      },
    },
    nodes: [
      { id: 'requirements', label: '需求分析', profile: 'requirements', goal: 'g' },
      { id: 'design', label: '方案设计', profile: 'designer', goal: 'g' },
      { id: 'dev', label: '开发', profile: 'dev', goal: 'g' },
    ],
    edges: [
      { from: 'requirements', to: 'design', on: 'success' },
      { from: 'design', to: 'dev', outcome: 'READY' },
      { from: 'design', to: 'requirements', outcome: 'RETURN_REQUIREMENTS', countRound: false },
      { from: 'dev', to: 'design', outcome: 'RETURN_DESIGN', countRound: false },
      { from: 'dev', to: '$end', outcome: 'BLOCKED' },
    ],
  }
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(blueprint, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
  const nameInput = Array.from(container.querySelectorAll('input.vwf-input')).find((el) => el.getAttribute('placeholder') === '模板名称' || el.value === '完整功能开发')
  assert.ok(nameInput, '模板名称从 displayName 摄入')
  assert.equal(nameInput.value, '完整功能开发')
  const yOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return Number(match[2])
  }
  // V-12 自上而下：需求 → 设计 → 开发依次向下
  assert.ok(yOf('requirements') < yOf('design'), '需求在设计上方')
  assert.ok(yOf('design') < yOf('dev'), '设计在开发上方')
  const badges = Array.from(container.querySelectorAll('.vwf-entry-badge-text')).map((el) => {
    const g = el.closest('g[data-node-id]')
    return g && g.getAttribute('data-node-id')
  }).filter(Boolean)
  assert.deepEqual(badges, ['requirements'], '只有需求分析带入口徽标，开发不得并列入口')
  await act(async () => {
    container.querySelector('g[data-node-id="requirements"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  await openSection(container, 'advanced')
  const selects = Array.from(container.querySelectorAll('.vwf-inspector select.vwf-select'))
  const values = selects.map((s) => s.value)
  assert.ok(values.includes('kimi-coding'), '节点 provider 从 bindings.models 投影：' + JSON.stringify(values))
  assert.ok(values.includes('k3'), '节点 model 从 bindings.models 投影：' + JSON.stringify(values))
})

test('一键检测结果条：整体结论 + 一级节点 + 同列二级节点三级呈现（无 ## / ### 标记）', async () => {
  const blueprint = {
    id: 'probe-report',
    displayName: '探针结果条',
    entry: 'a',
    bindings: {
      models: {
        a: { provider: 'kimi-coding', model: 'k3' },
        b1: { provider: 'kimi-coding', model: 'k3' },
        b2: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        c: { provider: 'kimi-coding', model: 'k3' },
      },
    },
    nodes: [
      { id: 'a', label: '需求分析', profile: 'dispatcher', goal: 'g' },
      { id: 'b1', label: '开发1', profile: 'dispatcher', goal: 'g' },
      { id: 'b2', label: '开发2', profile: 'dispatcher', goal: 'g' },
      { id: 'c', label: '收口', profile: 'dispatcher', goal: 'g' },
    ],
    edges: [
      { from: 'a', to: 'b1', on: 'success' },
      { from: 'a', to: 'b2', on: 'success' },
      { from: 'b1', to: 'c', on: 'success' },
      { from: 'b2', to: 'c', on: 'success' },
      { from: 'c', to: '$end', on: 'success' },
    ],
  }
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify(blueprint, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
  })
  // 画布两级序号：a=0；b1/b2 同列 → 1.1/1.2（二级节点）；c=2（一级节点）
  state.probe = {
    ok: false,
    stage: 'probe',
    results: [
      { key: 'kimi-coding\u0000k3', provider: 'kimi-coding', model: 'k3', nodes: ['a', 'b1', 'c'], status: 'available', code: 'OK', message: '', cached: false },
      { key: 'deepseek-official\u0000deepseek-v4-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro', nodes: ['b2'], status: 'model_not_configured', code: 'MODEL_NOT_CONFIGURED', message: '模型「deepseek-v4-pro」不在 Provider「deepseek-official」当前已配置的模型目录中（可能已删除或改名）：请重新选择该节点的模型。', cached: false },
    ],
    cached: false,
  }
  await act(async () => {
    byText(container, '一键检测').click()
    await flush()
    await flush()
  })
  const block = container.querySelector('.vwf-editor-msg .vwf-code')
  assert.ok(block, '结果条渲染在编辑器内')
  const rowOf = (el) => ({ cls: el.className, text: el.textContent })
  const rows = Array.from(block.querySelectorAll('.vwf-msg-line')).map(rowOf)
  assert.equal(rows.length, 5, '整体结论 1 行 + 4 个节点各 1 行：' + JSON.stringify(rows.map((r) => r.text)))
  for (const r of rows) assert.ok(r.text.indexOf('##') < 0, '不写 markdown 标记：' + r.text)
  // 一级：整体结论
  assert.match(rows[0].cls, /l1/, '整体结论为一级：' + rows[0].cls)
  assert.ok(rows[0].text.indexOf('❌') === 0 && rows[0].text.includes('4 个节点') && rows[0].text.includes('1 个不可用'), '整体结论文案：' + rows[0].text)
  // 二级：一级节点（按画布序号排序，单列节点）
  assert.match(rows[1].cls, /l2/, '一级节点为二级层级：' + rows[1].cls)
  assert.ok(rows[1].text.indexOf('✅ 0 需求分析（a）') === 0 && rows[1].text.includes('kimi-coding/k3'), '序号 0 的需求分析可用：' + rows[1].text)
  assert.match(rows[2].cls, /l3/, '同列并行节点为三级层级：' + rows[2].cls)
  assert.ok(rows[2].text.indexOf('✅ 1.1 开发1（b1）') === 0, '二级节点 1.1：' + rows[2].text)
  assert.match(rows[3].cls, /l3/, '二级节点 1.2 同为三级：' + rows[3].cls)
  assert.ok(rows[3].text.indexOf('❌ 1.2 开发2（b2）') === 0 && rows[3].text.includes('模型未配置') && rows[3].text.includes('deepseek-v4-pro'), '二级节点 1.2 失败并带原因：' + rows[3].text)
  assert.match(rows[4].cls, /l2/, '收口回到二级层级：' + rows[4].cls)
  assert.ok(rows[4].text.indexOf('✅ 2 收口（c）') === 0, '序号 2 的收口可用：' + rows[4].text)
  const css = styleText.join('\n')
  assert.match(css, /\.vwf-msg-line\.l1/, '一级行有独立样式')
  assert.match(css, /\.vwf-msg-line\.l2/, '二级行有独立样式')
  assert.match(css, /\.vwf-msg-line\.l3/, '三级行有独立样式')
  assert.match(css, /\.vwf-msg-line\.bad/, '失败行有独立色调')
  state.probe = null
})

test('角色库收口：来源双重可辨识、长摘要两行收敛、详情独立滚动、Escape 回收焦点（FEAT-86）', async () => {
  // 与原型同一形态的长职责：摘要本身很长（连续长串），完整职责 4,500+ 字
  const longSummary = '无空格连续长串'.repeat(30)
  const longContent = '职责说明：'.repeat(40) + 'x'.repeat(600)
  roleState.roles.push({ id: '长职责角色', name: '长职责角色', summary: longSummary, builtin: false, content: longContent })
  // FEAT-101 V-3：只读「查看」是内置角色的入口（自定义角色走「编辑」表单）——长职责的
  // 独立滚动区改由内置角色验证；自定义一侧改验表单内的滚动文本域（同一条能力，两种形态）。
  roleState.roles.push({ id: '长职责内置角色', name: '长职责内置角色', summary: longSummary, builtin: true, content: longContent })
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  // FEAT-100 V-1：角色库入口改为设置页「角色」页签（不再从模板编辑画布进入）
  const mgr = await openRolesTab(fresh)
  // 详情/表单浮层容器（.vwf-role-mgr）只承载内层，列表本身内联在页签里
  const ovPanel = () => fresh.querySelector('.vwf-role-mgr')
  const rows = () => Array.from(fresh.querySelectorAll('.vwf-role-row'))
  // V-1 来源在标题与行内双重可识别，按 builtin 字段判定
  assert.ok(byText(mgr, '内置角色'), '内置分区标题')
  assert.ok(byText(mgr, '自定义角色'), '自定义分区标题')
  const row = rows().find(r => byText(r, '长职责角色'))
  assert.equal(row.getAttribute('data-vwf-role-origin'), 'custom', '行内来源按 builtin 字段判定')
  assert.ok(Array.from(row.querySelectorAll('.vwf-badge')).some(b => b.textContent === '自定义角色'), '行内来源 badge')
  // V-2 列表摘要：行内只承载摘要（两行由 .vwf-role-summary 的 line-clamp 收敛，
  // 见 role-theme.test.mjs），不承载完整职责 → 行高不随全文增长
  const sum = row.querySelector('.vwf-role-summary')
  assert.ok(sum, '行内显示摘要')
  assert.equal(sum.textContent, longSummary, '显式 summary 优先，连续长串原样交给样式层断词')
  assert.ok(!row.textContent.includes(longContent), '列表行不承载完整职责')
  // V-6 筛选（键盘可达按钮）：切换后分区收敛；FEAT-100 起按原型带上分段计数（内置 N / 自定义 N）
  const filterBtn = (label) => Array.from(mgr.querySelectorAll('button')).find(b => b.textContent.includes(label))
  await act(async () => { filterBtn('内置').click(); await flush() })
  assert.ok(!rows().some(r => byText(r, '长职责角色')), '内置筛选隐藏自定义角色')
  await act(async () => { filterBtn('自定义').click(); await flush() })
  assert.ok(!rows().some(r => byText(r, 'dev')), '自定义筛选隐藏内置角色')
  await act(async () => { filterBtn('全部').click(); await flush() })
  assert.ok(rows().some(r => byText(r, 'dev')) && rows().some(r => byText(r, '长职责角色')), '全部筛选恢复两个分区')
  // 自定义角色单一入口「编辑」：全文落在表单滚动文本域里，列表行仍不承载完整职责
  const customRow = rows().find(r => byText(r, '长职责角色'))
  const customBtns = Array.from(customRow.querySelectorAll('button')).map(b => b.textContent)
  assert.deepEqual(customBtns, ['编辑', '基于此角色创建', '删除'], '自定义角色不再并列查看 + 编辑：' + JSON.stringify(customBtns))
  // V-2 查看详情：完整职责在独立滚动区，键盘可进入（内置角色）
  const backRow = rows().find(r => byText(r, '长职责内置角色'))
  const detailBtn = Array.from(backRow.querySelectorAll('button')).find(b => b.textContent === '查看')
  await act(async () => { detailBtn.click(); await flush() })
  const content = fresh.querySelector('.vwf-role-content')
  assert.ok(content, '详情提供完整职责区')
  assert.equal(content.textContent, longContent, '详情展示完整职责原文')
  assert.equal(content.getAttribute('tabindex'), '0', '详情滚动区键盘可进入')
  assert.ok(dom.window.document.activeElement === ovPanel(), '打开详情后焦点进入详情浮层容器')
  // V-6 Escape 关闭详情并把焦点回收到触发元素
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  assert.ok(!fresh.querySelector('.vwf-role-content'), 'Escape 关闭详情回到列表')
  // 焦点回收到触发元素：行按钮是返回列表后重新渲染的节点，按角色重新取当次元素
  const viewBtnBack = Array.from(rows().find(r => byText(r, '长职责内置角色')).querySelectorAll('button')).find(b => b.textContent === '查看')
  assert.ok(dom.window.document.activeElement === viewBtnBack, 'Escape 关闭详情后焦点回收到触发元素')
  // 自定义角色的同一条能力（完整职责不撑高列表）：编辑表单内是自带滚动的文本域
  await act(async () => {
    Array.from(rows().find(r => byText(r, '长职责角色')).querySelectorAll('button')).find(b => b.textContent === '编辑').click()
    await flush()
  })
  const roleArea = ovPanel().querySelector('textarea')
  assert.ok(roleArea && roleArea.value === longContent, '自定义角色编辑表单承载完整职责原文')
  assert.ok(!fresh.querySelector('.vwf-role-content'), '自定义角色编辑态不再渲染只读详情滚动区')
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  // 摘要生成不写回原文（规格 §9）：查看前后角色字段逐字不变
  assert.equal(roleState.roles.find(r => r.id === '长职责角色').content, longContent, '职责原文未被改写')
  assert.equal(roleState.roles.find(r => r.id === '长职责角色').summary, longSummary, '摘要字段未被写回')
  // V-6 真实 label：表单字段用 label[for] 绑定
  const newBtn = Array.from(mgr.querySelectorAll('button')).find(b => b.textContent === '＋ 新建角色')
  assert.ok(newBtn, '列表层常驻新建角色入口（不随自定义角色数量消失）')
  await act(async () => { newBtn.click(); await flush() })
  const formPanel = ovPanel()
  assert.ok(formPanel, '新增角色打开创建表单浮层')
  assert.ok(formPanel.querySelector('label[for="vwf-role-name"]') && formPanel.querySelector('#vwf-role-name'), '角色名称使用真实 label 绑定')
  assert.ok(formPanel.querySelector('label[for="vwf-role-content"]') && formPanel.querySelector('#vwf-role-content'), '角色配置使用真实 label 绑定')
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  assert.ok(!fresh.querySelector('#vwf-role-name'), 'Escape 关闭表单回到列表')
  // 焦点回收（V-6）：取消新建没有对应行，焦点归位到列表层的「新增角色」（重新渲染后的当次节点），
  // 不掉到 body
  const newBtnBack = Array.from(mgr.querySelectorAll('button')).find(b => b.textContent === '＋ 新建角色')
  assert.ok(dom.window.document.activeElement === newBtnBack, '关闭表单后焦点回到列表层新建角色')
  // V-6 逐层 Escape 止于列表层：列表层不再是自己的一层浮层（角色=设置页签，FEAT-100 V-1），
  // 该层不能再吞掉 Escape——否则宿主设置面板按 Escape 关不上。
  let escaped = null
  await act(async () => {
    escaped = dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush()
  })
  assert.ok(fresh.querySelector('[data-vwf-roles-tab]'), '列表层 Escape 不关闭角色页签')
  assert.equal(escaped, true, '列表层 Escape 放行给宿主（未 preventDefault / stopPropagation）')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
  roleState.roles = roleState.roles.filter(r => r.id !== '长职责角色' && r.id !== '长职责内置角色')
})

test('角色库：内置角色只读可查看可复制，不提供编辑/删除（V-1 权限边界）', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  await openRolesTab(fresh)
  const mgr = fresh.querySelector('[data-vwf-roles-tab]')
  const builtinRow = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => r.getAttribute('data-vwf-role-origin') === 'builtin')
  const builtinBtns = Array.from(builtinRow.querySelectorAll('button')).map(b => b.textContent)
  // FEAT-103 V-1：内置行与自定义行一样有「基于此角色创建」；编辑 / 删除仍只属于自定义
  assert.deepEqual(builtinBtns, ['查看', '基于此角色创建'], '内置角色：查看 + 基于此角色创建，无编辑/删除')
  await act(async () => { Array.from(builtinRow.querySelectorAll('button'))[0].click(); await flush() })
  const viewBtns = Array.from(fresh.querySelectorAll('.vwf-role-mgr button')).map(b => b.textContent)
  assert.ok(viewBtns.some((x) => x.includes('基于此角色创建')), '内置详情提供复制为自定义：' + JSON.stringify(viewBtns))
  assert.ok(!viewBtns.includes('编辑'), '内置详情无编辑入口')
  assert.ok(byText(mgr, '开发角色正文'), '内置详情展示完整内容')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})

// FEAT-103 V-1：内置角色「列表行」的复制入口与详情页同行为——以该角色为初稿进新建表单，
// 保存落成自定义角色，原内置角色内容不被写回。
test('FEAT-103 V-1：内置角色行「基于此角色创建」进新建表单并落成自定义角色', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  await openRolesTab(fresh)
  const mgr = fresh.querySelector('[data-vwf-roles-tab]')
  const builtinRow = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => r.getAttribute('data-vwf-role-origin') === 'builtin')
  const cloneBtn = Array.from(builtinRow.querySelectorAll('button')).find(b => b.textContent === '基于此角色创建')
  assert.ok(cloneBtn, '内置行提供「基于此角色创建」')
  await act(async () => { cloneBtn.click(); await flush(); await flush() })
  const nameInput = mgr.querySelector('input.vwf-input')
  assert.equal(nameInput.value, 'dev - 自定义', '以该内置角色为初稿（建议名预填）')
  const contentArea = mgr.querySelector('textarea.vwf-textarea')
  assert.equal(contentArea.value, '开发角色正文\n', '职责正文带入表单')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(nameInput, '内置行复制稿')
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
    byText(mgr, '保存角色').click()
    await flush()
    await flush()
  })
  const created = roleState.roles.find(r => r.id === '内置行复制稿')
  assert.ok(created && created.builtin === false, '保存落成自定义角色')
  assert.equal(roleState.roles.find(r => r.id === 'dev').content, '开发角色正文\n', '原内置角色内容未被写回')
  roleState.roles = roleState.roles.filter(r => r.id !== '内置行复制稿')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})

test('FEAT-101 V-4：角色详情展示一句话简介；缺失时由职责生成展示、不写回原文', async () => {
  // 无 summary 的 fixture：详情必须由职责生成一段可读简介，且不改写角色对象
  roleState.roles.push({ id: '无简介角色', name: '无简介角色', builtin: true, content: '第一句职责。\n第二句职责。\n' })
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  const mgr = await openRolesTab(fresh)
  const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, '无简介角色'))
  assert.ok(row, '无简介角色出现在内置分区')
  const rowSummary = row.querySelector('.vwf-role-summary')
  assert.equal(rowSummary.textContent, '第一句职责。', '列表行展示列表载荷给出的摘要')
  await act(async () => {
    Array.from(row.querySelectorAll('button')).find(b => b.textContent === '查看').click()
    await flush()
  })
  const detailSummary = fresh.querySelector('.vwf-role-mgr .vwf-role-summary')
  assert.ok(detailSummary, '详情页展示一句话简介')
  // vwf.roles.get 返回的角色没有 summary 字段 → 客户端按既有规则由完整职责生成（不写回）
  assert.equal(detailSummary.textContent, '第一句职责。 第二句职责。', '缺失 summary 时按既有规则由职责生成')
  assert.ok(fresh.querySelector('.vwf-role-content').textContent.indexOf('第一句职责。') >= 0, '完整职责仍在独立滚动区')
  const stored = roleState.roles.find(r => r.id === '无简介角色')
  assert.equal(stored.summary, undefined, '摘要不写回角色字段')
  assert.equal(stored.content, '第一句职责。\n第二句职责。\n', '职责原文未被改写')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
  roleState.roles = roleState.roles.filter(r => r.id !== '无简介角色')
})

// ═══════════════════════════════════════════════════════════════════════════
// FEAT-102 角色一句话简介（选填）+ 内置「基于此角色创建」固定页脚
// 原型基准：packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.js:193
//   · 表单字段顺序：角色名称 → 一句话简介（选填）→ 完整职责；页脚 取消 / 保存角色
//   · 内置详情：note + 完整职责；页脚只有「＋ 基于此角色创建」
// ═══════════════════════════════════════════════════════════════════════════

function setInput(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

test('FEAT-102 V-2/V-3：一句话简介（选填）显式优先展示、留空沿用职责生成、职责原文不改写', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => { freshRoot.render(React.createElement(Page)); await flush(); await flush() })
  const mgr = await openRolesTab(fresh)
  await act(async () => { byText(mgr, '新建角色').click(); await flush() })
  // 字段顺序照原型：名称 → 一句话简介（选填）→ 完整职责
  const labels = Array.from(mgr.querySelectorAll('.vwf-role-mgr .vwf-field-label')).map((l) => (l.textContent || '').trim())
  assert.ok(labels[0].includes('角色名称'), '第一字段是角色名称：' + JSON.stringify(labels))
  assert.ok(labels[1].includes('一句话简介（选填）'), '第二字段是一句话简介（选填）：' + JSON.stringify(labels))
  assert.ok(labels[2].includes('角色配置'), '第三字段是完整职责：' + JSON.stringify(labels))
  const summaryInput = mgr.querySelector('#vwf-role-summary')
  assert.ok(summaryInput, '一句话简介是独立输入框')
  assert.equal(summaryInput.value, '', '新建时简介留空（＝沿用职责生成）')
  assert.ok(byText(mgr, '列表只显示简介；未填写时，从职责中截取两行。'), '给出原型同款说明')
  // 填简介 + 正文 → 保存
  await act(async () => {
    setInput(mgr.querySelector('#vwf-role-name'), '体验检查员')
    setInput(summaryInput, '检查一致性、可读性与操作连续性。')
    setInput(mgr.querySelector('textarea'), '体验检查员职责正文\n第二行职责。\n')
    await flush()
  })
  await act(async () => { byText(mgr, '保存角色').click(); await flush(); await flush() })
  const stored = () => roleState.roles.find((r) => r.id === '体验检查员')
  assert.ok(stored(), '角色保存成功')
  assert.equal(stored().content, '---\nsummary: 检查一致性、可读性与操作连续性。\n---\n\n体验检查员职责正文\n第二行职责。\n', '简介以文件顶部前置块保存')
  // V-3：列表行展示显式简介（两行收敛样式与断词由 .vwf-role-summary 承担，见 role-theme.test.mjs）
  const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find((r) => byText(r, '体验检查员'))
  assert.equal(row.querySelector('.vwf-role-summary').textContent, '检查一致性、可读性与操作连续性。', '列表行展示显式简介')
  // 编辑：简介回填；职责正文原样（前置块不进入正文文本域）
  await act(async () => {
    Array.from(row.querySelectorAll('button')).find((b) => b.textContent === '编辑').click()
    await flush(); await flush()
  })
  assert.equal(mgr.querySelector('#vwf-role-summary').value, '检查一致性、可读性与操作连续性。', '编辑时简介回填')
  assert.equal(mgr.querySelector('textarea').value, '体验检查员职责正文\n第二行职责。\n', '职责正文原样展示（不带前置块）')
  // 清空简介保存：不再写前置块；列表回落为「由职责生成」
  await act(async () => {
    setInput(mgr.querySelector('#vwf-role-summary'), '')
    await flush()
  })
  await act(async () => { byText(mgr, '保存角色').click(); await flush(); await flush() })
  assert.equal(stored().content, '体验检查员职责正文\n第二行职责。\n', '留空时不写前置块，职责原文逐字不变')
  const row2 = Array.from(mgr.querySelectorAll('.vwf-role-row')).find((r) => byText(r, '体验检查员'))
  assert.equal(row2.querySelector('.vwf-role-summary').textContent, '体验检查员职责正文', '留空时由职责生成摘要')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
  roleState.roles = roleState.roles.filter((r) => r.id !== '体验检查员')
})

test('FEAT-102 V-2：载荷未带 summary 时，回退生成先摘掉「一句话简介」前置块', () => {
  // 正常 list/get 由内核 explicitSummary 给出显式值；这里锁住客户端回退路径：
  // 没有 summary 字段时不得把前置块里的键当成职责正文。
  assert.equal(plugin.roleSummaryOf({ content: '---\nsummary: 检查一致性。\n---\n\n职责正文首行\n第二行\n' }), '职责正文首行 第二行')
  assert.equal(plugin.roleSummaryOf({ content: '职责正文首行\n' }), '职责正文首行', '无前置块时口径不变')
})

test('FEAT-102 V-1：内置详情「基于此角色创建」在固定页脚（原型 modal-foot 单一主操作）', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => { freshRoot.render(React.createElement(Page)); await flush(); await flush() })
  const mgr = await openRolesTab(fresh)
  const builtinRow = Array.from(mgr.querySelectorAll('.vwf-role-row')).find((r) => r.getAttribute('data-vwf-role-origin') === 'builtin')
  await act(async () => { Array.from(builtinRow.querySelectorAll('button'))[0].click(); await flush(); await flush() })
  const foot = fresh.querySelector('.vwf-role-mgr-foot')
  assert.ok(foot, '内置详情提供固定页脚（动作不随职责滚动跑出视野）')
  const footBtns = Array.from(foot.querySelectorAll('button'))
  assert.deepEqual(footBtns.map((b) => b.textContent), ['＋ 基于此角色创建'], '页脚只有原型那一个主操作：' + JSON.stringify(footBtns.map((b) => b.textContent)))
  assert.equal(footBtns[0].className, 'vwf-btn primary', '主操作为主按钮（原型 button(..., "primary", "plus")）')
  assert.ok(byText(fresh.querySelector('.vwf-role-mgr'), '内置角色 · 开发'), '浮层标题照原型带来源前缀')
  assert.equal(fresh.querySelectorAll('.vwf-role-mgr-body [data-vwf-role-origin]').length, 0, '详情正文不再重复行内入口')
  // 点击后进入以该角色为初稿的新建表单；表单页脚同样是固定页脚
  await act(async () => { footBtns[0].click(); await flush(); await flush() })
  assert.equal(mgr.querySelector('#vwf-role-name').value, 'dev - 自定义', '以原角色为初稿的新建表单')
  assert.ok(mgr.querySelector('textarea').value.includes('开发角色正文'), '正文预填原角色内容')
  const foot2 = fresh.querySelector('.vwf-role-mgr-foot')
  assert.deepEqual(Array.from(foot2.querySelectorAll('button')).map((b) => b.textContent), ['取消', '保存角色'], '表单页脚为 取消 / 保存角色')
  const original = roleState.roles.find((r) => r.id === 'dev')
  assert.equal(original.content, '开发角色正文\n', '查看/复制路径不写回原内置角色')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})

test('角色库：读取失败显示明确失败态，不把空列表当作「没有角色」（规格 §11）', async () => {
  state.failRoles = true
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush()
    await flush()
  })
  await openRolesTab(fresh)
  const mgr = fresh.querySelector('[data-vwf-roles-tab]')
  assert.ok(byText(mgr, '角色服务不可用'), '展示失败原因')
  assert.ok(!byText(mgr, '暂无自定义角色'), '失败态不得显示为空列表')
  assert.ok(!mgr.querySelector('.vwf-role-row'), '失败态不渲染任何角色行')
  state.failRoles = false
  // 失败态不是终态：关闭后重开可恢复（roles 重新拉取）
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})



// FEAT-100 V-1：角色库从编辑器画布迁移到设置页的独立「角色」页签。
// 入口形态变了，角色库能力用例本身不变——只换进入方式（V-7 允许修订入口选择器）。
async function openRolesTab(root) {
  const tab = root.querySelector('[data-vwf-nav="roles"]')
  assert.ok(tab, '设置页存在「角色」页签')
  await act(async () => { tab.click(); await flush() })
  const panel = root.querySelector('[data-vwf-roles-tab]')
  assert.ok(panel, '角色页签渲染角色库列表')
  return panel
}

// ── FEAT-85：多工作空间运行列表与 Logical Run 详情 ────────────────────────
function runRows() { return Array.from(container.querySelectorAll('.vwf-run-row')) }
function groupHeads() { return Array.from(container.querySelectorAll('.vwf-run-group-head')).map((el) => (el.textContent || '').trim()) }
function runRowWith(text) { return runRows().find((r) => (r.textContent || '').includes(text)) }
function nodeDirRows() { return Array.from(container.querySelectorAll('.vwf-node-dir-row')) }
function detailTabs() { return Array.from(container.querySelectorAll('.vwf-rd-body .vwf-tab')) }
function attemptSelect() { return container.querySelector('.vwf-rd-body select') }

async function clickEl(el, times) {
  assert.ok(el, '待点击元素存在')
  await act(async () => {
    el.click()
    for (let i = 0; i < (times || 3); i++) await flush()
  })
}
async function selectValue(sel, value) {
  assert.ok(sel, '待选择控件存在')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(sel, value)
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await flush()
    await flush()
  })
}
// 关闭当前打开的工作区层（模板编辑 / 运行详情）。FEAT-100 V-4 起运行详情也在大工作区层里，
// 列表留在下层继续挂载——用例之间必须显式关掉它，否则前一条的详情会带进下一条的断言。
async function closeWorkspace() {
  const dlg = container.querySelector('dialog.vwf-editor-dialog[open]')
  if (!dlg) return
  const closeBtn = Array.from(dlg.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '关闭')
  const back = closeBtn || Array.from(dlg.querySelectorAll('button')).find((b) => (b.textContent || '').includes('返回列表'))
  if (back) await clickEl(back)
  // 未保存草稿走三选一确认：放弃修改（'不改了' 是另一个弹窗的按钮文案，写错会静默留下一个打开的编辑器）
  const discard = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '放弃修改')
  if (discard) await clickEl(discard)
}
// 打开运行页签：先收掉工作区层，避免其文案混入断言
// （FEAT-100 V-1：顶部导航为 流程库 / 运行 / 角色，页签用 data-vwf-nav 定位，不再靠文案）
async function openRunsTab() {
  await closeWorkspace()
  await clickEl(container.querySelector('[data-vwf-nav="dashboard"]'), 6)
  await resetFilters()
}
// 四类筛选复位：避免前一条用例的筛选残留影响后续断言
async function resetFilters() {
  for (let i = 0; i < 4; i++) {
    const sel = filterSelect(i)
    if (sel && sel.value !== 'all') await selectValue(sel, 'all')
  }
}
function filterSelect(index) { return container.querySelectorAll('.vwf-filter select')[index] }
async function backToList() {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').includes('返回列表'))
  await clickEl(btn)
}

test('FEAT-85 列表：同一任务的多次执行合并为一条、按工作空间分组、superseded 段不另起一行', async () => {
  await openRunsTab()
  await act(async () => { await flush(); await flush(); await flush() })
  const rows = runRows()
  assert.ok(rows.length > 0, '运行列表渲染')
  // 同一次运行的两段只呈现为一条任务（T-A1 只出现一次）
  const a1Rows = rows.filter((r) => (r.textContent || '').includes('T-A1'))
  assert.equal(a1Rows.length, 1, '多 segment 折叠为一条用户任务：' + a1Rows.length)
  // 被恢复的运行接续的第 1 段不再单独占一行：列表里不出现「已由恢复的运行接续」行
  assert.ok(!container.querySelector('.vwf-run-row') || !container.textContent.includes('已由恢复的运行接续'), 'superseded 段不作为新用户任务展示')
  // 多段任务显示轮次
  assert.ok(a1Rows[0].textContent.includes('第 2/2 轮'), '多段任务显示当前轮/总轮数：' + a1Rows[0].textContent)
  // 按工作空间分组（两个空间 + 未归属旧记录）
  const heads = groupHeads()
  assert.ok(heads.some((x) => x.includes('工作空间A')), '按工作空间 A 分组：' + JSON.stringify(heads))
  assert.ok(heads.some((x) => x.includes('工作空间B')), '按工作空间 B 分组：' + JSON.stringify(heads))
  assert.ok(heads.some((x) => x.includes('未归属工作空间')), '无逻辑归属的旧记录有独立分组：' + JSON.stringify(heads))
  // 返工次数与最近更新时间
  assert.ok(a1Rows[0].textContent.includes('返工 1 次'), '返工次数来自节点重复执行：' + a1Rows[0].textContent)
  assert.ok(a1Rows[0].textContent.includes('最近更新'), '显示最近更新时间：' + a1Rows[0].textContent)
  // 合并说明可见（用户不会误以为多轮执行是新任务）
  assert.ok(container.textContent.includes('同一次任务的多次执行合并为一条'), '列表给出合并说明')
  // 界面不拼接让用户复制的命令
  assert.ok(!container.textContent.includes('wf_run {'), '界面不出现可复制的 wf_run 命令')
  assert.ok(!container.textContent.includes('USER_ACCEPTED|ADD_BUDGET|STOP'), '界面不出现占位枚举命令行')
})

test('FEAT-85 列表：空间/状态/结果/结束方式四类筛选与分页', async () => {
  await openRunsTab()
  const total = Array.from(container.querySelectorAll('.vwf-muted-sm')).map((e) => e.textContent).join(' ')
  assert.ok(total.includes('共 20 条'), '任务总数为折叠后的 20：' + total.slice(0, 200))
  assert.ok(container.textContent.includes('第 1/2 页'), '分页按任务数计算')
  // 空间筛选：只剩工作空间 A 的三条
  await selectValue(filterSelect(0), '工作空间A')
  let rows = runRows()
  assert.equal(rows.length, 3, '按空间筛选后只剩该空间任务：' + rows.length)
  assert.ok(!rows.some((r) => (r.textContent || '').includes('T-B1')), '其它空间任务被筛掉')
  await selectValue(filterSelect(0), 'all')
  // 状态筛选：待处理 = WAITING_HUMAN + BLOCKED + PAUSED
  await selectValue(filterSelect(1), 'attention')
  rows = runRows()
  assert.equal(rows.length, 3, '待处理筛选命中三个可恢复/待裁决运行：' + rows.length)
  await selectValue(filterSelect(1), 'done')
  assert.ok(container.textContent.includes('共 13 条'), '已完成筛选按 DONE 计：' + rows.length)
  await selectValue(filterSelect(1), 'all')
  // 业务结果筛选：READY 只命中 lr-a
  await selectValue(filterSelect(2), 'READY')
  rows = runRows()
  assert.equal(rows.length, 2, '业务结果筛选按节点业务结果取值：' + rows.length)
  await selectValue(filterSelect(2), 'all')
  // 结束方式筛选：DELIVERED（raw 值仍是筛选口径，展示为「独立完成」）只命中 lr-b
  await selectValue(filterSelect(3), 'DELIVERED')
  rows = runRows()
  assert.equal(rows.length, 1, '结束方式筛选按 completion.type：' + rows.length)
  assert.ok((rows[0].textContent || '').includes('T-B1'), '结束方式命中 T-B1：' + rows[0].textContent)
  assert.ok(container.textContent.includes('结束方式') && container.textContent.includes('独立完成'), '结束方式筛选与取值展示为用户语言')
  assert.ok(!container.textContent.includes('完成类型'), '旧文案「完成类型」不再出现')
  await selectValue(filterSelect(3), 'all')
})

test('FEAT-85 列表：进入详情再返回后保留筛选与列表位置', async () => {
  await openRunsTab()
  await selectValue(filterSelect(1), 'done')
  // 翻到第 2 页并记住位置
  const nextBtn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '下一页')
  await clickEl(nextBtn)
  assert.ok(container.textContent.includes('第 2/2 页'), '翻到第 2 页')
  await openTask('T-X1')
  assert.ok(container.querySelector('.vwf-rd-main'), '进入详情工作区')
  assert.ok(container.textContent.includes('保留筛选与列表位置'), '详情给出返回后位置保留提示')
  await backToList()
  assert.ok(container.textContent.includes('第 2/2 页'), '返回后保留分页位置')
  const doneSel = filterSelect(1)
  assert.equal(doneSel.value, 'done', '返回后保留状态筛选')
  await selectValue(filterSelect(1), 'all')
})

async function openTask(taskId) {
  // 前一个用例可能停在详情视图：先关掉详情工作区，保证每条用例独立可重复
  // （V-4 起列表在详情打开时仍挂载，不能再靠「列表为空」判断是否停在详情）
  await closeWorkspace()
  const row = runRowWith(taskId)
  assert.ok(row, '列表中找到任务行：' + taskId)
  await clickEl(row, 6)
}

test('FEAT-85 详情：唯一选中节点结果出口 + 结果/检查/活动三页签', async () => {
  await openRunsTab()
  await selectValue(filterSelect(0), 'all')
  await selectValue(filterSelect(1), 'all')
  await openTask('T-A1')
  assert.ok(container.querySelector('.vwf-rd-main'), '详情为左侧定位 + 单一结果出口布局')
  assert.equal(nodeDirRows().length, 6, '节点目录列出全部节点：' + nodeDirRows().length)
  assert.equal(container.querySelectorAll('.vwf-rd-body .vwf-card').length, 1, '正文只有一个选中节点详情卡（不上下重复）')
  assert.equal(container.querySelectorAll('.vwf-tab-panel').length, 1, '同一时刻只有一个页签面板')
  assert.equal(container.querySelectorAll('.vwf-rd-body select').length, 0, '未执行节点不渲染 attempt 选择器')
  await clickEl(nodeDirRows().find((r) => (r.textContent || '').includes('实现')))
  assert.equal(container.querySelectorAll('.vwf-rd-body select').length, 1, '唯一 attempt 选择器')
  // 页签切换：同一区域内容切换，不叠加
  const labels = detailTabs().map((t) => (t.textContent || '').trim())
  assert.deepEqual(labels, ['结果', '检查', '活动'], '三个页签：' + JSON.stringify(labels))
  await clickEl(detailTabs().find((t) => t.textContent.trim() === '检查'))
  assert.equal(container.querySelectorAll('.vwf-tab-panel').length, 1, '切换后仍只有一个面板')
  const checksPanel = container.querySelector('.vwf-tab-panel').textContent
  // 当前选中「实现」的第 2 次执行（第 2 段）：该段检查已通过，因此如实显示没有退回意见
  assert.ok(checksPanel.includes('本次执行没有记录退回意见'), '检查页签按所选执行如实显示：' + checksPanel.slice(0, 140))
  assert.ok(!checksPanel.includes('第 1 次实现成果'), '检查页签不重复展示结果页签正文（不叠加）')
  await clickEl(detailTabs().find((t) => t.textContent.trim() === '活动'))
  const actPanel = container.querySelector('.vwf-tab-panel').textContent
  assert.ok(actPanel.includes('活动记录'), '活动页签渲染：' + actPanel.slice(0, 120))
  assert.ok(!actPanel.includes('本次执行没有记录退回意见'), '切换页签后不再显示检查页签内容（不叠加）')
  assert.ok(container.querySelector('.vwf-tab-panel').textContent.includes('[第 2 轮]'), '运行日志标注来源轮次')
  await clickEl(detailTabs().find((t) => t.textContent.trim() === '结果'))
})

test('FEAT-85 详情：返工 attempt 切换、退回意见跟随审查轮次、旧下游结果标为上一轮成果', async () => {
  await openRunsTab()
  await openTask('T-A1')
  // 目录：测试节点只有第 1 段尝试 → 上一轮成果
  const testRow = nodeDirRows().find((r) => (r.textContent || '').includes('测试'))
  assert.ok(testRow.textContent.includes('上一轮成果'), '旧下游结果在目录标注上一轮成果：' + testRow.textContent)
  await clickEl(testRow)
  assert.ok(container.querySelector('.vwf-note.warn') && container.querySelector('.vwf-note.warn').textContent.includes('这是返工前的成果'), '选中旧下游节点给出上一轮成果说明')
  // 实现节点有两次执行
  const devRow = nodeDirRows().find((r) => (r.textContent || '').includes('实现'))
  await clickEl(devRow)
  const sel = attemptSelect()
  assert.equal(sel.options.length, 2, '实现节点有两次执行记录：' + sel.options.length)
  assert.ok(sel.options[0].textContent.includes('第 1 次') && sel.options[0].textContent.includes('退回修改'), '第 1 次标为退回修改：' + sel.options[0].textContent)
  assert.ok(sel.options[1].textContent.includes('最新'), '第 2 次标为最新：' + sel.options[1].textContent)
  // 切到第 1 次 → 历史执行 + 该轮成果
  await selectValue(sel, '1')
  assert.ok(container.querySelector('.vwf-rd-body').textContent.includes('历史执行'), '切到历史执行有明确标注')
  assert.ok(container.querySelector('.vwf-tab-panel').textContent.includes('第 1 次实现成果'), '第 1 次成果与选择对应')
  // 检查页签：退回意见跟随第 1 段审查轮次
  await clickEl(detailTabs().find((t) => t.textContent.trim() === '检查'))
  const checks = container.querySelector('.vwf-tab-panel').textContent
  assert.ok(checks.includes('需要修改的问题'), '检查页签显示退回意见：' + checks.slice(0, 200))
  assert.ok(checks.includes('配置滚动后主要操作离开视口'), '退回意见内容来自该段记录：' + checks.slice(0, 200))
  assert.ok(checks.includes('退回意见 · 第 1 次审查'), '退回意见跟随触发它的审查轮次：' + checks.slice(0, 200))
  // 回最新执行
  await clickEl(detailTabs().find((t) => t.textContent.trim() === '结果'))
  await selectValue(attemptSelect(), '2')
  assert.ok(container.querySelector('.vwf-tab-panel').textContent.includes('第 2 次实现成果'), '回到第 2 次成果')
})

test('FEAT-85 详情：扇出子任务独立结果与汇总输入来源，未完成不冒充完成', async () => {
  await openRunsTab()
  await openTask('T-B1')
  const fanRow = nodeDirRows().find((r) => (r.textContent || '').includes('多视角研究'))
  assert.ok(fanRow, '目录有并行组节点')
  await clickEl(fanRow)
  const panel = container.querySelector('.vwf-tab-panel').textContent
  assert.ok(panel.includes('并行组 · 3 个子任务'), '并行组显示子任务数：' + panel.slice(0, 200))
  assert.ok(panel.includes('技术可行性') && panel.includes('用户需求') && panel.includes('风险与反证'), '三个子任务各自可辨识')
  assert.ok(panel.includes('技术上可行') && panel.includes('需求集中在位置感'), '每个子任务有独立结果')
  assert.ok(panel.includes('未完成'), '未完成子任务有明确状态')
  assert.ok(panel.includes('汇总节点等待'), '未完成时汇总节点显示等待：' + panel.slice(0, 300))
  assert.ok(panel.includes('不冒充完成'), '给出不冒充完成的说明')
  // 汇总节点输入来源
  const synthRow = nodeDirRows().find((r) => (r.textContent || '').includes('汇总发现'))
  await clickEl(synthRow)
  const synthPanel = container.querySelector('.vwf-tab-panel').textContent
  assert.ok(synthPanel.includes('汇总输入来源'), '汇总节点显示输入来源')
  assert.ok(synthPanel.includes('来自 explore'), '输入来源列出生产者：' + synthPanel.slice(0, 300))
})

test('FEAT-85 详情：WAITING_HUMAN 决策卡（选项/理由/影响/锁定 + DT-01 受阻字段映射）', async () => {
  await openRunsTab()
  await openTask('T-A1')
  const card = Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('需要你的决定'))
  assert.ok(card, 'WAITING_HUMAN 显示结构化决策卡')
  const text = card.textContent
  assert.ok(text.includes('材料齐备，交给你验收'), '决策卡显示为什么需要决定')
  assert.ok(text.includes('实现与检查均已完成'), '决策卡显示当前状态')
  for (const opt of ['USER_ACCEPTED', 'ADD_BUDGET', 'STOP']) {
    assert.ok(text.includes(opt), '决策卡含选项 ' + opt)
    assert.ok(text.includes('选择后效果'), '决策卡含选择后效果')
  }
  assert.ok(text.includes('增加 1 轮自动返工额度后继续'), '选择后效果来自决策包')
  assert.ok(text.includes('未知'), '可选四项显式未知被本地化')
  assert.ok(!text.includes('UNKNOWN'), '不出现英文 UNKNOWN 哨兵')
  assert.ok(card.querySelector('textarea'), '决策卡含理由输入')
  assert.ok(text.includes('提交前影响说明'), '决策卡含提交前影响说明')
  const submit = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('提交决定'))
  assert.ok(submit && submit.disabled, 'DT-01 未裁定：提交按钮锁定，不伪造成功')
  assert.ok(text.includes('DT-01-ui-resume-attribution') && text.includes('不会发起续跑'), '决策卡写明提交路径受阻及其原因')
  assert.ok(text.includes('字段映射'), '决策卡附字段映射（交给会话执行）')
  assert.ok(text.includes('T-A1:review:1:1'), '字段映射含真实 decision_id')
  // 点选选项后映射更新
  const addBudget = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'ADD_BUDGET')
  await clickEl(addBudget)
  assert.ok(card.textContent.includes('增加 1 轮自动返工额度后继续'), '点选选项后影响说明可读')
  assert.ok(container.textContent.includes('提交中，按钮已锁定') || container.textContent.includes('按钮锁定'), '给出提交后锁定与续跑中状态说明')
  assert.ok(!container.textContent.includes('wf_run {'), '决策卡不拼接让用户复制的命令')
})

test('FEAT-85 详情：BLOCKED 恢复卡（原因 / 服务商·模型前后值 / 新版本与旧版本保留）', async () => {
  await openRunsTab()
  await openTask('T-C2')
  const card = Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('阻塞原因'))
  assert.ok(card, 'BLOCKED 显示恢复卡')
  const text = card.textContent
  assert.ok(text.includes('EVALUATION_BASELINE_CONFLICT'), '恢复卡显示阻塞原因')
  assert.ok(text.includes('恢复入口：dev'), '恢复卡显示恢复入口节点')
  assert.ok(text.includes('deepseek-official / deepseek-v4-pro'), '恢复卡显示当前服务商 / 模型')
  assert.ok(card.querySelectorAll('select').length >= 2, '恢复卡提供服务商 / 模型修改入口')
  assert.ok(text.includes('恢复后会生成新的版本存档，历史版本仍可查'), '恢复卡说明新版本与旧版本保留')
  assert.ok(text.includes('model_overrides'), '恢复卡附 model_overrides 字段映射')
  const submit = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('恢复并继续'))
  assert.ok(submit && submit.disabled, 'DT-01 未裁定：恢复提交按钮锁定')
  // 版本表同时保留旧版本（按卡片标题定位，避免与恢复卡里的同词说明混淆）
  const snaps = Array.from(container.querySelectorAll('.vwf-card')).find((c) => {
    const title = c.querySelector('.vwf-card-title')
    return title && (title.textContent || '').trim() === '历史版本'
  })
  assert.ok(snaps && snaps.textContent.includes('第 1 版'), '历史版本表可查')
})

test('FEAT-85 详情：工作空间字段齐全、读取失败显示未知与重试；节点成果不可用不冒充内容', async () => {
  await openRunsTab()
  await openTask('T-A1')
  const locatorOf = () => Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('运行定位'))
  // FEAT-103 V-5：运行定位默认只给概要；「详细」展开全量（原工作空间区域内容并入这里）
  const locator = locatorOf()
  assert.ok(locator, '详情含运行定位卡')
  const expandBtn = Array.from(locator.querySelectorAll('button')).find((b) => b.textContent === '详细')
  assert.ok(expandBtn && expandBtn.getAttribute('aria-expanded') === 'false', '默认收起，只给概要')
  assert.ok(!locator.textContent.includes('工作分支'), '概要里不再重复工作空间全量字段')
  await act(async () => { expandBtn.click(); await flush() })
  assert.ok(locator.textContent.includes('工作空间信息'), '「详细」展开原工作空间区域内容')
  const ws = locator.textContent
  for (const field of ['模式', '仓库', '工作分支', '当前 HEAD', 'base HEAD', '集成状态', '活动锁', '清理状态']) {
    assert.ok(ws.includes(field), '工作空间字段齐备：' + field)
  }
  assert.ok(ws.includes('ISOLATED_WRITE'), '模式取值来自注册表')
  assert.ok(ws.includes('dev-t-a1'), '工作分支来自注册表')
  assert.ok(ws.includes('aaaa1111bb'), '当前 HEAD 显示短哈希：' + ws.slice(0, 400))
  assert.ok(ws.includes('lock_acquired'), '活动锁可见')
  assert.ok(ws.includes('未知 / 不可用'), '缺值字段显示未知，不用空白冒充')
  // 收起恢复概要（V-5）
  await act(async () => {
    Array.from(locator.querySelectorAll('button')).find((b) => b.textContent === '收起').click()
    await flush()
  })
  assert.ok(!locator.textContent.includes('工作分支'), '收起后回到概要')
  // 运行记录读取失败：显式错误 + 重试入口，不把缓存当事实（失败不藏在展开层后面）
  await backToList()
  await openTask('T-E1')
  assert.ok(container.textContent.includes('记录摘要暂时读不到'), '读取失败有可见错误：' + container.textContent.slice(0, 300))
  const errLoc = locatorOf()
  assert.ok(errLoc.textContent.includes('工作空间信息读取失败'), '运行定位显示读取失败')
  assert.ok(Array.from(errLoc.querySelectorAll('button')).some((b) => (b.textContent || '').includes('重试读取')), '提供重试入口')
  assert.ok(errLoc.textContent.includes('不把过时缓存当作当前事实'), '写明不把缓存当事实')
  // 正式记录通道不可用：只显示基本信息，不冒充成果正文
  runState.recordsFail = true
  const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '刷新列表')
  await clickEl(refreshBtn, 6)
  assert.ok(container.textContent.includes('暂时读不到这一步的成果内容'), '记录通道不可用时给出明确降级说明')
  assert.ok(container.textContent.includes('只显示基本信息'), '写明只显示基本信息、不冒充内容')
  // B8：降级说明就地保留重试入口（重试即重取摘要与记录，不隐藏失败也不新增 RPC）
  const recNote = container.querySelector('.vwf-note.warn')
  assert.ok(recNote && Array.from(recNote.querySelectorAll('button')).some((b) => (b.textContent || '').includes('重试读取')), '降级说明旁保留重试读取入口')
  runState.recordsFail = false
  await backToList()
})

test('FEAT-85 详情：PAUSED 指导经 vwf.run.control 提交；控制按钮名对应实际 action', async () => {
  await openRunsTab()
  await openTask('T-P1')
  const card = Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('提交指导'))
  assert.ok(card, 'PAUSED 显示暂停卡')
  assert.ok(card.textContent.includes('USER_PAUSE'), '暂停卡显示暂停原因')
  assert.ok(card.textContent.includes('先补测试再继续'), '暂停卡显示已有指导')
  assert.ok(card.textContent.includes('暂停指导不属人工业务结果'), '不把暂停指导误标为人工业务结果')
  // 已有指导时提交按钮因空输入禁用
  const submit = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('提交指导'))
  assert.ok(submit && submit.disabled, '无输入时指导提交禁用')
  // 输入后提交 → 走 vwf.run.control guidance
  const ta = card.querySelector('textarea')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '补测试再继续')
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  const submit2 = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('提交指导'))
  assert.ok(!submit2.disabled, '有输入后指导提交可用')
  await clickEl(submit2, 6)
  assert.equal(runState.controlCalls.length, 1, '指导提交走控制通道：' + JSON.stringify(runState.controlCalls))
  assert.equal(runState.controlCalls[0].action, 'guidance', '指导 action = guidance')
  assert.equal(runState.controlCalls[0].logical_run_id, 'lr-p', '指导按逻辑运行提交')
  assert.equal(runState.controlCalls[0].text, '补测试再继续', '指导正文随请求提交')
  assert.ok(card.textContent.includes('恢复入口'), '暂停卡含恢复入口')
  assert.ok(card.textContent.includes('resume_paused'), '恢复参数映射含 resume_paused')
  assert.ok(card.textContent.includes('DT-01-ui-resume-attribution'), '恢复提交路径受阻有明确标注')
  await backToList()
  // 控制按钮名对应实际 action（RUNNING 运行才可用暂停/立即中断）
  await openTask('T-R1')
  const ctl = Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('运行控制'))
  assert.ok(ctl, '运行控制卡渲染')
  const ctlText = ctl.textContent
  assert.ok(ctlText.includes('暂停在最近完成节点的检查点后生效'), '暂停说明对应检查点语义')
  assert.ok(ctlText.includes('立即中断不等检查点'), '立即中断说明对应即时中止语义')
  const pauseBtn = Array.from(ctl.querySelectorAll('button')).find((b) => (b.textContent || '').includes('暂停'))
  const intBtn = Array.from(ctl.querySelectorAll('button')).find((b) => (b.textContent || '').includes('立即中断'))
  assert.ok(pauseBtn && !pauseBtn.disabled, 'RUNNING 可暂停')
  assert.ok(intBtn && !intBtn.disabled, 'RUNNING 可立即中断')
  await backToList()
})

// FEAT-103 V-3：链路弹窗展示完整工作链路（含尝试 / 返工轮次），点选一条回到详情并把
// 右侧当前结果切到该节点那一次；V-4：底部不再并列一份节点 / 结果表；V-6：正式产物进
// 右侧「结果」页签，页面底部不再有独立区块。
test('FEAT-103 V-3/V-4/V-6：完整经过链路弹窗点选联动右侧结果；正式产物在「结果」页签', async () => {
  await openRunsTab()
  await openTask('T-A1')
  const body = container.querySelector('.vwf-rd-body')
  // V-6：正式产物默认落在「结果」页签内，工件路径 / 版本 / 来源节点齐全
  assert.ok(body.textContent.includes('正式交付物'), '结果页签内有正式交付物')
  assert.ok(body.textContent.includes('node:lr-a:dev'), '工件清单来自 run 的 formalRecords')
  assert.ok(body.textContent.includes('版本 2'), '工件版本可见')
  assert.ok(body.textContent.includes('节点 dev'), '工件来源节点可见')
  const belowCards = Array.from(container.querySelectorAll('.vwf-root > .vwf-card')).map((c) => c.textContent || '')
  assert.ok(!belowCards.some((x) => x.includes('正式交付物')), '页面底部不再有独立的正式交付物区块')
  assert.ok(!belowCards.some((x) => x.includes('节点 / 结果')), '页面底部不再有独立的节点 / 结果区域')
  // V-3：打开链路弹窗
  await clickEl(Array.from(container.querySelectorAll('.vwf-rd-strip button')).find((b) => b.textContent.includes('查看完整经过')))
  const chain = container.querySelector('.vwf-chain')
  assert.ok(chain, '链路弹窗打开')
  const entry = (node, attempt) => chain.querySelector('[data-vwf-chain-node="' + node + '"][data-vwf-chain-attempt="' + attempt + '"]')
  const labels = Array.from(chain.querySelectorAll('.vwf-chain-entry')).map((e) => e.textContent)
  assert.ok(labels.length >= 6, '链路铺开全部节点（未执行的也占位）：' + labels.length)
  assert.ok(labels.some((x) => x.includes('实现') && x.includes('第 1 次 · 退回修改')), '链路含返工前的第 1 次执行')
  assert.ok(labels.some((x) => x.includes('实现') && x.includes('第 2 次 · 已通过') && x.includes('最新')), '链路含最新一次执行并标最新')
  assert.ok(labels.some((x) => x.includes('尚未开始')), '未执行的节点在链路里明确标注')
  // 点选第 1 次实现 → 关闭弹窗，右侧切到该节点该次执行
  await clickEl(entry('dev', '1'))
  assert.ok(!container.querySelector('.vwf-chain'), '点选后弹窗关闭回到详情页')
  assert.equal(attemptSelect().value, '1', '右侧当前结果切到点选的那一次执行')
  assert.ok(container.querySelector('.vwf-rd-body').textContent.includes('历史执行'), '历史执行有明确标注')
  assert.ok(container.querySelector('.vwf-tab-panel').textContent.includes('第 1 次实现成果'), '右侧正文是该次执行的成果')
  // 再点最新一次 → 回到当前结果
  await clickEl(Array.from(container.querySelectorAll('.vwf-rd-strip button')).find((b) => b.textContent.includes('查看完整经过')))
  await clickEl(container.querySelector('.vwf-chain [data-vwf-chain-node="dev"][data-vwf-chain-attempt="2"]'))
  assert.equal(attemptSelect().value, '2', '切回最新一次执行')
  assert.ok(container.querySelector('.vwf-tab-panel').textContent.includes('第 2 次实现成果'), '右侧正文回到最新成果')
  assert.ok(!container.querySelector('.vwf-rd-body').textContent.includes('历史执行'), '最新一次不标历史执行')
  await backToList()
})

test('FEAT-85 详情：结果 / 当前进展 / 结束方式分层显示（不塌缩为成功失败徽标）', async () => {
  await openRunsTab()
  await openTask('T-B1')
  const locator = Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('运行定位'))
  assert.ok(locator, '运行定位卡渲染')
  const text = locator.textContent
  assert.ok(text.includes('当前进展'), '当前进展单独成层：' + text.slice(0, 300))
  assert.ok(text.includes('COMPLETED'), '当前进展取值可见')
  assert.ok(text.includes('结束方式'), '结束方式单独成层')
  assert.ok(text.includes('独立完成'), '结束方式取值来自 completion.type 且展示为用户语言')
  assert.ok(!text.includes('DELIVERED'), '结束方式不再显示 raw 机器词')
  await backToList()
  // 未声明结束方式时如实标注
  await openTask('T-C2')
  const locator2 = Array.from(container.querySelectorAll('.vwf-card')).find((c) => (c.textContent || '').includes('运行定位'))
  assert.ok(locator2.textContent.includes('未声明结束方式'), '无结束方式时如实标注而非留白')
  await backToList()
})

test('FEAT-85 窄屏与键盘：详情在同页切换、控件可聚焦、窄屏折行样式存在', async () => {
  const css = styleText.join('\n')
  assert.match(css, /\.vwf-rd-main[^`]*grid-template-columns/, '详情为定位 + 出口的网格布局')
  assert.match(css, /@media \(max-width: 560px\)[^`]*\.vwf-rd-main[^}]*grid-template-columns:1fr/, '窄屏下详情折为单列')
  assert.match(css, /\.vwf-run-row:focus-visible[^`]*outline/, '列表行有可见键盘焦点')
  assert.match(css, /\.vwf-node-dir-row:focus-visible/, '节点目录有可见键盘焦点')
  assert.match(css, /\.vwf-tab:focus-visible/, '页签有可见键盘焦点')
  assert.match(css, /prefers-reduced-motion/, '尊重减少动态效果设置')
  // 详情与列表在同一页面切换（不是弹窗），返回按钮可聚焦
  await openRunsTab()
  await openTask('T-A1')
  const back = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').includes('返回列表'))
  assert.equal(back.tagName, 'BUTTON', '返回控件是原生按钮（键盘可达）')
  assert.ok(!container.querySelector('.vwf-rd-main[role="dialog"]'), '详情不是模态层，避免焦点被困')
  await backToList()
})

// ═══════════════════════════════════════════════════════════════════════════
// FEAT-100 设置页信息架构对齐原型（V-1~V-6）
// 原型基准：packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.js
//   · 顶部导航 3 页签 流程库 / 运行 / 角色
//   · 流程库子页签 全部 / 内置 / 我的
//   · 运行列表按工作空间分组，组内 需处理 → 进行中 → 已完成，人工门禁队列并入列表
//   · 运行记录点击后在同级大工作区层打开详情
//   · 两页同一套语义 token（浅色不出现灰白混用）
//   · 内置记录操作 查看流程 / 模型设置，无删除按钮
// ═══════════════════════════════════════════════════════════════════════════

// 待处理项在列表行上仍带的人工门禁位次（原型保留「一次裁决一张」这条信息）
test('FEAT-100 V-1：顶部导航为 流程库 / 运行 / 角色 三个页签，角色库有独立入口', async () => {
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush(); await flush()
  })
  const navs = Array.from(fresh.querySelectorAll('.vwf-tabs [data-vwf-nav]'))
  assert.deepEqual(navs.map((b) => b.getAttribute('data-vwf-nav')), ['templates', 'dashboard', 'roles'], '导航为三个页签')
  const labels = navs.map((b) => (b.textContent || '').replace(/\s*\d+\s*$/, '').trim())
  assert.deepEqual(labels, ['流程库', '运行', '角色'], '页签文案与原型一致：' + JSON.stringify(labels))
  // 页面归属：每个页签切到各自的内容
  for (const [key, marker] of [['templates', '[data-vwf-lib-filter]'], ['dashboard', '.vwf-run-list'], ['roles', '[data-vwf-roles-tab]']]) {
    await act(async () => { fresh.querySelector(`[data-vwf-nav="${key}"]`).click(); await flush() })
    assert.ok(fresh.querySelector(marker), key + ' 页签渲染对应内容：' + marker)
  }
  // 角色库与模板编辑画布互不耦合：工作区里没有角色库入口（V-1 的「不再嵌于」）
  await act(async () => {
    fresh.querySelector('[data-vwf-nav="templates"]').click()
    await flush()
    byText(fresh, '编辑').click()
    await flush()
  })
  const dialog = fresh.querySelector('dialog.vwf-editor-dialog[open]')
  assert.ok(dialog, '模板工作区已打开')
  assert.equal(fresh.querySelector('.vwf-role-zone'), null, '画布工具栏没有角色库常驻区')
  assert.equal(byText(dialog, '管理角色'), undefined, '模板编辑画布区域不再嵌角色库入口')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
})

test('FEAT-100 V-2：流程库子页签 全部 / 内置 / 我的，默认全部且过滤正确、键盘可达', async () => {
  state.wfList = [
    { id: 'wf-builtin-1', name: '内置流程一', description: '', builtin: true, dsl: JSON.parse(JSON.stringify(SEED_DSL)) },
    { id: 'wf-builtin-2', name: '内置流程二', description: '', builtin: true, dsl: JSON.parse(JSON.stringify(SEED_DSL)) },
    { id: 'wf-mine-1', name: '我的流程一', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(SEED_DSL)) },
  ]
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush(); await flush()
  })
  const segs = () => Array.from(fresh.querySelectorAll('[data-vwf-lib-filter]'))
  assert.deepEqual(segs().map((b) => b.getAttribute('data-vwf-lib-filter')), ['all', 'builtin', 'mine'], '三个子页签')
  assert.deepEqual(segs().map((b) => (b.textContent || '').trim()), ['全部 3', '内置 2', '我的 1'], '标签带分段计数：' + JSON.stringify(segs().map((b) => b.textContent)))
  const names = () => Array.from(fresh.querySelectorAll('.vwf-list-name')).map((el) => el.textContent)
  // 默认「全部」
  assert.equal(segs().find((b) => b.getAttribute('aria-selected') === 'true').getAttribute('data-vwf-lib-filter'), 'all', '默认停在全部')
  assert.equal(names().length, 3, '全部显示三条')
  // 内置：只剩内置记录
  await act(async () => { segs()[1].click(); await flush() })
  assert.deepEqual(names().sort(), ['内置流程一', '内置流程二'], '内置子页签只留内置记录：' + JSON.stringify(names()))
  // 我的：只剩自定义记录
  await act(async () => { segs()[2].click(); await flush() })
  assert.deepEqual(names(), ['我的流程一'], '我的子页签只留自定义记录：' + JSON.stringify(names()))
  // 键盘可达：真按钮，可用 Enter/Space 触发（原生 button 语义即可用键盘到达）
  for (const b of segs()) assert.equal(b.tagName, 'BUTTON', '子页签是原生按钮（键盘可达）')
  // 子页签与搜索词叠加
  await act(async () => { segs()[0].click(); await flush() })
  await act(async () => {
    const input = fresh.querySelector('input[aria-label]')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '内置')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  assert.deepEqual(names().sort(), ['内置流程一', '内置流程二'], '搜索在子页签范围内生效')
  await act(async () => { freshRoot.unmount(); fresh.remove() })
  state.wfList = null
})

test('FEAT-100 V-3：运行列表按工作空间分组，组内 需处理 → 进行中 → 已完成；人工门禁队列并入列表且不丢项', async () => {
  // 「需处理 → 进行中」的排序只有在混合档位的分组里才真正被检验。既有样本里工作空间A 恰好
  // 三条全是待处理（无法区分），因此临时补一条同空间、时间更新的进行中任务：按时间倒序它会
  // 排在最前，只有按组内档位排序才会落到三条待处理之后。
  runState.logical['lr-a-mix'] = {
    logical_run_id: 'lr-a-mix', schema: 1, task_id: 'T-A1MIX', template_id: 'wf-runs', title: '混合档位运行', created_at: 8900, updated_at: 9000,
    lifecycle: { state: 'RUNNING' }, terminal: false, completion: null,
    segments: [{ index: 1, run_id: 'run-a-mix', trigger: 'start', started_at: 9000, status: 'running', active: true }],
    snapshots: [{ revision: 1, created_at: 8900, active: true, workflow: { id: 'wf-runs', name: '完整功能开发', dsl: RUN_DSL }, provider_model: {} }],
    node_attempts: [], business_outcomes: {}, guidance: [], control_events: [], baseline_revisions: [], baseline_applied_upto: 0,
    last_engine_error: null, pause_state: null, pause_resume: null, evaluation_baseline: null, evaluation_baselines: [], formal_records: null,
    workspace: WS_A, human_decisions: [], consumed_decisions: {},
  }
  runState.runs.push({ id: 'run-a-mix', taskId: 'T-A1MIX', name: '完整功能开发', workflowId: 'wf-runs', status: 'running', phase: '实现', startedAt: 9000, logical_run_id: 'lr-a-mix', segment: 1, segment_count: 1, logical_state: 'RUNNING' })
  // 测试桩不跑轮询，列表只在挂载时取一次：先离开运行页签再进来，让新样本进入本轮取数
  await clickEl(container.querySelector('[data-vwf-nav="templates"]'), 3)
  await openRunsTab()
  await act(async () => { await flush(); await flush(); await flush(); await flush() })
  // 原独立的人工门禁队列卡（标题「人工门禁队列（一次裁决一张）」）不再单独占一块
  assert.ok(!container.textContent.includes('人工门禁队列'), '原独立的人工门禁队列卡已并入列表')
  const badgeTextOf = (row) => {
    const t = row.textContent || ''
    if (t.includes('等待人工') || t.includes('受阻') || t.includes('PAUSED')) return 0
    if (t.includes('进行中')) return 1
    if (t.includes('DONE')) return 2
    return 3
  }
  // 一页看全量任务，才能对「组内顺序」做整组断言（默认每页 10 条会截断分组）
  const sizeSel = Array.from(container.querySelectorAll('select')).find((s) => Array.from(s.options).map((o) => o.value).join() === '10,20,50,100')
  await selectValue(sizeSel, '100')
  const groups = Array.from(container.querySelectorAll('.vwf-run-group'))
  assert.ok(groups.length >= 2, '列表按工作空间分组：' + groups.length + ' 组')
  let mixed = 0
  for (const g of groups) {
    const ranks = Array.from(g.querySelectorAll('.vwf-run-row')).map(badgeTextOf)
    assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b), '组内为 需处理 → 进行中 → 已完成：' + (g.querySelector('.vwf-run-group-head').textContent || ''))
    if (ranks.length > 1 && ranks[0] === 0 && ranks.some((x) => x > 0)) mixed++
  }
  assert.ok(mixed >= 1, '至少有一个分组把需处理项排在进行中/已完成之前（顺序断言不是空过）')
  // 决定性证据：混合档位分组内，最后开始的进行中任务仍排在待处理任务之后
  const groupOf = (label) => groups.find((g) => (g.querySelector('.vwf-run-group-head').textContent || '').includes(label))
  const rankListOf = (g) => Array.from(g.querySelectorAll('.vwf-run-row')).map(badgeTextOf)
  assert.deepEqual(rankListOf(groupOf('工作空间A')), [0, 0, 0, 1], '工作空间A：三条待处理在前，最新开始的进行中任务在后（按时间倒序它会排到最前）')
  assert.deepEqual(rankListOf(groupOf('工作空间B')), [1, 2], '工作空间B：进行中在已完成之前')
  // 待处理项一个不少：页签计数与「待处理」筛选同口径，且原队列里的项都在
  const badge = container.querySelector('[data-vwf-nav="dashboard"] .vwf-badge')
  assert.ok(badge, '运行页签常驻待处理计数')
  await selectValue(filterSelect(1), 'attention')
  const attRows = runRows()
  assert.equal(attRows.length, Number(badge.textContent), '页签计数与待处理筛选同口径')
  const attText = attRows.map((r) => r.textContent || '').join('\n')
  for (const id of ['T-A1', 'T-C2', 'T-P1']) assert.ok(attText.includes(id), '待处理项 ' + id + ' 并入列表后仍可见')
  // 人工门禁位次信息保留（原队列卡上的「裁决中 / 排队 #n」）
  const a1 = attRows.find((r) => (r.textContent || '').includes('T-A1'))
  const c2 = attRows.find((r) => (r.textContent || '').includes('T-C2'))
  assert.ok((a1.textContent || '').includes('裁决中'), '裁决中的运行在列表行上标出：' + a1.textContent)
  assert.ok((c2.textContent || '').includes('排队 #'), '排队位次在列表行上标出：' + c2.textContent)
  await selectValue(filterSelect(1), 'all')
  await selectValue(sizeSel, '10')
})

test('FEAT-100 V-4：点击运行记录在同级大工作区层打开详情，关闭后回到列表并保留筛选与位置', async () => {
  await openRunsTab()
  const sizeSelV4 = Array.from(container.querySelectorAll('select')).find((s) => Array.from(s.options).map((o) => o.value).join() === '10,20,50,100')
  await selectValue(sizeSelV4, '10')
  await selectValue(filterSelect(1), 'done')
  const nextBtn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '下一页')
  await clickEl(nextBtn)
  const beforePage = container.textContent.includes('第 2/2 页')
  assert.ok(beforePage, '先翻到第 2 页')
  const target = runRowWith('T-X1')

  await clickEl(target, 6)
  // 与模板编辑同级：同一 .vwf-editor-dialog 工作区层承载
  const dialog = container.querySelector('dialog.vwf-editor-dialog[open]')
  assert.ok(dialog, '详情在原生 top-layer 工作区层里打开')
  assert.ok(dialog.querySelector('.vwf-rd-main'), '工作区层内是 Logical Run 详情')
  assert.equal(dialog.querySelector('.vwf-rd-main').getAttribute('role'), null, '详情本身不再自建对话框语义')
  assert.ok(dialog.querySelector('button'), '工作区层提供关闭操作')
  // 列表仍在（未卸载）：关闭后回到原筛选与位置，不需要重建
  assert.ok(runRows().length > 0, '详情打开时列表仍在挂载（关掉即回原位）')
  await backToList()
  assert.equal(container.querySelector('dialog.vwf-editor-dialog[open]'), null, '关闭后工作区层收起')
  assert.ok(container.textContent.includes('第 2/2 页'), '返回后保留分页位置')
  assert.equal(filterSelect(1).value, 'done', '返回后保留状态筛选')
  assert.ok(runRowWith('T-X1'), '返回后列表可用')
  await selectValue(filterSelect(1), 'all')
})

// ═══════════════════════════════════════════════════════════════════════════
// FEAT-102 V-4 运行记录详情页布局照原型
// 原型基准：packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.js:160 workspace()
//   · 页头 page-header：返回 + 标题 + 状态徽标 + 副标题（工作空间 / 模板 · 时间）+ 操作
//   · 状态条 workspace-strip：返工 / 阶段 + 查看完整经过
//   · 三栏 editor-a：步骤定位 outline / 画布 graph / 详情 runInspector
// ═══════════════════════════════════════════════════════════════════════════

test('FEAT-102 V-4：运行详情为 页头 + 状态条 + 三栏工作台（步骤 / 画布 / 详情）', async () => {
  await openRunsTab()
  await openTask('T-A1')
  const dlg = container.querySelector('dialog.vwf-editor-dialog[open]')
  // 页头：标题 = 运行标题，状态徽标 + 副标题（工作空间 / 模板 · 时间），返回与关闭常驻
  const head = dlg.querySelector('.vwf-rd-head')
  assert.ok(head, '详情有页头（原型 page-header）')
  assert.equal(head.querySelector('.vwf-rd-title').textContent, '工作流界面改版', '标题取运行标题')
  assert.ok(head.querySelector('.vwf-badge'), '状态徽标在标题行')
  const subline = head.querySelector('.vwf-rd-subline').textContent
  assert.ok(subline.includes('工作空间A') && subline.includes('完整功能开发'), '副标题含工作空间 / 模板：' + subline)
  const headBtns = Array.from(head.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
  assert.ok(headBtns.some((x) => x.includes('返回列表')) && headBtns.some((x) => x === '关闭'), '页头提供返回与关闭：' + JSON.stringify(headBtns))
  assert.ok(headBtns.some((x) => x === '刷新列表'), '页头保留刷新入口')
  // 状态条：返工 / 阶段 + 查看完整经过
  const strip = dlg.querySelector('.vwf-rd-strip')
  assert.ok(strip, '详情有状态条（原型 workspace-strip）')
  assert.ok(strip.textContent.includes('返工') && strip.textContent.includes('当前阶段'), '状态条显示返工与阶段：' + strip.textContent)
  assert.ok(Array.from(strip.querySelectorAll('button')).some((b) => b.textContent.includes('查看完整经过')), '状态条提供查看完整经过')
  // 三栏：步骤定位 / 画布 / 详情
  const main = dlg.querySelector('.vwf-rd-main')
  assert.deepEqual(Array.from(main.children).map((c) => c.className), ['vwf-rd-side', 'vwf-rd-canvas', 'vwf-rd-body'], '三栏顺序照原型（步骤 / 画布 / 详情）')
  assert.equal(nodeDirRows().length, 6, '左栏步骤定位列出全部节点')
  assert.ok(main.querySelector('.vwf-rd-canvas .vwf-canvas-wrap svg'), '中栏是只读流程画布')
  assert.equal(main.querySelectorAll('.vwf-rd-body .vwf-canvas-wrap').length, 0, '画布不再堆在详情栏下方')
  assert.ok(main.querySelector('.vwf-rd-body .vwf-tab'), '右栏是唯一选中节点详情出口（三页签在其中）')
  // 运行级记录留在工作台下方，不与详情栏混排（决策卡 / 恢复卡 / 控制卡等仍在）
  const belowCards = Array.from(dlg.querySelectorAll('.vwf-root > .vwf-card')).map((c) => c.textContent || '')
  assert.ok(belowCards.some((x) => x.includes('运行控制')), '工作台下方保留运行控制卡')
  // FEAT-103 V-4/V-5/V-6：节点 / 结果表与工作空间区块不再各占一张重复卡——
  // 前者并入链路弹窗，后者并入左栏运行定位的「详细」，正式产物进右侧「结果」页签。
  assert.ok(!belowCards.some((x) => x.includes('工作空间信息')), '页面底部不再有独立的工作空间区块')
  assert.ok(!belowCards.some((x) => x.includes('Formal Artifacts')), '页面底部不再有独立的 Formal Artifacts 区块')
  assert.equal(main.querySelectorAll('.vwf-card').length, 3, '工作台内只有左栏两张 + 详情栏一张卡：' + main.querySelectorAll('.vwf-card').length)
  await backToList()
})

test('FEAT-100 V-5：流程库与运行页共用同一套语义 token（浅色下不出现灰白混用）', async () => {
  const css = styleText.join('\n')
  // 运行列表（设置面板内，与流程库同表面）只引用 --vwf-*
  const runListRules = ['\\.vwf-run-row\\s*\\{[^}]*\\}', '\\.vwf-run-group-head\\s*\\{[^}]*\\}', '\\.vwf-run-row-note\\s*\\{[^}]*\\}', '\\.vwf-filter\\s*\\{[^}]*\\}', '\\.vwf-empty\\s*\\{[^}]*\\}']
  for (const re of runListRules) {
    const m = new RegExp(re).exec(css)
    assert.ok(m, '取到规则：' + re)
    assert.ok(!/--dsw-alias-/.test(m[0]), '设置面板内的运行页规则不得引用宿主 alias：' + m[0].slice(0, 90))
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m[0]), '设置面板内的运行页规则不得写死颜色：' + m[0].slice(0, 90))
  }
  // 运行详情（大工作区层内，与模板编辑同表面）只引用 --vwf-wb-*
  for (const re of ['\\.vwf-node-dir-row\\s*\\{[^}]*\\}', '\\.vwf-note\\s*\\{[^}]*\\}', '\\.vwf-sec\\s*\\{[^}]*\\}', '\\.vwf-rd-scroll\\s*\\{[^}]*\\}']) {
    const m = new RegExp(re).exec(css)
    assert.ok(m, '取到规则：' + re)
    assert.ok(!/--dsw-alias-/.test(m[0]), '工作区内的详情规则走 --vwf-wb-*，不直写宿主 alias：' + m[0].slice(0, 90))
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m[0]), '工作区内的详情规则不得写死颜色：' + m[0].slice(0, 90))
  }
  // 两页共用同一组浅色底（画布 / 表面成对定义，深浅各有取值）
  assert.match(css, /--vwf-canvas:\s*#F1F4FA/, '浅色画布 token 就位')
  assert.match(css, /--vwf-surface:\s*#FFFFFF/, '浅色表面 token 就位')
  // 运行详情与模板编辑同层：同一 .vwf-editor-dialog 承载（V-4 + V-5 同源）
  assert.match(css, /\.vwf-editor-dialog \{[^}]*--vwf-wb-canvas/, '工作区层自带成对语义 token')
})

test('FEAT-100 V-6：内置记录只提供 查看流程 / 模型设置（无删除与置灰删除），自定义记录不回退', async () => {
  state.wfList = [
    { id: 'wf-builtin-1', name: '内置流程', description: 'builtin', builtin: true, dsl: JSON.parse(JSON.stringify(SEED_DSL)) },
    { id: 'wf-mine-1', name: '我的流程', description: 'mine', builtin: false, dsl: JSON.parse(JSON.stringify(SEED_DSL)) },
  ]
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
    await flush(); await flush()
  })
  const rowOf = (name) => Array.from(fresh.querySelectorAll('.vwf-list-item')).find((r) => (r.textContent || '').includes(name))
  const btnsOf = (row) => Array.from(row.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
  const builtinRow = rowOf('内置流程')
  assert.deepEqual(btnsOf(builtinRow), ['查看流程', '模型设置'], '内置记录只有 查看流程 / 模型设置：' + JSON.stringify(btnsOf(builtinRow)))
  assert.ok(!btnsOf(builtinRow).some((x) => x.includes('删除')), '内置记录不提供删除按钮（含置灰态）')
  assert.equal(builtinRow.querySelectorAll('button:disabled').length, 0, '内置记录没有置灰按钮')
  // 自定义记录不回退：编辑 + 删除
  const mineRow = rowOf('我的流程')
  assert.deepEqual(btnsOf(mineRow), ['编辑', '删除'], '自定义记录仍为 编辑 / 删除：' + JSON.stringify(btnsOf(mineRow)))
  await act(async () => { freshRoot.unmount(); fresh.remove() })
  state.wfList = null
})

test('清理：卸载冒烟测试根节点', async () => {
  await act(async () => {
    root.unmount()
  })
})
