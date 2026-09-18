// FEAT-84 · 编排台工作流模板编辑器（画布独立滚动 / 业务路由 / 撤销历史）
//
// 覆盖规格 §15 验收条件中可在仓库内自动验证的部分：
//   V-1 两层表面与关闭后位置保留（列表 / 筛选）；V-2 三段独立滚动；
//   V-3 业务文案渐进披露（技术词只在高级层）；V-4 多结果路由与连接清单不漏边；
//   V-5 调用重试 / 业务回环 / 返工轮次三类不同标签与说明；V-7 内置模板结构只读；
//   V-8 工作区语义 token 与深色兜底成对；V-9 窄屏流程 / 配置切换与 Escape 分层关闭；
//   V-11 节点配置三档 tab（业务词在前，高级设置 / JSON 不切过去不渲染）；
//   V-12 画布自上而下（入口在顶部、流程向下展开，同级并排）；
//   V-13「查看连接」按钮 + 弹窗，分类标识与不漏边要求不变。
// V-6（撤销历史语义）由 client.smoke.mjs 既有用例覆盖；V-10 的真实 DSH 验收不在本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
// 真实内置模板：扇出（并行研究组）+ 汇总 + 三类连接齐备（V-4 要求的第三类模板）
const EXPLORE_DSL = JSON.parse(readFileSync(join(here, '..', '..', '..', 'templates', 'wf-explore.json'), 'utf8'))
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

// 防抖（HISTORY_DEBOUNCE_MS / VALIDATE_DEBOUNCE_MS）在默认桩下不触发，与 client.smoke 同口径
function makeTimeout(fn, delay) {
  if (typeof fn !== 'function') return () => {}
  if (delay === 0) { fn(); return () => {} }
  return () => {}
}

// ── 用例数据 ────────────────────────────────────────────────────────────────
// 多结果 + 业务回环 + 调用重试 + $end：连接清单必须逐条覆盖，分类互斥
const DIAG_DSL = {
  id: 'wf-diag',
  name: '诊断与修复',
  description: '多结果诊断',
  entry: 'check',
  control: { maxRounds: 3 },
  nodes: [
    {
      id: 'check', label: '检查结果', profile: 'tester', goal: '检查实现',
      output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['pass', 'need-fix', 'invalid', 'blocked'] } } }, outcomePath: '$.route' },
    },
    { id: 'fix', label: '修复问题', profile: 'dev', goal: '按检查意见修复', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    { id: 'review', label: '复核结论', profile: 'reviewer', goal: '复核原判断是否成立', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
  ],
  edges: [
    { from: 'check', to: 'fix', outcome: 'need-fix' },
    { from: 'check', to: 'review', outcome: 'invalid' },
    { from: 'check', to: '$end', outcome: 'blocked' },
    { from: 'fix', to: 'check', outcome: 'RETRY_CHECK', countRound: true },
    { from: 'check', to: 'check', on: 'technical' },
    { from: 'fix', to: 'review', on: 'success' },
  ],
}

const PLAIN_DSL = {
  id: 'wf1', name: '测试流', description: 'seed', entry: 'node-1',
  control: { maxRounds: 9 },
  nodes: [
    { id: 'node-1', profile: 'dispatcher', label: '节点1', goal: 'g' },
    { id: 'node-2', profile: 'dev', label: '节点2', goal: 'g2' },
  ],
  edges: [{ from: 'node-1', to: 'node-2', on: 'success' }],
}

const BUILTIN_DSL = {
  id: 'wf-builtin', name: '内置流程', description: '内置模板', entry: 'b1',
  control: { maxRounds: 3 },
  nodes: [
    { id: 'b1', profile: 'dispatcher', label: '内置步骤一', goal: 'g' },
    { id: 'b2', profile: 'dev', label: '内置步骤二', goal: 'g2' },
  ],
  edges: [{ from: 'b1', to: 'b2', on: 'success' }],
}

const ROLES = [
  { id: 'dispatcher', name: '调度', summary: '分发', builtin: true },
  { id: 'dev', name: '开发', summary: '实现', builtin: true },
  { id: 'tester', name: '测试', summary: '检查', builtin: true },
  { id: 'reviewer', name: '审核', summary: '复核', builtin: true },
]

// ── 运行环境（与真实插件同形的动态客户端装配）──────────────────────────────
function makeRuntime(opts) {
  const options = opts || {}
  const state = { saved: [], overrides: {}, overrideCalls: [], list: options.list || [{ id: 'wf1', name: '测试流', description: 'seed', builtin: false, dsl: JSON.parse(JSON.stringify(options.dsl || PLAIN_DSL)) }] }
  const rpc = async (method, args) => {
    switch (method) {
      case 'vwf.workflows.list':
        return state.list.map((w) => ({ id: w.id, name: w.name, description: w.description, builtin: !!w.builtin, dsl: w.dsl }))
      case 'vwf.models':
        return { providers: [{ id: 'deepseek-official', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }] }
      case 'vwf.roles':
        return { roles: ROLES }
      case 'vwf.validate':
        // options.validateErrors 用于构造校验失败：错误按节点回填 fieldErrors（与真实内核同口径）
        if (options.validateErrors) {
          return { ok: false, errors: options.validateErrors, fieldErrors: options.fieldErrors || {}, sanitized: args.dsl }
        }
        return { ok: true, errors: [], fieldErrors: {}, sanitized: args.dsl }
      case 'vwf.workflows.save':
        state.saved.push(JSON.parse(JSON.stringify(args.dsl)))
        return { ok: true, id: args.dsl.id, dsl: args.dsl }
      case 'vwf.workflows.modelOverride.get':
        return { ok: true, overrides: JSON.parse(JSON.stringify(state.overrides || {})) }
      case 'vwf.workflows.modelOverride.save':
        state.overrides = JSON.parse(JSON.stringify(args.overrides || {}))
        state.overrideCalls = (state.overrideCalls || []).concat([{ op: 'save', overrides: state.overrides }])
        return { ok: true }
      case 'vwf.workflows.modelOverride.clear':
        state.overrides = {}
        state.overrideCalls = (state.overrideCalls || []).concat([{ op: 'clear' }])
        return { ok: true }
      case 'vwf.i18n':
        return { locale: 'zh', messages: JSON.parse(readFileSync(join(here, '..', 'locales', 'zh.json'), 'utf8')) }
      default:
        throw new Error('unexpected rpc: ' + method)
    }
  }
  const styleText = []
  const styles = { insert: (css) => { styleText.push(css); return () => {} } }
  const host = { call: (m, a = null) => rpc(m, a) }
  const slotsFake = {
    inject: (name, fn) => { const r = fn(); if (r && r.__register) return },
    register: (o, Component) => { slotsFake.component = Component; return { __register: true } },
  }
  const ctxFake = { get: (n) => (n === 'slots' ? slotsFake : undefined), timeout: makeTimeout, interval: () => () => {} }
  const closure = new Function(
    'React', 'console', 'styles', 'host', 'harness', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'fetch', 'require', 'process', 'Buffer', src,
  )
  const plugin = closure(React, console, styles, host, {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, undefined, undefined)
  plugin.apply(ctxFake)
  return { Page: slotsFake.component, state, styleText }
}

async function mountPage(opts) {
  const rt = makeRuntime(opts)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(rt.Page))
    await flush(); await flush(); await flush()
  })
  return { container, root, state: rt.state, styleText: rt.styleText }
}

function byText(root, text) {
  return Array.from(root.querySelectorAll('*')).find((el) => el.children.length === 0 && (el.textContent || '').includes(text))
}

