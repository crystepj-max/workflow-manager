// #75 S-2a：内置 Outcome Preset 与模板真实契约的一致性回归（packet s2a-preset-001 设计 T01–T09）
// 权威来源：templates/*.json 节点的 output.outcomePath 与 output.schema；本测试不维护第二份枚举表。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import validatorCore from '../validate-core.cjs'

const { parseJsonPath, schemaLeafAt, enumerableValues } = validatorCore

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const presetsPath = path.join(repoRoot, 'docs/design/outcome-presets.json')

const loadTemplateFile = (templateFile) => {
  const resolved = path.resolve(repoRoot, templateFile)
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) return null
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'))
  } catch {
    return null
  }
}

// 正向校验与 T09 负向模拟共用同一套不变量：保证「回归能拦住错误数据」本身也被测试。
function validatePresetData(presets, resolveTemplate) {
  const errors = []
  if (!Array.isArray(presets)) return ['outcome-presets: 根节点缺少 presets 数组']
  const seenIds = new Set()
  for (const preset of presets) {
    const id = preset && preset.id
    const at = `preset[${id ?? '<缺失id>'}]`
    if (!id || typeof id !== 'string') {
      errors.push(`${at}.id: 缺失或非字符串`)
      continue
    }
    if (seenIds.has(id)) errors.push(`${at}.id: 重复`)
    seenIds.add(id)
    for (const field of ['outcomePath', 'values', 'labelsZh', 'applicableNodes']) {
      if (!(field in (preset || {}))) errors.push(`${at}.${field}: 缺失必填字段`)
    }
    if (typeof preset.outcomePath !== 'string' || !preset.outcomePath) {
      errors.push(`${at}.outcomePath: 需为非空字符串`)
    }
    if (!Array.isArray(preset.values) || preset.values.length === 0) {
      errors.push(`${at}.values: 需为非空数组`)
    } else {
      const dup = preset.values.filter((v, i) => preset.values.indexOf(v) !== i)
      if (dup.length) errors.push(`${at}.values: 存在重复取值 ${[...new Set(dup)].join('/')}`)
      if (preset.values.some((v) => typeof v !== 'string')) errors.push(`${at}.values: 存在非字符串取值`)
    }
    if (!preset.labelsZh || typeof preset.labelsZh !== 'object' || Array.isArray(preset.labelsZh)) {
      errors.push(`${at}.labelsZh: 缺失或非对象`)
    } else {
      for (const [k, v] of Object.entries(preset.labelsZh)) {
        if (typeof v !== 'string' || !v.trim()) errors.push(`${at}.labelsZh.${k}: 需为非空字符串`)
      }
    }
    if (!Array.isArray(preset.applicableNodes) || preset.applicableNodes.length === 0) {
      errors.push(`${at}.applicableNodes: 至少声明一个适用节点`)
      continue
    }
    for (const app of preset.applicableNodes) {
      const templateFile = app && app.templateFile
      const nodeId = app && app.nodeId
      const where = `${at} <- ${templateFile ?? '<缺失templateFile>'}#${nodeId ?? '<缺失nodeId>'}`
      if (!templateFile || typeof templateFile !== 'string') {
        errors.push(`${where}: templateFile 缺失或非字符串`)
        continue
      }
      if (!nodeId || typeof nodeId !== 'string') {
        errors.push(`${where}: nodeId 缺失或非字符串`)
        continue
      }
      const bp = resolveTemplate(templateFile)
      if (!bp) {
        errors.push(`${where}: 模板不存在或不可解析`)
        continue
      }
      const matched = Array.isArray(bp.nodes) ? bp.nodes.filter((n) => n && n.id === nodeId) : []
      if (matched.length === 0) {
        errors.push(`${where}: 节点不存在`)
        continue
      }
      if (matched.length > 1) {
        errors.push(`${where}: 节点定义不唯一(${matched.length})`)
        continue
      }
      const node = matched[0]
      const declared = node.output && typeof node.output.outcomePath === 'string' ? node.output.outcomePath.trim() : null
      if (!declared) {
        errors.push(`${where}: 节点未声明 output.outcomePath`)
        continue
      }
      if (declared !== preset.outcomePath) {
        errors.push(`${where}: outcomePath 不一致 preset=${preset.outcomePath} 模板=${declared}`)
      }
      const segs = parseJsonPath(preset.outcomePath)
      if (!segs) {
        errors.push(`${where}.outcomePath: 需为 $.field 形式（与内核 parseJsonPath 同规则）`)
        continue
      }
      const leaf = schemaLeafAt(node.output.schema, segs)
      if (!leaf) {
        errors.push(`${where}.outcomePath: 路径未落在节点 output.schema 属性上`)
        continue
      }
      if (leaf.type !== 'string') {
        errors.push(`${where}: 路径字段类型需为 string，实际 ${leaf.type ?? '<未声明>'}`)
      }
      const enumVals = enumerableValues(leaf)
      if (!enumVals || enumVals.length === 0) {
        errors.push(`${where}: 路径字段无可穷举枚举`)
        continue
      }
      if (Array.isArray(preset.values) && preset.values.length > 0 && preset.values.every((v) => typeof v === 'string')) {
        const presetSet = new Set(preset.values)
        const enumSet = new Set(enumVals)
        for (const v of presetSet) {
          if (!enumSet.has(v)) errors.push(`${where}.values: 取值 ${v} 不在节点枚举内`)
        }
        for (const v of enumSet) {
          if (!presetSet.has(v)) errors.push(`${where}.values: 缺少节点枚举取值 ${v}`)
        }
        if (preset.labelsZh && typeof preset.labelsZh === 'object' && !Array.isArray(preset.labelsZh)) {
          const labelKeys = new Set(Object.keys(preset.labelsZh))
          for (const v of presetSet) {
            if (!labelKeys.has(v)) errors.push(`${where}.labelsZh: 缺少 ${v} 的中文解释`)
          }
          for (const k of labelKeys) {
            if (!presetSet.has(k)) errors.push(`${where}.labelsZh: 存在无对应取值的键 ${k}`)
          }
        }
      }
    }
  }
  return errors
}

