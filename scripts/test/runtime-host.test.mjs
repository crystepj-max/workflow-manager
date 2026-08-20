// 统一编译器验收套件（候选一 T-IMP-12）——原「双编译器对拍」的差异断言已翻转为一致断言：
// 单一编译器 = scripts/generate.mjs compileBlueprint；宿主经管道取译文。
// H1 内置模板磁盘路径：wf_run(templateId) → 引擎收到 .generated/script.mjs（含全部增强）
// H2 用户模板磁盘路径：wf_run(templateId) → 引擎收到 ~/.dsh/skills/<id>/script.mjs（save 闭环产物）
// H3 临时图 CLI 兜底：wf_run(args.dsl) → 临时蓝图落盘 + compile 子命令 + 清理
// H4 vwf.script RPC（编辑器实时查看）→ 同一 CLI 管道
// H5 行为统一：宿主管道交付的译文跑原三差异场景 → 折叠零出场 / 闸门拦 / 归因出场
// H6 CLI 集成：真实 spawn generate.mjs compile → 产物可被排练厅真实执行

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { generateAll, generateUserSkill, projectToVwf } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import { loadHost } from '../../packages/dsh-visual-workflow/tests/helpers/load-host.mjs'
import { REPO, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } from '../../packages/dsh-visual-workflow/tests/helpers/fake-services.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '../..')
const tplDir = path.join(root, 'templates')
const tpl = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'))
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))
const { files } = generateAll(tplDir)
const tplVwfDsl = files.get('dev-workflow-2-0/vwf-dsl.json')
const tplScript = files.get('dev-workflow-2-0/script.mjs')

// wf_run 驱动环境：假 fs/子进程/引擎，捕获 engine.start 收到的 script/meta
function wfRunEnv({ fsSeed = {}, compileScript = '//MOCK-SCRIPT' } = {}) {
  const fs = makeFs(fsSeed)
  const sub = makeSubprocess({ fs, compileScript })
  const captured = {}
  const engine = {
    start: (spec) => {
      captured.script = spec.script
      captured.meta = spec.meta
      captured.args = spec.args
      return { id: 'r1', result: Promise.resolve({ stopReason: 'completed', value: { status: 'DONE' }, agentsStarted: 1 }) }
    },
  }
  const { handlers, definedTools } = loadHost({
    fs, subprocess: sub, sandboxPolicy, workflowEngine: engine,
    agents: { requireInitiator: () => ({}) },
  })
  return { tool: definedTools.find((t) => t.name === 'wf_run'), handlers, fs, sub, captured }
}

const runTool = async (tool, args) => JSON.parse(await tool.execute(args))

test('H1 内置模板磁盘路径：wf_run(templateId) 收到 .generated 译文，与引擎产物逐字节一致且含增强', async () => {
  const { tool, captured } = wfRunEnv({
    fsSeed: {
      [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: tplVwfDsl,
      [REPO + '/.generated/dev-workflow-2-0/script.mjs']: tplScript,
    },
  })
  const out = await runTool(tool, { templateId: 'dev-workflow-2-0', taskId: 't' })
  assert.equal(out.stopReason, 'completed')
  assert.equal(captured.script, tplScript, '宿主磁盘路径译文与引擎产物逐字节一致')
  assert.ok(captured.script.includes('claimError') && captured.script.includes('超限归因') && captured.script.includes('FOLDS'), '增强（闸门/归因/折叠）在交付译文中')
})

test('H2 用户模板磁盘路径：wf_run(templateId) 收到 save 闭环产物（~/.dsh/skills/<id>/script.mjs）', async () => {
  const userScript = generateUserSkill(mini).get('script.mjs')
  const { tool, captured } = wfRunEnv({
    fsSeed: {
      [USER_DIR + '/hello.json']: JSON.stringify(mini, null, 2) + '\n',
      [SKILL_ROOT + '/hello/script.mjs']: userScript,
    },
  })
  const out = await runTool(tool, { templateId: 'hello', taskId: 't' })
  assert.equal(out.stopReason, 'completed')
  assert.equal(captured.script, userScript, '用户模板走 save 闭环产物')
})

test('H3 临时图 CLI 兜底：wf_run(args.dsl) → 逆投影蓝图落盘 + compile 子命令 + 清理', async () => {
  const fs = makeFs({})
  const writes = []
  const origWrite = fs.writeText
  fs.writeText = async (t, content, ...rest) => { writes.push([t.displayPath || t.targetKey, content]); return origWrite.call(fs, t, content, ...rest) }
  const sub = makeSubprocess({ fs, compileScript: '//CLI-SCRIPT' })
  const captured = {}
  const engine = { start: (spec) => { captured.script = spec.script; return { id: 'r1', result: Promise.resolve({ stopReason: 'completed', value: {}, agentsStarted: 1 }) } } }
  const { definedTools } = loadHost({ fs, subprocess: sub, sandboxPolicy, workflowEngine: engine, agents: { requireInitiator: () => ({}) } })
  const tool = definedTools.find((t) => t.name === 'wf_run')
  const out = await runTool(tool, { dsl: projectToVwf(mini), taskId: 't' })
  assert.equal(out.stopReason, 'completed')
  assert.equal(captured.script, '//CLI-SCRIPT', '引擎收到 CLI 编译译文')
  const compileCall = sub._calls.find((c) => c.join(' ').includes('generate.mjs') && c.join(' ').includes(' compile '))
  assert.ok(compileCall, '已 spawn generate.mjs compile')
  const tmpPath = compileCall[compileCall.length - 1]
  const written = writes.find(([p]) => p === tmpPath)
  assert.ok(written, '临时蓝图已落盘（逆投影）')
  const bp = JSON.parse(written[1])
  assert.equal(bp.id, 'hello')
  assert.equal(bp.entry, 'dispatch')
  assert.ok(bp.bindings.models.work, '节点 model 逆投影为 bindings.models')
  const rmCall = sub._calls.find((c) => c.join(' ').includes('rmSync'))
  assert.ok(rmCall && rmCall[rmCall.length - 1] === tmpPath, '清理目标为同一临时文件')
  assert.ok(!fs._files.has(tmpPath), '临时蓝图已从假 fs 清除')
})

test('H4 vwf.script RPC（编辑器实时查看）→ 同一 CLI 管道', async () => {
  const { handlers, sub } = wfRunEnv({ compileScript: '//RPC-SCRIPT' })
  const r = await handlers.get('vwf.script')({ dsl: projectToVwf(mini) })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.script, '//RPC-SCRIPT')
  const compileCall = sub._calls.find((c) => c.join(' ').includes('generate.mjs') && c.join(' ').includes(' compile '))
  assert.ok(compileCall, 'vwf.script 走 CLI compile')
})