async function openEditor(container, label) {
  await act(async () => {
    const btn = byText(container, label || '编辑') || byText(container, '查看并验收')
    assert.ok(btn, '存在打开大工作区的入口')
    btn.click()
    await flush(); await flush()
  })
  const dialog = container.querySelector('dialog.vwf-editor-dialog')
  assert.ok(dialog, '大工作区已打开')
  return dialog
}

// 配置栏三档 tab（V-11）：档位按钮自身携带选中态，未选中的档不渲染内容
function tabOf(root, key) {
  return root.querySelector('.vwf-wb-tab[data-vwf-tab="' + key + '"]')
}

function activeTabOf(root) {
  const el = root.querySelector('.vwf-wb-tab.on')
  return el ? el.getAttribute('data-vwf-tab') : null
}

async function openTab(root, key) {
  const tab = tabOf(root, key)
  assert.ok(tab, '存在配置档：' + key)
  if (tab.getAttribute('aria-selected') !== 'true') {
    await act(async () => { tab.click(); await flush() })
  }
  return tab
}

// 连接信息（V-13）：常驻清单改为「查看连接」按钮 + 弹窗
async function openConnections(container) {
  await act(async () => {
    const btn = container.querySelector('.vwf-conn-open')
    assert.ok(btn, '存在「查看连接」按钮')
    btn.click()
    await flush()
  })
  const dialog = container.querySelector('.vwf-conn-dialog')
  assert.ok(dialog, '连接弹窗已打开')
  return dialog
}

function editorOf(container) {
  return container.querySelector('.vwf-editor')
}

// 源码样式带缩进与空格；断言前统一成紧凑口径（保留后代选择器空格与 @media 名称）
function compactCss(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .replace(/;}/g, '}')
}

// ═══════════════════════════════════════════════════════════════════════════
// V-2 三段结构与独立滚动
// ═══════════════════════════════════════════════════════════════════════════
test('V-2 三段结构：步骤定位 / 画布 / 配置栏三个独立滚动区，外层不再承担页面级滚动', async () => {
  const { container, styleText } = await mountPage()
  await openEditor(container)

  const editor = editorOf(container)
  assert.ok(editor, '存在工作区网格')
  // 三个直接网格项各占一个 grid-area —— 各自滚动互不带动
  assert.ok(editor.querySelector('.vwf-nav-col'), '左侧步骤定位区存在')
  assert.ok(editor.querySelector('.vwf-canvas-col'), '中间路线画布存在')
  assert.ok(editor.querySelector('.vwf-inspector'), '右侧节点配置栏存在')
  const areas = Array.from(editor.children).map((el) => el.className)
  assert.equal(areas.length, 3, '工作区只有三个直接子项：' + JSON.stringify(areas))

  const css = compactCss(styleText.join('\n'))
  // 外层容器只负责裁剪，不再滚动（改造前是 overflow:auto 的共享滚动源）
  assert.match(css, /\.vwf-editor-body\{[^}]*overflow:hidden/, '外层 .vwf-editor-body 不再滚动')
  assert.doesNotMatch(css, /\.vwf-editor-body\{[^}]*overflow:auto/, '外层不得保留 overflow:auto')
  // 网格项各自滚动；连接信息走弹窗，自身滚动（V-13）
  assert.match(css, /\.vwf-inspector\{grid-area:config[^}]*overflow:auto/, '配置栏自身滚动')
  assert.match(css, /\.vwf-wb-steps-body,\.vwf-wb-conn-body\{[^}]*overflow:auto/, '步骤定位与连接弹窗清单各自滚动')
  assert.match(css, /\.vwf-editor\{position:absolute[^}]*grid-template-areas:"nav canvas config"/, '三段各占一个网格区')
  // 画布在工作区内由网格行定高：不得再用固定 min-height 撑高（改造前 min-height:360px）
  assert.match(css, /\.vwf-editor \.vwf-canvas-wrap\{flex:1;min-height:0/, '工作区画布 min-height:0 随网格收缩')
  assert.doesNotMatch(css, /\.vwf-editor \.vwf-canvas-wrap\{[^}]*min-height:360px/, '不再用固定 min-height 撑高画布')
  // 网格列可收缩，避免窄容器里横向溢出
  assert.match(css, /grid-template-columns:minmax\(0,224px\) minmax\(0,1fr\) minmax\(0,368px\)/, '三段列宽均可收缩')
})

test('V-2 配置栏内容长于可视高度时，画布仍是独立滚动区（不共用同一滚动容器）', async () => {
  const { container } = await mountPage()
  await openEditor(container)
  const inspector = container.querySelector('.vwf-inspector')
  const canvasWrap = container.querySelector('.vwf-canvas-wrap')
  const body = container.querySelector('.vwf-editor-body')
  assert.ok(inspector && canvasWrap && body, '三个容器都在')
  // 三者互不为滚动祖先：配置栏与画布是同一网格的直接子项，任一滚动都不带动另一个
  assert.ok(!inspector.contains(canvasWrap), '配置栏不得包含画布')
  assert.ok(!canvasWrap.contains(inspector), '画布不得包含配置栏')
  assert.ok(body.contains(inspector) && body.contains(canvasWrap), '两者都在工作区外层之内')
  assert.ok(inspector.parentElement.classList.contains('vwf-editor'), '配置栏是工作区网格的直接子项')
  assert.ok(canvasWrap.closest('.vwf-editor') === inspector.parentElement, '画布与配置栏属于同一个工作区网格')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-3 业务文案与渐进披露
// ═══════════════════════════════════════════════════════════════════════════
test('V-11 配置栏三档 tab：默认停在业务词档，节点 ID / JSON 结构不切过去就不渲染', async () => {
  const { container } = await mountPage({ dsl: DIAG_DSL, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(DIAG_DSL)) }] })
  await openEditor(container)

  const bar = container.querySelector('.vwf-wb-tabbar')
  assert.ok(bar, '存在档位条')
  const tabs = Array.from(container.querySelectorAll('.vwf-wb-tab'))
  assert.equal(tabs.length, 3, '三个配置档：' + JSON.stringify(tabs.map((el) => el.textContent)))
  assert.deepEqual(tabs.map((el) => el.getAttribute('data-vwf-tab')), ['basic', 'outcome', 'advanced'])
  assert.equal(activeTabOf(container), 'basic', '默认停在第一档（业务词）')
  assert.equal(bar.getAttribute('role'), 'tablist', '档位条语义为 tablist')
  assert.equal(tabs[0].getAttribute('role'), 'tab', '档位按钮语义为 tab')
  assert.ok(container.querySelector('.vwf-wb-tabpanel'), '内容落在 tabpanel 内')

  // 第一档：业务词齐备
  assert.ok(byText(container, '步骤名称'), '第一档有「步骤名称」')
  assert.ok(byText(container, '任务（这一步要做什么）'), '第一档有「任务」')
  assert.ok(byText(container, '负责角色'), '第一档有「负责角色」')
  assert.ok(byText(container, '交付内容（这一步产出什么）'), '第一档有「交付内容」')

  // 未切到第三档前，技术词不得出现（字段名 / JSON 只出现在高级档）
  const beforeText = container.querySelector('.vwf-inspector').textContent
  assert.ok(beforeText.indexOf('节点 ID') < 0, '未切到高级档时不应出现「节点 ID」')
  assert.ok(!container.querySelector('.vwf-inspector textarea.vwf-mono'), '未切到高级档时不应出现 JSON 结构编辑区')

  // 未选中的档位：档名常驻可见（可再次切回），但内容不渲染
  for (const key of ['outcome', 'advanced']) {
    assert.ok(tabOf(container, key).textContent.length > 0, '未选中的档位仍以档名可见：' + key)
    assert.equal(tabOf(container, key).getAttribute('aria-selected'), 'false', '未选中的档位不处于选中态：' + key)
  }
  const beforePanel = container.querySelector('.vwf-wb-tabpanel').textContent
  assert.ok(beforePanel.indexOf('怎么判定做完') < 0, '未选中的档位内容不渲染（不是靠 CSS 隐藏）')

  await openTab(container, 'advanced')
  const afterText = container.querySelector('.vwf-inspector').textContent
  assert.equal(activeTabOf(container), 'advanced', '已切到高级档')
  assert.ok(afterText.indexOf('节点 ID') >= 0, '切到高级档后出现「节点 ID」')
  assert.ok(container.querySelector('.vwf-inspector textarea.vwf-mono'), '切到高级档后出现 JSON 结构编辑区')
  assert.ok(afterText.indexOf('默认 / 覆盖 / 还原') >= 0, '高级档说明模型默认 / 覆盖 / 还原只对内置模板有效')
})

