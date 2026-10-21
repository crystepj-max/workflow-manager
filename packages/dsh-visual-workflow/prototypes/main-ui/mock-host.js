// 原型专用的内存宿主。没有真实 DSH 地址，也没有把调用转发到外部的路径。
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))

export function createMockHost(seed) {
  const data = clone(seed)
  const overrides = {}
  const usage = (id, draft) => {
    const flows = data.workflows.map((w) => ({ ...w, dsl: w.dsl }))
    if (draft) {
      const index = flows.findIndex((w) => w.id === draft.id)
      const row = { id: draft.id || 'draft', name: draft.name || '未保存草稿', dsl: draft, builtin: false, draft: true }
      if (index >= 0) flows[index] = row
      else flows.push(row)
    }
    const refs = flows.map((w) => ({
      workflowId: w.id, workflowName: w.name, builtin: w.builtin, draft: w.draft,
      nodes: w.dsl.nodes.filter((n) => n.profile === id).map((n) => ({ id: n.id, label: n.label || n.id })),
    })).filter((w) => w.nodes.length)
    return { ok: true, id, refs, count: refs.reduce((n, w) => n + w.nodes.length, 0) }
  }
  const fail = (message, at = '$') => ({ ok: false, errors: [{ at, message }], error: message })
  const roleSummary = (content) => {
    const summary = /^---\n[\s\S]*?summary:\s*([^\n]*)/.exec(content)
    return summary?.[1] || content.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.slice(0, 80) || ''
  }
  async function validate(dsl) {
    const response = await fetch('/api/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dsl }),
    })
    if (!response.ok) throw new Error('原型静态校验不可用')
    return response.json()
  }
  async function call(method, args = {}) {
    args ||= {}
    let result
    switch (method) {
      case 'vwf.i18n': result = { locale: 'zh', messages: data.messages }; break
      case 'vwf.models': result = { providers: data.providers }; break
      case 'vwf.outcomePresets.list': result = { ok: true, schemaVersion: 1, presets: data.presets }; break
      case 'vwf.workflows.list':
        result = data.workflows.map((w) => ({ ...w, modelOverridden: !!Object.keys(overrides[w.id] || {}).length }))
        break
      case 'vwf.workflows.modelOverride.get':
        result = { ok: true, id: args.id, overrides: overrides[args.id] || {} }; break
      case 'vwf.workflows.modelOverride.save':
        overrides[args.id] = clone(args.overrides || {})
        result = { ok: true, id: args.id, overrides: overrides[args.id] }; break
      case 'vwf.workflows.modelOverride.clear':
        delete overrides[args.id]
        result = { ok: true, id: args.id }; break
      case 'vwf.validate': return validate(args.dsl)
      case 'vwf.workflows.save': {
        const index = data.workflows.findIndex((w) => w.id === args.currentId || w.id === args.dsl.id)
        if (index >= 0 && data.workflows[index].builtin) return fail('内置流程结构只读')
        const checked = await validate(args.dsl)
        if (!checked.ok) return checked
        const dsl = checked.sanitized || args.dsl
        const row = { id: dsl.id, name: dsl.name || dsl.id, description: dsl.description || '', builtin: false, dsl }
        if (index >= 0) data.workflows[index] = row
        else data.workflows.push(row)
        result = { ok: true, id: dsl.id, dsl }; break
      }
      case 'vwf.workflows.remove': {
        const index = data.workflows.findIndex((w) => w.id === args.id)
        if (data.workflows[index]?.builtin) return fail('内置流程不能删除')
        if (index >= 0) data.workflows.splice(index, 1)
        result = { ok: true, id: args.id }; break
      }
      case 'vwf.probe': {
        // 静态检查可用，模型连通性必须如实标记为未执行。
        const checked = await validate(args.dsl)
        if (!checked.ok) return { ...checked, stage: 'static' }
        const pairs = new Map()
        for (const node of args.dsl.nodes || []) if (node.model) {
          const key = node.model.provider + '/' + node.model.model
          if (!pairs.has(key)) pairs.set(key, { ...node.model, nodes: [] })
          pairs.get(key).nodes.push(node.id)
        }
        result = { ...checked, ok: false, stage: 'probe', cached: false, results: [...pairs.values()].map((pair) => ({ ...pair, status: 'probe_degraded', code: 'PROTOTYPE_ONLY', message: '网页原型不调用模型，连通性未执行。', cached: false })) }; break
      }
      case 'vwf.script':
        result = { ok: true, engineAvailable: false, script: '// 网页原型：不编译或执行真实工作流。' }; break
      case 'vwf.roles':
        result = { roles: data.roles.map(({ content, ...r }) => r) }; break
      case 'vwf.roles.get': {
        const role = data.roles.find((r) => r.id === args.id)
        result = role ? { ok: true, role } : fail('示例角色不存在'); break
      }
      case 'vwf.roles.usage': result = usage(args.id, args.draftDsl); break
      case 'vwf.roles.validate': {
        const name = String(args.name || '').trim()
        const invalid = !name || name.length > 64 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.|\.$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)
        const duplicate = data.roles.some((r) => r.id !== args.excludeId && r.name.toLowerCase() === name.toLowerCase())
        result = invalid ? fail('请使用有效的角色名称', 'name') : duplicate ? fail('已存在同名角色', 'name') : { ok: true }; break
      }
      case 'vwf.roles.create':
      case 'vwf.roles.update': {
        const checked = await call('vwf.roles.validate', { name: args.name, excludeId: args.id })
        if (!checked.ok) return checked
        const index = data.roles.findIndex((r) => r.id === args.id)
        if (data.roles[index]?.builtin) return fail('内置角色只读')
        const role = { id: args.name, name: args.name, content: args.content, summary: roleSummary(args.content || ''), builtin: false, readonly: false }
        if (index >= 0) data.roles[index] = role
        else data.roles.push(role)
        result = { ok: true, role }; break
      }
      case 'vwf.roles.remove': {
        const index = data.roles.findIndex((r) => r.id === args.id)
        if (data.roles[index]?.builtin) return fail('内置角色只读')
        if (usage(args.id, args.draftDsl).count) return fail('该示例角色仍有流程引用')
        if (index >= 0) data.roles.splice(index, 1)
        result = { ok: true, id: args.id }; break
      }
      case 'vwf.runs.list': result = { runs: data.runs }; break
      case 'vwf.logicalRuns.get': {
        const record = data.logical[args.logical_run_id]
        result = { found: !!record, record: record || null }; break
      }
      case 'vwf.records.list':
        result = { ok: true, found: true, logical_run_id: args.logical_run_id, records: data.records[args.logical_run_id] || [], attempts: [] }; break
      case 'vwf.state':
        result = { found: !!data.states[args.runId], state: data.states[args.runId] || null }; break
      case 'vwf.run.control': {
        const lr = data.logical[args.logical_run_id]
        if (!lr) return fail('找不到示例运行')
        const head = data.runs.find((r) => r.logical_run_id === args.logical_run_id && !r.supersededBy)
        const state = data.states[head.id]
        if (args.action === 'guidance') {
          if (lr.lifecycle.state !== 'PAUSED') return fail('仅暂停的演示运行可补充说明')
          lr.guidance.push({ seq: lr.guidance.length + 1, mode: 'coach', text: args.text, at: Date.now(), run_id: head.id })
        } else {
          const next = args.action === 'pause' ? 'PAUSED' : args.action === 'interrupt' ? 'STOPPED' : 'RUNNING'
          lr.lifecycle.state = next
          lr.lifecycle.reason = { code: next === 'PAUSED' ? 'USER_PAUSE' : next }
          lr.terminal = next === 'STOPPED'
          head.status = next === 'RUNNING' ? 'running' : next; head.logical_state = next; state.status = head.status
          state.reason = lr.lifecycle.reason.code
          lr.pause_state = next === 'PAUSED' ? { paused_at: Date.now(), source: 'user', reason: 'USER_PAUSE' } : null
        }
        lr.control_events.push({ type: args.action, at: Date.now(), text: args.text || '', run_id: head.id })
        result = { ok: true, action: args.action, logical_run_id: lr.logical_run_id }; break
      }
      default: throw new Error('原型未模拟的接口：' + method)
    }
    return clone(result)
  }
  return { call }
}