const realPresets = JSON.parse(readFileSync(presetsPath, 'utf8')).presets
const realErrors = () => validatePresetData(realPresets, loadTemplateFile)
const byId = (id) => realPresets.find((p) => p.id === id)
const clone = (ps) => JSON.parse(JSON.stringify(ps))
const errorsMatching = (re) => realErrors().filter((e) => re.test(e))

test('T01 Preset 文件结构完整且 ID 唯一', () => {
  assert.ok(Array.isArray(realPresets) && realPresets.length > 0, 'presets 需为非空数组')
  const ids = realPresets.map((p) => p && p.id)
  for (const id of ids) assert.ok(typeof id === 'string' && id, 'preset id 需为非空字符串')
  assert.equal(new Set(ids).size, ids.length, 'preset id 不得重复')
  for (const p of realPresets) {
    for (const field of ['outcomePath', 'values', 'labelsZh', 'applicableNodes']) {
      assert.ok(field in p, `preset[${p.id}] 缺少 ${field}`)
    }
    assert.ok(Array.isArray(p.applicableNodes) && p.applicableNodes.length > 0, `preset[${p.id}] 须声明适用节点`)
  }
})

test('T02 适用模板与节点存在且节点唯一', () => {
  assert.deepEqual(errorsMatching(/模板不存在|节点不存在|不唯一/), [])
})

test('T03 outcomePath 与节点声明一致且可解析到 string 枚举字段', () => {
  assert.deepEqual(
    errorsMatching(/outcomePath 不一致|\$.field 形式|未落在节点 output\.schema|类型需为 string|无可穷举枚举|未声明 output\.outcomePath/),
    []
  )
})

test('T04 values 与节点枚举集合完全相等且无重复', () => {
  assert.deepEqual(errorsMatching(/\.values/), [])
})

