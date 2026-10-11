import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareNodeContext, buildNodeExecutionProfile } from '../node-isolation.mjs'
import { prepareNodeArtifacts, publishNodeArtifacts } from '../node-artifacts.mjs'
import { createProviderRoutes } from '../node-provider-routes.mjs'

const require = createRequire(import.meta.url)
const baseline = require('../evaluation-baseline.cjs')
const manifest = require('../artifact-manifest.cjs')
const provider = require('../node-provider-core.cjs')

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wfm-node-artifacts-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const workspace = { workspace_path: join(root, 'workspace'), source_path: join(root, 'workspace', 'source'), resources: {} }
  mkdirSync(project)
  mkdirSync(workspace.source_path, { recursive: true })
  const binding = { cwd: project, runDir: '.agent-runs/uat', taskId: 'uat' }
  const context = (id, profile) => prepareNodeContext(workspace, { node_id: id, profile, isolation_guarantee: 'enforced' })
  return { root, project, workspace, binding, context }
}

test('隔离节点产物经宿主交接后，真实字节冻结和产物清单使用同一文件', (t) => {
  const f = fixture(t)
  const node = { id: 'confirm', output: { files: { 'evaluation-contract.md': 'markdown' } } }
  const prepared = prepareNodeArtifacts(f.workspace, f.context('confirm', 'requirements'), f.binding, node)
  const bytes = Buffer.from('# 评估契约\n真实字节由确认节点生成。\n')
  const digest = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(prepared.context.artifact_output_path, 'evaluation-contract.md'), bytes)
  writeFileSync(join(prepared.context.artifact_output_path, 'STATE.md'), 'stage: confirm\n')
  writeFileSync(join(prepared.context.evidence_path, 'private-worker-log.txt'), '不得成为正式产物\n')
  const published = publishNodeArtifacts(f.workspace, prepared.context, f.binding, node)
  assert.deepEqual(published.files.sort(), ['STATE.md', 'evaluation-contract.md'])
  const root = join(f.project, f.binding.runDir)
  assert.deepEqual(readFileSync(join(root, 'evaluation-contract.md')), bytes)
  assert.equal(existsSync(join(root, 'private-worker-log.txt')), false)
  const payload = baseline.freezePayload({ ...f.binding, artifact: 'evaluation-contract.md', req: { version: 1, claimed_digest: digest } })
  const frozen = JSON.parse(execFileSync(process.execPath, ['-e', baseline.snippetSource(), JSON.stringify(payload)], { encoding: 'utf8' }))
  assert.equal(frozen.ok, true)
  assert.equal(frozen.digest, digest)
  const submitted = manifest.processSubmit({ ...f.binding, req: { revision: 1, node: 'confirm', entries: [{ logical_name: 'evaluation-contract.md', relative_path: 'evaluation-contract.md', required: true }] } })
  assert.equal(submitted.manifest.required_complete, true)
  assert.equal(submitted.manifest.entries[0].sha256, digest)
  const consumer = { id: 'execute', inputs: [{ artifact: 'evaluation-contract.md', required: true }, { artifact: 'execute-report.md', required: true, default: '首轮无报告' }], output: { files: { 'execute-report.md': 'markdown' } } }
  const staged = prepareNodeArtifacts(f.workspace, f.context('execute', 'dev'), { ...f.binding, evaluationBaseline: baseline.baselineRefOf(frozen, payload, 'uat') }, consumer)
  assert.deepEqual(readFileSync(join(staged.context.artifact_input_path, 'evaluation-contract.md')), bytes)
  assert.deepEqual(readFileSync(join(staged.context.artifact_input_path, 'evaluation-baselines/v1/evaluation-contract.md')), bytes)
  assert.equal(existsSync(join(staged.context.artifact_input_path, 'private-worker-log.txt')), false)
  assert.ok(staged.artifacts.inputRefs.some(ref => ref.source === frozen.copy_path))
})

