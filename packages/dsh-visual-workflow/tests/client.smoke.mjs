// client.js jsdom 冒烟测试：
// 模板列表 → 打开大抽屉编辑器 → 新增/删除节点 → 拖拽连线 → 边/节点配置面板
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
      default:
        throw new Error('unexpected rpc: ' + method)
    }
  }
  const styles = { insert: () => () => {} }
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
    timeout: () => () => {},
    interval: () => () => {},
  }
  const harnessTrap = {}
  const closure = new Function('React', 'console', 'styles', 'host', 'harness', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'require', 'process', 'Buffer', src)
  const plugin = closure(React, console, styles, host, harnessTrap, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, undefined, undefined)
  return { plugin, slotsFake, state }
}

const { plugin, slotsFake, state } = makeRuntime()
plugin.apply({ get: (n) => (n === 'slots' ? slotsFake : undefined), timeout: () => () => {}, interval: () => () => {} })

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
const root = createRoot(container)

test('模板列表渲染并打开大抽屉编辑器', async () => {
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
  assert.ok(byText(container, '工作流编辑器'), '抽屉打开，编辑器标题渲染')
  assert.ok(byText(container, '配置面板'), '配置面板渲染')
  assert.ok(byText(container, '节点配置'), '默认选中首节点，节点表单渲染')
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

test('点击边：边配置面板出现', async () => {
  await act(async () => {
    const hit = container.querySelector('.vwf-edge-hit')
    assert.ok(hit, '存在边命中路径')
    hit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.ok(byText(container, '边配置'), '边配置面板渲染')
  assert.ok(byText(container, '删除边'), '边面板含删除按钮')
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
  await act(async () => {
    root.unmount()
  })
})