// ---------- H5 行为统一（原 C2 三差异断言翻转） ----------
const VERIFIED = { verified_branch: 'dev2/task', verified_head: 'abc123' }

test('H5a 折叠统一：宿主交付译文分流节点零出场（原差异：宿主走 LLM）', async () => {
  const { tool, captured } = wfRunEnv({
    fsSeed: {
      [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: tplVwfDsl,
      [REPO + '/.generated/dev-workflow-2-0/script.mjs']: tplScript,
    },
  })
  await runTool(tool, { templateId: 'dev-workflow-2-0', taskId: 't' })
  const agent = makeAgentScript({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    审核: { verdict: 'APPROVE', summary: 's', ...VERIFIED },
    人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
  })
  const { result, agentCalls } = await runGeneratedScript(captured.script, { agent })
  assert.equal(result.status, 'AWAITING_HUMAN_accept')
  assert.ok(!agentCalls.some((c) => c.label === '分流'), '统一译文：分流节点折叠，零出场')
})

test('H5b 闸门统一：宿主交付译文交错分支即 TECHNICAL_FAILURE（原差异：宿主无闸门）', async () => {
  const { tool, captured } = wfRunEnv({
    fsSeed: {
      [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: tplVwfDsl,
      [REPO + '/.generated/dev-workflow-2-0/script.mjs']: tplScript,
    },
  })
  await runTool(tool, { templateId: 'dev-workflow-2-0', taskId: 't' })
  const agent = makeAgentScript({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: 'main', verified_head: '' },
  })
  const { result } = await runGeneratedScript(captured.script, { agent })
  assert.equal(result.status, 'TECHNICAL_FAILURE', '统一译文：可信度闸门硬校验生效')
})

test('H5c 归因统一：宿主交付译文超限有归因演员与 reschedule（原差异：宿主无归因）', async () => {
  const { tool, captured } = wfRunEnv({
    fsSeed: {
      [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: tplVwfDsl,
      [REPO + '/.generated/dev-workflow-2-0/script.mjs']: tplScript,
    },
  })
  await runTool(tool, { templateId: 'dev-workflow-2-0', taskId: 't' })
  const agent = makeAgentScript({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    '/^开发( R\\d+)?$/': { status: 'completed', summary: 's', self_verify: 'v' },
    '/^测试( R\\d+)?$/': { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    '/^审核( R\\d+)?$/': { verdict: 'REQUEST_CHANGES', summary: '要改', ...VERIFIED },
    超限归因: { reason: '卡在审核', reschedule: { attribution: '审核过严', split: ['x'], human_action: '放宽' } },
  })
  const { result, agentCalls } = await runGeneratedScript(captured.script, { agent })
  assert.equal(result.status, 'FAILED_MAX_ROUNDS')
  assert.equal(result.reschedule.attribution, '审核过严')
  assert.equal(agentCalls.filter((c) => c.label === '超限归因').length, 1)
})

// ---------- H6 CLI 集成（真实 spawn，不经假服务） ----------
test('H6 CLI 集成：generate.mjs compile 真实执行，产物可被排练厅跑通', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'vwf-compile-'))
  const bpFile = path.join(tmp, 'hello.json')
  writeFileSync(bpFile, JSON.stringify(mini, null, 2) + '\n')
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts/generate.mjs'), 'compile', bpFile], { cwd: root, encoding: 'utf8' })
    const r = JSON.parse(out)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.meta.name, 'vwf-hello')
    assert.equal(r.meta.description, 'hello 微型蓝图')
    assert.equal(r.meta.phases.length, 4)
    // 真实 CLI 产物进排练厅：幸福路径（门禁挂起 → 通过 → DONE）
    const a = await runGeneratedScript(r.script, { agent: makeAgentScript({
      dispatch: { complete: true }, work: { status: 'completed' }, gate: { verdict: 'ok' },
    }) })
    assert.equal(a.result.status, 'AWAITING_HUMAN_gate')
    const b = await runGeneratedScript(r.script, {
      agent: makeAgentScript({ finish: { done: true } }),
      args: { entry: 'gate', approved: true, startRound: 0, history: [], feedback: '' },
    })
    assert.equal(b.result.status, 'DONE')
  } finally {
    execFileSync('/bin/rm', ['-rf', tmp], { cwd: root })
  }
})
