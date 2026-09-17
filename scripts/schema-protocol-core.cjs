// Blueprint Schema 协议 1.0 — 共享校验语义（静态 schema 审计 + 运行时实例校验）
// 消费方：validate-core.cjs（蓝图静态门）、generate.mjs（编译产物嵌入）、
// runtime-harness、测试。Portable 仍走 cwf-validate.mjs 独立契约。

const PROTOCOL_VERSION = '1.0'
const SUPPORTED_MAJOR = 1

const EXECUTION_KEYWORDS = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern',
  'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
])

const LEGACY_EXECUTION_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])

const ANNOTATION_KEYWORDS = new Set([
  'title', 'description', '$comment', 'examples', 'default', '$schema',
])

const REJECTED_KEYWORDS = new Set([
  '$ref', 'format', 'uniqueItems', 'unevaluatedProperties',
])

const IMPLEMENTED_CAPABILITIES = new Set(EXECUTION_KEYWORDS)

const MAX_DEPTH = 64

function fmtPath(p) {
  return p === '' ? '(root)' : p
}

function codePointLength(s) {
  let n = 0
  for (const _ of s) n++
  return n
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((k) => deepEqual(a[k], b[k]))
}

function jsonType(data) {
  if (data === null) return 'null'
  if (Array.isArray(data)) return 'array'
  if (Number.isInteger(data)) return 'integer'
  if (typeof data === 'number') return 'number'
  return typeof data
}

function typeMatch(type, data) {
  const types = Array.isArray(type) ? type : [type]
  return types.some((t) => {
    switch (t) {
      case 'string': return typeof data === 'string'
      case 'number': return typeof data === 'number' && Number.isFinite(data)
      case 'integer': return Number.isInteger(data)
      case 'boolean': return typeof data === 'boolean'
      case 'array': return Array.isArray(data)
      case 'object': return typeof data === 'object' && data !== null && !Array.isArray(data)
      case 'null': return data === null
      default: return false
    }
  })
}

function parseProtocolVersion(version) {
  if (typeof version !== 'string' || !version.trim()) return null
  const m = /^(\d+)\.(\d+)$/.exec(version.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), raw: version.trim() }
}

function resolveProtocol(bp) {
  if (!bp || bp.protocol === undefined || bp.protocol === null) {
    return {
      mode: 'legacy-unversioned',
      version: null,
      required_capabilities: [],
      legacy: true,
    }
  }
  const p = bp.protocol
  if (typeof p !== 'object' || Array.isArray(p)) {
    return { mode: 'invalid', version: null, required_capabilities: [], error: 'protocol 必须是对象' }
  }
  const caps = Array.isArray(p.required_capabilities) ? p.required_capabilities.slice() : null
  return {
    mode: 'versioned',
    version: typeof p.version === 'string' ? p.version.trim() : null,
    required_capabilities: caps || [],
    legacy: false,
    declaration: p,
  }
}

function validateProtocolDeclaration(protocol) {
  const errors = []
  if (protocol === undefined || protocol === null) return errors
  const at = '$.protocol'
  if (typeof protocol !== 'object' || Array.isArray(protocol)) {
    errors.push({ at, message: 'protocol 必须是对象 { version, required_capabilities }' })
    return errors
  }
  const parsed = parseProtocolVersion(protocol.version)
  if (!parsed) {
    errors.push({ at: at + '.version', message: 'protocol.version 须为 major.minor 字符串（如 "1.0"）' })
  } else if (parsed.major !== SUPPORTED_MAJOR) {
    errors.push({ at: at + '.version', message: '不支持的主版本 ' + protocol.version + '（当前实现仅支持 1.x）' })
  }
  if (!Array.isArray(protocol.required_capabilities)) {
    errors.push({ at: at + '.required_capabilities', message: 'required_capabilities 必须是字符串数组' })
  } else {
    const seen = new Set()
    protocol.required_capabilities.forEach((cap, i) => {
      const key = at + '.required_capabilities[' + i + ']'
      if (typeof cap !== 'string' || !cap.trim()) {
        errors.push({ at: key, message: '能力项必须是非空字符串' })
        return
      }
      if (!EXECUTION_KEYWORDS.has(cap)) {
        errors.push({ at: key, message: '未知能力关键字：' + cap })
        return
      }
      if (!IMPLEMENTED_CAPABILITIES.has(cap)) {
        errors.push({ at: key, message: '能力尚未实现：' + cap })
        return
      }
      if (seen.has(cap)) errors.push({ at: key, message: '重复声明能力：' + cap })
      seen.add(cap)
    })
  }
  return errors
}

