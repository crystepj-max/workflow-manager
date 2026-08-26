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

// ── 组装动态客户端运行环境 ─────────────────────────────────────────────────
function makeRuntime() {
  const state = { failSave: false, saved: [] }
  const rpc = async (method, args) => {
    switch (method) {
      case 'vwf.workflows.list':
        return [{ id: 'wf1', name: '测试流', description: 'seed', builtin: false, dsl: JSON.parse(JSON.stringify(SEED_DSL)) }]
      case 'vwf.models':
        return { providers: [{ id: 'deepseek-official', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }] }
      case 'vwf.roles':
        return { roles: [{ id: 'dispatcher', name: '调度', summary: '调度角色' }, { id: 'dev', name: '开发', summary: '开发角色' }] }
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

test('顶部操作区：按钮独立、提示文字可换行让位', async () => {
  const toolbar = container.querySelector('.vwf-canvas-toolbar')
  assert.ok(toolbar, '顶部操作区渲染')
  const labels = Array.from(toolbar.querySelectorAll('button')).map((el) => el.textContent)
  assert.ok(labels.includes('＋ 新增节点'), '新增节点按钮独立存在')
  assert.ok(labels.includes('删除节点'), '删除节点按钮独立存在')
  assert.ok(toolbar.querySelector('.vwf-toolbar-hint'), '连接提示使用独立可换行区域')
  const css = styleText.join('\n')
  assert.ok(css.includes('.vwf-canvas-toolbar { display:flex;'), '操作区使用 flex 排布')
  assert.ok(css.includes('flex-wrap:wrap'), '窄屏允许操作区换行')
  assert.ok(css.includes('.vwf-canvas-toolbar .vwf-btn { flex:0 0 auto;'), '按钮不压缩不变形')
  assert.ok(css.includes('.vwf-toolbar-hint { flex:1 1 240px;'), '提示文字占用剩余空间并让位')
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
    // 拖到 $end 节点位置（rank=1；node-2 加入后 $end 纵向居中于 y≈144..188 → 用 clientY 200）
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

test('编辑器关闭：未保存草稿需要确认', async () => {
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
  // 拒绝关闭 → 询问后保留草稿
  let confirmCalls = 0
  dom.window.confirm = () => { confirmCalls += 1; return false }
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
    assert.equal(confirmCalls, 1, 'Escape 关闭前询问放弃改动')
    assert.ok(fresh.querySelector('dialog.vwf-editor-dialog'), '拒绝后编辑器仍打开')
  })
  // 接受关闭 → 询问后关闭
  dom.window.confirm = () => { confirmCalls += 1; return true }
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
    assert.equal(confirmCalls, 2, '接受关闭前再次询问放弃改动')
    assert.equal(fresh.querySelector('dialog.vwf-editor-dialog'), null, '接受后编辑器关闭')
  })
  // 干净状态（无未保存改动）直接关闭，不询问
  let cleanConfirmCalls = 0
  dom.window.confirm = () => { cleanConfirmCalls += 1; return false }
  await act(async () => {
    byText(fresh, '编辑').click()
    await flush()
    assert.ok(fresh.querySelector('dialog.vwf-editor-dialog'), '重新打开编辑器（干净状态）')
  })
  await act(async () => {
    fresh.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
    assert.equal(cleanConfirmCalls, 0, '无未保存改动不询问')
    assert.equal(fresh.querySelector('dialog.vwf-editor-dialog'), null, '干净编辑器直接关闭')
  })
  await act(async () => {
    freshRoot.unmount()
    fresh.remove()
  })
})

test('清理：卸载冒烟测试根节点', async () => {
  await act(async () => {
    root.unmount()
  })
})
