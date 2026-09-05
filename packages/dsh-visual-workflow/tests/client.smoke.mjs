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

function byText(root, text) {
  return Array.from(root.querySelectorAll('*')).find((el) => el.children.length === 0 && (el.textContent || '').includes(text))
}
function byClass(root, cls) {
  return root.querySelector('.' + cls)
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
// 模拟「需求分析师」被 node-1 引用（其余角色零引用）
const ROLE_USAGE = {
  '需求分析师': { count: 1, refs: [{ workflowId: 'wf1', workflowName: '测试流', builtin: false, nodes: [{ id: 'node-1', label: '节点1' }] }] },
}

// ── 组装动态客户端运行环境 ─────────────────────────────────────────────────
function makeRuntime() {
  const state = { failSave: false, failUsage: false, saved: [] }
  const rpc = async (method, args) => {
    switch (method) {
      case 'vwf.workflows.list':
        return [{ id: 'wf1', name: '测试流', description: 'seed', builtin: false, dsl: JSON.parse(JSON.stringify(SEED_DSL)) }]
      case 'vwf.models':
        return { providers: [{ id: 'deepseek-official', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }] }
      case 'vwf.roles':
        return { roles: roleState.roles.map(r => ({ id: r.id, name: r.name, summary: r.summary, builtin: r.builtin })) }
      case 'vwf.roles.get': {
        const role = roleState.roles.find(r => r.id === args.id)
        return role ? { ok: true, role: { ...role } } : { ok: false, errors: [{ at: '$', message: '角色不存在：' + args.id }] }
      }
      case 'vwf.roles.create': {
        const dup = roleState.roles.some(r => String(r.id).toLowerCase() === String(args.name).toLowerCase())
        if (dup) return { ok: false, errors: [{ at: 'name', message: '已存在同名角色，请使用其他名称。' }] }
        const role = { id: args.name, name: args.name, summary: String(args.content || '').split('\n')[0].slice(0, 80), builtin: false, content: args.content }
        roleState.roles.push(role)
        return { ok: true, role: { ...role } }
      }
      case 'vwf.roles.update': {
        const idx = roleState.roles.findIndex(r => r.id === args.id)
        if (idx < 0) return { ok: false, errors: [{ at: '$', message: '自定义角色不存在：' + args.id }] }
        const role = { ...roleState.roles[idx], id: args.name || args.id, name: args.name || args.id, content: args.content }
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
        return { ok: true, errors: [], fieldErrors: {} }
      case 'vwf.workflows.save':
        state.saved.push(args.dsl)
        return { ok: true, id: args.dsl.id, dsl: args.dsl }
      case 'vwf.script':
        return { ok: true, engineAvailable: false, script: '// compiled' }
      case 'vwf.state':
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
    timeout: (fn, delay) => { if (delay === 0 && typeof fn === 'function') fn(); return () => {} },
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
  timeout: (fn, delay) => { if (delay === 0 && typeof fn === 'function') fn(); return () => {} },
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
  await act(async () => {
    root.render(React.createElement(Page))
    await flush()
  })
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

test('拖拽连线：从节点右把手拖到结束节点创建新边', async () => {
  const wrap = container.querySelector('.vwf-canvas-wrap')
  Object.defineProperty(wrap, 'clientWidth', { value: 1000, configurable: true })
  Object.defineProperty(wrap, 'clientHeight', { value: 600, configurable: true })
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 })
  // fitView 已在首帧调用（clientWidth 0 时 scale=0.3）；重新触发一次 fit 以对齐坐标假设
  const before = container.querySelectorAll('.vwf-edge-flow').length
  await act(async () => {
    const fitBtn = container.querySelector('.vwf-zoom button[title="适配视图"]')
    if (fitBtn) fitBtn.click()
    await flush()
    const handles = container.querySelectorAll('.vwf-handle-src')
    assert.ok(handles.length >= 2, '存在源把手（node-1、node-2）')
    const srcHandle = handles[0]
    srcHandle.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 80 }))
    // 拖到 $end 节点位置（rank=1：图形坐标 x∈[392,532]；scale=1.2 → clientX 500 → 416.7）
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 500, clientY: 200 }))
    await flush()
  })
  // act 结束后 React 已提交：拖线指向的目标节点应带高亮标记
  const targetHit = container.querySelector('[data-vwf-connect-target="true"]')
  assert.ok(targetHit, '拖线指向目标节点时高亮标记出现')
  assert.equal(targetHit.closest('g').getAttribute('data-node-id'), '$end', '高亮目标为拖动指向的节点')
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 480, clientY: 200 }))
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
  assert.equal(firstEdge.getAttribute('stroke'), '#2563eb', '默认 success 边使用固定蓝色，不随品牌色变黑')
  await act(async () => {
    const hit = container.querySelector('.vwf-edge-hit')
    assert.ok(hit, '存在边命中路径')
    hit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.ok(byText(container, '边配置'), '边配置面板渲染')
  assert.ok(byText(container, '删除边'), '边面板含删除按钮')
  assert.equal(firstEdge.getAttribute('stroke'), '#111827', '选中边使用黑色')
  assert.equal(firstEdge.getAttribute('stroke-width'), '4.2', '选中边加粗')
  const selectedLabel = Array.from(container.querySelectorAll('text')).find((el) => el.textContent.includes('成功') && el.getAttribute('fill') === '#111827')
  assert.ok(selectedLabel, '选中边标签同步使用主文字色')
  assert.equal(selectedLabel.getAttribute('font-weight'), '700', '选中边标签加粗')
  assert.equal(selectedLabel.style.stroke, 'rgba(255,255,255,.82)', '黑色选中标签在深色画布上保留浅色描边')
  assert.equal(container.querySelector('#vwf-arrow-sel path').getAttribute('fill'), '#111827', '选中边箭头同步使用黑色')
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
  const kindLabel = byText(container, '节点类型')
  assert.ok(kindLabel, '存在节点类型字段')
  const kindSelect = kindLabel.closest('.vwf-field').querySelector('select')
  await act(async () => {
    kindSelect.value = 'fanout'
    kindSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await flush()
  })
  assert.ok(byText(container, 'items 来源'), 'fanout 显示 items 来源')
  assert.ok(byText(container, '失败阈值'), 'fanout 显示失败阈值')
  assert.ok(container.querySelector('.vwf-help[title*="该 Schema 校验每个子代理"]'), 'fanout 显示 per-item schema 说明')
  const kinds = Array.from(container.querySelectorAll('text.vwf-node-kind')).map((el) => el.textContent)
  assert.ok(kinds.includes('fanout'), '画布卡片显示 fanout')
})

