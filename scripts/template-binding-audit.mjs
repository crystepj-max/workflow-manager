#!/usr/bin/env node
// FIX-234 内置模板默认绑定核对：逐模板逐节点核对默认 provider/model 是否 ∈ 当前可用模型目录。
// 背景：模板默认绑定曾静默过期（deepseek-v4-flash 被删，真机 MODEL_NOT_CONFIGURED 才发现），
// 本段把它做成发布前可核对产物（真机层；仓库层锚点 = builtin-template-model-defaults.test.mjs 映射表）。
//
// 用法：
//   node scripts/template-binding-audit.mjs [--catalog <catalog.json>] [--format text|json]
//
// 目录文件格式（provider → 可用模型 id 数组）：
//   { "deepseek-official": ["deepseek-flash", "deepseek-v4.1-flash"] }
// 目录来源：产品 DSH 运行时 llm 目录（与运行前探针 listProviders/listModels 同口径）。
// 可在编辑器控制台执行 vwf.models 后按上式落盘，或由后续官方导出通道生成；
// 未提供目录 = 「产品 DSH 不可达」→ 显式跳过并留痕（exit 0，不静默绿、不误报红）。
//
// 退出码：0 = 全部命中或显式跳过；1 = 存在过期绑定（输出逐节点失败清单）。
// 审计范围：四套正式内置模板（与 builtin-template-model-defaults 映射表同口径）；
// 历史自定义模板（default-workflow / dev-workflow-2-0）为用户自管资产，不在本审计内。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const TPL_DIR = join(repoRoot, 'templates')

// 四套正式内置模板（与 builtin-template-model-defaults.test.mjs 同源；改动须双侧同步）
export const AUDITED_TEMPLATES = [
  'wf-construction-full-feature',
  'wf-diagnose',
  'wf-optimize',
  'wf-explore',
]

function parseArgs(argv) {
  const opts = { catalog: null, format: 'text' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--catalog') opts.catalog = argv[++i] ?? null
    else if (argv[i] === '--format') opts.format = argv[++i] === 'json' ? 'json' : 'text'
  }
  return opts
}

export function loadCatalog(path) {
  if (!path) return { catalog: null, reason: '未提供模型目录（--catalog）：视为产品 DSH 不可达，显式跳过' }
  if (!existsSync(path)) return { catalog: null, reason: `目录文件不存在：${path}` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    return { catalog: null, reason: `目录文件不可解析（${String(e && e.message || e).slice(0, 200)}）` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { catalog: null, reason: '目录文件结构非法：须为 { "<provider>": ["<model>", ...] }' }
  }
  const catalog = {}
  for (const [provider, models] of Object.entries(parsed)) {
    if (!Array.isArray(models)) return { catalog: null, reason: `目录文件结构非法：provider「${provider}」的值须为字符串数组` }
    catalog[provider] = new Set(models)
  }
  return { catalog, reason: null }
}

// 纯核对内核：模板绑定 + 目录 → 逐节点结果（可注入测试，无 IO）
export function auditBindings(bindingsByTemplate, catalog) {
  const results = []
  const missing = []
  for (const templateId of AUDITED_TEMPLATES) {
    const bindings = bindingsByTemplate[templateId] || {}
    for (const nodeId of Object.keys(bindings).sort()) {
      const { provider, model } = bindings[nodeId] || {}
      const providerModels = (catalog && catalog[provider]) || null
      const present = !!(providerModels && providerModels.has(model))
      const row = { template: templateId, node: nodeId, provider, model, present }
      results.push(row)
      if (!present) missing.push(row)
    }
  }
  return { results, missing, ok: missing.length === 0 }
}

function renderText(out) {
  const lines = []
  if (out.skipped) {
    lines.push(`⏭️ 内置模板默认绑定核对：跳过——${out.skipReason}`)
    lines.push('   （提供模型目录后重跑本段即可核对；未核对不等于通过，发布若要求绑定有效性须补跑）')
    return lines.join('\n')
  }
  lines.push(`—— 内置模板默认绑定核对（${out.results.length} 节点）——`)
  for (const r of out.results) {
    lines.push(`${r.present ? '✅' : '❌'} ${r.template} · ${r.node} → ${r.provider}/${r.model}${r.present ? '' : '（不在当前可用目录）'}`)
  }
  if (!out.ok) {
    lines.push(`❌ ${out.missing.length} 个节点默认绑定指向当前目录不存在的模型，清单如下：`)
    for (const m of out.missing) lines.push(`   - ${m.template} / ${m.node}：${m.provider}/${m.model}`)
  } else {
    lines.push('✅ 全部默认绑定 ∈ 当前可用模型目录')
  }
  return lines.join('\n')
}

function main(argv) {
  const opts = parseArgs(argv)
  const catalogPath = opts.catalog || process.env.TEMPLATE_BINDING_CATALOG || null
  const { catalog, reason } = loadCatalog(catalogPath)
  if (!catalog) {
    const out = { skipped: true, skipReason: reason }
    console.log(opts.format === 'json' ? JSON.stringify(out, null, 2) : renderText(out))
    return 0
  }
  const bindingsByTemplate = {}
  for (const id of AUDITED_TEMPLATES) {
    const file = join(TPL_DIR, id + '.json')
    if (!existsSync(file)) {
      console.error(`模板缺失：${file}`)
      return 1
    }
    const bp = JSON.parse(readFileSync(file, 'utf-8'))
    bindingsByTemplate[id] = (bp.bindings && bp.bindings.models) || {}
  }
  const audit = auditBindings(bindingsByTemplate, catalog)
  const out = { skipped: false, ok: audit.ok, results: audit.results, missing: audit.missing }
  console.log(opts.format === 'json' ? JSON.stringify(out, null, 2) : renderText(out))
  return audit.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