function checkProtocolGate(resolved) {
  const errors = []
  if (!resolved || resolved.mode === 'legacy-unversioned') return errors
  if (resolved.mode === 'invalid') {
    errors.push({ at: '$.protocol', message: resolved.error || 'protocol 无效' })
    return errors
  }
  const parsed = parseProtocolVersion(resolved.version)
  if (!parsed) {
    errors.push({ at: '$.protocol.version', message: 'protocol.version 无效' })
    return errors
  }
  if (parsed.major !== SUPPORTED_MAJOR) {
    errors.push({ at: '$.protocol.version', message: '不支持的主版本 ' + resolved.version })
    return errors
  }
  for (const cap of resolved.required_capabilities) {
    if (!IMPLEMENTED_CAPABILITIES.has(cap)) {
      errors.push({ at: '$.protocol.required_capabilities', message: '未实现的必需能力：' + cap })
    }
  }
  return errors
}

function walkSchemaNodes(schema, visitor, depth) {
  if (depth > MAX_DEPTH) {
    visitor(schema, depth, 'depth')
    return
  }
  if (schema === true || schema === false || schema === undefined || schema === null) return
  if (typeof schema !== 'object') return
  visitor(schema, depth, 'node')
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((s) => walkSchemaNodes(s, visitor, depth + 1))
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((s) => walkSchemaNodes(s, visitor, depth + 1))
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((s) => walkSchemaNodes(s, visitor, depth + 1))
  if (schema.not) walkSchemaNodes(schema.not, visitor, depth + 1)
  if (schema.if) walkSchemaNodes(schema.if, visitor, depth + 1)
  if (schema.then) walkSchemaNodes(schema.then, visitor, depth + 1)
  if (schema.else) walkSchemaNodes(schema.else, visitor, depth + 1)
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    walkSchemaNodes(schema.items, visitor, depth + 1)
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const sub of Object.values(schema.properties)) walkSchemaNodes(sub, visitor, depth + 1)
  }
  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    walkSchemaNodes(schema.additionalProperties, visitor, depth + 1)
  }
}

function collectExecutionKeywords(schema) {
  const found = new Set()
  walkSchemaNodes(schema, (node) => {
    for (const key of Object.keys(node)) {
      if (EXECUTION_KEYWORDS.has(key)) found.add(key)
    }
  }, 0)
  return found
}

function auditSchemaDefinition(schema, ctx) {
  const errors = []
  const warnings = []
  if (schema === undefined || schema === null) return { errors, warnings }
  const mode = (ctx && ctx.mode) || 'legacy-unversioned'
  const allowedCaps = ctx && ctx.requiredCapabilities ? new Set(ctx.requiredCapabilities) : null
  const pathPrefix = (ctx && ctx.path) || '(root)'

  walkSchemaNodes(schema, (node, depth, kind) => {
    if (kind === 'depth') {
      errors.push({ at: pathPrefix, message: 'Schema 嵌套过深' })
      return
    }
    if (Array.isArray(node.items)) {
      errors.push({ at: pathPrefix, message: 'items 仅支持单 schema，不支持 tuple 数组形式' })
    }
    for (const key of Object.keys(node)) {
      if (ANNOTATION_KEYWORDS.has(key)) continue
      if (REJECTED_KEYWORDS.has(key)) {
        errors.push({ at: pathPrefix + '/' + key, message: '不支持的执行关键字：' + key })
        continue
      }
      if (EXECUTION_KEYWORDS.has(key)) {
        if (mode === 'legacy-unversioned' && !LEGACY_EXECUTION_KEYWORDS.has(key)) {
          warnings.push({ at: pathPrefix + '/' + key, message: 'legacy-unversioned 模板使用了扩展执行关键字 ' + key + '（运行时仅落实八关键字子集；建议迁移 protocol 1.0）' })
        } else if (mode === 'versioned' && allowedCaps && !allowedCaps.has(key)) {
          errors.push({ at: pathPrefix + '/' + key, message: 'Schema 使用了未在 required_capabilities 声明的关键字：' + key })
        }
        continue
      }
      if (key === 'items' && Array.isArray(node.items)) continue
      errors.push({ at: pathPrefix + '/' + key, message: '未知 Schema 关键字：' + key })
    }
  }, 0)

  return { errors, warnings }
}

