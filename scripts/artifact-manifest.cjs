// LOC-035 产物清单内核：声明、核验、不可变快照与 manifest 索引。
// 消费方：宿主（host.js）经 dist loadDist 加载；测试直接 require。
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const LINE_TAG = '[am-submit]'
const MANIFEST_RECORD_PREFIX = 'artifact_manifest:'

const KIND_TO_MEDIA = {
  json: 'application/json',
  markdown: 'text/markdown',
  text: 'text/plain',
  html: 'text/html',
  canvas: 'application/vnd.workflow.canvas+json',
  flowchart: 'application/vnd.workflow.flowchart+json',
  diagram: 'application/vnd.workflow.diagram+json',
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function manifestRecordId(logicalRunId, nodeId) {
  return MANIFEST_RECORD_PREFIX + String(logicalRunId || '') + ':' + String(nodeId || '')
}

function identityKey(entry) {
  return [
    String(entry.producer_attempt_id || ''),
    String(entry.round_id == null ? '' : entry.round_id),
    String(entry.item_id == null ? '' : entry.item_id),
    String(entry.logical_name || ''),
  ].join('\0')
}

// 蓝图 output.files → 声明条目（旧字符串形态默认 required=true）
function declarationsFromOutputFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return []
  const out = []
  for (const [rel, spec] of Object.entries(files)) {
    if (typeof spec === 'string') {
      out.push({
        logical_name: rel,
        relative_path: rel,
        media_type: KIND_TO_MEDIA[spec] || 'application/octet-stream',
        kind: spec,
        required: true,
        allow_empty: false,
      })
    } else if (spec && typeof spec === 'object') {
      const kind = String(spec.kind || spec.type || 'text')
      out.push({
        logical_name: rel,
        relative_path: rel,
        media_type: KIND_TO_MEDIA[kind] || String(spec.media_type || 'application/octet-stream'),
        kind,
        required: spec.required !== false,
        allow_empty: spec.allow_empty === true,
        sha256: spec.sha256 === undefined ? null : String(spec.sha256),
      })
    }
  }
  return out
}

function parseSubmitRequest(message) {
  const raw = String(message || '')
  const idx = raw.indexOf(LINE_TAG)
  if (idx < 0) return null
  let req = null
  try { req = JSON.parse(raw.slice(idx + LINE_TAG.length)) } catch (e) { return null }
  if (!req || typeof req !== 'object' || !req.node || !Array.isArray(req.entries)) return null
  return req
}

function resolveAuthRoot(cwd, runDirRel) {
  const base = cwd ? path.resolve(cwd, runDirRel) : path.resolve(runDirRel)
  try { return fs.realpathSync.native ? fs.realpathSync.native(base) : fs.realpathSync(base) } catch (e) { return path.resolve(base) }
}

function isPathInside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function verifyEntry(authRoot, entry) {
  const logical = String(entry.logical_name || '')
  const rel = String(entry.relative_path || logical)
  if (!logical) return failEntry('MISSING_LOGICAL_NAME', 'logical_name 必填', logical)
  if (!rel || rel.startsWith('/') || rel.includes('..')) {
    return failEntry('PATH_TRAVERSAL', '拒绝绝对路径或 .. 越界：' + rel, logical)
  }
  const abs = path.resolve(authRoot, rel)
  if (!isPathInside(authRoot, abs)) {
    return failEntry('PATH_OUTSIDE_ROOT', '路径越出授权根：' + rel, logical)
  }
  let realAbs = abs
  try { realAbs = fs.realpathSync(abs) } catch (e) {
    if (entry.required === false) {
      return okEntry(logical, rel, entry, null, 'missing_optional')
    }
    return failEntry('FILE_MISSING', '必需文件缺失：' + rel, logical)
  }
  if (!isPathInside(authRoot, realAbs)) {
    return failEntry('SYMLINK_ESCAPE', '符号链接越出授权根：' + rel, logical)
  }
  let st
  try { st = fs.statSync(realAbs) } catch (e) {
    if (entry.required === false) {
      return okEntry(logical, rel, entry, null, 'missing_optional')
    }
    return failEntry('FILE_MISSING', '必需文件缺失：' + rel, logical)
  }
  if (!st.isFile()) {
    return failEntry('NOT_REGULAR_FILE', '只允许普通可读文件：' + rel, logical)
  }
  let buf
  try { buf = fs.readFileSync(realAbs) } catch (e) {
    return failEntry('NOT_READABLE', '文件不可读：' + rel, logical)
  }
  if (buf.length === 0 && entry.required !== false && entry.allow_empty !== true) {
    return failEntry('EMPTY_REQUIRED', '默认不允许空字节必需文件：' + rel, logical)
  }
  const digest = sha256Hex(buf)
  if (entry.sha256 && String(entry.sha256).toLowerCase() !== digest) {
    return failEntry('DIGEST_MISMATCH', '摘要不符：声称 ' + entry.sha256 + '，实际 ' + digest, logical)
  }
  return okEntry(logical, rel, entry, { buf, digest, abs }, 'verified')
}

