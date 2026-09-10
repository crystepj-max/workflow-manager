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
const tpl = JSON.parse(readFileSync(path.join(tplDir, 'custom-seeds', 'dev-workflow-2-0.json'), 'utf8'))
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))
const { files } = generateAll(tplDir)
const tplVwfDsl = files.get('dev-workflow-2-0/vwf-dsl.json')
const tplScript = files.get('dev-workflow-2-0/script.mjs')

// wf_run 驱动环境：假 fs/子进程/引擎，捕获 engine.start 收到的 script/meta
// （统一校验内核 T-IMP-13：假 fs 默认种入真实 validate-core.cjs 源码）
const validatorCoreSrc = readFileSync(path.join(root, 'scripts', 'validate-core.cjs'), 'utf8')

function wfRunEnv({ fsSeed = {}, compileScript = '//MOCK-SCRIPT' } = {}) {
  const fs = makeFs({ [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc, ...fsSeed })
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

test('H1 内置模板现编译优先：wf_run(templateId) 走同一 CLI 编译管道（磁盘旧产物不再直接执行）', async () => {
  const { tool, captured, sub } = wfRunEnv({
    fsSeed: {
      [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: tplVwfDsl,
      [REPO + '/.generated/dev-workflow-2-0/script.mjs']: tplScript,
    },
  })
  const out = await runTool(tool, { templateId: 'dev-workflow-2-0', taskId: 't' })
  assert.equal(out.stopReason, 'completed')
  // UAT-80 实证：磁盘产物可能出自旧版生成器（如 agent cwd 契约收紧前），直接执行
  // 会与引擎不兼容。现编译优先后，templateId 与 dsl/RPC 同走 CLI 管道，一致性由
  // 「同一生成器」保证（H6 真实编译 + 编译器单测 + 排练厅）。
  assert.equal(captured.script, '//MOCK-SCRIPT', '引擎收到 CLI 编译译文')
  assert.notEqual(captured.script, tplScript, '磁盘旧产物不再直接执行')
  assert.ok(sub._calls.find((c) => c.join(' ').includes('generate.mjs') && c.join(' ').includes('--inline')), '已 spawn generate.mjs compile --inline')
})

test('H2 用户模板现编译优先：过期 save 闭环产物不再直接执行', async () => {
  const userScript = generateUserSkill(mini).get('script.mjs')
  const { tool, captured, sub } = wfRunEnv({
    fsSeed: {
      [USER_DIR + '/hello.json']: JSON.stringify(mini, null, 2) + '\n',
      [SKILL_ROOT + '/hello/script.mjs']: userScript,
    },
  })
  const out = await runTool(tool, { templateId: 'hello', taskId: 't' })
  assert.equal(out.stopReason, 'completed')
  assert.equal(captured.script, '//MOCK-SCRIPT', '用户模板同样走现编译（save 闭环产物可能过期）')
  assert.notEqual(captured.script, userScript, '过期 save 闭环产物不被静默执行')
  assert.ok(sub._calls.find((c) => c.join(' ').includes(' compile ')), '已走 CLI compile')
})

test('H2b 编译通道不可用即失败关闭：不静默回落磁盘产物', async () => {
  const userScript = generateUserSkill(mini).get('script.mjs')
  const fs = makeFs({
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/hello.json']: JSON.stringify(mini, null, 2) + '\n',
    [SKILL_ROOT + '/hello/script.mjs']: userScript,
  })
  // 有进程服务形态但不可用（缺 resolveExecutable）：编译失败必须显式报错，
  // 不得静默回落磁盘产物（过期产物直执正是 UAT-80 实证的事故源）
  const badSub = { spawn() { throw new Error('no subprocess in this env') } }
  const { definedTools } = loadHost({ fs, subprocess: badSub, sandboxPolicy, workflowEngine: { start: () => ({ id: 'r1', result: Promise.resolve({ stopReason: 'completed', value: {} }) }) }, agents: { requireInitiator: () => ({}) } })
  const tool = definedTools.find((t) => t.name === 'wf_run')
  const out = await tool.execute({ templateId: 'hello', taskId: 't' })
  assert.ok(String(out).includes('编译失败') || String(out).includes('无法编译'), '编译不可用显式失败：' + out)
})

test('H3 临时图 CLI 兜底：wf_run(args.dsl) → 逆投影蓝图经 --inline 交给 compile 子命令', async () => {
  const fs = makeFs({ [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc })
  const sub = makeSubprocess({ fs, compileScript: '//CLI-SCRIPT' })
  const captured = {}
  const engine = { start: (spec) => { captured.script = spec.script; return { id: 'r1', result: Promise.resolve({ stopReason: 'completed', value: {}, agentsStarted: 1 }) } } }
  const { definedTools } = loadHost({ fs, subprocess: sub, sandboxPolicy, workflowEngine: engine, agents: { requireInitiator: () => ({}) } })
  const tool = definedTools.find((t) => t.name === 'wf_run')
  const out = await runTool(tool, { dsl: projectToVwf(mini), taskId: 't' })
  assert.equal(out.stopReason, 'completed')
  assert.equal(captured.script, '//CLI-SCRIPT', '引擎收到 CLI 编译译文')
  // 蓝图以 --inline 参数直传 CLI：编辑器未保存的改动必须进译文，
  // 不再落临时蓝图文件（避免磁盘旧产物充数与临时文件残留）。
  const compileCall = sub._calls.find((c) => c.join(' ').includes('generate.mjs') && c.join(' ').includes(' compile ') && c.join(' ').includes('--inline'))
  assert.ok(compileCall, '已 spawn generate.mjs compile --inline')
  const bp = JSON.parse(compileCall[compileCall.indexOf('--inline') + 1])
  assert.equal(bp.id, 'hello')
  assert.equal(bp.entry, 'dispatch')
  assert.ok(bp.bindings.models.work, '节点 model 逆投影为 bindings.models')
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
  // 现编译优先后交付译文经 CLI 管道（H1 断言）；行为统一由同一编译器的产物形态
  // （tplScript = generate.mjs 产物）直接验证，真实编译另见 H6
  const agent = makeAgentScript({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    审核: { verdict: 'APPROVE', summary: 's', ...VERIFIED },
    人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', ...VERIFIED },
  })
  const { result, agentCalls } = await runGeneratedScript(tplScript, { agent })
  assert.equal(result.status, 'AWAITING_HUMAN_accept')
  assert.ok(!agentCalls.some((c) => c.label === '分流'), '统一译文：分流节点折叠，零出场')
})

test('H5b 闸门统一：宿主交付译文交错分支即 TECHNICAL_FAILURE（原差异：宿主无闸门）', async () => {
  const agent = makeAgentScript({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    开发: { status: 'completed', summary: 's', self_verify: 'v' },
    测试: { result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: 'main', verified_head: '' },
  })
  const { result } = await runGeneratedScript(tplScript, { agent })
  assert.equal(result.status, 'TECHNICAL_FAILURE', '统一译文：可信度闸门硬校验生效')
})

test('H5c 归因统一：宿主交付译文超限有归因演员与 reschedule（原差异：宿主无归因）', async () => {
  const agent = makeAgentScript({
    调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
    '/^开发( R\\d+)?$/': { status: 'completed', summary: 's', self_verify: 'v' },
    '/^测试( R\\d+)?$/': { result: 'PASSED', reason: 'r', evidence: 'e', ...VERIFIED },
    '/^审核( R\\d+)?$/': { verdict: 'REQUEST_CHANGES', summary: '要改', ...VERIFIED },
    超限归因: { reason: '卡在审核', reschedule: { attribution: '审核过严', split: ['x'], human_action: '放宽' } },
  })
  const { result, agentCalls } = await runGeneratedScript(tplScript, { agent })
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
