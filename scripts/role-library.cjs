'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// 角色库内核（Role Library Core）——唯一决策模块
//
// 深度设计：外部只有两类入口，内部隐藏名称规则、来源优先级、摘要口径、引用统计、
// 只读裁决与重命名回滚决策。
//   1. createRoleLibrary(manifest) → { describe(), execute(request) }——运行时深模块。
//      execute 只接受闭合命令联合（manifest/list/get/usage/validateName/change），
//      事实（facts）由调用方（Host 适配器）采集注入，模块不触碰 fs/subprocess/路径。
//      决策以意图（effect）返回：{kind:'write'|'rename'|'remove', ...}，由 Host 执行。
//   2. buildSnapshot(opts) → 同步构建期投影（生成器用）：清单 + 内置角色正文。
//      保持 compileBlueprint 同步，不引入顶层 await。
//
// 单一事实源：dsh/roles/builtin-roles.json（内置清单）；dsh/roles/<id>.md（角色正文）。
// 删除本模块后，名称规则 / 来源优先级 / usage 统计 / 只读与回滚裁决会重新散落回
// Host、Generator、Client 三处——这正是它存在的理由（删除测试）。
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_NAME_MAX = 64
// 名称唯一性键：NFC 规范化 + 小写（macOS/Windows 默认文件系统对规范化/大小写不敏感）。
function roleKey(s) {
  return String(s || '').normalize('NFC').toLowerCase()
}
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\x00-\x1F\x7F]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

// 角色名称校验：非空 / 长度 / 文件系统安全字符 / 首尾点 / Windows 保留设备名。
// 返回错误文案（与线上 RPC 逐字一致）或 null。
function validateRoleName(name) {
  const v = String(name || '').trim()
  if (!v) return '角色名称不能为空'
  if (v.length > ROLE_NAME_MAX) return '角色名称过长（最多 ' + ROLE_NAME_MAX + ' 字符）'
  if (ILLEGAL_NAME_CHARS.test(v)) return '角色名称包含非法字符'
  if (/^\./.test(v) || /\.$/.test(v)) return '角色名称不能以点开头或结尾'
  if (WINDOWS_RESERVED.test(v)) return '角色名称是系统保留名（如 CON/NUL/AUX），请换一个名称'
  return null
}

// 角色正文摘要：取首个有意义行（跳过 frontmatter 键/标题），截 80 字符；空则回退 fallback。
function summarizeRole(content, fallback) {
  if (typeof content !== 'string') return fallback || ''
  const skip = /^---|^id:|^name:|^summary|^createdAt|^updatedAt|^dynamicTemplate|^#/
  const firstLine = content.split('\n').map((l) => l.trim()).filter((l) => l && !skip.test(l))[0]
  return (firstLine || fallback || '').slice(0, 80)
}

// 打包回退角色的摘要口径：取首个非空行（注意：不做 trim——与线上行为逐字一致）。
function bundledFirstLine(content) {
  return String(content || '').split('\n').find((l) => l.trim()) || ''
}

function placeholderContent(meta) {
  return '# ' + meta.name + '（' + meta.id + '）\n\n' + meta.summary + '\n\n> 当前工作区未包含该内置角色的完整定义（dsh/roles/' + meta.id + '.md），角色仍可正常选择使用。'
}