function subValidates(schema, data, rootSchema, depth, mode) {
  const errors = []
  validateInstance(schema, data, '(sub)', rootSchema, errors, depth, mode)
  return errors.length === 0
}

function validateInstance(schema, data, path, rootSchema, errors, depth, mode) {
  if (depth === undefined) depth = 0
  if (errors === undefined) errors = []
  if (rootSchema === undefined) rootSchema = schema
  if (mode === undefined) mode = '1.0'
  if (depth > MAX_DEPTH) {
    errors.push(fmtPath(path) + ': 超出最大嵌套深度')
    return errors
  }
  if (schema === true || schema === undefined) return errors
  if (schema === false) {
    errors.push(fmtPath(path) + ': schema 禁止该值')
    return errors
  }
  if (typeof schema !== 'object' || schema === null) {
    errors.push(fmtPath(path) + ': 非法 schema 片段')
    return errors
  }

  if (schema.type) {
    if (!typeMatch(schema.type, data)) {
      errors.push(fmtPath(path) + ': 类型不符（期望 ' + JSON.stringify(schema.type) + '，实际 ' + jsonType(data) + '）')
      return errors
    }
  }

  if (schema.enum) {
    if (!schema.enum.some((v) => deepEqual(v, data))) {
      errors.push(fmtPath(path) + ': 值不在枚举内')
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, data)) {
    errors.push(fmtPath(path) + ': 值必须恒等于 ' + JSON.stringify(schema.const))
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && codePointLength(data) < schema.minLength) {
      errors.push(fmtPath(path) + ': 长度不足 minLength ' + schema.minLength)
    }
    if (schema.maxLength !== undefined && codePointLength(data) > schema.maxLength) {
      errors.push(fmtPath(path) + ': 长度超过 maxLength ' + schema.maxLength)
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(data)) {
          errors.push(fmtPath(path) + ': 不匹配 pattern')
        }
      } catch {
        errors.push(fmtPath(path) + ': 非法 pattern')
      }
    }
  }

  if (typeof data === 'number') {
    if (!Number.isFinite(data)) {
      errors.push(fmtPath(path) + ': 数字必须是有限值')
    }
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(fmtPath(path) + ': 小于 minimum ' + schema.minimum)
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(fmtPath(path) + ': 大于 maximum ' + schema.maximum)
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(fmtPath(path) + ': 数组少于 minItems ' + schema.minItems)
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push(fmtPath(path) + ': 数组多于 maxItems ' + schema.maxItems)
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      data.forEach((item, i) => {
        validateInstance(schema.items, item, path + '/' + i, rootSchema, errors, depth + 1, mode)
      })
    }
  }

  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const props = schema.properties || {}
    for (const k of schema.required || []) {
      if (!(k in data)) errors.push(fmtPath(path) + ': 缺少必需属性 ' + k)
    }
    for (const [k, subSchema] of Object.entries(props)) {
      if (k in data) validateInstance(subSchema, data[k], path + '/' + k, rootSchema, errors, depth + 1, mode)
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) {
        if (!(k in props)) errors.push(fmtPath(path) + ': 不允许额外属性 ' + k)
      }
    } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
      for (const k of Object.keys(data)) {
        if (!(k in props)) {
          validateInstance(schema.additionalProperties, data[k], path + '/' + k, rootSchema, errors, depth + 1, mode)
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateInstance(sub, data, path, rootSchema, errors, depth + 1, mode)
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((sub) => subValidates(sub, data, rootSchema, depth + 1, mode))) {
      errors.push(fmtPath(path) + ': 不匹配 anyOf 任何分支')
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => subValidates(sub, data, rootSchema, depth + 1, mode))
    if (matches.length !== 1) {
      errors.push(fmtPath(path) + ': oneOf 必须恰好匹配 1 个分支（实际 ' + matches.length + '）')
    }
  }
  if (schema.not && subValidates(schema.not, data, rootSchema, depth + 1, mode)) {
    errors.push(fmtPath(path) + ': 不允许匹配 not 分支')
  }
  if (schema.if) {
    const ifOk = subValidates(schema.if, data, rootSchema, depth + 1, mode)
    if (ifOk && schema.then) validateInstance(schema.then, data, path, rootSchema, errors, depth + 1, mode)
    if (!ifOk && schema.else) validateInstance(schema.else, data, path, rootSchema, errors, depth + 1, mode)
  }
  return errors
}