test('fanout 看板：按节点归组展示三项并保留失败状态', async () => {
  await act(async () => {
    const dashboardTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '运行看板')
    assert.ok(dashboardTab)
    dashboardTab.click()
    await flush()
  })
  const input = container.querySelector('input[placeholder^="runId"]')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'run-1')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  await act(async () => {
    const refresh = input.parentElement.querySelector('button')
    refresh.click()
    await flush()
  })
  assert.ok(byText(container, '逐项处理 · fanout · 3 items'), '看板显示 fanout 组标题')
  assert.ok(byText(container, '逐项处理 #1'))
  assert.ok(byText(container, '逐项处理 #2'))
  const failed = Array.from(container.querySelectorAll('.vwf-badge')).find((el) => el.textContent === 'failed')
  assert.ok(failed && failed.getAttribute('style').includes('error'), '失败项使用失败色')
  await act(async () => {
    const templatesTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '模板库')
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

  // 规则 6：所有边终点落在目标节点左边框垂直居中（不做目标锚点间隔）
  const endYOf = (d) => Number(d.trim().split(/[\s,]+/).pop())
  const nodeCenterY = (g) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    const h = Number(g.querySelector('rect').getAttribute('height'))
    return Number(m[2]) + h / 2
  }
  // 规则 6：每条边的终点都落在目标节点左边框垂直居中（数据驱动，取自 dsl 与 DOM 实测高度）
  complexDsl.edges.forEach((e, i) => {
    const g = svg.querySelector('g[data-node-id="' + e.to + '"]')
    assert.ok(g, '画布存在目标节点 ' + e.to)
    assert.equal(endYOf(paths[i].getAttribute('d')), nodeCenterY(g), '边 ' + i + ' 终点在 ' + e.to + ' 左边框垂直居中')
  })
  // 规则 5：同源起点按「上绕 → 直连 → 下绕」自上而下间隔，与边在 dsl 中的出现顺序无关；
  // 所有起点圆点与对应边同色，且精确落在源节点右边框（transform.x + rect.width）。
  const starts = Array.from(svg.querySelectorAll('circle.vwf-edge-start'))
  assert.equal(starts.length, paths.length, '每条边有一个起点圆点')
  const nodeRightX = (id) => {
    const g = svg.querySelector('g[data-node-id="' + id + '"]')
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return Number(m[1]) + Number(g.querySelector('rect').getAttribute('width'))
  }
  complexDsl.edges.forEach((e, i) => {
    assert.equal(starts[i].getAttribute('fill'), paths[i].getAttribute('stroke'), '边 ' + i + ' 起点圆点与边同色')
    assert.equal(Number(starts[i].getAttribute('cx')), nodeRightX(e.from), '边 ' + i + ' 起点落在 ' + e.from + ' 右边框')
  })
  const rankOf = { up: 0, direct: 1, down: 2 }
  // 路径类型判定：命令字母 + 数字序列解析（与空格/逗号格式无关）；直连为 C 曲线，绕行为 L 折线
  const kindOf = (i) => {
    const d = paths[i].getAttribute('d')
    if (/C/.test(d)) return 'direct'
    const nums = d.match(/-?[\d.]+/g).map(Number)
    const yStart = nums[1]
    const laneY = nums[5]
    return laneY < yStart ? 'up' : 'down'
  }
  const perSource = new Map()
  complexDsl.edges.forEach((e, i) => {
    const list = perSource.get(e.from) || []
    list.push({ idx: i, kind: kindOf(i) })
    perSource.set(e.from, list)
  })
  for (const [src, list] of perSource) {
    const cyOf = (idx) => Number(starts[idx].getAttribute('cy'))
    const sorted = list.slice().sort((a, b) => rankOf[a.kind] - rankOf[b.kind] || a.idx - b.idx)
    for (let k = 1; k < sorted.length; k += 1) {
      // 优化 3：固定三槽位——同类边共享槽位（相等），跨类严格上升（上<直连<下）
      assert.ok(cyOf(sorted[k].idx) >= cyOf(sorted[k - 1].idx),
        '源 ' + src + ' 起点按 ' + sorted[k - 1].kind + '→' + sorted[k].kind + ' 自下而下不降')
      if (sorted[k].kind !== sorted[k - 1].kind) {
        assert.ok(cyOf(sorted[k].idx) > cyOf(sorted[k - 1].idx),
          '源 ' + src + ' 起点按 ' + sorted[k - 1].kind + '→' + sorted[k].kind + ' 跨类严格上升')
      }
    }
    // 直连槽位 = 节点右边框垂直居中（与连线源把手位置一致）
    for (const item of sorted) {
      if (item.kind === 'direct') {
        const g = svg.querySelector('g[data-node-id="' + src + '"]')
        const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
        const center = Number(m[2]) + Number(g.querySelector('rect').getAttribute('height')) / 2
        assert.equal(cyOf(item.idx), center, '源 ' + src + ' 直连起点与节点右框垂直居中一致')
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
  const yOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return Number(match[2])
  }
  await act(async () => { await setDsl(makeDsl('a')) })
  assert.ok(yOf('a') < yOf('b'), 'entry=a 时 A 排在 B 上方')
  await act(async () => { await setDsl(makeDsl('b')) })
  assert.ok(yOf('b') < yOf('a'), 'entry 改为 b 后 B 排在 A 上方')
})