// ── manifest 校验（加载即 loud-fail；不得静默退化为「全是自定义」）─────────────────
function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('内置角色清单解析失败：manifest 不是对象')
  if (!Array.isArray(m.builtins)) throw new Error('内置角色清单解析失败：缺少 builtins 数组')
  if (!m.builtins.length) throw new Error('内置角色清单解析失败：builtins 为空')
  if (m.schemaVersion !== 1) throw new Error('内置角色清单解析失败：schemaVersion 必须为 1')
  const seen = new Set()
  for (const r of m.builtins) {
    if (!r || typeof r !== 'object') throw new Error('内置角色清单解析失败：存在非对象条目')
    if (!/^[a-z][a-z0-9-]*$/.test(String(r.id || ''))) throw new Error('内置角色清单解析失败：非法 id：' + r.id)
    const key = roleKey(r.id)
    if (seen.has(key)) throw new Error('内置角色清单解析失败：id 归一化后冲突：' + r.id)
    seen.add(key)
    if (!r.name || !String(r.name).trim()) throw new Error('内置角色清单解析失败：中文名为空：' + r.id)
    if (!r.summary || !String(r.summary).trim()) throw new Error('内置角色清单解析失败：摘要为空：' + r.id)
    if (r.definition !== 'dsh/roles/' + r.id + '.md') throw new Error('内置角色清单解析失败：definition 路径非法：' + r.id)
    if (r.builtin !== true || r.readonly !== true) throw new Error('内置角色清单解析失败：内置角色必须 builtin/readonly：' + r.id)
  }
  if (seen.has('dispatcher')) throw new Error('内置角色清单解析失败：dispatcher 不得为内置（issue-81 已迁出）')
  const compat = Array.isArray(m.compatibilityRoles) ? m.compatibilityRoles : []
  for (const r of compat) {
    if (!r || typeof r !== 'object' || !r.id) throw new Error('内置角色清单解析失败：兼容角色条目非法')
    if (seen.has(roleKey(r.id))) throw new Error('内置角色清单解析失败：兼容角色与内置冲突：' + r.id)
    if (r.builtin !== false) throw new Error('内置角色清单解析失败：兼容角色必须 builtin:false：' + r.id)
  }
  return m
}

// ── 事实（facts）规范化：Host 适配器注入的目录事实 → 模块内部快照 ──────────────────
// catalog = { state:'ok'|'missing'|'error', message?, workspace:[{id,summary,content}], bundled:[{id,content}] }
// workspace 缺失/失败时按空目录参与只读读取（list/get）；写操作在 change 中单独裁决 fail-closed。
function catalogSnapshot(catalog) {
  const c = catalog && typeof catalog === 'object' ? catalog : { state: 'error', message: '角色库事实缺失' }
  return {
    state: c.state === 'ok' || c.state === 'missing' ? c.state : 'error',
    message: typeof c.message === 'string' ? c.message : '',
    workspace: Array.isArray(c.workspace) ? c.workspace : [],
    bundled: Array.isArray(c.bundled) ? c.bundled : [],
  }
}