function failEntry(code, message, logical_name) {
  return {
    logical_name,
    verification_status: 'rejected',
    rejection_code: code,
    rejection_reason: message,
    ref: null,
  }
}

function okEntry(logical_name, rel, entry, payload, status) {
  const base = {
    logical_name,
    relative_path: rel,
    media_type: String(entry.media_type || 'application/octet-stream'),
    required: entry.required !== false,
    allow_empty: entry.allow_empty === true,
    verification_status: status,
    rejection_code: null,
    rejection_reason: null,
    byte_length: payload ? payload.buf.length : 0,
    sha256: payload ? payload.digest : null,
    ref: null,
    _payload: payload || null,
  }
  return base
}

function copySnapshot(authRoot, snapRoot, revision, item) {
  if (!item.buf) return null
  const rel = String(item.relative_path)
  const destDir = path.join(snapRoot, 'r' + revision, String(item.producer_attempt_id || 'a0'), String(item.round_id == null ? '0' : item.round_id), String(item.item_id == null ? '_' : item.item_id))
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, path.basename(rel))
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest)
    if (Buffer.compare(existing, item.buf) !== 0) {
      throw new Error('IMMUTABLE_CONFLICT：快照已存在且内容不同（' + rel + '）')
    }
  } else {
    fs.writeFileSync(dest, item.buf)
  }
  const ref = {
    record_id: 'artifact:' + item.run_id + ':' + item.node + ':' + rel,
    snapshot_path: path.relative(authRoot, dest),
    algorithm: 'sha256',
    digest: item.digest,
    source_path: rel,
  }
  return ref
}

function processSubmit(opts) {
  const { cwd, runDir, taskId, req, prevManifest } = opts
  const authRoot = resolveAuthRoot(cwd, runDir)
  const revision = Number(req.revision) || ((prevManifest && prevManifest.revision) || 0) + 1
  const seen = new Set()
  const entries = []
  const failures = []
  let hasRequiredFailure = false
  const snapRoot = path.join(authRoot, 'artifact-snapshots')

  for (const raw of req.entries) {
    const entry = Object.assign({}, raw, {
      producer_attempt_id: raw.producer_attempt_id || req.producer_attempt_id,
      round_id: raw.round_id != null ? raw.round_id : req.round_id,
      item_id: raw.item_id != null ? raw.item_id : req.item_id,
    })
    const idk = identityKey({
      producer_attempt_id: entry.producer_attempt_id,
      round_id: entry.round_id,
      item_id: entry.item_id,
      logical_name: entry.logical_name,
    })
    if (seen.has(idk)) {
      const rej = failEntry('DUPLICATE_IDENTITY', '重复产物身份：' + entry.logical_name, entry.logical_name)
      entries.push(Object.assign(rej, {
        producer_attempt_id: entry.producer_attempt_id,
        round_id: entry.round_id,
        item_id: entry.item_id,
      }))
      failures.push(rej)
      if (entry.required !== false) hasRequiredFailure = true
      continue
    }
    seen.add(idk)
    const verified = verifyEntry(authRoot, entry)
    const row = Object.assign(verified, {
      producer_attempt_id: entry.producer_attempt_id,
      round_id: entry.round_id,
      item_id: entry.item_id,
    })
    if (verified.verification_status === 'verified') {
      try {
        const ref = copySnapshot(authRoot, snapRoot, revision, {
          run_id: taskId,
          node: req.node,
          relative_path: entry.relative_path || entry.logical_name,
          producer_attempt_id: entry.producer_attempt_id,
          round_id: entry.round_id,
          item_id: entry.item_id,
          buf: verified._payload && verified._payload.buf,
          digest: verified.sha256,
        })
        row.ref = ref
        delete row._payload
      } catch (e) {
        row.verification_status = 'rejected'
        row.rejection_code = 'SNAPSHOT_FAILED'
        row.rejection_reason = String(e.message || e)
        failures.push(row)
        if (entry.required !== false) hasRequiredFailure = true
      }
    } else if (verified.verification_status === 'rejected') {
      failures.push(row)
      if (entry.required !== false) hasRequiredFailure = true
    }
    entries.push(row)
  }

  const manifest = {
    run_id: taskId,
    node: req.node,
    revision,
    producer_attempt_id: req.producer_attempt_id,
    round_id: req.round_id,
    item_id: req.item_id == null ? null : req.item_id,
    submitted_at: new Date().toISOString(),
    entries,
    materials_status: materialsStatusOf(entries),
    required_complete: !hasRequiredFailure && entries.every((e) => e.required === false || e.verification_status === 'verified' || e.verification_status === 'missing_optional'),
  }
  const manifestPath = path.join(authRoot, 'artifact-manifests', 'r' + revision + '.json')
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  for (const e of entries) delete e._payload
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  manifest.manifest_path = path.relative(authRoot, manifestPath)
  return { ok: true, manifest, failures }
}

