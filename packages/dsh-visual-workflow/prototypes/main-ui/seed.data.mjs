import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const prototypeDir = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(prototypeDir, '../../../..')
export const packageRoot = path.resolve(prototypeDir, '../..')
const require = createRequire(import.meta.url)
export const core = require(path.join(repoRoot, 'scripts/validate-core.cjs'))
const hash = (content) => createHash('sha256').update(content).digest('hex')
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
const clone = (v) => JSON.parse(JSON.stringify(v))
const templateFiles = async () => (await readdir(path.join(repoRoot, 'templates'))).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(repoRoot, 'templates', n))

export async function sourceHashes() {
  const catalog = await json(path.join(repoRoot, 'dsh/roles/builtin-roles.json'))
  const digest = async (files) => hash((await Promise.all(files.map(async (f) => path.relative(repoRoot, f) + '\0' + hash(await readFile(f))))).sort().join('\n'))
  return {
    client: hash(await readFile(path.join(packageRoot, 'src/client.js'))),
    host: hash(await readFile(path.join(packageRoot, 'src/host.js'))),
    templates: await digest(await templateFiles()),
    builtinRoles: hash(await readFile(path.join(repoRoot, 'dsh/roles/builtin-roles.json'))),
    roleBodies: await digest(catalog.builtins.map((r) => path.join(repoRoot, r.definition))),
    locale: hash(await readFile(path.join(packageRoot, 'locales/zh.json'))),
    presets: hash(await readFile(path.join(repoRoot, 'docs/design/outcome-presets.json'))),
  }
}
export async function syncStatus() {
  const baseline = await json(path.join(prototypeDir, 'sync-baseline.json'))
  const current = await sourceHashes()
  const changed = Object.keys(current).filter((key) => current[key] !== baseline.hashes[key])
  const prototypeHash = hash(await readFile(path.join(prototypeDir, 'client.prototype.js')))
  return { inSync: changed.length === 0, previewExact: prototypeHash === current.client, changed, baseline: baseline.productionBaseline, checkedAt: baseline.checkedAt, prototypeHash, currentClientHash: current.client }
}

function personalFlow(id, name, roles, defaultModel, reviewModel) {
  const nodes = roles.map((profile, i) => ({
    id: 'step-' + (i + 1), profile, label: ['收集材料', '整理与检查', '完成交付'][i],
    goal: ['收集并核对本次任务的输入材料，标记缺少的证据。', '按已确认目标整理结果，检查遗漏与不一致。', '提交可直接使用的交付说明，并保留必要来源。'][i],
    model: clone(profile === 'review' ? reviewModel : defaultModel),
  }))
  return { id, name, description: '个人流程示例 · 可编辑，刷新后恢复。', entry: nodes[0].id, control: { maxRounds: 3 }, nodes, edges: nodes.map((n, i) => ({ from: n.id, to: nodes[i + 1]?.id || '$end', on: 'success' })) }
}

