#!/usr/bin/env node
// 建设交接包最小 JSON Schema 校验器（零依赖，可被其他 cwf-*.mjs 导入）
// 覆盖 handoff.schema.json 实际用到的 draft-07 子集：
//   type / properties / required / additionalProperties / items
//   enum / const / oneOf / anyOf / allOf / if / then / not / $ref
//   minItems / maxItems / minLength / pattern / minimum
// 直跑用法：node scripts/cwf-validate.mjs <schema.json> <record.json> [...]
//           exit 0 全部通过；exit 1 至少一条失败（错误打印到 stderr）
// 导入用法：import { validateRecord } from './cwf-validate.mjs'
//           validateRecord(schema, data) -> string[]（错误列表，空 = 通过）

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MAX_DEPTH = 64

function fmtPath(p) {
  return p === '' ? '(root)' : p
}

function validate(schema, data, path, rootSchema, errors, depth) {
  if (depth > MAX_DEPTH) {
    errors.push(`${fmtPath(path)}: 超出最大嵌套深度`)
    return
  }
  if (schema === true || schema === undefined) return
  if (schema === false) {
    errors.push(`${fmtPath(path)}: schema 禁止该值`)
    return
  }
  if (typeof schema !== 'object' || schema === null) {
    errors.push(`${fmtPath(path)}: 非法 schema 片段`)
    return
  }

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, rootSchema)
    if (!resolved) {
      errors.push(`${fmtPath(path)}: 无法解析 $ref ${schema.$ref}`)
      return
    }
    validate(resolved, data, path, rootSchema, errors, depth + 1)
  }

  if (schema.type) {
    if (!typeMatch(schema.type, data)) {
      errors.push(`${fmtPath(path)}: 类型不符（期望 ${schema.type}，实际 ${jsonType(data)}）`)
      return
    }
  }

  if (schema.enum) {
    if (!schema.enum.some(v => deepEqual(v, data))) {
      errors.push(`${fmtPath(path)}: 值不在枚举内（期望 ${JSON.stringify(schema.enum)}）`)
    }
  }
  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, data)) {
      errors.push(`${fmtPath(path)}: 值必须恒等于 ${JSON.stringify(schema.const)}`)
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${fmtPath(path)}: 长度不足 ${schema.minLength}`)
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(data)) {
          errors.push(`${fmtPath(path)}: 不匹配 pattern ${schema.pattern}`)
        }
      } catch {
        errors.push(`${fmtPath(path)}: 非法 pattern ${schema.pattern}`)
      }
    }
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${fmtPath(path)}: 小于 minimum ${schema.minimum}`)
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${fmtPath(path)}: 数组少于 minItems ${schema.minItems}`)
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push(`${fmtPath(path)}: 数组多于 maxItems ${schema.maxItems}`)
    }
    if (schema.items) {
      data.forEach((item, i) => {
        validate(schema.items, item, `${path}/${i}`, rootSchema, errors, depth + 1)
      })
    }
  }

  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const props = schema.properties || {}
    const required = schema.required || []
    for (const k of required) {
      if (!(k in data)) {
        errors.push(`${fmtPath(path)}: 缺少必需属性 ${k}`)
      }
    }
    for (const [k, subSchema] of Object.entries(props)) {
      if (k in data) {
        validate(subSchema, data[k], `${path}/${k}`, rootSchema, errors, depth + 1)
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) {
        if (!(k in props)) {
          errors.push(`${fmtPath(path)}: 不允许额外属性 ${k}`)
        }
      }
    } else if (typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(data)) {
        if (!(k in props)) {
          validate(schema.additionalProperties, data[k], `${path}/${k}`, rootSchema, errors, depth + 1)
        }
      }
    }
  }

  if (schema.allOf) {
    for (const sub of schema.allOf) {
      validate(sub, data, path, rootSchema, errors, depth + 1)
    }
  }
  if (schema.anyOf) {
    const matched = schema.anyOf.some(sub => subValidates(sub, data, rootSchema, depth + 1))
    if (!matched) {
      errors.push(`${fmtPath(path)}: 不匹配 anyOf 任何分支`)
    }
  }
  if (schema.oneOf) {
    const branchErrors = schema.oneOf.map(sub => collectErrors(sub, data, path, rootSchema, depth + 1))
    const matchCount = branchErrors.filter(errs => errs.length === 0).length
    if (matchCount !== 1) {
      errors.push(`${fmtPath(path)}: oneOf 必须恰好匹配 1 个分支（实际 ${matchCount}）`)
      if (matchCount === 0) {
        appendOneOfNearestCauses(errors, path, schema.oneOf, branchErrors, data)
      }
    }
  }
  if (schema.if) {
    const ifOk = subValidates(schema.if, data, rootSchema, depth + 1)
    if (ifOk && schema.then) {
      validate(schema.then, data, path, rootSchema, errors, depth + 1)
    }
    if (!ifOk && schema.else) {
      validate(schema.else, data, path, rootSchema, errors, depth + 1)
    }
  }
  if (schema.not) {
    if (subValidates(schema.not, data, rootSchema, depth + 1)) {
      errors.push(`${fmtPath(path)}: 不允许匹配 not 分支`)
    }
  }
}

function collectErrors(schema, data, path, rootSchema, depth) {
  const errors = []
  validate(schema, data, path, rootSchema, errors, depth)
  return errors
}

function subValidates(schema, data, rootSchema, depth) {
  return collectErrors(schema, data, '(sub)', rootSchema, depth).length === 0
}

/** 从 oneOf 分支 schema 取可读标签（优先 properties.*.const，否则 #index） */
function oneOfBranchLabel(sub, index) {
  if (sub && typeof sub === 'object' && sub.properties && typeof sub.properties === 'object') {
    for (const sch of Object.values(sub.properties)) {
      if (sch && typeof sch === 'object' && sch.const !== undefined) {
        return String(sch.const)
      }
    }
  }
  return `#${index}`
}