test('每次节点调用使用独立输出目录，缺失必需产物不能复用旧文件', (t) => {
  const f = fixture(t)
  const node = { id: 'confirm', output: { files: { 'evaluation-contract.md': 'markdown' } } }
  const first = prepareNodeArtifacts(f.workspace, f.context('confirm', 'requirements'), f.binding, node)
  writeFileSync(join(first.context.artifact_output_path, 'evaluation-contract.md'), '旧契约\n')
  publishNodeArtifacts(f.workspace, first.context, f.binding, node)
  const second = prepareNodeArtifacts(f.workspace, f.context('confirm', 'requirements'), f.binding, node)
  assert.notEqual(second.context.artifact_output_path, first.context.artifact_output_path)
  assert.throws(() => publishNodeArtifacts(f.workspace, second.context, f.binding, node), /必需产物缺失/)
  assert.equal(readFileSync(join(f.project, f.binding.runDir, 'evaluation-contract.md'), 'utf8'), '旧契约\n')
})

test('真实路由适配把隔离 worker 的声明产物交给宿主，完成返回前文件已可冻结', async (t) => {
  const f = fixture(t)
  const node = { id: 'confirm', profile: 'requirements', model: { provider: 'deepseek-official', model: 'deepseek-flash' }, output: { files: { 'evaluation-contract.md': 'markdown' } } }
  const calls = []
  const tokens = await provider.issueRun('uat', { nodes: [node] }, null, f.workspace, { guarantee: 'enforced' }, async () => ({ workspaces: f.root }), async (command, input) => {
    calls.push(command)
    if (command === 'createProviderRoutes') return createProviderRoutes(input)
    if (command === 'prepareNode') return { ok: true, ...prepareNodeArtifacts(f.workspace, f.context(input.node_id, input.profile), input.artifact_binding, input.node) }
    if (command === 'publishNodeArtifacts') return { ok: true, ...publishNodeArtifacts(f.workspace, input.context, input.artifact_binding, input.node) }
    if (command === 'spawnProviderWorker') {
      const prompt = input.prompt.map(part => part.text || '').join('\n')
      assert.match(prompt, new RegExp('run 产物目录：' + input.context.artifact_output_path + '/'))
      assert.equal(prompt.includes(f.binding.runDir + '/STATE.md'), false)
      assert.equal(JSON.stringify(input).includes(tokens.nodes.confirm), false)
      writeFileSync(join(input.context.artifact_output_path, 'evaluation-contract.md'), '# 来自真实隔离输出目录\n')
      return { accepted: Promise.resolve(), result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
    }
    throw new Error('未预期的宿主调用：' + command)
  }, f.binding)
  t.after(() => provider.clearRun('uat'))
  const run = await provider.start({ agentOptions: { provider: 'vwf-node-isolated:' + tokens.nodes.confirm, model: 'deepseek-flash' }, prompt: [{ type: 'text', text: '- run 产物目录：' + f.binding.runDir + '/（记录写这里）\n完成后更新 ' + f.binding.runDir + '/STATE.md' }] })
  assert.equal((await run.result).stopReason, 'completed')
  assert.equal(readFileSync(join(f.project, f.binding.runDir, 'evaluation-contract.md'), 'utf8'), '# 来自真实隔离输出目录\n')
  assert.deepEqual(calls, ['createProviderRoutes', 'prepareNode', 'spawnProviderWorker', 'publishNodeArtifacts'])
})

test('产物协议能在拒绝 Node require 的插件环境加载，文件核验仍由子进程执行', () => {
  const source = readFileSync(new URL('../artifact-manifest.cjs', import.meta.url), 'utf8')
  const module = { exports: {} }
  new Function('module', 'exports', 'require', source)(module, module.exports, () => { throw new Error('插件不能直接加载 Node 模块') })
  const kernel = module.exports
  assert.equal(kernel.parseSubmitRequest('[am-submit]{"node":"confirm","entries":[]}').node, 'confirm')
  assert.equal(kernel.gateBlockOf({ materials_status: 'incomplete', required_complete: false, entries: [{ logical_name: 'report', rejection_reason: 'missing' }] }, 'confirm').code, 'ARTIFACT_MANIFEST_INCOMPLETE')
  assert.match(kernel.submitSnippetSource(), /artifact-manifest-submit/)
  assert.throws(() => kernel.processSubmit({}), /插件不能直接加载 Node 模块/)
})

test('产物交接拒绝声明越界、源文件符号链接和目标符号链接', (t) => {
  const f = fixture(t)
  const node = { id: 'confirm', output: { files: { 'evaluation-contract.md': 'markdown' } } }
  assert.throws(() => prepareNodeArtifacts(f.workspace, f.context('confirm', 'requirements'), f.binding, { id: 'confirm', output: { files: { '../escape.md': 'markdown' } } }), /产物相对路径/)
  const prepared = prepareNodeArtifacts(f.workspace, f.context('confirm', 'requirements'), f.binding, node)
  const outside = join(f.root, 'outside.md')
  writeFileSync(outside, '不允许读取或覆盖\n')
  symlinkSync(outside, join(prepared.context.artifact_output_path, 'evaluation-contract.md'))
  assert.throws(() => publishNodeArtifacts(f.workspace, prepared.context, f.binding, node), /符号链接/)
  rmSync(join(prepared.context.artifact_output_path, 'evaluation-contract.md'))
  writeFileSync(join(prepared.context.artifact_output_path, 'evaluation-contract.md'), '当前契约\n')
  mkdirSync(join(f.project, f.binding.runDir), { recursive: true })
  symlinkSync(outside, join(f.project, f.binding.runDir, 'evaluation-contract.md'))
  assert.throws(() => publishNodeArtifacts(f.workspace, prepared.context, f.binding, node), /符号链接/)
  assert.equal(readFileSync(outside, 'utf8'), '不允许读取或覆盖\n')
})

test('冻结基线输入缺失或摘要变化时，节点启动前拒绝交接', (t) => {
  const f = fixture(t)
  const node = { id: 'evaluate', output: { files: { 'evaluation-report.md': 'markdown' } } }
  const artifact = join(f.project, f.binding.runDir, 'evaluation-baselines/v1/evaluation-contract.md')
  const binding = { ...f.binding, evaluationBaseline: { artifact_path: artifact, digest: 'a'.repeat(64), algorithm: 'sha256' } }
  assert.throws(() => prepareNodeArtifacts(f.workspace, f.context('evaluate', 'evaluator'), binding, node), /冻结基线.*缺失/)
  mkdirSync(join(f.project, f.binding.runDir, 'evaluation-baselines/v1'), { recursive: true })
  writeFileSync(artifact, '被改变的契约\n')
  assert.throws(() => prepareNodeArtifacts(f.workspace, f.context('evaluate', 'evaluator'), binding, node), /冻结基线.*摘要/)
})

test('真实 macOS 沙箱允许读取声明输入，拒绝改写输入和 canonical 产物', { skip: process.platform !== 'darwin' }, (t) => {
  const f = fixture(t)
  mkdirSync(join(f.project, f.binding.runDir), { recursive: true })
  writeFileSync(join(f.project, f.binding.runDir, 'evaluation-contract.md'), '冻结输入\n')
  const node = { id: 'evaluate', inputs: [{ artifact: 'evaluation-contract.md', required: true }], output: { files: { 'evaluation-report.md': 'markdown' } } }
  const prepared = prepareNodeArtifacts(f.workspace, f.context('evaluate', 'evaluator'), f.binding, node)
  const input = join(prepared.context.artifact_input_path, 'evaluation-contract.md')
  const canonical = join(f.project, f.binding.runDir, 'evaluation-contract.md')
  const output = join(prepared.context.artifact_output_path, 'evaluation-report.md')
  const command = 'cat ' + JSON.stringify(input) + '; if printf tamper > ' + JSON.stringify(input) + ' 2>/dev/null; then echo input-write-allowed; else echo input-write-denied; fi; if printf tamper > ' + JSON.stringify(canonical) + ' 2>/dev/null; then echo canonical-write-allowed; else echo canonical-write-denied; fi; printf report > ' + JSON.stringify(output)
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', buildNodeExecutionProfile(prepared.context), '/bin/sh', '-c', command], { encoding: 'utf8', cwd: prepared.context.agent_cwd })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /冻结输入/)
  assert.match(result.stdout, /input-write-denied/)
  assert.match(result.stdout, /canonical-write-denied/)
  assert.equal(readFileSync(input, 'utf8'), '冻结输入\n')
  assert.equal(readFileSync(canonical, 'utf8'), '冻结输入\n')
  assert.equal(readFileSync(output, 'utf8'), 'report')
  assert.throws(() => buildNodeExecutionProfile({ ...prepared.context, writable_roots: [...prepared.context.writable_roots, prepared.context.artifact_input_path] }), /产物输入.*只读/)
})
