// 隔离节点的文件交接由宿主执行：声明输入只读拷贝，声明输出在节点结束后发布。
// 模型进程始终不能写 canonical 目录，也不能读取其他节点未声明的证据。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { prepareExploreHandoff, restoreExploreHandoff, finishExploreHandoff, failExploreHandoff } from './explore-handoff.mjs'

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function artifactPath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('无效的产物相对路径：' + String(value))
  }
  return value
}

// 逐层拒绝符号链接；不存在的目录只由受信宿主创建。
function checkedPath(root, rel, createParent = false) {
  const base = resolve(root)
  const target = resolve(base, artifactPath(rel))
  if (!inside(base, target)) throw new Error('产物路径越出授权根')
  for (let current = base; ; ) {
    if (existsSync(current) || (() => { try { lstatSync(current); return true } catch { return false } })()) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('产物路径拒绝符号链接：' + current)
    }
    if (current === target) break
    const suffix = relative(current, target).split(sep)[0]
    current = join(current, suffix)
  }
  if (createParent) mkdirSync(dirname(target), { recursive: true })
  return target
}

function canonicalRoot(binding) {
  if (!binding || typeof binding.cwd !== 'string' || !isAbsolute(binding.cwd)) throw new Error('产物宿主目录必须为绝对路径')
  const cwd = realpathSync(binding.cwd)
  const runDir = artifactPath(binding.runDir || ('.agent-runs/' + binding.taskId))
  return checkedPath(cwd, runDir)
}

function outputDeclarations(node) {
  const files = node?.output?.files || {}
  return Object.entries(files).map(([path, spec]) => ({
    path: artifactPath(path), required: typeof spec === 'string' || spec?.required !== false,
  }))
}

function handoffIo(canonical) {
  return {
    checked: (rel, create = false) => checkedPath(canonical, rel, create),
    read(rel) {
      const path = checkedPath(canonical, rel)
      if (!lstatSync(path).isFile()) throw new Error('探索输入产物不是普通文件：' + rel)
      return readFileSync(path)
    },
  }
}

function boundContext(workspace, context, node) {
  if (!workspace?.workspace_path || !context || context.node_id !== node?.id || context.isolation_guarantee !== 'enforced') {
    throw new Error('产物交接上下文与隔离节点不匹配')
  }
  const root = realpathSync(workspace.workspace_path)
  const evidence = realpathSync(context.evidence_path)
  if (!inside(root, evidence)) throw new Error('节点证据目录越出工作区')
  return { root, evidence }
}

export function prepareNodeArtifacts(workspace, context, binding, node) {
  const { root, evidence } = boundContext(workspace, context, node)
  const canonical = canonicalRoot(binding)
  const handoff = prepareExploreHandoff(binding, node, handoffIo(canonical))
  const outputs = outputDeclarations(handoff?.node || node)
  const attempt = 'artifacts-' + randomUUID()
  const output = checkedPath(evidence, attempt, true)
  const input = checkedPath(root, 'inputs/' + artifactPath(node.id) + '/' + attempt, true)
  mkdirSync(output)
  mkdirSync(input)
  const inputRefs = []
  const stagedPaths = new Set()
  function stage(rel, bytes, source) {
    if (!stagedPaths.has(rel)) {
      writeFileSync(checkedPath(input, rel, true), bytes, { flag: 'wx', mode: 0o444 })
      stagedPaths.add(rel)
    }
    inputRefs.push({ source, staged: join(input, rel) })
  }
  for (const declared of handoff ? [] : node.inputs || []) {
    if (!declared.artifact) continue
    const rel = artifactPath(declared.artifact)
    const path = checkedPath(canonical, rel)
    if (!existsSync(path)) {
      if (declared.required === true && declared.default === undefined) throw new Error('节点必需输入产物缺失：' + rel)
      continue
    }
    if (!lstatSync(path).isFile()) throw new Error('输入产物不是普通文件：' + rel)
    const bytes = readFileSync(path)
    stage(rel, bytes, path)
    inputRefs.push({ source: (binding.runDir || '.agent-runs/' + binding.taskId) + '/' + rel, staged: join(input, rel) })
  }
  if (handoff) {
    for (const file of handoff.files) {
      const bytes = handoffIo(canonical).read(file.relative_path)
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('探索输入产物摘要不一致：' + file.path)
      stage(file.path, bytes, join(canonical, file.path))
      inputRefs.push({ source: (binding.runDir || '.agent-runs/' + binding.taskId) + '/' + file.path, staged: join(input, file.path) })
    }
    for (const file of handoff.json) stage(file.path, Buffer.from(JSON.stringify(file.value)), join(canonical, file.path))
  }
  const frozen = binding.evaluationBaseline
  if (frozen) {
    if (frozen.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(frozen.digest || '')
      || typeof frozen.artifact_path !== 'string' || !isAbsolute(frozen.artifact_path)
      || !inside(canonical, resolve(frozen.artifact_path))) throw new Error('冻结基线引用越界或无效')
    const rel = artifactPath(relative(canonical, frozen.artifact_path).split(sep).join('/'))
    const path = checkedPath(canonical, rel)
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error('冻结基线输入缺失：' + rel)
    const bytes = readFileSync(path)
    if (createHash('sha256').update(bytes).digest('hex') !== frozen.digest) throw new Error('冻结基线输入摘要不一致')
    stage(rel, bytes, frozen.artifact_path)
  }
  return {
    context: { ...context, artifact_input_path: input, artifact_output_path: output },
    artifacts: { runDir: binding.runDir || '.agent-runs/' + binding.taskId, canonicalRoot: canonical, outputFiles: outputs.map(file => file.path), inputRefs,
      ...(handoff ? { transportInputs: [...handoff.files, ...handoff.json].map(file => join(input, file.path)), handoffVersion: binding.explore_handoff.contract } : {}),
    },
  }
}

export function publishNodeArtifacts(workspace, context, binding, node, structured) {
  const { root, evidence } = boundContext(workspace, context, node)
  const output = resolve(context.artifact_output_path || '')
  if (!inside(evidence, output) || output === evidence || !inside(root, output)) throw new Error('节点产物输出目录越界')
  const canonical = canonicalRoot(binding)
  const handoff = restoreExploreHandoff(binding, node, handoffIo(canonical))
  const declarations = outputDeclarations(handoff?.node || node)
  if (!declarations.some(file => file.path === 'STATE.md')) declarations.push({ path: 'STATE.md', required: false })
  const ready = []
  for (const file of declarations) {
    const source = checkedPath(output, file.path)
    if (!existsSync(source)) {
      if (file.required) throw new Error('节点必需产物缺失：' + file.path)
      continue
    }
    if (!lstatSync(source).isFile()) throw new Error('输出产物不是普通文件：' + file.path)
    const destination = checkedPath(canonical, file.path)
    ready.push({ path: file.path, destination, bytes: readFileSync(source) })
  }
  const finish = handoff ? finishExploreHandoff(handoff, structured, ready, handoffIo(canonical)) : null
  // 先验证全部路径及必需文件，再发布；不会把半份无效提交当作成功。
  for (const file of ready) {
    checkedPath(canonical, file.path, true)
    writeFileSync(file.destination, file.bytes)
  }
  if (finish) finish()
  return { files: ready.map(file => file.path) }
}

export function failNodeArtifacts(workspace, context, binding, node, error) {
  boundContext(workspace, context, node)
  if (binding.explore_handoff) failExploreHandoff(binding, node, handoffIo(canonicalRoot(binding)), error)
}