test('T05 labelsZh 覆盖全部取值且无多余键', () => {
  assert.deepEqual(errorsMatching(/labelsZh/), [])
})

test('T06 审核路由预设不混入审核意见枚举', () => {
  const construction = byId('construction-review-route')
  assert.ok(construction, '须存在 construction-review-route')
  assert.equal(construction.outcomePath, '$.route')
  assert.deepEqual(
    [...new Set(construction.values)].sort(),
    ['APPROVE', 'BLOCKED', 'RETURN_DEV'],
    '建设审核路由取值须与模板 route 枚举一致'
  )
  assert.ok(!construction.values.includes('REQUEST_CHANGES'), 'REQUEST_CHANGES 属审核意见字段，不得进入路由预设')
  assert.ok(!construction.values.includes('COMMENT_ONLY'), 'COMMENT_ONLY 属审核意见字段，不得进入路由预设')
  const diagnose = byId('diagnose-review-route')
  assert.ok(diagnose, '须存在 diagnose-review-route')
  assert.equal(diagnose.outcomePath, '$.route')
  assert.ok(diagnose.values.includes('ROOT_CAUSE_REFUTED'), '诊断审核路由须保留 ROOT_CAUSE_REFUTED')
})

test('T07 探索评价保持 $.verdict，不被错误纠偏', () => {
  const explore = byId('explore-evaluator')
  assert.ok(explore, '须存在 explore-evaluator')
  assert.equal(explore.outcomePath, '$.verdict')
  const bp = loadTemplateFile('templates/wf-explore.json')
  const node = bp.nodes.find((n) => n.id === 'evaluate')
  assert.equal(node.output.outcomePath, '$.verdict', '探索模板 evaluate 节点声明须为 $.verdict')
})

test('T08 结果语义分层：路由预设不得指向 completion_type 或审核意见字段', () => {
  for (const p of realPresets) {
    assert.notEqual(p.outcomePath, '$.completion_type', `preset[${p.id}] 不得把完成类型当路由`)
  }
  const construction = byId('construction-review-route')
  assert.notEqual(construction.outcomePath, '$.verdict', '建设审核路由不得指向审核意见字段')
})

test('T09 防漂移：各类错误数据都必须被校验拦截', () => {
  const expectReject = (mutate, keyword) => {
    const mutated = clone(realPresets)
    mutate(mutated)
    const errs = validatePresetData(mutated, loadTemplateFile)
    assert.ok(errs.length > 0, `应拦截错误：${keyword}`)
    assert.ok(
      errs.some((e) => e.includes(keyword)),
      `错误信息应包含「${keyword}」，实际：${JSON.stringify(errs)}`
    )
  }
  expectReject((ps) => { ps.find((p) => p.id === 'optimize-evaluator').outcomePath = '$.verdict' }, 'outcomePath 不一致')
  expectReject((ps) => { ps.find((p) => p.id === 'explore-evaluator').outcomePath = '$.route' }, 'outcomePath 不一致')
  expectReject((ps) => { ps.find((p) => p.id === 'construction-review-route').values.push('COMMENT_ONLY') }, '不在节点枚举内')
  expectReject((ps) => {
    const v = ps.find((p) => p.id === 'diagnose-review-route').values
    v.splice(v.indexOf('ROOT_CAUSE_REFUTED'), 1)
  }, '缺少节点枚举取值')
  expectReject((ps) => { delete ps.find((p) => p.id === 'optimize-evaluator').labelsZh.CONFIRM }, '缺少 CONFIRM 的中文解释')
  expectReject((ps) => { ps.find((p) => p.id === 'optimize-evaluator').applicableNodes[0].nodeId = 'missing-node' }, '节点不存在')
  expectReject((ps) => { ps.find((p) => p.id === 'optimize-evaluator').applicableNodes[0].templateFile = 'templates/wf-missing.json' }, '模板不存在')
})

test('全量一致性：真实 Preset 数据零错误', () => {
  assert.deepEqual(realErrors(), [])
})