// ── 深模块本体 ─────────────────────────────────────────────────────────────────
function createRoleLibrary(rawManifest) {
  const manifest = validateManifest(rawManifest)
  // 冻结：清单是模块私有只读事实源
  const builtins = manifest.builtins.map((r) => Object.freeze({ id: r.id, name: r.name, summary: r.summary, definition: r.definition, builtin: true, readonly: true }))
  const builtinIds = builtins.map((r) => r.id)
  const builtinKeySet = new Set(builtins.map((r) => roleKey(r.id)))
  const byId = new Map(builtins.map((r) => [r.id, r]))

  function describe() {
    return { builtinIds: builtinIds.slice(), roles: builtins.map((r) => ({ id: r.id, name: r.name, summary: r.summary })) }
  }

  function isBuiltin(id) {
    return byId.has(id)
  }

  // 名称唯一性：内置 + 工作区自定义 + 打包回退；目录读取失败 fail-closed。
  // 返回 { taken:true } | { taken:false } | { error:'…' }
  function nameTaken(catalog, name, excludeId) {
    const key = roleKey(name)
    if (!key) return { taken: true }
    const cat = catalogSnapshot(catalog)
    if (cat.state === 'error') return { error: '角色库读取失败，无法验证名称唯一性：' + cat.message }
    const excl = excludeId ? roleKey(excludeId) : null
    for (const id of builtinIds) {
      if (excl && excl === roleKey(id)) continue
      if (roleKey(id) === key) return { taken: true }
    }
    for (const r of cat.workspace) {
      if (!r || typeof r.id !== 'string') continue
      if (excl && excl === roleKey(r.id)) continue
      if (roleKey(r.id) === key) return { taken: true }
    }
    for (const r of cat.bundled) {
      if (!r || typeof r.id !== 'string') continue
      if (excl && excl === roleKey(r.id)) continue
      if (roleKey(r.id) === key) return { taken: true }
    }
    return { taken: false }
  }

  // 统一角色清单：内置（清单顺序）→ 工作区自定义（id 序）→ 打包回退（id 序，排最后）。
  // 内置正文来源：打包快照 > 工作区同名文件 > 清单摘要兜底。
  function list(facts) {
    const cat = catalogSnapshot(facts && facts.catalog)
    const bodies = (facts && facts.builtinBodies) || {}
    const wsById = new Map()
    for (const r of cat.workspace) {
      if (r && typeof r.id === 'string') wsById.set(r.id, r)
    }
    const includeContent = !!(facts && facts.includeContent)
    const roles = []
    for (const meta of builtins) {
      const snap = typeof bodies[meta.id] === 'string' ? bodies[meta.id] : null
      const f = wsById.get(meta.id)
      const wsSummary = f && f.content != null ? summarizeRole(f.content, '') : ''
      const entry = { id: meta.id, name: meta.name, summary: snap != null ? summarizeRole(snap, meta.summary) : (wsSummary || meta.summary), builtin: true }
      if (includeContent) {
        const content = snap != null ? snap : (f && f.content != null ? f.content : null)
        if (content != null) entry.content = content
      }
      roles.push(entry)
    }
    const customIds = cat.workspace.map((r) => r.id).filter((id) => typeof id === 'string' && !builtinKeySet.has(roleKey(id)))
    customIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const seenCustom = new Set(customIds)
    for (const id of customIds) {
      const f = wsById.get(id)
      // 摘要口径收归内核：适配器只传原始正文，摘要由 summarizeRole 统一计算
      const entry = { id, name: id, summary: summarizeRole(f && f.content, ''), builtin: false }
      if (includeContent && f) entry.content = f.content
      roles.push(entry)
    }
    const bundledIds = cat.bundled.map((r) => r.id).filter((id) => typeof id === 'string' && !builtinKeySet.has(roleKey(id)) && !seenCustom.has(id))
    bundledIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const id of bundledIds) {
      const b = cat.bundled.find((r) => r.id === id)
      const content = (b && typeof b.content === 'string') ? b.content : ''
      const entry = { id, name: id, summary: bundledFirstLine(content), builtin: false }
      if (includeContent) entry.content = content
      roles.push(entry)
    }
    return roles
  }

  // 单个角色详情：内置（快照 → 工作区 → 占位）→ 工作区自定义 → 打包回退 → null。
  function get(facts, id) {
    const cat = catalogSnapshot(facts && facts.catalog)
    const bodies = (facts && facts.builtinBodies) || {}
    const wsById = new Map()
    for (const r of cat.workspace) {
      if (r && typeof r.id === 'string') wsById.set(r.id, r)
    }
    if (isBuiltin(id)) {
      const meta = byId.get(id)
      let content = typeof bodies[id] === 'string' ? bodies[id] : null
      if (content == null) {
        const f = wsById.get(id)
        content = f && f.content != null ? f.content : null
      }
      if (content == null) content = placeholderContent(meta)
      return { id, name: meta.name, summary: summarizeRole(content, meta.summary), builtin: true, content }
    }
    const f = wsById.get(id)
    if (f) return { id, name: id, summary: summarizeRole(f.content, ''), builtin: false, content: f.content != null ? f.content : '' }
    const b = cat.bundled.find((r) => r.id === id)
    if (b && typeof b.content === 'string') {
      return { id, name: id, summary: bundledFirstLine(b.content), builtin: false, content: b.content }
    }
    return null
  }

  // 引用统计：全部工作流 + 可选开放草稿；草稿取代同 id 持久化版本；profile 按 roleKey 匹配。
  // workflows 事实 = { state:'ok'|'error', message?, records:[{workflowId,workflowName,builtin,nodes:[{id,label,profile}]}], draft? }
  function usage(facts, id) {
    const wf = (facts && facts.workflows) || { state: 'error', message: '引用事实缺失' }
    if (wf.state === 'error') return { error: wf.message || '引用统计失败' }
    const target = roleKey(id)
    const wfRefs = new Map()
    const add = (rec) => {
      const nodes = []
      for (const n of rec.nodes || []) {
        if (n && typeof n.profile === 'string' && roleKey(n.profile) === target) nodes.push({ id: n.id, label: n.label || n.id })
      }
      if (!nodes.length) {
        // 草稿里已移除全部引用 → 草稿状态取代持久化快照
        if (rec.draft) wfRefs.delete(String(rec.workflowId))
        return
      }
      const ref = { workflowId: String(rec.workflowId), workflowName: String(rec.workflowName), builtin: !!rec.builtin, nodes }
      if (rec.draft) ref.draft = true
      wfRefs.set(ref.workflowId, ref)
    }
    for (const rec of wf.records || []) add(rec)
    if (wf.draft) {
      // 草稿键：有 id 取代同 id 持久化版本；无 id 以 draft: 前缀独立计入（与线上语义一致）
      const draftId = wf.draft.id || ('draft:' + String(wf.draft.name || '未保存草稿'))
      add({ workflowId: draftId, workflowName: wf.draft.name || '未保存草稿', builtin: false, nodes: wf.draft.nodes, draft: true })
    }
    const refs = Array.from(wfRefs.values())
    const count = refs.reduce((sum, r) => sum + (r.nodes || []).length, 0)
    return { count, refs }
  }

  // 变更裁决（commit）：返回 { ok:true, effect } 或 { ok:false, errors, usage? }。
  // 检查顺序与线上 RPC 逐字一致；effect 由 Host 适配器执行（写/重命名/删除）。
  function change(request) {
    const facts = request.facts || {}
    const caps = facts.capabilities || {}
    const cat = catalogSnapshot(facts.catalog)
    const action = request.action
    const id = typeof request.id === 'string' ? request.id : ''
    const content = typeof request.content === 'string' ? request.content : null

    if (action === 'create') {
      if (!caps.fs) return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法创建角色' }] }
      const name = String(request.name || '').trim()
      const badName = validateRoleName(name)
      if (badName) return { ok: false, errors: [{ at: 'name', message: badName }] }
      if (content == null || !content.trim()) return { ok: false, errors: [{ at: 'content', message: '角色配置不能为空' }] }
      const dup = nameTaken(facts.catalog, name, null)
      if (dup.error) return { ok: false, errors: [{ at: '$', message: dup.error }] }
      if (dup.taken) return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
      return { ok: true, effect: { kind: 'write', id: name, content: content + (content.endsWith('\n') ? '' : '\n') } }
    }

    if (action === 'update') {
      if (!caps.fs) return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法更新角色' }] }
      if (!id) return { ok: false, errors: [{ at: '$.id', message: '缺少角色 id' }] }
      if (isBuiltin(id)) return { ok: false, errors: [{ at: '$', message: '内置角色只读：' + id + ' 属于系统标准角色，不能修改；可基于其创建自定义角色。' }] }
      if (cat.state === 'error') return { ok: false, errors: [{ at: '$', message: '角色库读取失败：' + cat.message }] }
      const inWorkspace = cat.workspace.some((r) => r && r.id === id)
      const inBundled = cat.bundled.some((r) => r && r.id === id)
      if (!inWorkspace && !inBundled) return { ok: false, errors: [{ at: '$', message: '自定义角色不存在：' + id }] }
      const newName = String(request.name || '').trim()
      const target = newName && newName !== id ? newName : id
      const isRename = target !== id
      if (isRename) {
        // 仅大小写/规范化差异指向同一文件：拒绝，避免写后删把自己删掉
        if (roleKey(target) === roleKey(id)) {
          return { ok: false, errors: [{ at: 'name', message: '新名称与当前名称仅大小写或写法不同（指向同一文件），请保留原名称或改用不同名称。' }] }
        }
        const badName = validateRoleName(target)
        if (badName) return { ok: false, errors: [{ at: 'name', message: badName }] }
        const dup = nameTaken(facts.catalog, target, id)
        if (dup.error) return { ok: false, errors: [{ at: '$', message: dup.error }] }
        if (dup.taken) return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
        const u = usage(facts, id)
        if (u.error) return { ok: false, errors: [{ at: '$', message: '引用统计失败：' + u.error }] }
        if (u.count > 0) {
          return { ok: false, errors: [{ at: 'name', message: '该角色仍被 ' + u.count + ' 个节点使用，重命名会导致这些引用全部失效；请先解除引用，或使用「基于此角色创建自定义角色」新建变体。' }] }
        }
        if (!caps.subprocess) return { ok: false, errors: [{ at: '$', message: '重命名需要子进程服务（删除旧角色文件）；当前宿主不可用，可先编辑内容或新建同名新角色。' }] }
      }
      if (content == null || !content.trim()) return { ok: false, errors: [{ at: 'content', message: '角色配置不能为空' }] }
      const normalized = content + (content.endsWith('\n') ? '' : '\n')
      if (isRename) return { ok: true, effect: { kind: 'rename', from: id, to: target, content: normalized } }
      return { ok: true, effect: { kind: 'write', id: id, content: normalized } }
    }

    if (action === 'remove') {
      if (!caps.fs || !caps.subprocess) return { ok: false, errors: [{ at: '$', message: '宿主文件能力不可用：无法删除角色' }] }
      if (!id) return { ok: false, errors: [{ at: '$.id', message: '缺少角色 id' }] }
      if (isBuiltin(id)) return { ok: false, errors: [{ at: '$', message: '内置角色只读：' + id + ' 属于系统标准角色，不能删除' }] }
      if (cat.state === 'error') return { ok: false, errors: [{ at: '$', message: '角色库读取失败：' + cat.message }] }
      const u = usage(facts, id)
      if (u.error) return { ok: false, errors: [{ at: '$', message: '引用统计失败，已阻止删除：' + u.error }] }
      if (u.count > 0) {
        const draftHint = u.refs.some((r) => r.draft) ? '（含未保存草稿的引用）' : ''
        return {
          ok: false,
          errors: [{ at: '$', message: '「' + id + '」仍被 ' + u.count + ' 个节点使用' + draftHint + '。请先将这些节点更换为其他角色，解除全部引用后再删除。' }],
          usage: { count: u.count, refs: u.refs },
        }
      }
      const inWorkspace = cat.workspace.some((r) => r && r.id === id)
      if (!inWorkspace) {
        if (inBundledOf(cat, id)) {
          return { ok: false, errors: [{ at: '$', message: '「' + id + '」的定义来自内置模板自带的角色包（生成产物），不在自定义角色库中，无法在此删除；如需停用，请在模板中把引用替换为其他角色。' }] }
        }
        return { ok: false, errors: [{ at: '$', message: '自定义角色不存在：' + id }] }
      }
      return { ok: true, effect: { kind: 'remove', id: id } }
    }

    return { ok: false, errors: [{ at: '$', message: '未知角色变更动作：' + String(action) }] }
  }

  function inBundledOf(cat, id) {
    return cat.bundled.some((r) => r && r.id === id)
  }

  // 统一入口：闭合命令联合。始终返回 Promise（Host 可 await）。
  async function execute(request) {
    const op = request && request.operation
    const facts = (request && request.facts) || {}
    switch (op) {
      case 'manifest':
        return { ok: true, manifest: { schemaVersion: manifest.schemaVersion, builtins: describe().roles, compatibilityRoles: manifest.compatibilityRoles || [] } }
      case 'list':
        return { ok: true, roles: list(facts) }
      case 'get': {
        const id = request.id
        const role = typeof id === 'string' && id ? get(facts, id) : null
        if (!role) return { ok: false, errors: [{ at: '$', message: '角色不存在：' + (id || '') }] }
        return { ok: true, role }
      }
      case 'usage': {
        const id = request.id
        if (!id || typeof id !== 'string') return { ok: false, errors: [{ at: '$.id', message: '缺少角色 id' }] }
        const u = usage(facts, id)
        if (u.error) return { ok: false, errors: [{ at: '$', message: '引用统计失败：' + u.error }] }
        return { ok: true, id, count: u.count, refs: u.refs }
      }
      case 'validateName': {
        const name = String(request.name || '').trim()
        const badName = validateRoleName(name)
        if (badName) return { ok: false, errors: [{ at: 'name', message: badName }] }
        const dup = nameTaken(facts.catalog, name, request.excludeId || null)
        if (dup.error) return { ok: false, errors: [{ at: '$', message: dup.error }] }
        if (dup.taken) return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
        return { ok: true }
      }
      case 'change':
        return change(request)
      default:
        return { ok: false, errors: [{ at: '$', message: '未知角色库操作：' + String(op) }] }
    }
  }

  return Object.freeze({ describe, execute })
}

