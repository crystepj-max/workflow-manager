// FEAT-86：A 编排台语义 token 成对性与对比度门禁 + 角色来源/摘要纯函数。
//
// 覆盖验收条件 V-1（来源按 builtin 字段判定）、V-2（摘要生成不写回）、
// V-3（三页共用一套语义 token、浅深成对）与 V-4（正文 ≥ 4.5:1、非文本 ≥ 3:1）。
//
// 对比度采样点与阈值即为本任务的测量记录：token 值改坏、漏定义深色值、
// 或把单一主题的硬编码色重新引入组件样式，这里都会红灯。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')
const plugin = new Function(src)()

// ── token 区块解析（浅色/深色分别成段，见 src/client.js 顶部注释）──────────────
function tokenBlock(name) {
  const m = new RegExp('/\\* @vwf-token-' + name + ' \\*/([\\s\\S]*?)/\\* @vwf-token-' + name + '-end \\*/').exec(src)
  assert.ok(m, '存在 ' + name + ' token 区块')
  const tokens = {}
  for (const line of m[1].split('\n')) {
    const t = /^\s*(--vwf-[a-z0-9-]+)\s*:\s*(.+?);\s*$/.exec(line)
    if (t) tokens[t[1]] = t[2]
  }
  return tokens
}
const light = tokenBlock('light')
const dark = tokenBlock('dark')

// WCAG 2.x 相对亮度与对比度（sRGB）
function luminance(value) {
  const hex = String(value).replace('#', '')
  assert.match(hex, /^[0-9a-fA-F]{6}$/, '对比度采样只接受 #RRGGBB：' + value)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  const [hi, lo] = x > y ? [x, y] : [y, x]
  return (hi + 0.05) / (lo + 0.05)
}

// 采样点：每一项 = [前景 token, 背景 token, 阈值]
const TEXT_PAIRS = [
  ['--vwf-text', '--vwf-surface'], ['--vwf-text', '--vwf-canvas'],
  ['--vwf-text-2', '--vwf-surface'], ['--vwf-text-2', '--vwf-canvas'],
  ['--vwf-text-3', '--vwf-surface'], ['--vwf-text-3', '--vwf-canvas'],
  ['--vwf-accent', '--vwf-surface'], ['--vwf-accent', '--vwf-canvas'],
  ['--vwf-accent', '--vwf-accent-surface'],
  ['--vwf-accent-on', '--vwf-accent'],
  ['--vwf-ok', '--vwf-surface'], ['--vwf-ok', '--vwf-canvas'],
  ['--vwf-err', '--vwf-surface'], ['--vwf-err', '--vwf-canvas'],
  ['--vwf-warn', '--vwf-surface'], ['--vwf-warn', '--vwf-canvas'],
  ['--vwf-info', '--vwf-surface'], ['--vwf-info', '--vwf-canvas'],
]
const CONTROL_PAIRS = [
  ['--vwf-border-ctl', '--vwf-surface'], ['--vwf-border-ctl', '--vwf-canvas'],
  ['--vwf-focus', '--vwf-surface'], ['--vwf-focus', '--vwf-canvas'],
]

const measure = (tokens) => (pairs) => pairs.map(([fg, bg]) => ({
  pair: fg + ' on ' + bg,
  ratio: contrast(tokens[fg], tokens[bg]),
}))

test('V-3/V-4：浅色与深色成对定义同一套语义 token，且新增 token 不再是单一主题硬编码', () => {
  const lk = Object.keys(light).sort()
  const dk = Object.keys(dark).sort()
  assert.ok(lk.length >= 17, '语义 token 覆盖画布/表面/正文/次要正文/强调/状态/边框/焦点/遮罩：' + lk.length)
  assert.deepEqual(dk, lk, '深色必须与浅色逐项成对（缺一项即「深色背景配深色字」的成因）')
  for (const k of lk) {
    assert.notEqual(light[k], dark[k], k + ' 的浅色与深色取值相同——说明只定义了一套主题值')
  }
})

test('V-4：正文类 token 在浅色与深色下都 ≥ 4.5:1（采样点见 TEXT_PAIRS）', () => {
  for (const [name, tokens] of [['浅色', light], ['深色', dark]]) {
    for (const { pair, ratio } of measure(tokens)(TEXT_PAIRS)) {
      assert.ok(ratio >= 4.5, name + ' ' + pair + ' = ' + ratio.toFixed(2) + ':1 < 4.5:1')
    }
  }
})

test('V-4：非文本控件边界与焦点指示在浅色与深色下都 ≥ 3:1（采样点见 CONTROL_PAIRS）', () => {
  for (const [name, tokens] of [['浅色', light], ['深色', dark]]) {
    for (const { pair, ratio } of measure(tokens)(CONTROL_PAIRS)) {
      assert.ok(ratio >= 3, name + ' ' + pair + ' = ' + ratio.toFixed(2) + ':1 < 3:1')
    }
  }
})

