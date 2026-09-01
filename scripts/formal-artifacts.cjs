// Formal Artifact 共享内核（#69）：Blueprint kind ↔ Formal Record media_type 映射
// 与产物解析。CommonJS 供 validate-core / VWF host vm 求值；formal-records.mjs 经 createRequire 复用。
'use strict'

const FILE_KINDS = ['json', 'markdown', 'text', 'html', 'canvas', 'flowchart', 'diagram']

const KIND_TO_MEDIA = {
  json: 'application/json',
  markdown: 'text/markdown',
  text: 'text/plain',
  html: 'text/html',
  canvas: 'application/vnd.workflow.canvas+json',
  flowchart: 'application/vnd.workflow.flowchart+json',
  diagram: 'application/vnd.workflow.diagram+json',
}

const JSON_KINDS = new Set(['json', 'canvas', 'flowchart', 'diagram'])

function blueprintKindToMediaType(kind) {
  const media = KIND_TO_MEDIA[kind]
  if (!media) throw new Error('非法 artifact kind: ' + kind)
  return media
}

function parseArtifactBody(kind, rawContent) {
  const media = blueprintKindToMediaType(kind)
  if (JSON_KINDS.has(kind)) {
    const value = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent
    return { media_type: media, value }
  }
  const value = typeof rawContent === 'string' ? rawContent : String(rawContent ?? '')
  return { media_type: media, value }
}

function artifactRecordId(runId, nodeId, filePath) {
  return 'artifact:' + runId + ':' + nodeId + ':' + filePath
}

// 向已有 Record 快照追加 Artifact（host 侧无完整 Store 时的轻量摄入）
function ingestArtifacts(existingRecords, input) {
  const { runId, nodeId, artifacts, provenance, outcome } = input
  if (!runId || !nodeId || !Array.isArray(artifacts)) {
    throw new Error('ingestArtifacts 需要 runId、nodeId 与 artifacts 数组')
  }
  const byId = new Map()
  for (const r of existingRecords || []) {
    if (!byId.has(r.record_id)) byId.set(r.record_id, [])
    byId.get(r.record_id).push(r)
  }
  const produced = []
  const baseProv = provenance && typeof provenance === 'object' ? provenance : {}
  for (const art of artifacts) {
    if (!art || typeof art.path !== 'string' || !art.path.trim()) {
      throw new Error('artifact.path 必填')
    }
    if (!FILE_KINDS.includes(art.kind)) {
      throw new Error('非法 artifact kind: ' + art.kind)
    }
    const recordId = artifactRecordId(runId, nodeId, art.path)
    const revs = byId.get(recordId) || []
    const prevRev = revs.length ? Math.max(...revs.map((r) => r.record_revision)) : null
    const nextRev = prevRev ? prevRev + 1 : 1
    const body = parseArtifactBody(art.kind, art.content)
    const dependencies = []
    if (prevRev) dependencies.push({ record_id: recordId, record_revision: prevRev })
    const record = {
      record_id: recordId,
      record_revision: nextRev,
      kind: 'result',
      body,
      dependencies,
      provenance: {
        logical_run_id: baseProv.logical_run_id || runId,
        node: nodeId,
        attempt: baseProv.attempt || 1,
        snapshot_revision: baseProv.snapshot_revision || 'unspecified',
        provider: baseProv.provider || 'unknown',
        model: baseProv.model || 'unknown',
        produced_by: baseProv.produced_by || 'unknown',
        node_business_outcome: outcome === undefined ? null : outcome,
      },
      created_at: new Date().toISOString(),
    }
    if (prevRev) record.based_on = { record_id: recordId, record_revision: prevRev }
    produced.push(record)
    if (!byId.has(recordId)) byId.set(recordId, [])
    byId.get(recordId).push(record)
  }
  return [...(existingRecords || []), ...produced]
}

function artifactFormatHint(kind) {
  switch (kind) {
    case 'html': return '（完整 HTML 文档，写入 runDir 相对路径）'
    case 'canvas': return '（JSON：nodes/edges/layout 画布结构）'
    case 'flowchart': return '（JSON：流程图 nodes/edges 或 { source, graph }）'
    case 'diagram': return '（JSON：结构图 nodes/edges 或等价图结构）'
    default: return ''
  }
}

module.exports = {
  FILE_KINDS,
  KIND_TO_MEDIA,
  JSON_KINDS,
  blueprintKindToMediaType,
  parseArtifactBody,
  artifactRecordId,
  ingestArtifacts,
  artifactFormatHint,
}
