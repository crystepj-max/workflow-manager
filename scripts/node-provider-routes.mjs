import { randomBytes } from 'node:crypto'

const DEFAULT_ROUTE_TTL_MS = 12 * 60 * 60 * 1000
const MAX_ROUTE_TTL_MS = 24 * 60 * 60 * 1000

export function createProviderRoutes(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('route input must be an object')
  if (typeof input.logical_run_id !== 'string' || !input.logical_run_id.trim()) throw new Error('logical_run_id is required')
  if (typeof input.work_root !== 'string' || !input.work_root.startsWith('/')) throw new Error('work_root must be absolute')
  if (input.isolation_guarantee !== 'enforced') throw new Error('node routes require enforced isolation')
  const ttlMs = input.ttl_ms === undefined ? DEFAULT_ROUTE_TTL_MS : input.ttl_ms
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_ROUTE_TTL_MS) throw new Error('route ttl_ms must be between 1 and 86400000')
  const dsl = input.dsl
  const nodes = dsl && Array.isArray(dsl.nodes) ? dsl.nodes.filter((node) => node && typeof node.id === 'string' && node.id && !node.mechanical) : []
  if (!nodes.length || nodes.length > 1000) throw new Error('dsl must contain 1–1000 model nodes')
  const ids = new Set()
  const routes = []
  const tokens = { nodes: Object.create(null), attribution: Object.create(null) }
  const models = dsl.bindings && dsl.bindings.models || {}
  const overrides = input.model_overrides && typeof input.model_overrides === 'object' ? input.model_overrides : {}
  for (const node of nodes) {
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw new Error('node id must be non-empty and unique')
    if (typeof node.profile !== 'string' || !node.profile) throw new Error('node profile is required')
    ids.add(node.id)
    const base = node.model && typeof node.model === 'object' ? node.model : (models[node.id] || {})
    const override = overrides[node.id] || overrides.$default || {}
    const provider = typeof override.provider === 'string' && override.provider ? override.provider : (typeof base.provider === 'string' ? base.provider : '')
    const model = typeof override.model === 'string' && override.model ? override.model : (typeof base.model === 'string' ? base.model : '')
    let token
    do { token = randomBytes(32).toString('hex') } while (routes.some((route) => route.token === token))
    routes.push({
      token, logicalRunId: input.logical_run_id, workRoot: input.work_root, nodeId: node.id,
      nodeFolderId: 'route-' + token.slice(0, 24), attributionFolderId: 'route-' + token.slice(0, 24) + '-attribution',
      profile: node.profile, nodeCapabilities: node.node_capabilities || null, provider, model,
      isolationGuarantee: input.isolation_guarantee,
    })
    tokens.nodes[node.id] = token
    tokens.attribution[node.id] = token
  }
  return { ok: true, expiresAt: Date.now() + ttlMs, tokens, routes }
}