/** 分支顶层 const 判别字段是否与 data 一致（无 const 判别则视为候选） */
function oneOfDiscriminatorMatches(sub, data) {
  if (!sub || typeof sub !== 'object' || !sub.properties) return true
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return true
  for (const [key, sch] of Object.entries(sub.properties)) {
    if (!sch || typeof sch !== 'object' || sch.const === undefined) continue
    if (!(key in data) || !deepEqual(data[key], sch.const)) return false
  }
  return true
}

/**
 * oneOf 全不匹配时追加各（候选）分支最近因。
 * 有判别字段命中的分支优先；否则回退到错误数最少的分支，避免把其它 record_type 的 const 噪声全刷出来。
 */
function appendOneOfNearestCauses(errors, path, branches, branchErrors, data) {
  const indexed = branches.map((sub, i) => ({
    i,
    label: oneOfBranchLabel(sub, i),
    errs: branchErrors[i],
    discOk: oneOfDiscriminatorMatches(sub, data),
  }))
  let selected = indexed.filter(b => b.discOk && b.errs.length > 0)
  if (selected.length === 0) {
    const min = Math.min(...indexed.map(b => b.errs.length))
    selected = indexed.filter(b => b.errs.length === min)
  }
  const prefix = `${fmtPath(path)}: `
  for (const b of selected) {
    // 每分支最多 3 条最近因，去掉与汇总行重复的路径前缀噪音
    for (const err of b.errs.slice(0, 3)) {
      const detail = err.startsWith(prefix) ? err.slice(prefix.length) : err
      errors.push(`${fmtPath(path)}: 分支 ${b.label}：${detail}`)
    }
  }
}

function resolveRef(ref, rootSchema) {
  if (!ref.startsWith('#/')) return null
  const parts = ref.slice(2).split('/')
  let cur = rootSchema
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) return null
    cur = cur[p]
  }
  return cur
}

function typeMatch(type, data) {
  switch (type) {
    case 'string': return typeof data === 'string'
    case 'number': return typeof data === 'number'
    case 'integer': return Number.isInteger(data)
    case 'boolean': return typeof data === 'boolean'
    case 'array': return Array.isArray(data)
    case 'object': return typeof data === 'object' && data !== null && !Array.isArray(data)
    case 'null': return data === null
    default: return false
  }
}

function jsonType(data) {
  if (data === null) return 'null'
  if (Array.isArray(data)) return 'array'
  if (Number.isInteger(data)) return 'integer'
  if (typeof data === 'number') return 'number'
  return typeof data
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => k in b && deepEqual(a[k], b[k]))
}

export { deepEqual }

export function validateRecord(schema, data) {
  const errors = []
  validate(schema, data, '', schema, errors, 0)
  return errors
}

function main() {
  const [schemaPath, ...recordPaths] = process.argv.slice(2)
  if (!schemaPath || recordPaths.length === 0) {
    console.error('用法: node scripts/cwf-validate.mjs <schema.json> <record.json> [...]')
    process.exit(2)
  }
  let schema
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf-8'))
  } catch (e) {
    console.error(`schema 读取失败: ${e.message}`)
    process.exit(2)
  }
  let allOk = true
  for (const rp of recordPaths) {
    let record
    try {
      record = JSON.parse(readFileSync(rp, 'utf-8'))
    } catch (e) {
      console.error(`${rp}: JSON 读取失败: ${e.message}`)
      allOk = false
      continue
    }
    const errors = validateRecord(schema, record)
    if (errors.length === 0) {
      console.log(`${rp} valid`)
    } else {
      console.log(`${rp} invalid`)
      for (const e of errors) console.error(`  ${e}`)
      allOk = false
    }
  }
  process.exit(allOk ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