function validateInstanceSimple(schema, data, mode) {
  const errors = []
  validateInstance(schema, data, '', schema, errors, 0, mode || '1.0')
  return errors
}

function instanceValid(schema, data, mode) {
  return validateInstanceSimple(schema, data, mode).length === 0
}

function legacyInstanceValid(schema, data) {
  return instanceValid(schema, data, 'legacy')
}

function freezeProtocolSnapshot(bp, scriptDigest) {
  const resolved = resolveProtocol(bp)
  return {
    protocol_version: resolved.version,
    mode: resolved.mode,
    required_capabilities: resolved.required_capabilities.slice(),
    script_digest: scriptDigest || null,
    frozen_at: new Date().toISOString(),
  }
}

function buildRuntimeEnvelope(ctx) {
  const c = ctx || {}
  return {
    protocol_version: c.protocol_version === undefined ? null : c.protocol_version,
    mode: c.mode || 'legacy-unversioned',
    run_id: c.run_id || null,
    node_id: c.node_id || null,
    host_call_id: c.host_call_id || null,
    script_digest: c.script_digest || null,
    model: c.model || null,
    inputs: c.inputs || null,
    outputs: c.outputs || null,
    decision_ref: c.decision_ref || null,
    attempt_ref: c.attempt_ref === undefined ? 'unavailable' : c.attempt_ref,
    payload: c.payload === undefined ? null : c.payload,
    producer: c.producer || 'workflow-runtime',
    consumer: c.consumer || 'workflow-runtime',
  }
}

function auditBlueprintSchemas(bp) {
  const errors = []
  const warnings = []
  const resolved = resolveProtocol(bp)
  if (resolved.mode === 'invalid') {
    errors.push({ at: '$.protocol', message: resolved.error })
    return { errors, warnings }
  }
  if (resolved.mode === 'legacy-unversioned') {
    warnings.push({ at: '$.protocol', message: '蓝图未声明 protocol，按 legacy-unversioned 兼容读取' })
  }
  errors.push(...validateProtocolDeclaration(bp.protocol))
  errors.push(...checkProtocolGate(resolved))

  const mode = resolved.mode === 'versioned' ? 'versioned' : 'legacy-unversioned'
  const caps = resolved.required_capabilities
  const usedAll = new Set()

  for (const n of bp.nodes || []) {
    if (!n || !n.output || !n.output.schema) continue
    collectExecutionKeywords(n.output.schema).forEach((k) => usedAll.add(k))
    const nodeAudit = auditSchemaDefinition(n.output.schema, {
      mode,
      requiredCapabilities: caps,
      path: '$.nodes[' + n.id + '].output.schema',
    })
    errors.push(...nodeAudit.errors)
    warnings.push(...nodeAudit.warnings)
  }

  if (mode === 'versioned') {
    for (const cap of caps) {
      if (!usedAll.has(cap)) {
        errors.push({ at: '$.protocol.required_capabilities', message: '声明了未在任何 output.schema 中使用的关键字：' + cap })
      }
    }
    for (const cap of usedAll) {
      if (!caps.includes(cap)) {
        errors.push({ at: '$.protocol.required_capabilities', message: 'output.schema 使用了未声明的能力：' + cap })
      }
    }
  }
  return { errors, warnings }
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_MAJOR,
  EXECUTION_KEYWORDS,
  LEGACY_EXECUTION_KEYWORDS,
  ANNOTATION_KEYWORDS,
  REJECTED_KEYWORDS,
  IMPLEMENTED_CAPABILITIES,
  resolveProtocol,
  parseProtocolVersion,
  validateProtocolDeclaration,
  checkProtocolGate,
  collectExecutionKeywords,
  auditSchemaDefinition,
  auditBlueprintSchemas,
  validateInstance,
  validateInstanceSimple,
  instanceValid,
  legacyInstanceValid,
  freezeProtocolSnapshot,
  buildRuntimeEnvelope,
}