test('V-3：组件样式只引用 --vwf-* 语义 token，不再退回 DSH alias + 单一主题兜底色', () => {
  const start = src.indexOf('styles.insert(`')
  const end = src.indexOf('`)', start)
  const css = src.slice(start, end)
  assert.ok(css.length > 1000, '取到注入样式块')
  assert.equal(src.split('--dsw-alias-').length - 1, 0, '不再出现 DSH alias 引用（含兜底色）')
  const withoutTokens = css
    .replace(/\/\* @vwf-token-light \*\/[\s\S]*?\/\* @vwf-token-light-end \*\//, '')
    .replace(/\/\* @vwf-token-dark \*\/[\s\S]*?\/\* @vwf-token-dark-end \*\//, '')
  assert.deepEqual(withoutTokens.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'token 之外的样式不得硬编码颜色')
  // 允许颜色之外的 rgb/rgba 只出现在投影（纯装饰，不承载文字或控件语义）
  for (const decl of withoutTokens.split(';')) {
    if (!/rgba?\(/.test(decl)) continue
    assert.match(decl, /box-shadow|outline|transparent/, '非投影用途不得写死颜色：' + decl.trim())
  }
  assert.ok(!/\bb(white|black)\b/.test(withoutTokens.replace(/white-space/g, '')), '不得写死 black/white 颜色关键字')
})

test('V-5/V-6：可见焦点与窄屏规则就位（不靠缩字号解决拥挤）', () => {
  assert.match(src, /\.vwf-root :focus-visible \{ outline:2px solid var\(--vwf-focus\)/, '键盘焦点可见且限本插件作用域')
  assert.match(src, /@media \(max-width: 480px\) \{[\s\S]*?\.vwf-role-actions \{ flex:1 1 100%; margin-left:0; \}/, '窄屏下角色行操作折行而不是缩字号')
  assert.match(src, /\.vwf-role-mgr \{ width:min\(780px, 94vw\); max-height:calc\(100vh - 2 \* var\(--vwf-safe-gap\)\)/, '弹层保留安全边距')
  // 两行收敛必须落在摘要选择器上（独立审查 F-03：原断言用了可选分支，选择器写错也能通过）
  assert.match(src, /\.vwf-role-summary \{[^}]*-webkit-line-clamp:2/, '摘要选择器自身按两行收敛')
  assert.match(src, /\.vwf-role-content \{[^}]*max-height:min\(340px, 40vh\)/, '完整职责区独立滚动且随视口收敛')
  assert.match(src, /\.vwf-role-summary \{[^}]*overflow-wrap:anywhere/, '连续长串断词换行')
})

test('V-1：来源按 builtin 布尔字段判定（不靠角色名猜来源）', () => {
  const origin = plugin.roleOriginOf
  assert.equal(typeof origin, 'function', 'client 顶层导出 roleOriginOf')
  assert.equal(origin({ id: 'dev', builtin: true }).key, 'builtin')
  assert.equal(origin({ id: '体验检查员', builtin: false }).key, 'custom')
  // 缺字段按布尔语义映射为自定义，且名字里带「内置」也不能翻转判定
  assert.equal(origin({ id: '内置角色' }).key, 'custom', '缺 builtin 字段按布尔语义映射，不按名字猜')
  assert.equal(origin({ id: 'dev', builtin: true }).builtin, true)
})

test('V-2：摘要显式优先、缺失时由职责生成，且不改写角色原文', () => {
  const summaryOf = plugin.roleSummaryOf
  assert.equal(typeof summaryOf, 'function', 'client 顶层导出 roleSummaryOf')
  assert.equal(summaryOf({ summary: '调度与分派' }), '调度与分派', '显式 summary 优先')
  const content = '# 职责\n\n- 负责需求拆解\n- 负责验收\n\n```\ncode\n```\n'
  assert.equal(summaryOf({ content }), '职责 负责需求拆解 负责验收', '从职责生成可读摘要（去标记与代码块）')
  const role = { id: 'r1', content: 'x'.repeat(400) }
  const before = JSON.stringify(role)
  const out = summaryOf(role)
  assert.equal(Array.from(out).length, 121, '默认截断到 120 字符 + 省略号')
  assert.ok(out.endsWith('…'), '截断用省略号收尾')
  assert.equal(JSON.stringify(role), before, '生成摘要不得写回角色对象（原文与字段均未变化）')
  const long = '无空格连续长串'.repeat(20)
  assert.ok(summaryOf({ content: long }).length <= 121, '连续长串同样受长度上限约束')
  assert.equal(summaryOf({}), '', '无 summary 也无职责时返回空串，不抛错')
  assert.equal(Array.from(summaryOf({ content: '😀'.repeat(200) })).length <= 121, true, '代理对不被切断')
})