function addDemoRun(seed, workflow, options) {
  const { id, title, status, space, minute, rework = false, fanout = false } = options
  const dsl = clone(workflow.dsl)
  const now = Date.now() - minute * 60000
  const logicalId = 'demo-logical-' + id
  const runId = 'demo-run-' + id
  const segment = rework ? 2 : 1
  const selected = fanout ? Math.max(0, dsl.nodes.findIndex((n) => n.kind === 'fanout')) : status === 'WAITING_HUMAN' ? Math.max(0, dsl.nodes.length - 2) : Math.min(2, dsl.nodes.length - 1)
  const node = dsl.nodes[selected]
  const workspace = {
    workspace_id: space, mode: 'ISOLATED_WRITE', workspace_path: '/tmp/prototype-only/' + id,
    source_path: 'workflow-manager（演示数据）', source_revision: 'prototype', work_branch: 'demo/' + id,
    current_head: 'demo-only', base_commit: 'demo-only', lifecycle: 'ACTIVE', allocated_at: now - 600000,
    events: [], resource_locks: [], integration_checkpoints: [], cleanup: null, refreshed_at: now,
  }
  const row = { id: runId, taskId: '示例任务 ' + id, name: workflow.name, workflowId: workflow.id, status, phase: node.label || node.id, startedAt: now - 600000, logical_run_id: logicalId, segment, segment_count: segment, logical_state: status }
  const terminal = ['COMPLETED', 'STOPPED', 'FAILED'].includes(status)
  if (status === 'COMPLETED') row.status = 'DONE'
  if (status === 'RUNNING') row.status = 'running'
  const lr = {
    schema: 1, logical_run_id: logicalId, task_id: row.taskId, template_id: workflow.id, title,
    created_at: now - 600000, updated_at: now, lifecycle: { state: status, reason: { code: status === 'WAITING_HUMAN' ? 'HUMAN_ACCEPTANCE' : status === 'BLOCKED' ? 'MODEL_PROVIDER_UNAVAILABLE' : status === 'PAUSED' ? 'USER_PAUSE' : status } },
    terminal, completion: status === 'COMPLETED' ? { type: 'EVALUATION_PASSED', at: now } : null,
    segments: [], snapshots: [], node_attempts: [], business_outcomes: {}, guidance: [], control_events: [],
    baseline_revisions: [], baseline_applied_upto: 0, last_engine_error: null,
    pause_state: status === 'PAUSED' ? { paused_at: now, reason: 'USER_PAUSE', source: 'user' } : null,
    pause_resume: null, evaluation_baseline: null, evaluation_baselines: [], formal_records: null,
    workspace, human_decisions: [], consumed_decisions: {},
  }
  const providerModel = Object.fromEntries(dsl.nodes.filter((n) => n.model).map((n) => [n.id, n.model]))
  for (let i = 1; i <= segment; i++) {
    lr.segments.push({ index: i, run_id: i === segment ? runId : runId + '-previous', trigger: i === 1 ? 'start' : 'human_decision', started_at: now - (segment - i + 1) * 300000, status: i === segment ? row.status : 'DONE', active: i === segment })
    lr.snapshots.push({ revision: i, created_at: now - (segment - i + 1) * 300000, active: i === segment, workflow: { id: workflow.id, name: workflow.name, dsl }, provider_model: providerModel })
  }
  const records = []
  function addAttempt(n, seg, outcome, text, kind = 'logical', itemIndex, attemptStatus = 'completed') {
    const attemptId = n.id + '-' + seg + '-' + (itemIndex ?? 'main')
    const at = now - (dsl.nodes.length - dsl.nodes.indexOf(n)) * 45000 - (segment - seg) * 300000
    const model = n.model || { provider: 'deepseek-official', model: 'deepseek-flash' }
    const value = {
      schema: 1, attempt_id: attemptId, kind, node: n.id, round: seg - 1, segment: seg,
      status: attemptStatus, snapshot_revision: String(seg), ...model,
      ...(attemptStatus === 'completed' ? { ended_at: new Date(at).toISOString() } : { started_at: new Date(at).toISOString() }),
      outcome, outcome_path: n.output?.outcomePath || '$.route', result: { summary: text, evidence: '原型演示记录，不代表真实执行。' },
      ...(itemIndex === undefined ? {} : { item_index: itemIndex, item_id: 'research-' + itemIndex, item: ['技术可行性', '用户使用路径', '风险与反证'][itemIndex] }),
    }
    records.push({ record_id: 'attempt:' + logicalId + ':' + attemptId, record_revision: 1, body: { media_type: 'application/json', value }, provenance: { node: n.id, attempt: seg, snapshot_revision: String(seg), ...model } })
    if (kind === 'logical') {
      lr.node_attempts.push({ node: n.id, segment: seg, snapshot_revision: seg, ...model, outcome, status: attemptStatus, ...(attemptStatus === 'completed' ? { completed_at: at } : { started_at: at }) })
      if (attemptStatus === 'completed') {
        lr.business_outcomes[n.id] = { outcome, path: value.outcome_path, segment: seg, snapshot_revision: seg, at }
        records.push({ record_id: 'node:' + logicalId + ':' + n.id, record_revision: seg, body: { media_type: 'application/json', value: value.result }, provenance: { node: n.id, attempt: seg, snapshot_revision: String(seg), ...model, node_business_outcome: outcome } })
      }
    }
  }
  if (rework) {
    const dev = dsl.nodes.find((n) => n.profile === 'dev') || dsl.nodes[0]
    const review = dsl.nodes.find((n) => n.profile === 'review') || dsl.nodes[1]
    addAttempt(dev, 1, 'READY', '第 1 次实现：完成初版布局，主要入口可用。')
    addAttempt(review, 1, 'RETURN_DEV', '退回意见：配置区滚动时主要操作离开视口；需要保持画布与配置独立滚动。')
    seed.runs.push({ ...row, id: runId + '-previous', segment: 1, status: 'DONE', supersededBy: runId })
  }
  for (let i = 0; i < dsl.nodes.length; i++) {
    if (!terminal && (status === 'WAITING_HUMAN' ? i > selected : i >= selected)) break
    const n = dsl.nodes[i]
    const outcome = dsl.edges.find((e) => e.from === n.id && e.on !== 'technical' && e.to !== '$end')?.outcome || 'PASS'
    addAttempt(n, segment, outcome, (rework && i > 0 ? '第 2 次成果：' : '') + (n.label || n.id) + '已经完成。主要路径和必要证据已核对。')
  }
  if (fanout) {
    const group = dsl.nodes.find((n) => n.kind === 'fanout') || node
    addAttempt(group, segment, undefined, '演示进度：两个视角已提交，风险与反证视角仍在研究。', 'logical', undefined, 'running')
    for (let i = 0; i < 3; i++) addAttempt(group, segment, i < 2 ? 'RESEARCH_DONE' : undefined, ['已形成可行方案与实现约束。', '已整理典型使用路径与主要分歧。', '正在核对反例与风险。'][i], 'item', i, i < 2 ? 'completed' : 'running')
  }
  const state = {
    status: row.status, node: node.id, phase: node.label, round: rework ? 1 : 0,
    logs: ['[演示] 已加载任务输入', '[演示] 主要步骤已完成', '[演示] 当前状态：' + status],
    agents: lr.node_attempts.map((a, i) => ({ seq: i + 1, label: dsl.nodes.find((n) => n.id === a.node)?.label || a.node, phase: a.node, outcome: a.status === 'running' ? 'running' : 'completed' })),
    formalRecords: [], decision_id: status === 'WAITING_HUMAN' ? logicalId + ':accept:1' : '',
    reason: status === 'WAITING_HUMAN' ? 'HUMAN_ACCEPTANCE' : status === 'BLOCKED' ? 'MODEL_PROVIDER_UNAVAILABLE' : '',
    decision_package: status === 'WAITING_HUMAN' ? {
      why: '实现、审查和回归检查已完成，交给你确认体验是否符合要求。',
      current_state: '第 2 次修改已解决配置滚动问题；请检查主要路径。',
      options: [{ id: 'USER_ACCEPTED' }, { id: 'ADD_BUDGET' }, { id: 'STOP' }],
      subsequent_effects: { USER_ACCEPTED: '完成本次示例', ADD_BUDGET: '增加一轮返工', STOP: '保留示例记录并停止' },
      cost: 'UNKNOWN', benefit: 'UNKNOWN', risk: 'UNKNOWN', recommendation: 'UNKNOWN',
    } : null,
    blocked_edge: status === 'BLOCKED' ? { from: node.id, to: node.id, on: 'technical' } : null,
  }
  seed.runs.push(row)
  seed.logical[logicalId] = lr
  seed.records[logicalId] = records
  seed.states[runId] = state
}

