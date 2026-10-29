// WFM-67：界面续跑边界。身份仅取原 Run 的冻结配置；执行复用宿主 wf_run。
// 不启动模型、不签发 Proof、不猜测或创建 Agent。每个插件加载实例有自己的提交锁。
'use strict'

const pending = new Map()
const foreground = new Map()
const fail = message => ({ ok: false, errors: [{ at: '$', message }] })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const messageOf = value => {
  if (typeof value === 'string') return value
  return value && (value.error || (value.errors || []).map(e => e.message).join(';')) || '续跑未启动，请刷新后重试。'
}

function submit(a, h) {
  const rec = h.rec
  const state = rec.lifecycle.state
  const taskId = rec.task_id
  if (pending.has(taskId)) return fail('该运行已有界面提交正在处理，请等待状态更新，勿重复提交。')
  if (foreground.has(taskId)) return fail('上一执行段仍在整理结果或核验门禁，请稍后刷新重试。')
  if (h.latest !== rec || rec.terminal || (a.action === 'decision' ? state !== 'WAITING_HUMAN' : state !== 'BLOCKED')) return fail('运行状态已前进或不适用此操作（' + state + '），请刷新后重试。')
  const lastSeg = rec.segments.at(-1)
  const snapshot = rec.snapshots.find(s => s.active) || rec.snapshots.at(-1)
  if (!snapshot || Number(a.snapshot_revision) !== snapshot.revision || String(a.run_id || '') !== String(lastSeg && lastSeg.run_id || '')) return fail('运行版本或执行段已变化，请刷新后重试。')
  const first = rec.snapshots.find(s => s.revision === 1)
  const config = first && first.config || {}
  const ownerId = config.execution_session_id
  const registry = h.agents
  if (!ownerId || !registry || typeof registry.get !== 'function' || typeof registry.withInitiator !== 'function') return fail('原运行缺少可核验的执行会话归属，无法从界面续跑；请在原会话中恢复。旧记录不会被改写。')
  const owner = registry.get(ownerId)
  if (!owner || !owner.session || owner.session.id !== ownerId || owner.id !== ownerId) return fail('原执行会话当前未加载或已退出，请先打开原会话，再重试；不会改用其他会话。')
  if (!first.workflow || !object(first.workflow.dsl)) return fail('原运行缺少冻结工作流，无法续跑。')
  const args = { ...config, dsl: JSON.parse(JSON.stringify(first.workflow.dsl)), taskId }
  delete args.execution_session_id
  let decision = a
  if (a.action === 'recover') {
    if (!object(a.model_overrides) || !Object.keys(a.model_overrides).length) return fail('请先选择要更换的服务商 / 模型。')
    // 不从浏览器透传额外参数；仅允许非空的模型绑定变更。
    const overrides = {}
    const nodeIds = new Set((first.workflow.dsl.nodes || []).map(n => n.id))
    for (const [node, binding] of Object.entries(a.model_overrides)) {
      if (node !== '$default' && !nodeIds.has(node)) return fail('未知模型覆盖节点：' + node)
      if (!object(binding) || (!binding.provider && !binding.model) || Object.keys(binding).some(k => !['provider', 'model'].includes(k) || typeof binding[k] !== 'string')) return fail('模型覆盖参数不完整：' + node)
      overrides[node] = { ...binding }
    }
    args.model_overrides = overrides
    const code = rec.lifecycle.reason && rec.lifecycle.reason.code || ''
    if (code === 'NEEDS_REDEFINE') return fail('NEEDS_REDEFINE：须重定义基线，不能从原运行恢复。')
    // 探针失败可能出现在人工决定续跑前；沿用已核验的 UI 选择，不补造选择。
    if (h.parked && h.parked.decision_id) {
      const previous = [...(rec.control_events || [])].reverse().find(e => e.type === 'ui_resume_requested' && e.action === 'decision' && e.decision_id === h.parked.decision_id)
      if (!previous) return fail('该运行仍有未完成的人工决定，请在原会话携原 decision_id 与选择恢复。')
      decision = previous
    } else if (code !== 'PROBE_FAILED') {
      const node = /^GATE_/.test(code) ? 'uat' : h.parked && h.parked.node
      if (!node || !(first.workflow.dsl.nodes || []).some(n => n.id === node)) return fail('缺少可核验的恢复入口，请在原会话确认后恢复。')
      args.entry = node
    }
  }
  if (a.action === 'decision' || decision !== a) {
    const parked = h.parked
    if (!parked || !parked.decision_id || String(decision.decision_id) !== parked.decision_id) return fail('decision_id 已变化或无可提交的决策包，请刷新后重试。')
    const options = (parked.decision_package && parked.decision_package.options) || []
    if (!options.some(o => o && o.id === decision.user_choice)) return fail('请选择当前决策包中的有效选项。')
    args.decision_id = parked.decision_id
    args.user_choice = decision.user_choice
    args.feedback = typeof decision.reason === 'string' ? decision.reason.trim() : ''
  }
  const initiator = { source: 'ui', execution_session_id: ownerId }
  const event = { action: a.action, decision_id: args.decision_id || null, user_choice: args.user_choice || null, reason: args.feedback || '', initiator, snapshot_revision: snapshot.revision }
  const before = { lifecycle: rec.lifecycle, terminal: rec.terminal, segments: rec.segments.length }
  const restoreUnstarted = () => {
    const code = rec.lifecycle.reason && rec.lifecycle.reason.code
    if (rec.segments.length === before.segments && rec.lifecycle.state === 'FAILED' && ['WORKSPACE_ALLOCATE_FAILED', 'NODE_ISOLATION_UNAVAILABLE', 'ENGINE_START_FAILED'].includes(code)) { rec.lifecycle = before.lifecycle; rec.terminal = before.terminal }
  }
  pending.set(taskId, event)
  h.event('ui_resume_requested', event)
  return new Promise(resolve => {
    let started = false
    const ui = {
      initiator,
      onStarted(runId) { started = true; resolve({ ok: true, action: a.action, logical_run_id: rec.logical_run_id, run_id: runId, state: 'RUNNING' }) },
    }
    let running
    try { running = registry.withInitiator(owner, () => h.execute(args, ui)) } catch (error) { running = Promise.reject(error) }
    Promise.resolve(running).then(value => {
      if (!started) {
        let result = value
        try { if (typeof value === 'string') result = JSON.parse(value) } catch (_) { /* 保留原错误 */ }
        restoreUnstarted()
        const details = result && result.failures && result.failures.map(f => f.provider + '/' + f.model + ': ' + (f.message || f.code)).join('; ')
        const message = result && result.blocked ? details || result.detail || '模型探针或恢复条件未通过，请修改后重试。' : messageOf(result)
        h.event('ui_resume_failed', { ...event, message })
        resolve(fail(message))
      }
    }, error => {
      const message = String(error && error.message || error)
      if (!started) restoreUnstarted()
      h.event('ui_resume_failed', { ...event, message })
      if (!started) resolve(fail(message))
    }).finally(() => { if (pending.get(taskId) === event) pending.delete(taskId) })
  })
}