test('自环边：布局不进入死循环，终点仍在节点左边框垂直居中', async () => {
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
  const endYOf = (d) => Number(d.trim().split(/[\s,]+/).pop())
  const aG = container.querySelector('g[data-node-id="a"]')
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(aG.getAttribute('transform'))
  const aCenterY = Number(m[2]) + Number(aG.querySelector('rect').getAttribute('height')) / 2
  assert.equal(endYOf(paths[1].getAttribute('d')), aCenterY, '自环边终点仍在节点左边框垂直居中')
})

test('编辑器关闭：未保存草稿使用统一样式确认弹窗', async () => {
  // 用全新渲染隔离前序测试留下的编辑器状态
  const fresh = document.createElement('div')
  document.body.appendChild(fresh)
  const freshRoot = createRoot(fresh)
  await act(async () => {
    freshRoot.render(React.createElement(Page))
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
  assert.ok(byText(fresh, '我再想想'), '存在「我再想想」按钮')
  assert.ok(byText(fresh, '不改了'), '存在「不改了」按钮')
  const maskRect = confirmMask.getBoundingClientRect ? confirmMask.getBoundingClientRect() : null
  if (maskRect && maskRect.width) {
    // jsdom 无法布局时跳过位置断言；真实 Chromium 证据另在 docs 中采集
    assert.ok(Math.abs((maskRect.top + maskRect.height / 2) - (window.innerHeight / 2)) < 2, '确认弹窗纵向居中')
    assert.ok(Math.abs((maskRect.left + maskRect.width / 2) - (window.innerWidth / 2)) < 2, '确认弹窗横向居中')
  }
  await act(async () => {
    byText(fresh, '我再想想').click()
    await flush()
  })
  assert.ok(fresh.querySelector('dialog.vwf-editor-dialog'), '点击我再想想后编辑器仍打开')
  assert.ok(!fresh.querySelector('.vwf-confirm-mask'), '我再想想关闭确认弹窗')
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
  // 再次取消 → 点击「不改了」关闭
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
    byText(fresh, '不改了').click()
    await flush()
  })
  assert.equal(fresh.querySelector('dialog.vwf-editor-dialog'), null, '点击不改了后编辑器关闭')
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
  })
  // 打开编辑器（画布右上角「角色库」常驻区含 管理角色/新增角色）
  await act(async () => {
    const editBtn = byText(fresh, '编辑')
    assert.ok(editBtn, '存在编辑按钮')
    editBtn.click()
    await flush()
  })
  const roleZone = fresh.querySelector('.vwf-role-zone')
  assert.ok(roleZone, '画布工具栏渲染角色库常驻区')
  assert.ok(byText(roleZone, '角色库'), '角色库区域有可感知标识')
  const zoneBtns = Array.from(roleZone.querySelectorAll('button')).map((b) => b.textContent)
  assert.ok(zoneBtns.some(s => s.includes('管理角色')), '管理角色入口常驻')
  assert.ok(zoneBtns.some(s => s.includes('新增角色')), '新增角色入口常驻（不随自定义角色数量消失）')
  // 常驻区「新增角色」直达创建表单（不依赖分区列表中的按钮）
  await act(async () => {
    Array.from(roleZone.querySelectorAll('button')).find(b => b.textContent.includes('新增角色')).click()
    await flush()
  })
  const createMgr = fresh.querySelector('.vwf-role-mgr')
  assert.ok(createMgr, '新增角色打开创建表单')
  assert.ok(createMgr.querySelector('input.vwf-input'), '创建表单提供名称输入')
  assert.ok(byText(createMgr, '保存角色'), '创建表单提供保存')
  await act(async () => {
    Array.from(createMgr.querySelectorAll('button')).find(b => b.textContent === '关闭').click()
    await flush()
  })
  assert.ok(!fresh.querySelector('.vwf-role-mgr'), '关闭后创建浮层消失')
  // 节点配置不再提供角色管理/新增入口（仅保留角色下拉分组）
  await act(async () => {
    fresh.querySelector('.vwf-node-card').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const inspector = fresh.querySelector('.vwf-inspector')
  assert.ok(inspector, '选中节点后显示节点配置')
  const inspectorBtns = Array.from(inspector.querySelectorAll('button')).map((b) => b.textContent)
  assert.ok(!inspectorBtns.some(s => s.includes('管理角色')), '节点配置不提供管理角色入口')
  assert.ok(!inspectorBtns.some(s => s.includes('新增角色')), '节点配置不提供新增角色入口')
  // 打开角色管理：内置/自定义分区
  await act(async () => {
    Array.from(roleZone.querySelectorAll('button')).find(b => b.textContent.includes('管理角色')).click()
    await flush()
  })
  const mgr = fresh.querySelector('.vwf-role-mgr')
  assert.ok(mgr, '角色管理浮层打开')
  assert.ok(byText(mgr, '内置角色'), '内置角色分区渲染')
  assert.ok(byText(mgr, '自定义角色'), '自定义角色分区渲染')
  assert.ok(byText(mgr, '需求分析师'), '自定义角色列出')
  const viewBtns = Array.from(mgr.querySelectorAll('button')).filter(b => b.textContent === '查看')
  assert.ok(viewBtns.length >= 1, '内置角色提供查看入口')
  const editBtns = Array.from(mgr.querySelectorAll('button')).filter(b => b.textContent === '编辑')
  // issue-81 后自定义角色为 dispatcher + 需求分析师两个；内置仅剩 dev，不提供编辑入口
  assert.ok(editBtns.length === 2, '内置角色不提供编辑入口（仅自定义）')
  // 查看内置角色：只读 + 基于此角色创建
  await act(async () => {
    viewBtns[0].click()
    await flush()
  })
  assert.ok(byText(mgr, '开发角色正文'), '查看内置角色完整配置')
  const createFromBtn = byText(mgr, '基于此角色创建自定义角色')
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
  // 关闭角色管理：角色选择器随角色库刷新（分区 optgroup + 自定义项）
  await act(async () => {
    const close = Array.from(mgr.querySelectorAll('button')).find(b => b.textContent === '关闭')
    close.click()
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
  })
  await act(async () => {
    const editBtn = byText(fresh, '编辑')
    assert.ok(editBtn, '存在编辑按钮')
    editBtn.click()
    await flush()
  })
  const roleZone = fresh.querySelector('.vwf-role-zone')
  await act(async () => {
    Array.from(roleZone.querySelectorAll('button')).find(b => b.textContent.includes('管理角色')).click()
    await flush()
  })
  const mgr = fresh.querySelector('.vwf-role-mgr')
  // 自定义行提供「基于此创建」
  const row = Array.from(mgr.querySelectorAll('.vwf-role-row')).find(r => byText(r, '需求分析师'))
  const cloneBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '基于此创建')
  assert.ok(cloneBtn, '自定义角色行提供基于此创建')
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
  })
  await act(async () => { byText(fresh, '编辑').click(); await flush() })
  const roleZone = fresh.querySelector('.vwf-role-zone')
  await act(async () => {
    Array.from(roleZone.querySelectorAll('button')).find(b => b.textContent.includes('管理角色')).click()
    await flush()
  })
  const mgr = fresh.querySelector('.vwf-role-mgr')
  await act(async () => { byText(mgr, '新增角色').click(); await flush() })
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
  })
  await act(async () => { byText(fresh, '编辑').click(); await flush() })
  const roleZone = fresh.querySelector('.vwf-role-zone')
  await act(async () => {
    Array.from(roleZone.querySelectorAll('button')).find(b => b.textContent.includes('管理角色')).click()
    await flush()
  })
  const mgr = fresh.querySelector('.vwf-role-mgr')
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