function materialsStatusOf(entries) {
  const required = entries.filter((e) => e.required !== false)
  const verified = required.filter((e) => e.verification_status === 'verified')
  const missingOpt = entries.filter((e) => e.required === false && e.verification_status === 'missing_optional')
  const rejected = entries.filter((e) => e.verification_status === 'rejected')
  if (rejected.some((e) => e.required !== false)) return 'incomplete'
  if (verified.length < required.length) return 'incomplete'
  return 'ready'
}

function gateBlockOf(manifest, nodeId) {
  if (!manifest) return null
  if (manifest.materials_status === 'ready' || manifest.required_complete === true) return null
  const missing = (manifest.entries || []).filter((e) => e.required !== false && e.verification_status !== 'verified')
  const detail = missing.map((e) => e.logical_name + '(' + (e.rejection_reason || e.verification_status) + ')').join('；')
  return {
    code: 'ARTIFACT_MANIFEST_INCOMPLETE',
    event: 'artifact_manifest_incomplete',
    message: '验收材料未就绪（节点 ' + nodeId + '）：' + (detail || '必需产物未全部通过核验'),
    recovery_hint: '补齐缺失/损坏产物后在同一 Run 重新提交（wf_run entry=' + nodeId + '）',
    manifest_revision: manifest.revision,
    entries: manifest.entries,
  }
}

function submitPayload(opts) {
  const runDirRel = opts.runDir || ('.agent-runs/' + opts.taskId)
  return {
    cwd: opts.cwd || '',
    runDir: runDirRel,
    taskId: opts.taskId,
    req: opts.req,
    prevManifest: opts.prevManifest || null,
  }
}

function buildSubmitRequest(nodeId, ctx) {
  const entries = (ctx.entries || []).map((e) => Object.assign({}, e))
  return {
    revision: ctx.revision,
    node: nodeId,
    producer_attempt_id: ctx.producer_attempt_id,
    round_id: ctx.round_id,
    item_id: ctx.item_id == null ? null : ctx.item_id,
    entries,
  }
}

function entriesForManifestRead(manifest, pick) {
  if (!manifest || !Array.isArray(manifest.entries)) return []
  const want = pick && typeof pick === 'object' ? pick : {}
  return manifest.entries.filter((e) => {
    if (e.verification_status !== 'verified' || !e.ref) return false
    if (want.round_id != null && String(e.round_id) !== String(want.round_id)) return false
    if (want.item_id != null && String(e.item_id) !== String(want.item_id)) return false
    if (want.logical_name && e.logical_name !== want.logical_name) return false
    return true
  })
}

module.exports = {
  LINE_TAG,
  MANIFEST_RECORD_PREFIX,
  KIND_TO_MEDIA,
  sha256Hex,
  manifestRecordId,
  identityKey,
  declarationsFromOutputFiles,
  parseSubmitRequest,
  resolveAuthRoot,
  verifyEntry,
  processSubmit,
  materialsStatusOf,
  gateBlockOf,
  submitPayload,
  buildSubmitRequest,
  entriesForManifestRead,
}
