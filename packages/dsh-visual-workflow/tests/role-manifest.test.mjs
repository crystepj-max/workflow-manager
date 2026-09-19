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

// 规格 §8 的权威名单（通用 8 + 专业 4，顺序即展示顺序）+ 一句话简介数据字段
// （FEAT-103 V-2：定位与职责的 1~2 句提炼，列表与详情直接展示该字段）
const EXPECTED = [
  { id: 'requirements', name: '需求分析', summary: '把原始诉求加工成可直接执行的需求：任务目标、涉及范围、验收标准三要素齐全、不含歧义。' },
  { id: 'designer', name: '方案设计', summary: '把已确认的需求转化为可实施方案：拆解实施路径、明确关键取舍、指出风险与验证方式。' },
  { id: 'dev', name: '开发', summary: '按任务目标、涉及范围和验收标准实现需求，并做必要的自测与实现相关测试。独立测试证明交由独立会话出具。' },
  { id: 'review', name: '审核', summary: '对实现做规范与需求符合性、代码质量的双轴并行审查并给出明确结论。不实施修复、不写测试。' },
  { id: 'test', name: '测试', summary: '对实现做运行态验证，用证据判定通过或失败。不修改业务代码、不做验收。' },
  { id: 'evaluator', name: '评估', summary: '依据所在节点给出的评价契约对当前成果做独立评估，回答是否足够以及是否需要再来一轮。' },
  { id: 'accept', name: '验收助手', summary: '在审核通过后对照验收标准做最终核验，产出验收报告并等待人工确认。' },
  { id: 'closeout', name: '收口', summary: '验收通过后做合并前收口：先只读整理交付事实，再按已授权的必要动作完成交付。' },
  { id: 'diagnose', name: '缺陷诊断', summary: '动手修复之前先还原现象、收集证据并收敛到根因，再交棒给开发角色去修。' },
  { id: 'orchestrator', name: '探索统筹', summary: '为问题设计研究方案：明确核心问题、判断研究条件、选择互补视角并形成专家任务书。' },
  { id: 'researcher', name: '专家研究', summary: '严格按专家任务书指定的视角独立研究，形成有证据、有反证、有边界的明确观点。' },
  { id: 'synthesizer', name: '综合分析', summary: '把多份相互独立的专业判断整合成一张可支持决策的观点地图，不掩盖真实分歧。' },
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

// FEAT-103 V-2：简介是给用户读的「定位与职责」1~2 句，不是角色名标签、也不是提示词片段。
test('manifest：一句话简介是 1~2 句定位与职责（非角色名标签、非提示词首句）', () => {
  const m = loadManifest()
  for (const r of m.builtins) {
    const s = String(r.summary)
    assert.ok(s.length <= 80, `${r.id} 简介过长（${s.length} > 80 字符，列表两行放不下）`)
    assert.ok(/。$/.test(s), `${r.id} 简介必须以句号收尾（1~2 句）`)
    assert.ok(s.split('。').filter(Boolean).length <= 2, `${r.id} 简介最多 2 句`)
    assert.ok(!s.startsWith(r.name), `${r.id} 简介不再以角色名开头（行内已有角色名，重复即冗余）`)
    assert.ok(!/^你是/.test(s) && !/Agent/.test(s), `${r.id} 简介不得是角色提示词原文（"你是…Agent"）`)
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

test('host 不再内嵌 EMBEDDED_BUILTIN_MANIFEST 降级清单', () => {
  const hostSrc = readFileSync(join(repoRoot, 'packages', 'dsh-visual-workflow', 'src', 'host.js'), 'utf8')
  assert.equal(hostSrc.includes('EMBEDDED_BUILTIN_MANIFEST'), false, '内核找不到应明确报错，不得再嵌入降级清单')
})