// 只跟踪原工具的完整前台生命周期，不改变工具之间的既有启动裁决。
// UI 必须等 Proof / baseline / integration 等后处理全部收束，不能抢过暂写的等待状态。
function execute(run, args, ui) {
  const taskId = String(args && args.taskId || '')
  if (ui) return run(args, ui)
  if (pending.has(taskId)) return Promise.resolve('错误：界面续跑正在处理，请等待。')
  const active = foreground.get(taskId) || new Set()
  const token = {}
  active.add(token); foreground.set(taskId, active)
  const release = () => { active.delete(token); if (!active.size && foreground.get(taskId) === active) foreground.delete(taskId) }
  try { return Promise.resolve(run(args)).finally(release) } catch (error) { release(); throw error }
}

function config(args, parent, roleDir) {
  const value = { roleDir: args.roleDir || roleDir, execution_session_id: parent.session && parent.session.id }
  for (const key of ['runDir', 'baseBranch', 'issueRef', 'issueTitle', 'issueBody', 'issueComments', 'requirement', 'resource_kind', 'issuePath', 'specPath']) if (args[key] !== undefined && args[key] !== null && args[key] !== '') value[key] = args[key]
  return value
}

// 与 WFM-81 的 isolation=unavailable 行互斥；这里只展示真正的“未开段、模型探针受阻”。
function unstartedRuns(records) {
  return Array.from(records).filter(r => !r.segments.length && r.lifecycle.state === 'BLOCKED' && r.lifecycle.reason && r.lifecycle.reason.code === 'PROBE_FAILED' && r.isolation_guarantee !== 'unavailable').map(r => ({
    id: 'logical:' + r.logical_run_id, logical_run_id: r.logical_run_id, taskId: r.task_id,
    workflowId: r.template_id, name: r.title, status: 'BLOCKED', logical_state: 'BLOCKED',
    reason: r.lifecycle.reason.code, startedAt: r.created_at, segment: null, segment_count: 0, execution_not_started: true,
  }))
}

module.exports = { submit, execute, config, unstartedRuns }