test('V-11 校验错误落在未选中档时档位标出并自动切过去（错误不被藏起来）', async () => {
  const dsl = JSON.parse(JSON.stringify(DIAG_DSL))
  // 让内核返回「高级档字段」的错误：model.provider 只出现在高级档
  const { container } = await mountPage({
    dsl, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl }],
    validateErrors: [{ nodeId: 'fix', message: 'fix 缺少 AI 服务' }],
    fieldErrors: { 'node:fix:model.provider': ['必填'] },
  })
  await openEditor(container)
  assert.equal(activeTabOf(container), 'basic', '默认停在业务档')
  // 触发一次保存 → 校验失败弹窗
  await act(async () => {
    byText(container, '保存工作流').click()
    await flush(); await flush()
  })
  assert.ok(container.querySelector('.vwf-dialog-mask'), '校验失败弹出问题清单')
  // 关闭弹窗 → 逐字段错误回填（选中节点被切到出错节点 fix）
  await act(async () => {
    byText(container, '查看并修正').click()
    await flush(); await flush()
  })
  const marked = Array.from(container.querySelectorAll('.vwf-wb-tab-err')).map((el) => el.closest('.vwf-wb-tab').getAttribute('data-vwf-tab'))
  assert.deepEqual(marked, ['advanced'], '⚠ 只标在真正出错的档位上：' + JSON.stringify(marked))
  assert.equal(activeTabOf(container), 'advanced', '错误出现后自动切到出错的档位（不出现保存被拦却看不到字段的死角）')
  assert.ok(container.querySelector('.vwf-wb-tabpanel .vwf-select'), '出错档位的内容可直接修改')
  // 用户手动切回业务档后，错误档位的标记仍在（不会因为切走就丢）
  await openTab(container, 'basic')
  assert.equal(activeTabOf(container), 'basic', '可手动切回业务档')
  assert.equal(container.querySelectorAll('.vwf-wb-tab-err').length, 1, '切走后错误标记仍在')
})

test('V-3 业务结果取值可直接完成配置，不必切到高级档', async () => {
  const { container } = await mountPage({ dsl: DIAG_DSL, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(DIAG_DSL)) }] })
  await openEditor(container)
  // 检查节点默认选中（入口节点）
  await openTab(container, 'outcome')
  const inspector = container.querySelector('.vwf-inspector')
  const outcomes = Array.from(inspector.querySelectorAll('.vwf-wb-outcome-row'))
  assert.ok(outcomes.length >= 3, '结果与去向档直接列出该步骤的各条去向：' + outcomes.length)
  // 业务结果行内直接写出取值与去向，不需要读 JSON
  const text = inspector.textContent
  assert.ok(text.indexOf('need-fix') >= 0, '业务结果取值可见')
  assert.ok(text.indexOf('修复问题') >= 0, '业务结果的去向以步骤名呈现')
  assert.equal(activeTabOf(container), 'outcome', '全程停在业务档位')
  assert.ok(text.indexOf('节点 ID') < 0, '业务档内不出现技术字段名')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-4 多结果路由与连接清单不漏边
// ═══════════════════════════════════════════════════════════════════════════
test('V-13 查看连接弹窗逐条覆盖模板定义的全部连接（不漏边）', async () => {
  const { container } = await mountPage({ dsl: DIAG_DSL, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(DIAG_DSL)) }] })
  await openEditor(container)
  // 弹窗打开前，连接信息不占画布版面（不再是左下常驻清单）
  assert.equal(container.querySelector('.vwf-wb-conn-body'), null, '未点「查看连接」时不渲染连接清单')
  const dialog = await openConnections(container)
  const rows = dialog.querySelectorAll('.vwf-wb-conn-row')
  assert.equal(rows.length, DIAG_DSL.edges.length, '连接条数 = 模板定义连接数（' + DIAG_DSL.edges.length + '）')
  const all = dialog.querySelector('.vwf-wb-conn-body').textContent
  for (const e of DIAG_DSL.edges) {
    const to = e.to === '$end' ? '结束' : (DIAG_DSL.nodes.find((n) => n.id === e.to) || {}).label
    assert.ok(all.indexOf(to) >= 0, '连接信息覆盖去向：' + to)
  }
  // 按钮上带条数，点一条可定位到画布上的这条连接（弹窗关闭、边配置出现）
  assert.ok(container.querySelector('.vwf-conn-open').textContent.indexOf(String(DIAG_DSL.edges.length)) >= 0, '「查看连接」按钮标出连接数')
  await act(async () => {
    dialog.querySelectorAll('.vwf-wb-conn-row')[0].click()
    await flush()
  })
  assert.equal(container.querySelector('.vwf-conn-dialog'), null, '点选连接后弹窗关闭')
  assert.ok(container.querySelector('.vwf-inspector').textContent.indexOf('边配置') >= 0, '点选连接后进入该连接的配置')
})

test('V-4 已声明但缺少去向的业务结果给出缺项提示，且不删除连接', async () => {
  const dsl = JSON.parse(JSON.stringify(DIAG_DSL))
  // 声明 pass 取值但去掉对应连接：模板定义的其余连接必须原样保留
  dsl.nodes[0].output.schema.properties.route.enum.push('pass')
  const before = dsl.edges.length
  const { container } = await mountPage({ dsl, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl }] })
  await openEditor(container)
  const dialog = await openConnections(container)
  const conn = dialog.querySelector('.vwf-wb-conn-body').textContent
  assert.ok(conn.indexOf('已声明') >= 0 && conn.indexOf('pass') >= 0, '缺项提示列出未接去向的取值')
  assert.equal(dialog.querySelectorAll('.vwf-wb-conn-row').length, before, '缺项不导致任何连接被删除')
})