export async function loadSeed() {
  const blueprints = await Promise.all((await templateFiles()).map(json))
  const workflows = blueprints.map((bp) => ({ id: bp.id, name: bp.displayName, description: bp.description || '', builtin: true, dsl: core.projectToVwf(bp) }))
  const defaultModel = workflows.flatMap((w) => w.dsl.nodes).find((n) => n.model)?.model || { provider: 'deepseek-official', model: 'deepseek-flash' }
  const reviewModel = workflows.flatMap((w) => w.dsl.nodes).find((n) => n.profile === 'review' && n.model)?.model || { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const personalNames = ['发布说明整理', '需求澄清', '体验问题分析', '版本风险检查', '资料归纳']
  personalNames.forEach((name, i) => {
    const dsl = personalFlow('demo-personal-' + (i + 1), name + '（示例）', ['dev', 'review', 'closeout'], defaultModel, reviewModel)
    workflows.push({ id: dsl.id, name: dsl.name, description: dsl.description, builtin: false, dsl })
  })
  const catalog = await json(path.join(repoRoot, 'dsh/roles/builtin-roles.json'))
  const roles = await Promise.all(catalog.builtins.map(async (r) => ({ ...r, content: await readFile(path.join(repoRoot, r.definition), 'utf8') })))
  roles.push({ id: '体验检查员（示例）', name: '体验检查员（示例）', summary: '检查界面是否一致、可读，并能连续完成主要操作。', builtin: false, readonly: false, content: '# 体验检查员\n\n' + '检查界面入口、信息层级、控件状态、长文案、键盘操作和窄屏滚动。每项结论都附具体操作与可观察结果。\n\n'.repeat(22) })
  roles.push({ id: '资料整理员（示例）', name: '资料整理员（示例）', summary: '核对来源并整理可追溯的材料摘要。', builtin: false, readonly: false, content: '# 资料整理员\n\n对输入材料按主题归纳，保留来源、时间和证据限制。' })
  const providerMap = new Map()
  for (const w of workflows) for (const n of w.dsl.nodes) if (n.model?.provider && n.model.model) {
    if (!providerMap.has(n.model.provider)) providerMap.set(n.model.provider, new Set())
    providerMap.get(n.model.provider).add(n.model.model)
  }
  providerMap.set('openai-demo', new Set(['demo-model-fast', 'demo-model-reasoning']))
  const seed = {
    workflows, roles, messages: await json(path.join(packageRoot, 'locales/zh.json')),
    presets: (await json(path.join(repoRoot, 'docs/design/outcome-presets.json'))).presets,
    providers: [...providerMap].map(([id, models]) => ({ id, models: [...models] })),
    runs: [], logical: {}, records: {}, states: {},
  }
  const byId = (id) => workflows.find((w) => w.id === id)
  const rows = [
    ['204', '工作流界面改版（示例）', 'wf-construction-full-feature', 'WAITING_HUMAN', '工作流插件 · 示例空间', 1, true],
    ['203', '诊断画布筛选问题（示例）', 'wf-diagnose', 'BLOCKED', '工作流插件 · 示例空间', 6],
    ['202', '研究三种导航方案（示例）', 'wf-explore', 'RUNNING', '产品研究 · 示例空间', 12, false, true],
    ['201', '减少发布准备步骤（示例）', 'wf-optimize', 'COMPLETED', '个人工具 · 示例空间', 80],
    ['200', '整理本周发布说明（示例）', 'demo-personal-1', 'PAUSED', '个人工具 · 示例空间', 60],
    ['199', '核对版本风险（示例）', 'demo-personal-4', 'COMPLETED', '工作流插件 · 示例空间', 140],
    ['198', '汇总产品资料（示例）', 'demo-personal-5', 'RUNNING', '产品研究 · 示例空间', 24],
    ['197', '澄清操作范围（示例）', 'demo-personal-2', 'STOPPED', '个人工具 · 示例空间', 240],
  ]
  for (const [id, title, workflowId, status, space, minute, rework, fanout] of rows) addDemoRun(seed, byId(workflowId), { id, title, status, space, minute, rework, fanout })
  return seed
}

export function validateDraft(input) {
  const dsl = input?.displayName ? core.projectToVwf(input) : clone(input)
  const bp = core.projectToBlueprint(dsl)
  const checked = core.validateBlueprint(bp, { requireModels: true })
  const fieldErrors = {}
  const errors = checked.errors.map((error) => {
    if (error.fieldKey) (fieldErrors[error.fieldKey] ||= []).push(error.message)
    const node = /^\$\.nodes\[([^\]]+)\]/.exec(error.at)
    const edge = /^\$\.edges\[(\d+)\]/.exec(error.at)
    return { ...error, ...(node ? { nodeId: node[1] } : {}), ...(edge ? { edgeIndex: Number(edge[1]) } : {}) }
  })
  return { ok: checked.ok, errors, fieldErrors, sanitized: dsl, warnings: checked.warnings || [] }
}