// ── 构建期投影（生成器同步入口）────────────────────────────────────────────────
// 角色文件安全读取：标识只允许中英文/数字/下划线/短横线，且解析后路径必须在角色源目录内。
function readRoleFileSafe(rolesDir, id, io) {
  if (!/^[\w一-龥-]+$/.test(String(id || ''))) return null
  const file = joinPath(rolesDir, id + '.md')
  const rel = relativePath(rolesDir, file)
  if (rel.startsWith('..') || isAbsolutePath(rel)) return null
  try { return io.readFileSync(file, 'utf8') } catch (e) { return null }
}

// 极简 path 工具（本模块禁止 require；只需 posix 风格的拼接/相对/绝对判定，
// rolesDir 由调用方以绝对路径传入——生成器与测试都以 node:path 解析后传入）。
function joinPath(a, b) {
  return String(a).replace(/[\\/]+$/, '') + '/' + b
}
function isAbsolutePath(p) {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p)
}
function relativePath(from, to) {
  const f = String(from).replace(/[\\/]+$/, '') + '/'
  return String(to).startsWith(f) ? String(to).slice(f.length) : '..' + '/' + to
}

// 打包蓝图中引用的角色文件（**包含自定义角色**：dispatcher 等历史角色必须随 skill
// 自包含——名称沿用历史误导名 collectBuiltinRoles 的调用契约，语义 = referenced+existing）。
function collectReferencedRoleFiles(bp, rolesDir, io) {
  const out = new Map()
  if (!bp || !Array.isArray(bp.nodes)) return out
  const profiles = new Set()
  for (const n of bp.nodes) {
    if (n && typeof n.profile === 'string' && n.profile) profiles.add(n.profile)
  }
  for (const profile of profiles) {
    const content = readRoleFileSafe(rolesDir, profile, io)
    if (content != null) out.set('roles/' + profile + '.md', content)
  }
  return out
}

// 同步快照：清单 + 内置角色正文（生成器编译期内联）。manifest/角色目录读取失败 loud-fail
// 由调用方决定（生成器直接抛错；此处返回结构化结果）。
function buildSnapshot(opts) {
  const o = opts || {}
  const io = o.io
  if (!io || typeof io.readFileSync !== 'function') throw new Error('buildSnapshot 需要同步 io.readFileSync')
  const manifestText = io.readFileSync(o.manifestPath, 'utf8')
  const manifest = validateManifest(JSON.parse(manifestText))
  const builtinIds = manifest.builtins.map((r) => r.id)
  const roleDefs = {}
  for (const id of builtinIds) {
    const content = readRoleFileSafe(o.rolesDir, id, io)
    if (content != null) roleDefs[id] = content
  }
  return { manifest, builtinIds, roleDefs }
}

module.exports = {
  createRoleLibrary,
  validateManifest,
  buildSnapshot,
  readRoleFileSafe,
  collectReferencedRoleFiles,
  // 工具导出仅供测试与生成器复用（不构成业务接缝）
  roleKey,
  validateRoleName,
  summarizeRole,
}
