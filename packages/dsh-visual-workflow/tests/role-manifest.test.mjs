// 内置角色清单 manifest 契约测试（角色库深化 P1）
// seam：dsh/roles/builtin-roles.json 数据文件本身。
// 期望值来源 = 产品规格 §8 的 12 角色名单 + host.js 当前注册表（独立事实源，非从被测物推导）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const MANIFEST = join(repoRoot, 'dsh', 'roles', 'builtin-roles.json')
const ROLES_DIR = join(repoRoot, 'dsh', 'roles')

// 规格 §8 的权威名单（通用 8 + 专业 4，顺序即展示顺序）
const EXPECTED = [
  { id: 'requirements', name: '需求分析', summary: '需求分析角色：三要素门禁，产出需求基线' },
  { id: 'designer', name: '方案设计', summary: '方案设计角色：实施路径、关键取舍与风险' },
  { id: 'dev', name: '开发', summary: '开发角色：测试驱动施工，满足质量闸门' },
  { id: 'review', name: '审核', summary: '审核角色：规范与需求符合性、代码质量双轴审查' },
  { id: 'test', name: '测试', summary: '测试角色：运行态验证，证据驱动判定' },
  { id: 'evaluator', name: '评估', summary: '评估角色：按节点评价契约独立评估，场景差异由节点表达' },
  { id: 'accept', name: '验收助手', summary: '验收助手角色：对照验收标准最终核验并等待人工签字' },
  { id: 'closeout', name: '收口', summary: '收口角色：一致性收口与交接产物汇总' },
  { id: 'diagnose', name: '缺陷诊断', summary: '缺陷诊断角色：先取证后结论，收敛到根因' },
  { id: 'orchestrator', name: '探索统筹', summary: '探索统筹角色：设计研究方案与专家任务书' },
  { id: 'researcher', name: '专家研究', summary: '专家研究角色：按任务书独立取证，含反证' },
  { id: 'synthesizer', name: '综合分析', summary: '综合分析角色：把独立判断整合为可决策的观点地图' },
]

function loadManifest() {
  assert.ok(existsSync(MANIFEST), '缺少 dsh/roles/builtin-roles.json')
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

test('manifest：可解析 JSON 且 schemaVersion=1', () => {
  const m = loadManifest()
  assert.equal(m.schemaVersion, 1, 'manifest 必须声明 schemaVersion: 1')
  assert.ok(Array.isArray(m.builtins), 'manifest.builtins 必须是数组')
})

test('manifest：12 个内置角色按规格 §8 精确顺序与文案', () => {
  const m = loadManifest()
  assert.equal(m.builtins.length, EXPECTED.length, `内置角色必须恰好 ${EXPECTED.length} 个（规格 §8）`)
  for (let i = 0; i < EXPECTED.length; i++) {
    const got = m.builtins[i]
    const want = EXPECTED[i]
    assert.equal(got.id, want.id, `第 ${i} 位角色 id 漂移`)
    assert.equal(got.name, want.name, `${want.id} 中文名漂移`)
    assert.equal(got.summary, want.summary, `${want.id} 摘要漂移`)
  }
})

test('manifest：结构不变量（id 稳定英文、中文名非空、definition 不穿越、全部只读）', () => {
  const m = loadManifest()
  const seen = new Set()
  for (const r of m.builtins) {
    assert.match(r.id, /^[a-z][a-z0-9-]*$/, `机器 ID 必须为稳定英文：${r.id}`)
    const key = r.id.normalize('NFC').toLowerCase()
    assert.ok(!seen.has(key), `id 归一化后冲突：${r.id}`)
    seen.add(key)
    assert.ok(r.name && String(r.name).trim().length > 0, `中文名不得为空：${r.id}`)
    assert.ok(r.summary && String(r.summary).trim().length > 0, `摘要不得为空：${r.id}`)
    assert.equal(r.definition, 'dsh/roles/' + r.id + '.md', `definition 必须严格等于 dsh/roles/<id>.md：${r.id}`)
    assert.equal(r.builtin, true, `内置角色必须 builtin:true：${r.id}`)
    assert.equal(r.readonly, true, `内置角色必须 readonly:true：${r.id}`)
  }
})

test('manifest：12 个内置角色的定义文件全部存在', () => {
  const m = loadManifest()
  for (const r of m.builtins) {
    assert.ok(existsSync(join(ROLES_DIR, r.id + '.md')), `缺少角色定义文件：dsh/roles/${r.id}.md`)
  }
})

test('manifest：dispatcher 登记为兼容角色（builtin:false），且不与内置冲突', () => {
  const m = loadManifest()
  const builtinIds = new Set(m.builtins.map((r) => r.id))
  assert.ok(!builtinIds.has('dispatcher'), 'dispatcher 不得出现在 builtins（issue-81 已迁出）')
  const compat = Array.isArray(m.compatibilityRoles) ? m.compatibilityRoles : []
  const dp = compat.find((r) => r.id === 'dispatcher')
  assert.ok(dp, 'dispatcher 必须登记在 compatibilityRoles（历史引用兼容）')
  assert.equal(dp.builtin, false, 'dispatcher 身份必须是自定义')
  for (const r of compat) {
    assert.ok(!builtinIds.has(r.id), `兼容角色不得与内置冲突：${r.id}`)
  }
})

test('嵌入降级清单 EMBEDDED_BUILTIN_MANIFEST 与 manifest 逐字段一致（无 fs 降级数据闸）', () => {
  // host.js 无 fs / core 不可用时以嵌入清单兜底「内置角色常驻」。该清单是 manifest 的
  // 机器投影（禁止手改），本测试是两份数据的一致性闸。
  const m = loadManifest()
  const hostSrc = readFileSync(join(repoRoot, 'packages', 'dsh-visual-workflow', 'src', 'host.js'), 'utf8')
  const block = /const EMBEDDED_BUILTIN_MANIFEST = \[([\s\S]*?)\n\s*\]/.exec(hostSrc)
  assert.ok(block, 'host.js 必须含 EMBEDDED_BUILTIN_MANIFEST 嵌入清单')
  const embedded = new Function('return [' + block[1] + ']')()
  assert.equal(embedded.length, m.builtins.length, '嵌入清单与 manifest 数量漂移')
  for (let i = 0; i < m.builtins.length; i++) {
    assert.equal(embedded[i].id, m.builtins[i].id, `第 ${i} 位 id 漂移`)
    assert.equal(embedded[i].name, m.builtins[i].name, `第 ${i} 位 name 漂移`)
    assert.equal(embedded[i].summary, m.builtins[i].summary, `第 ${i} 位 summary 漂移`)
  }
})
