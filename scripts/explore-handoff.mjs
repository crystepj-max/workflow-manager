// wf-explore/1 的受限文件传输。只认已冻结的内置语义；不推断其他 DSL 的依赖。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import projection from './projection-core.cjs'
import schema from './schema-protocol-core.cjs'

export const EXPLORE_HANDOFF_VERSION = 'wf-explore/1'
const bundled = new URL('./explore-handoff-template.json', import.meta.url)
const blueprint = JSON.parse(readFileSync(existsSync(bundled) ? bundled : new URL('../templates/wf-explore.json', import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const encoded = value => JSON.stringify(value)
const equal = (a, b) => stable(a) === stable(b)
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function withoutModels(value, isBlueprint) {
  const result = structuredClone(value)
  if (isBlueprint) delete result.bindings
  for (const node of result.nodes) {
    delete node.model
    // 正向投影不携带此字段；显式出现时仍须与权威收紧能力相同。
    if (!isBlueprint && node.node_capabilities !== undefined) {
      if (!equal(node.node_capabilities, blueprint.nodes.find(item => item.id === node.id)?.node_capabilities)) throw new Error('探索交接节点能力与内置语义不一致')
      delete node.node_capabilities
    }
  }
  return result
}
const builtin = withoutModels(projection.projectToVwf(blueprint), false)
const digest = hash(stable(builtin))

export function exploreHandoffContract(dsl) {
  const version = dsl?.protocol?.artifact_handoff
  if (version === undefined) return null
  const isBlueprint = dsl.displayName !== undefined
  const expected = isBlueprint ? withoutModels(blueprint, true) : builtin
  if (version !== EXPLORE_HANDOFF_VERSION || (isBlueprint && dsl.bindings && Object.keys(dsl.bindings).some(key => key !== 'models'))
    || !equal(withoutModels(dsl, isBlueprint), expected)) throw new Error('探索交接只支持已冻结的内置 wf-explore/1 语义（含 goal；仅模型绑定可变）')
  return { version, digest }
}

// 所有 IO 路径都经过 node-artifacts 的同一 exact-path / symlink 检查。
export function prepareExploreHandoff(binding, node, io) {
  const spec = binding.explore_handoff
  if (!spec) return null
  if (spec.contract?.version !== EXPLORE_HANDOFF_VERSION || spec.contract.digest !== digest) throw new Error('探索交接版本与冻结语义不匹配')
  const x = spec.execution
  if (!x || !Number.isSafeInteger(x.round) || x.round < 0 || !Number.isSafeInteger(x.call) || x.call < 1
    || !/^[a-z0-9-]+$/.test(x.invocation_id || '') || !blueprint.nodes.some(n => n.id === node.id)
    || (node.id === 'research' ? x.kind !== 'item' || !Number.isSafeInteger(x.item_no) || x.item_no < 1 : x.kind !== 'node')) throw new Error('探索交接缺少可信 round/item/attempt 身份')
  const controller = spec.controller
  const allowed = { orchestrate: x.round > 0 ? ['evaluate'] : [], research: [], synthesize: ['orchestrate', 'research'], evaluate: ['orchestrate', 'research', 'synthesize'] }[node.id]
  if (!controller || controller.version !== EXPLORE_HANDOFF_VERSION || controller.node_id !== node.id || controller.phase_id !== x.round
    || controller.call_id !== x.call || controller.item_no !== (x.item_no || null) || !controller.inputs
    || Object.keys(controller.inputs).some(key => !allowed.includes(key)) || allowed.some(key => controller.inputs[key] === undefined)) throw new Error('探索控制器交接缺少当前声明输入或包含未授权来源')
  function matches(name, record) {
    if (!equal(controller.inputs[name], record.value)) throw new Error('探索控制器结果与当前宿主生产版本不一致：' + name)
  }
  const root = '.handoff/' + digest
  const slotPath = (id, round, itemNo) => root + '/round-' + round + '/' + id + (itemNo ? '-item-' + itemNo : '') + '/current.json'
  const versionPath = record => root + '/round-' + record.round_id + '/' + record.node_id + (record.item_no ? '-item-' + record.item_no : '') + '/attempt-' + record.invocation_id
  function read(id, round, itemNo, phase) {
    const rel = slotPath(id, round, itemNo)
    const value = JSON.parse(readFileSync(io.checked(rel), 'utf8'))
    if (value.contract_digest !== digest || value.task_id !== binding.taskId || value.node_id !== id || value.round_id !== round
      || value.item_no !== (itemNo || null) || !/^[a-z0-9-]+$/.test(value.invocation_id || '')
      || (phase && value.phase_id !== phase)) throw new Error('探索产物生产版本不匹配：' + id)
    return value
  }
  function ready(id, round, itemNo, phase) {
    const value = read(id, round, itemNo, phase)
    if (value.status !== 'ready' || value.value_sha256 !== hash(encoded(value.value))) throw new Error('探索产物生产版本尚未成功：' + id)
    return value
  }
  function write(record) {
    const rel = slotPath(record.node_id, record.round_id, record.item_no)
    const temp = io.checked(rel + '.' + randomUUID(), true)
    writeFileSync(temp, encoded(record), { flag: 'wx', mode: 0o600 })
    renameSync(temp, io.checked(rel))
  }
  const files = []
  const json = []
  function take(record, path) {
    const meta = record.files?.[path]
    if (!meta || !/^[a-f0-9]{64}$/.test(meta.sha256 || '')) throw new Error('探索产物没有当前生产摘要：' + path)
    files.push({ path, relative_path: versionPath(record) + '/' + path, sha256: meta.sha256, producer: identity(record) })
  }
  function takeResult(record, path) {
    json.push({ path, value: { transport_version: EXPLORE_HANDOFF_VERSION, independent_proof: false, producer: identity(record), value_sha256: record.value_sha256, value: record.value } })
  }
  function identity(record) {
    if (!record) return null
    return { node_id: record.node_id, round_id: record.round_id, item_no: record.item_no, call_id: record.call_id, invocation_id: record.invocation_id, phase_id: record.phase_id }
  }
  let plan = null
  let phase = x.invocation_id
  let expertId = null
  let synthesisVersion = null
  let previousEvaluation = null
  let researchDigest = null
  const resolved = structuredClone(node)
  if (node.id === 'orchestrate') {
    if (x.round > 0) {
      const previous = ready('evaluate', x.round - 1)
      const previousPlan = ready('orchestrate', x.round - 1)
      if (previous.phase_id !== previousPlan.invocation_id) throw new Error('前轮评价与计划生产版本不匹配')
      matches('evaluate', previous)
      take(previous, 'evaluation.md')
      takeResult(previous, 'evaluation.json')
      previousEvaluation = identity(previous)
    }
  } else {
    plan = ready('orchestrate', x.round)
    phase = plan.invocation_id
    if (node.id === 'research') {
      expertId = plan.value.expert_briefs?.[x.item_no - 1]?.expert_id
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expertId || '')) throw new Error('本次研究 item 的 expert_id 无效')
      resolved.output = { ...node.output, files: { ['research-' + expertId + '.md']: 'markdown' } }
    } else {
      matches('orchestrate', plan)
      take(plan, 'research-plan.md')
      takeResult(plan, 'research-plan.json')
      const aggregate = controller.inputs.research
      const briefs = plan.value.expert_briefs
      if (!aggregate || !Array.isArray(aggregate.items) || aggregate.items.length !== briefs.length || aggregate.total !== briefs.length
        || Object.keys(aggregate).some(key => !['total', 'okCount', 'failedCount', 'items'].includes(key))
        || aggregate.failedCount !== aggregate.items.filter(item => item === null).length || aggregate.okCount !== aggregate.total - aggregate.failedCount) throw new Error('探索控制器完整 fanout aggregate 无效')
      const records = plan.value.expert_briefs.map((brief, index) => {
        let record
        try { record = read('research', x.round, index + 1, phase) } catch (error) {
          if (aggregate.items[index] === null && (error.code === 'ENOENT' || /生产版本不匹配/.test(error.message))) return null
          throw error
        }
        if (record.expert_id !== brief.expert_id) throw new Error('专家生产版本的 expert_id 不匹配')
        if (aggregate.items[index] !== null) {
          if (record.status !== 'ready' || !equal(aggregate.items[index], record.value)) throw new Error('控制器非 null 专家项与当前成功 attempt 不一致')
          if (record.value.expert_id !== brief.expert_id || record.value_sha256 !== hash(encoded(record.value))) throw new Error('专家结果身份或摘要不匹配')
          take(record, 'research-' + brief.expert_id + '.md')
        }
        return record
      })
      researchDigest = hash(encoded(aggregate))
      json.push({ path: 'research-aggregate.json', value: { transport_version: EXPLORE_HANDOFF_VERSION, independent_proof: false, producer: { node_id: 'research', round_id: x.round, phase_id: phase, items: records.map(identity) }, value_sha256: researchDigest, value: aggregate, failures: aggregate.items.flatMap((item, index) => item === null ? [{ index, expert_id: briefs[index].expert_id, reason: records[index]?.error || 'controller_result_unavailable' }] : []) } })
      if (node.id === 'evaluate') {
        const synthesis = ready('synthesize', x.round, null, phase)
        matches('synthesize', synthesis)
        // 综合依赖的每个 item 必须仍是当前实际 attempt，不能在重试后沿用旧综合。
        if (!equal(synthesis.research_versions, records.map(identity)) || synthesis.research_digest !== researchDigest) throw new Error('综合依赖的专家生产版本已变化')
        take(synthesis, 'synthesis.md')
        takeResult(synthesis, 'synthesis.json')
        synthesisVersion = identity(synthesis)
      }
      resolved.research_versions = records.map(identity)
    }
  }
  const record = { contract_digest: digest, task_id: binding.taskId, node_id: node.id, round_id: x.round, item_no: x.item_no || null, call_id: x.call, invocation_id: x.invocation_id, phase_id: phase, expert_id: expertId, status: 'running', research_versions: resolved.research_versions || null, research_digest: researchDigest, synthesis_version: synthesisVersion, previous_evaluation: previousEvaluation }
  delete resolved.research_versions
  // 先核验每份输入，再登记当前 attempt；缺文件不能冒充已准备好的生产者。
  for (const file of files) {
    const bytes = io.read(file.relative_path)
    if (hash(bytes) !== file.sha256) throw new Error('探索输入产物摘要不一致：' + file.path)
  }
  write(record)
  return { node: resolved, files, json, record, expertId, write, readCurrent: () => read(node.id, x.round, x.item_no), versionRoot: versionPath(record) }
}

export function finishExploreHandoff(handoff, structured, readyFiles, io) {
  const current = handoff.readCurrent()
  if (current.invocation_id !== handoff.record.invocation_id || current.status !== 'running') throw new Error('探索产物不是当前 attempt，拒绝发布')
  if (!schema.instanceValid(handoff.node.output.schema, structured, 'versioned')) throw new Error('探索结果未通过生产 schema，拒绝发布')
  if (handoff.expertId && structured.expert_id !== handoff.expertId) throw new Error('研究结果 expert_id 与本次指派不匹配')
  if (readyFiles.some(file => file.path !== 'STATE.md' && file.bytes.length === 0)) throw new Error('探索必需产物不能为空')
  const files = {}
  for (const file of readyFiles) {
    if (file.path === 'STATE.md') continue
    const relative = handoff.versionRoot + '/' + file.path
    writeFileSync(io.checked(relative, true), file.bytes, { flag: 'wx', mode: 0o400 })
    files[file.path] = { sha256: hash(file.bytes), bytes: file.bytes.length }
  }
  return () => handoff.write({ ...current, status: 'ready', value: structured, value_sha256: hash(encoded(structured)), files })
}

// publish/fail 是另一个宿主进程；只恢复 prepare 已登记的 exact attempt，绝不重新 begin。
export function restoreExploreHandoff(binding, node, io, checkDependencies = true) {
  const spec = binding.explore_handoff
  if (!spec) return null
  const x = spec.execution
  if (spec.contract?.digest !== digest || spec.contract.version !== EXPLORE_HANDOFF_VERSION || !x || !Number.isSafeInteger(x.round) || !Number.isSafeInteger(x.call) || !/^[a-z0-9-]+$/.test(x.invocation_id || '')) throw new Error('探索交接恢复身份无效')
  const root = '.handoff/' + digest + '/round-' + x.round + '/' + node.id + (x.item_no ? '-item-' + x.item_no : '')
  const rel = root + '/current.json'
  const readCurrent = () => {
    const record = JSON.parse(readFileSync(io.checked(rel), 'utf8'))
    if (record.task_id !== binding.taskId || record.contract_digest !== digest || record.node_id !== node.id || record.round_id !== x.round || record.item_no !== (x.item_no || null) || record.call_id !== x.call || record.invocation_id !== x.invocation_id) throw new Error('探索交接不是当前生产 attempt')
    return record
  }
  const record = readCurrent()
  if (checkDependencies) {
    const slot = (id, round, itemNo) => JSON.parse(readFileSync(io.checked('.handoff/' + digest + '/round-' + round + '/' + id + (itemNo ? '-item-' + itemNo : '') + '/current.json'), 'utf8'))
    function sameVersion(expected, current) {
      return ['node_id', 'round_id', 'item_no', 'call_id', 'invocation_id', 'phase_id'].every(key => expected[key] === current[key])
    }
    if (node.id !== 'orchestrate') {
      const plan = slot('orchestrate', x.round)
      if (plan.status !== 'ready' || plan.invocation_id !== record.phase_id) throw new Error('探索生产期间计划版本已变化')
    }
    for (const version of record.research_versions || []) {
      if (!version) continue
      if (!sameVersion(version, slot('research', x.round, version.item_no))) throw new Error('探索生产期间专家 attempt 已变化')
    }
    for (const version of [record.synthesis_version, record.previous_evaluation].filter(Boolean)) {
      const current = slot(version.node_id, version.round_id)
      if (current.status !== 'ready' || !sameVersion(version, current)) throw new Error('探索生产期间上游版本已变化')
    }
  }
  const resolved = structuredClone(node)
  if (node.id === 'research') resolved.output = { ...node.output, files: { ['research-' + record.expert_id + '.md']: 'markdown' } }
  return { node: resolved, record, expertId: record.expert_id, readCurrent, versionRoot: root + '/attempt-' + record.invocation_id, write(value) {
    const temp = io.checked(rel + '.' + randomUUID(), true)
    writeFileSync(temp, encoded(value), { flag: 'wx', mode: 0o600 })
    renameSync(temp, io.checked(rel))
  } }
}

export function failExploreHandoff(binding, node, io, error) {
  const handoff = restoreExploreHandoff(binding, node, io, false)
  if (handoff?.record.status === 'running') handoff.write({ ...handoff.record, status: 'failed', error: String(error || '节点未完成').slice(0, 500) })
}