// ═══════════════════════════════════════════════════════════════════════════
// V-4 扇出后汇总（真实内置模板 wf-explore：并行研究组 + 汇总 + 三类连接）
// ═══════════════════════════════════════════════════════════════════════════
test('V-4 扇出后汇总模板：并行组与汇总可辨认，连接信息不漏边且三类分类正确', async () => {
  const dsl = JSON.parse(JSON.stringify(EXPLORE_DSL))
  const { container } = await mountPage({ dsl, list: [{ id: dsl.id, name: dsl.id, description: '', builtin: true, dsl }] })
  await openEditor(container, '查看并验收')

  // 步骤定位区：扇出节点标「并行组」，其下游汇总节点标「汇总」
  const stepRows = Array.from(container.querySelectorAll('.vwf-wb-step'))
  assert.equal(stepRows.length, dsl.nodes.length, '步骤定位覆盖全部节点')
  const fanoutIds = dsl.nodes.filter((n) => n.kind === 'fanout').map((n) => n.id)
  // 汇总只可能是真实节点：扇出也可以直接以 failure 连到 $end（终止节点，不是汇总页）
  const summaryIds = dsl.edges.filter((e) => fanoutIds.indexOf(e.from) >= 0 && e.to !== '$end').map((e) => e.to)
  assert.ok(fanoutIds.length >= 1, '模板含扇出节点')
  assert.ok(summaryIds.length >= 1, '扇出节点有下游汇总节点')
  for (const id of fanoutIds) {
    const row = stepRows.find((r) => r.getAttribute('data-node-id') === id)
    assert.ok(row && row.textContent.indexOf('并行组') >= 0, '扇出节点标为并行组：' + id)
  }
  for (const id of summaryIds) {
    const row = stepRows.find((r) => r.getAttribute('data-node-id') === id)
    assert.ok(row && row.textContent.indexOf('汇总') >= 0, '扇出下游节点标为汇总：' + id)
  }

  // 连接信息（V-13 弹窗）：条数 = 模板定义连接数（不漏边），三类分类与定义一一对应
  const dialog = await openConnections(container)
  const rows = Array.from(dialog.querySelectorAll('.vwf-wb-conn-row'))
  assert.equal(rows.length, dsl.edges.length, '连接条数 = 模板定义连接数（' + dsl.edges.length + '）')
  const body = dialog.querySelector('.vwf-wb-conn-body').textContent
  const countOf = (label) => { const seg = body.split(label + '（')[1]; return seg ? Number(seg.split('）')[0]) : -1 }
  const expectRetry = dsl.edges.filter((e) => e.on === 'technical').length
  const expectLoop = dsl.edges.filter((e) => e.on !== 'technical' && e.countRound === true).length
  assert.equal(countOf('调用重试'), expectRetry, '调用重试条数（技术自环）')
  assert.equal(countOf('业务回环'), expectLoop, '业务回环条数（计入打回轮次）')
  assert.equal(countOf('普通业务路由'), dsl.edges.length - expectRetry - expectLoop, '普通业务路由条数')
  // 每条连接的源与目标都在清单里出现（逐条核对，不是只数总数）
  const labelOf = (id) => id === '$end' ? '结束' : ((dsl.nodes.find((n) => n.id === id) || {}).label || id)
  for (const e of dsl.edges) {
    assert.ok(body.indexOf(labelOf(e.from) + ' → ' + labelOf(e.to)) >= 0, '清单含该连接：' + labelOf(e.from) + ' → ' + labelOf(e.to))
  }

  // 扇出的汇总语义写在业务侧：部分子任务未完成时汇总保持等待（在「结果与去向」档内）
  const fanoutId = fanoutIds[0]
  await act(async () => {
    container.querySelector('g[data-node-id="' + fanoutId + '"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  await openTab(container, 'outcome')
  const inspector = container.querySelector('.vwf-inspector')
  assert.ok(inspector.textContent.indexOf('并行研究组') >= 0, '扇出节点显示并行研究组说明')
  assert.ok(inspector.textContent.indexOf('每个子任务各自交自己的报告') >= 0, '说明子任务各自报告')
  assert.ok(inspector.textContent.indexOf('汇总') >= 0 && inspector.textContent.indexOf('保持等待') >= 0, '说明未完成时汇总保持等待')
  assert.ok(inspector.textContent.indexOf('不会显示为已完成') >= 0, '明确不冒充完成')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-5 三类连接标签与说明
// ═══════════════════════════════════════════════════════════════════════════
test('V-5 调用重试 / 业务回环 / 普通业务路由使用不同标签与说明，返工轮次单独表述', async () => {
  const { container } = await mountPage({ dsl: DIAG_DSL, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(DIAG_DSL)) }] })
  await openEditor(container)
  const dialog = await openConnections(container)
  const body = dialog.querySelector('.vwf-wb-conn-body')

  // 三类分组标签与说明同时存在
  for (const label of ['普通业务路由', '业务回环', '调用重试']) {
    assert.ok(body.textContent.indexOf(label) >= 0, '存在分类标签：' + label)
  }
  assert.ok(body.textContent.indexOf('不消耗返工轮次') >= 0, '调用重试说明与返工轮次区分')
  assert.ok(body.textContent.indexOf('计入返工轮次') >= 0, '业务回环说明与调用重试区分')
  assert.ok(body.textContent.indexOf('返工轮次：') >= 0, '返工轮次作为独立概念单独说明')

  // 分类与边一一对应：technical→调用重试；countRound→业务回环；其余→普通业务路由
  const groups = Array.from(body.querySelectorAll('.vwf-wb-conn-group')).map((el) => el.textContent)
  assert.equal(groups.length, 3, '三类分组都在：' + JSON.stringify(groups))
  const countOf = (label) => {
    const seg = body.textContent.split(label + '（')[1]
    return seg ? Number(seg.split('）')[0]) : -1
  }
  // 普通业务路由 = 全部 6 条中除去 1 条回环（fix→check countRound）与 1 条调用重试（check 技术自环）
  assert.equal(countOf('普通业务路由'), 4, '普通业务路由 4 条')
  assert.equal(countOf('业务回环'), 1, '业务回环 1 条（countRound）')
  assert.equal(countOf('调用重试'), 1, '调用重试 1 条（technical 自环）')
})

test('V-5 回环与调用重试在边配置中使用不同标签', async () => {
  const { container } = await mountPage({ dsl: DIAG_DSL, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(DIAG_DSL)) }] })
  await openEditor(container)
  // 选中回环边（fix → check，countRound）：从连接弹窗里点选
  const dialog = await openConnections(container)
  await act(async () => {
    const rows = dialog.querySelectorAll('.vwf-wb-conn-row')
    const loopRow = Array.from(rows).find((r) => r.textContent.indexOf('业务回环') >= 0)
    assert.ok(loopRow, '找到回环连接行')
    loopRow.click()
    await flush()
  })
  const inspectorText = container.querySelector('.vwf-inspector').textContent
  assert.ok(inspectorText.indexOf('计入打回轮次') >= 0, '回环边带打回轮次标记（与调用重试不同）')
  const options = Array.from(container.querySelectorAll('.vwf-inspector select option')).map((o) => o.textContent)
  assert.ok(options.includes('技术重试（自环）'), '边类型里技术重试是独立选项')
  assert.ok(options.includes('业务 outcome'), '业务 outcome 与技术重试分开')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-7 内置模板结构只读
// ═══════════════════════════════════════════════════════════════════════════
test('V-7 内置模板：结构控件不可用并给出只读说明，另存为仍可用', async () => {
  const { container } = await mountPage({ dsl: BUILTIN_DSL, list: [{ id: 'wf-builtin', name: '内置流程', description: '', builtin: true, dsl: JSON.parse(JSON.stringify(BUILTIN_DSL)) }] })
  // 内置模板入口文案为「查看并验收」
  await openEditor(container, '查看并验收')

  const dialog = container.querySelector('dialog.vwf-editor-dialog')
  assert.ok(dialog.textContent.indexOf('内置模板的步骤与连接只读') >= 0, '工作区给出只读说明')

  // 结构编辑出口不可用（不静默忽略点击）
  const addBtn = byText(container, '新增节点')
  assert.ok(addBtn, '存在新增节点按钮')
  assert.equal(addBtn.closest('button').disabled, true, '内置模板不能新增节点')
  const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
  assert.equal(jsonTab.disabled, true, '内置模板不提供结构 JSON 编辑入口')
  const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存工作流')
  assert.equal(saveBtn.disabled, true, '内置模板不能覆盖保存')
  assert.ok(byText(container, '另存为'), '另存为仍是可用出口')

  // 节点配置档位可见但为只读说明
  assert.ok(container.querySelector('.vwf-inspector .vwf-wb-readonly'), '节点配置给出只读说明')
  const goalInput = container.querySelector('.vwf-inspector textarea.vwf-textarea')
  assert.equal(goalInput.disabled, true, '内置模板节点字段不可编辑')
  await openTab(container, 'advanced')
  assert.equal(activeTabOf(container), 'advanced', '内置模板同样可在三档之间切换查看')
  const kindSelect = container.querySelector('.vwf-wb-tabpanel select')
  assert.equal(kindSelect.disabled, true, '内置模板技术档字段同样不可编辑')

  // 模型默认 / 覆盖入口不在自定义模板口径里扩展：流程库行内入口保持存在
  assert.ok(container.textContent.indexOf('模型覆盖') >= 0, '内置模板保留流程库「模型覆盖」入口')
})

test('V-7 自定义模板无模型默认 / 覆盖入口，节点结构可编辑', async () => {
  const { container } = await mountPage()
  await openEditor(container, '编辑')
  const addBtn = byText(container, '新增节点')
  assert.equal(addBtn.closest('button').disabled, false, '自定义模板可新增节点')
  const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存工作流')
  assert.equal(saveBtn.disabled, false, '自定义模板可保存')
  assert.ok(!container.querySelector('.vwf-inspector .vwf-wb-readonly'), '自定义模板无只读说明')
  assert.ok(container.textContent.indexOf('模型覆盖') < 0, '自定义模板不出现模型覆盖入口')
})


// ═══════════════════════════════════════════════════════════════════════════
// V-7 兼容检查项：内置节点的供应商 / 模型默认 → 覆盖 → 单节点还原 → 全部还原
// ═══════════════════════════════════════════════════════════════════════════
test('V-7 内置模板模型设置兼容：默认 / 覆盖 / 单节点还原 / 全部还原四步可走通', async () => {
  const { container, state } = await mountPage({ dsl: BUILTIN_DSL, list: [{ id: 'wf-builtin', name: '内置流程', description: '', builtin: true, dsl: JSON.parse(JSON.stringify(BUILTIN_DSL)) }] })
  // 流程库行内的「模型覆盖」是既有入口，本任务不重新设计它
  await act(async () => {
    byText(container, '模型覆盖').click()
    await flush(); await flush()
  })
  const ovDialog = Array.from(container.querySelectorAll('dialog.vwf-editor-dialog')).find((d) => d.textContent.indexOf('模型覆盖') >= 0)
  assert.ok(ovDialog, '模型覆盖对话框已打开')

  // ① 默认：未覆盖时每个节点显示「默认」徽标
  const rows = () => Array.from(ovDialog.querySelectorAll('.vwf-list-item'))
  assert.equal(rows().length, BUILTIN_DSL.nodes.length, '逐节点列出模型设置')
  for (const r of rows()) assert.ok(r.textContent.indexOf('默认') >= 0, '未覆盖时显示默认徽标')

  // ② 覆盖：给两个节点各写 provider/model 并保存（两个节点才能验证「单节点还原只清一个」）
  const setRowOverride = async (rowIndex) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
      const selects = Array.from(rows()[rowIndex].querySelectorAll('select'))
      assert.equal(selects.length, 2, '每行有 provider / model 两个选择器')
      setter.call(selects[0], 'deepseek-official')
      selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await flush()
      const modelSelects = Array.from(rows()[rowIndex].querySelectorAll('select'))
      setter.call(modelSelects[1], 'deepseek-v4-flash')
      modelSelects[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await flush()
    })
  }
  await setRowOverride(0)
  await setRowOverride(1)
  await act(async () => {
    byText(ovDialog, '保存覆盖').click()
    await flush(); await flush()
  })
  const savedCall = state.overrideCalls.filter((c) => c.op === 'save').pop()
  assert.ok(savedCall, '保存覆盖调用了 vwf.workflows.modelOverride.save')
  assert.equal(savedCall.overrides[BUILTIN_DSL.nodes[0].id].provider, 'deepseek-official', '覆盖写入 provider')
  assert.equal(savedCall.overrides[BUILTIN_DSL.nodes[0].id].model, 'deepseek-v4-flash', '覆盖写入 model')
  assert.ok(savedCall.overrides[BUILTIN_DSL.nodes[1].id], '第二个节点的覆盖一并写入')

  // ③ 单节点还原：该行「还原」使覆盖行消失
  await act(async () => {
    byText(container, '模型覆盖').click()
    await flush(); await flush()
  })
  const ovDialog2 = Array.from(container.querySelectorAll('dialog.vwf-editor-dialog')).find((d) => d.textContent.indexOf('模型覆盖') >= 0)
  const overriddenRow = Array.from(ovDialog2.querySelectorAll('.vwf-list-item')).find((r) => r.textContent.indexOf('已覆盖') >= 0)
  assert.ok(overriddenRow, '覆盖保存后重新打开显示「已覆盖」徽标')
  await act(async () => {
    byText(overriddenRow, '还原').click()
    await flush()
  })
  assert.ok(overriddenRow.textContent.indexOf('默认') >= 0, '单节点还原后回到默认徽标')
  // 还原只改草稿，真正生效要保存；断言必须落在 RPC 载荷上（否则是假绿）
  const savesBefore = state.overrideCalls.filter((c) => c.op === 'save').length
  await act(async () => {
    byText(ovDialog2, '保存覆盖').click()
    await flush(); await flush()
  })
  const savesAfter = state.overrideCalls.filter((c) => c.op === 'save')
  assert.equal(savesAfter.length, savesBefore + 1, '还原后保存覆盖再次落盘')
  const lastSave = savesAfter.pop()
  assert.equal(lastSave.overrides[BUILTIN_DSL.nodes[0].id], undefined, '单节点还原在持久化载荷中已清除该节点覆盖')
  assert.ok(lastSave.overrides[BUILTIN_DSL.nodes[1].id], '单节点还原只清该节点，其他节点的覆盖保留')
  assert.equal(state.overrides[BUILTIN_DSL.nodes[0].id], undefined, '回读持久化层：被还原节点已无覆盖')
  assert.ok(state.overrides[BUILTIN_DSL.nodes[1].id], '回读持久化层：另一节点覆盖仍在')

  // ④ 全部还原：清除该模板的全部覆盖（需二次确认）
  // 上一步「保存覆盖」成功后对话框会关闭，这里重新打开（保存成功即关闭是既有行为）
  await act(async () => {
    byText(container, '模型覆盖').click()
    await flush(); await flush()
  })
  const ovDialog3 = Array.from(container.querySelectorAll('dialog.vwf-editor-dialog')).find((d) => d.textContent.indexOf('模型覆盖') >= 0)
  assert.ok(ovDialog3, '再次打开模型覆盖对话框')
  assert.ok(ovDialog3.textContent.indexOf('已覆盖') >= 0, '保存后重新打开仍显示已覆盖')
  await act(async () => {
    byText(ovDialog3, '清除恢复默认').click()
    await flush()
  })
  const confirm = container.querySelector('.vwf-confirm-mask')
  assert.ok(confirm, '全部还原需要二次确认')
  await act(async () => {
    const doClear = Array.from(confirm.querySelectorAll('button')).find((b) => b.textContent === '清除恢复默认')
    assert.ok(doClear, '确认层给出清除动作')
    doClear.click()
    await flush(); await flush()
  })
  assert.ok(state.overrideCalls.some((c) => c.op === 'clear'), '全部还原调用了 vwf.workflows.modelOverride.clear')
  assert.deepEqual(state.overrides, {}, '回读持久化层：全部还原后该模板已无任何覆盖')

  // 结构只读与模型设置互不影响：模型设置走独立 RPC，未触碰结构保存
  assert.equal(state.saved.length, 0, '模型设置全程没有保存内置模板结构')
})