test('粘贴蓝图 JSON：模型投影、唯一入口徽标、主链从左到右', async () => {
  const blueprint = {
    id: 'construction-full-feature',
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
  const xOf = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    return Number(match[1])
  }
  assert.ok(xOf('requirements') < xOf('design'), '需求在设计左侧')
  assert.ok(xOf('design') < xOf('dev'), '设计在开发左侧')
  const badges = Array.from(container.querySelectorAll('.vwf-entry-badge-text')).map((el) => {
    const g = el.closest('g[data-node-id]')
    return g && g.getAttribute('data-node-id')
  }).filter(Boolean)
  assert.deepEqual(badges, ['requirements'], '只有需求分析带入口徽标，开发不得并列入口')
  await act(async () => {
    container.querySelector('g[data-node-id="requirements"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const selects = Array.from(container.querySelectorAll('.vwf-inspector select.vwf-select'))
  const values = selects.map((s) => s.value)
  assert.ok(values.includes('kimi-coding'), '节点 provider 从 bindings.models 投影：' + JSON.stringify(values))
  assert.ok(values.includes('k3'), '节点 model 从 bindings.models 投影：' + JSON.stringify(values))
})

test('清理：卸载冒烟测试根节点', async () => {
  await act(async () => {
    root.unmount()
  })
})