test('V-7 结构锁：内置模板可选中节点与连接（定位 / 查看），但不能改结构', async () => {
  const { container } = await mountPage({ dsl: BUILTIN_DSL, list: [{ id: 'wf-builtin', name: '内置流程', description: '', builtin: true, dsl: JSON.parse(JSON.stringify(BUILTIN_DSL)) }] })
  await openEditor(container, '查看并验收')

  // 可选中节点：点画布节点后右侧显示该节点详情
  await act(async () => {
    container.querySelector('g[data-node-id="' + BUILTIN_DSL.nodes[1].id + '"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.equal(activeTabOf(container), 'basic', '点节点后进入该节点配置（默认业务档）')
  assert.ok(container.querySelector('.vwf-inspector').textContent.indexOf(BUILTIN_DSL.nodes[1].label) >= 0
    || container.querySelectorAll('.vwf-inspector .vwf-input').length > 0, '右侧为该节点详情')

  // 可选中连接：从连接弹窗点一条后出现边配置
  const connDialog = await openConnections(container)
  await act(async () => {
    const rows = connDialog.querySelectorAll('.vwf-wb-conn-row')
    assert.ok(rows.length >= 1, '连接信息有条目')
    rows[0].click()
    await flush()
  })
  assert.ok(container.querySelector('.vwf-inspector').textContent.indexOf('边配置') >= 0, '点连接后进入边配置')

  // 结构不可改：连线把手不渲染（无把手就无法拖线），右键菜单不可用
  assert.equal(container.querySelectorAll('.vwf-editor-dialog .vwf-handle').length, 0, '内置模板不渲染连线把手')
  assert.equal(container.querySelectorAll('.vwf-editor-dialog .vwf-handle-src').length, 0, '内置模板不渲染连线源把手')
  await act(async () => {
    container.querySelector('.vwf-editor-dialog .vwf-canvas-wrap').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flush()
  })
  assert.equal(container.querySelector('.vwf-editor-dialog .vwf-menu'), null, '内置模板右键不出现结构编辑菜单')
})

test('V-7 编辑器结构锁与运行看板只读画布互不影响', async () => {
  const { container } = await mountPage({ dsl: BUILTIN_DSL, list: [{ id: 'wf-builtin', name: '内置流程', description: '', builtin: true, dsl: JSON.parse(JSON.stringify(BUILTIN_DSL)) }] })
  await openEditor(container, '查看并验收')
  // 编辑器：结构锁（不是 readOnly）——把手不渲染但节点可点
  assert.equal(container.querySelectorAll('.vwf-editor-dialog .vwf-handle').length, 0, '编辑器内无连线把手')
  await act(async () => {
    const closeBtn = byText(container, '关闭')
    closeBtn.click()
    await flush()
  })
  // 运行看板仍走 readOnly：连节点点击都不进入编辑态（本轮不改变看板行为）
  await act(async () => {
    const dashTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '运行看板')
    assert.ok(dashTab, '运行看板 tab 存在')
    dashTab.click()
    await flush()
  })
  assert.equal(container.querySelectorAll('.vwf-editor-dialog').length, 0, '看板不打开编辑器')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-1 两层表面与关闭后位置保留
// ═══════════════════════════════════════════════════════════════════════════
test('V-1 关闭大工作区后回到原列表、筛选词与列表内容保持', async () => {
  const { container } = await mountPage({ list: [
    { id: 'wf1', name: '测试流', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(PLAIN_DSL)) },
    { id: 'wf2', name: '另一条流', description: '', builtin: false, dsl: JSON.parse(JSON.stringify({ ...PLAIN_DSL, id: 'wf2' })) },
  ] })
  // 先施加筛选
  const filter = container.querySelector('input[placeholder^="筛选模板"]')
  assert.ok(filter, '流程库提供筛选入口')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(filter, '另一条')
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  const listNames = () => Array.from(container.querySelectorAll('.vwf-list-item .vwf-list-name')).map((el) => el.textContent)
  assert.deepEqual(listNames(), ['另一条流'], '筛选生效')

  // 列表滚动位置：先滚一段，再开关工作区，断言没有被重置
  const scroller = container.querySelector('.vwf-root') || container
  scroller.scrollTop = 120
  const scrollBefore = scroller.scrollTop
  assert.equal(scrollBefore, 120, 'jsdom 允许设置 scrollTop（真机布局由浏览器承担）')

  await openEditor(container, '编辑')
  assert.ok(container.querySelector('dialog.vwf-editor-dialog'), '大工作区打开时列表仍在页面上（两层表面，不卸载小设置入口）')
  // 无未保存改动 → 直接关闭
  await act(async () => {
    const closeBtn = byText(container, '关闭')
    closeBtn.click()
    await flush()
  })
  assert.equal(container.querySelector('dialog.vwf-editor-dialog'), null, '工作区已关闭')
  const filterAfter = container.querySelector('input[placeholder^="筛选模板"]')
  assert.equal(filterAfter.value, '另一条', '关闭后筛选词保留')
  assert.deepEqual(listNames(), ['另一条流'], '关闭后列表筛选结果保留')
  // 关闭后列表容器仍是同一个 DOM 节点（两层表面不卸载小设置入口），滚动位置因此不被重置
  const scrollerAfter = container.querySelector('.vwf-root') || container
  assert.equal(scrollerAfter, scroller, '关闭后列表容器未被重建')
  assert.equal(scrollerAfter.scrollTop, scrollBefore, '关闭后列表滚动位置保持')
})

test('V-1 未保存改动关闭时给出继续编辑 / 放弃修改 / 保存并返回', async () => {
  const { container, state } = await mountPage()
  await openEditor(container)
  await act(async () => {
    byText(container, '新增节点').click()
    await flush()
  })
  await act(async () => {
    container.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
  })
  const mask = container.querySelector('.vwf-confirm-mask')
  assert.ok(mask, '未保存关闭弹出确认层')
  assert.ok(byText(container, '继续编辑'), '选项一：继续编辑')
  assert.ok(byText(container, '放弃修改'), '选项二：放弃修改')
  assert.ok(byText(container, '保存并返回'), '选项三：保存并返回')

  // 「保存并返回」触发编辑器内的保存流程（校验通过 → 保存并关闭）
  await act(async () => {
    byText(container, '保存并返回').click()
    await flush(); await flush()
  })
  assert.equal(state.saved.length, 1, '保存并返回真的调用了保存')
  assert.equal(container.querySelector('dialog.vwf-editor-dialog'), null, '保存成功后关闭工作区')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-8 主题 token 成对与焦点可见
// ═══════════════════════════════════════════════════════════════════════════
test('V-8 工作区语义 token：浅色兜底与深色兜底成对，正文 / 边界分开取值，焦点样式可见', async () => {
  const { container, styleText } = await mountPage()
  await openEditor(container)
  const css = compactCss(styleText.join('\n'))

  // 浅色兜底：A 编排台浅色板（DESIGN.md 契约）
  assert.match(css, /--vwf-wb-text:var\(--dsw-alias-label-primary,#1D2B43\)/, '浅色正文兜底 = 契约正文色')
  assert.match(css, /--vwf-wb-surface:var\(--dsw-alias-bg-layer-1,#FFFFFF\)/, '浅色表面兜底 = 契约表面色')
  // 深色兜底：prefers-color-scheme 覆盖同一组变量，避免「深色背景 + 深色字」
  assert.match(css, /@media\s*\(prefers-color-scheme:dark\)/, '存在深色兜底')
  assert.match(css, /--vwf-wb-text:var\(--dsw-alias-label-primary,#EDF2FF\)/, '深色正文兜底 = 契约深色正文色')
  assert.match(css, /--vwf-wb-canvas:var\(--dsw-alias-bg-base,#101827\)/, '深色画布兜底 = 契约深色画布色')
  // 正文与边界分开取值（控件边界 / 图标 ≥3:1 的目标需要更深的边界色）
  assert.match(css, /--vwf-wb-border:var\(--dsw-alias-border-l2,#C3CCDD\)/, '边界色独立成对')
  assert.match(css, /--vwf-wb-border-strong:var\(--dsw-alias-border-l3,#8E9CB8\)/, '强调边界色独立成对')
  // 键盘焦点可见且不被滚动容器裁掉
  assert.match(css, /:focus-visible\{outline:2px solid var\(--vwf-wb-accent\);outline-offset:2px/, '工作区焦点样式可见：焦点可见且不被滚动容器裁掉')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-9 窄屏切换与 Escape 分层关闭
// ═══════════════════════════════════════════════════════════════════════════
test('V-9 窄屏 390×844：流程 / 配置两个区域可切换，不把桌面画布压成小图', async () => {
  const { container, styleText } = await mountPage()
  await openEditor(container)
  // 窄屏整段由 CSS 媒体查询驱动（无 JS 判定参与），因此断言结构与样式契约：
  // 默认流程窗格；切换按钮始终可达（不随窗格被隐藏）；网格列 / 行与隐藏规则齐备。
  const editor = editorOf(container)
  assert.ok(editor.className.indexOf('pane-flow') >= 0, '默认显示流程窗格')
  const tabs = Array.from(container.querySelectorAll('.vwf-wb-pane-tab'))
  assert.equal(tabs.length, 2, '提供流程 / 配置两个切换按钮')
  assert.deepEqual(tabs.map((t) => t.textContent), ['流程', '配置'])
  await act(async () => { tabs[1].click(); await flush() })
  assert.ok(editorOf(container).className.indexOf('pane-config') >= 0, '切到配置窗格')
  await act(async () => { container.querySelectorAll('.vwf-wb-pane-tab')[0].click(); await flush() })
  assert.ok(editorOf(container).className.indexOf('pane-flow') >= 0, '切回流程窗格')

  // 切换条必须在网格之外：放进网格会随所在窗格一起隐藏，配置窗格里就再也切不回去
  const switchBox = container.querySelector('.vwf-pane-switch')
  assert.ok(switchBox, '窗格切换条存在')
  assert.ok(!editorOf(container).contains(switchBox), '切换条不在工作区网格内')

  const css = compactCss(styleText.join('\n'))
  const has = (frag, label) => assert.ok(css.indexOf(frag) >= 0, label)
  has('@media (max-width:900px){', '窄屏规则集中在媒体查询内')
  has('.vwf-editor{grid-template-columns:minmax(0,1fr);inset:54px 16px 12px}', '窄屏单列可收缩且让出切换条高度')
  has('.vwf-editor.pane-flow{grid-template-rows:auto minmax(0,1fr);grid-template-areas:"nav" "canvas"}', '流程窗格：步骤条自适应 + 画布占满剩余高度')
  has('.vwf-editor.pane-config{grid-template-rows:minmax(0,1fr);grid-template-areas:"config"}', '配置窗格：配置栏占满剩余高度（连接信息走弹窗，不再占窗格）')
  // 未参与当窗格 grid-template-areas 的项必须显式隐藏，否则被自动放置撑出隐式行
  has('.vwf-editor.pane-flow .vwf-inspector{display:none}', '流程窗格隐藏配置栏')
  has('.vwf-editor.pane-config .vwf-nav-col,.vwf-editor.pane-config .vwf-canvas-col{display:none}', '配置窗格隐藏步骤定位与画布')
})

test('V-9 桌面宽度保持三段布局：切换条默认隐藏，网格为三列一行', async () => {
  const { container, styleText } = await mountPage()
  await openEditor(container)
  assert.equal(container.querySelectorAll('.vwf-wb-pane-tab').length, 2, '切换按钮存在但在桌面不显示（由 CSS 控制）')
  const css = compactCss(styleText.join('\n'))
  const has = (frag, label) => assert.ok(css.indexOf(frag) >= 0, label)
  has('.vwf-pane-switch{display:none}', '切换条默认隐藏')
  has('grid-template-rows:minmax(0,1fr);grid-template-areas:"nav canvas config"', '桌面单行网格与区域划分')
  // 画布宿主必须撑满卡片剩余高度（否则画布只有内容高度，首屏 fit 落到缩放下限）
  has('.vwf-editor-dialog .vwf-canvas-host{flex:1;min-height:0;display:flex;flex-direction:column}', '画布宿主撑满卡片')
})

test('V-9 Escape 分层关闭：先关最上层，不把整个工作区一起带走', async () => {
  const { container } = await mountPage()
  await openEditor(container)
  // 连接弹窗（V-13）开着时，Escape 只关它
  await openConnections(container)
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  assert.equal(container.querySelector('.vwf-conn-dialog'), null, 'Escape 关闭连接弹窗')
  assert.ok(container.querySelector('dialog.vwf-editor-dialog'), 'Escape 未关闭整个工作区')

  // 打开角色库浮层
  await act(async () => {
    byText(container, '管理角色').click()
    await flush()
  })
  assert.ok(container.querySelector('.vwf-role-mgr'), '角色管理浮层已打开')
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  assert.equal(container.querySelector('.vwf-role-mgr'), null, 'Escape 关闭角色浮层')
  assert.ok(container.querySelector('dialog.vwf-editor-dialog'), 'Escape 未关闭整个工作区')

  // 有未保存改动时：Escape 弹确认层，再按 Escape 只关确认层
  await act(async () => {
    byText(container, '新增节点').click()
    await flush()
  })
  await act(async () => {
    container.querySelector('dialog.vwf-editor-dialog').dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
    await flush()
  })
  assert.ok(container.querySelector('.vwf-confirm-mask'), '未保存关闭弹出确认层')
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
  })
  assert.equal(container.querySelector('.vwf-confirm-mask'), null, 'Escape 关闭确认层')
  assert.ok(container.querySelector('dialog.vwf-editor-dialog'), 'Escape 未关闭工作区（改由用户显式选择）')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-12 画布自上而下：入口在顶部、流程方向向下展开，同级步骤左右并排
// ═══════════════════════════════════════════════════════════════════════════
test('V-12 画布自上而下：入口在上、下游节点在下；同级兄弟左右并排而非上下堆叠', async () => {
  // 并行模板：a（入口）同时通向 b1 / b2，两者属同一主序号（同级兄弟）
  const parallelDsl = {
    id: 'vf-vertical', name: '纵向布局', entry: 'a', control: { maxRounds: 3 },
    nodes: [
      { id: 'a', label: '安排', profile: 'dispatcher', goal: 'g' },
      { id: 'b1', label: '分支一', profile: 'dev', goal: 'g' },
      { id: 'b2', label: '分支二', profile: 'dev', goal: 'g' },
    ],
    edges: [
      { from: 'a', to: 'b1', on: 'success' },
      { from: 'a', to: 'b2', on: 'success' },
    ],
  }
  const { container } = await mountPage({ dsl: parallelDsl, list: [{ id: parallelDsl.id, name: parallelDsl.name, description: '', builtin: false, dsl: JSON.parse(JSON.stringify(parallelDsl)) }] })
  await openEditor(container)
  const nodeAt = (id) => {
    const g = container.querySelector('g[data-node-id="' + id + '"]')
    assert.ok(g, '画布存在节点 ' + id)
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'))
    const rect = g.querySelector('rect')
    return { x: Number(m[1]), y: Number(m[2]), w: Number(rect.getAttribute('width')), h: Number(rect.getAttribute('height')) }
  }
  const a = nodeAt('a')
  const b1 = nodeAt('b1')
  const b2 = nodeAt('b2')
  // 入口在顶部，两条下游分支都在它下方（流程方向向下展开）
  assert.ok(b1.y > a.y + a.h, '下游节点排在入口下方（自上而下）：a.y=' + a.y + ' b1.y=' + b1.y)
  assert.ok(b2.y > a.y + a.h, '另一条下游分支也在入口下方')
  // 同一主序号的兄弟横向并排：同一行、左右分开
  assert.ok(Math.abs(b1.y - b2.y) < 2, '同级兄弟在同一行：b1.y=' + b1.y + ' b2.y=' + b2.y)
  assert.ok(b2.x > b1.x + b1.w, '同级兄弟左右并排：b1.x=' + b1.x + ' b2.x=' + b2.x)
  // 节点是「宽 > 高」的横向卡片（与原型一致），未被转置压成竖条
  assert.ok(a.w > a.h, '节点保持横向卡片形态：' + a.w + '×' + a.h)

  // 前向边从源节点下边框中点出发，向下落到目标节点上边框中点
  const nums = container.querySelectorAll('path.vwf-edge-flow')[0].getAttribute('d').match(/-?[\d.]+/g).map(Number)
  const startY = nums[1]
  const endY = nums[nums.length - 1]
  assert.ok(endY > startY, '前向边自上而下：start.y=' + startY + ' end.y=' + endY)
  assert.ok(Math.abs(nums[0] - (a.x + a.w / 2)) < 2, '前向边从源节点下边框中点出发')
  assert.ok(Math.abs(nums[nums.length - 2] - (b1.x + b1.w / 2)) < 2, '前向边落到目标节点上边框中点')
})

test('V-12 纵向布局保持缩放 / 拖拽 / 首屏 fit 与连接可查看（V-2 能力不回退）', async () => {
  const { container } = await mountPage({ dsl: DIAG_DSL, list: [{ id: 'wf-diag', name: '诊断与修复', description: '', builtin: false, dsl: JSON.parse(JSON.stringify(DIAG_DSL)) }] })
  await openEditor(container)
  // 首屏 fit：内容尺寸随纵向布局给出（高度 = 主序号方向的总长，宽度 = 同级并排方向的总长）
  const wrap = container.querySelector('.vwf-canvas-wrap')
  const svg = container.querySelector('svg.vwf-svg')
  assert.ok(svg, '画布 SVG 渲染')
  const w = Number(svg.getAttribute('width'))
  const h = Number(svg.getAttribute('height'))
  assert.ok(w > 0 && h > 0, '首屏 fit 给出可用缩放：' + w + '×' + h)
  // 滚轮缩放
  const zoomBefore = svg.getAttribute('viewBox')
  await act(async () => {
    wrap.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    await flush()
  })
  assert.notEqual(container.querySelector('svg.vwf-svg').getAttribute('width'), String(w), '滚轮缩放后画布尺寸变化')
  assert.ok(container.querySelector('svg.vwf-svg').getAttribute('viewBox') === zoomBefore, '缩放只改渲染尺寸，图坐标不变')
  // 拖拽平移：任意非把手区域可拖动
  Object.defineProperty(wrap, 'scrollWidth', { value: 1200, configurable: true })
  Object.defineProperty(wrap, 'scrollHeight', { value: 1400, configurable: true })
  wrap.scrollLeft = 100
  wrap.scrollTop = 100
  await act(async () => {
    container.querySelector('.vwf-node-card').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 }))
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 260, clientY: 240 }))
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 260, clientY: 240 }))
    await flush()
  })
  assert.equal(wrap.scrollLeft, 140, '拖拽后画布横向平移（V-2 位置感保持）')
  assert.equal(wrap.scrollTop, 160, '拖拽后画布纵向平移（V-2 位置感保持）')
  // 连接仍可查看：弹窗与画布上的边都可点选
  assert.ok(container.querySelectorAll('path.vwf-edge-flow').length === DIAG_DSL.edges.length, '画布连接不漏边')
  const dialog = await openConnections(container)
  assert.equal(dialog.querySelectorAll('.vwf-wb-conn-row').length, DIAG_DSL.edges.length, '弹窗连接不漏边')
})

// ═══════════════════════════════════════════════════════════════════════════
// V-6 撤销历史（与既有 client.smoke 覆盖互补：此处锁定「共用一条历史」）
// ═══════════════════════════════════════════════════════════════════════════
test('V-6 画布与 JSON 共用同一条历史：跨两种编辑方式连续撤销可回到起点', async () => {
  const { container } = await mountPage()
  await openEditor(container)
  const undoBtn = container.querySelector('.vwf-history-group .vwf-history-btn:first-child')
  const redoBtn = container.querySelector('.vwf-history-group .vwf-history-btn:nth-child(2)')
  assert.equal(undoBtn.disabled, true, '初始撤销禁用')
  assert.equal(redoBtn.disabled, true, '初始重做禁用')

  // 画布侧：新增节点（结构变更立即入栈）
  await act(async () => {
    byText(container, '新增节点').click()
    await flush()
  })
  assert.equal(undoBtn.disabled, false, '画布修改后可撤销')
  // JSON 侧：直接改文案
  await act(async () => {
    const jsonTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'JSON')
    jsonTab.click()
    await flush()
    const textarea = container.querySelector('textarea.vwf-json-edit')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, JSON.stringify({ ...JSON.parse(textarea.value), name: '改名后的流' }, null, 2))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush()
  })
  // 撤销一次（落定 JSON 改动）→ 再撤销（回退画布新增）→ 第三次回到起点
  await act(async () => { undoBtn.click(); await flush() })
  await act(async () => { undoBtn.click(); await flush() })
  await act(async () => { undoBtn.click(); await flush() })
  assert.equal(undoBtn.disabled, true, '同一栈连续撤销回到底部后禁用')
  assert.equal(redoBtn.disabled, false, '反撤销可用')
  // 撤销后产生新修改 → 重做分支被清空（先回画布再改，画布与 JSON 共用同一条历史）
  await act(async () => {
    const canvasTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '画布')
    canvasTab.click()
    await flush()
    byText(container, '新增节点').click()
    await flush()
  })
  assert.equal(redoBtn.disabled, true, '撤销后新修改清空重做分支')
})
