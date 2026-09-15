// LOC-027 评价基线冻结契约——宿主侧接线验收（fake fs/引擎 + 真实冻结子进程）：
//   EB1 冻结成功 → 检查点中止 → 注入已核验引用自动恢复（恢复段参数/逻辑运行入档/控制事件）
//   EB2 摘要与模型声称值不符 → 结构化 BLOCKED，不恢复（不自动纠正其专业结果）
//   EB3 原评价文件缺失 → BLOCKED（不进入执行）
//   EB4 冻结后原路径被改写 → 段收尾核验出基线冲突 BLOCKED，冻结副本保留
//   EB5 未声明 evaluationBaseline 的模板零改动（不观察、不冻结、不阻断）
// 保真边界：fake 引擎只建模 start/result + 事件时序；冻结/核验经 spawnHandler 跑真实
// node 子进程（真实 fs + crypto 字节语义），workspace 路径指向真实临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, DSH_HOME, makeFs, makeSubprocess, sandboxPolicy, USER_DIR, SKILL_ROOT } from './helpers/fake-services.mjs'

const require = createRequire(import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const LOGICAL_DIR = DSH_HOME + '/visual-workflow/logical-runs'
const validatorCoreSrc = readFileSync(path.join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')
const ebKernel = require(path.join(here, '..', '..', '..', 'scripts', 'evaluation-baseline.cjs'))

// 克隆真实 wf-optimize 蓝图（结构合法性 + 声明保真），仅换 id 隔离用户模板命名空间
const OPTIMIZE_LIKE = (() => {
  const bp = JSON.parse(readFileSync(path.join(here, '..', '..', '..', 'templates', 'wf-optimize.json'), 'utf8'))
  bp.id = 'eb-spec'
  return bp
})()
const PLAIN_BP = (() => {
  const bp = JSON.parse(JSON.stringify(OPTIMIZE_LIKE))
  bp.id = 'eb-plain'
  delete bp.evaluationBaseline
  return bp
})()

const until = async (fn, label, ms = 8000) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || ''))
    await new Promise((r) => setTimeout(r, 5))
  }
}
const readLogical = (fs, id) => JSON.parse(fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent(id) + '.json'))

// 真实冻结/核验子进程边界：'-e' + 内核脚本文本 + JSON 载荷 → 真实 node 执行（真实 fs/crypto）
function ebSpawnHandler(spec) {
  const argv = spec.argv
  if (argv[1] === '-e' && typeof argv[2] === 'string' && argv[2].includes('p.mode==="freeze"') && typeof argv[3] === 'string' && argv[3].startsWith('{')) {
    const r = spawnSync(process.execPath, ['-e', argv[2], argv[3]], { encoding: 'utf8' })
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status }
  }
  return undefined
}

function env({ template = OPTIMIZE_LIKE, workspaceSource = null, engine = null } = {}) {
  const seed = {
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [REPO + '/scripts/workspace-isolation-host.mjs']: '// workspace-isolation-host stub（测试种子）',
    [USER_DIR + '/' + template.id + '.json']: JSON.stringify(template, null, 2) + '\n',
    [SKILL_ROOT + '/' + template.id + '/script.mjs']: '//MOCK-SCRIPT',
  }
  const fs = makeFs(seed)
  const wsHost = (cmd) => {
    if (cmd === 'allocate') {
      return { ok: true, workspace: { workspace_id: 'ws-eb', workspace_path: workspaceSource + '/ws', source_path: workspaceSource, records_path: workspaceSource + '/records', work_branch: 'dev-eb', source_revision: 'rev-1', workspace_mode: 'SANDBOX' } }
    }
    if (cmd === 'context') return { ok: true, workspace: null, events: [] }
    return { ok: true }
  }
  const sub = makeSubprocess({ fs, compileScript: '//MOCK-SCRIPT', wsHost, spawnHandler: ebSpawnHandler })
  const { handlers, definedTools, events, ctx } = loadHost({
    fs, subprocess: sub, sandboxPolicy,
    agents: { requireInitiator: () => ({}), currentInitiator: () => null },
    workflowEngine: engine || undefined,
  })
  return { handlers, definedTools, events, ctx, fs }
}

function makeEngine() {
  const pending = []
  return {
    starts: [],
    start(req) {
      this.starts.push(req)
      const id = 'run-' + this.starts.length
      let release = () => {}
      const result = new Promise((r) => { release = r })
      pending.push({ id, release })
      return { id, result }
    },
    end(id, stopReason, value) {
      const p = pending.find((x) => x.id === id)
      if (p) p.release({ stopReason, value: value === undefined ? null : value, agentsStarted: 0 })
    },
  }
}
const settle = (eng, events, runId, stopReason, value) => {
  eng.end(runId, stopReason, value)
  events.get('workflow/end')({ id: runId }, { stopReason })
}
const ckptLog = (events, runId, next, results) => {
  events.get('workflow/log')({ id: runId }, '[pw-ckpt]' + JSON.stringify({ c: next, r: results || {}, h: [], rd: 0, fb: '', bu: 0, mr: 3, ds: 0 }))
}
const freezeLine = (version, claimed, supersedes) => '[eb-freeze]' + JSON.stringify({ version, source: '.agent-runs/t-eb/evaluation-contract.md', copy: '.agent-runs/t-eb/evaluation-baselines/v' + version + '/evaluation-contract.md', claimed_digest: claimed, supersedes: supersedes || null })

// 建真实工作区现场：<tmp>/source/.agent-runs/t-eb/evaluation-contract.md
function workspaceFixture(content) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'vwf-eb-runtime-'))
  const runDir = path.join(tmp, 'source', '.agent-runs', 't-eb')
  mkdirSync(runDir, { recursive: true })
  if (content !== undefined) writeFileSync(path.join(runDir, 'evaluation-contract.md'), content, 'utf8')
  return { tmp, contractPath: path.join(runDir, 'evaluation-contract.md'), copyV1: path.join(runDir, 'evaluation-baselines', 'v1', 'evaluation-contract.md') }
}

test('EB1 冻结成功：检查点中止 + 注入已核验引用自动恢复 + 逻辑运行入档', async () => {
  const wsx = workspaceFixture('# 契约\n判据：A\n')
  const real = createHash('sha256').update(readFileSync(wsx.contractPath)).digest('hex')
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ workspaceSource: path.join(wsx.tmp, 'source'), engine: eng })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'eb-spec', taskId: 't-eb', runDir: '.agent-runs/t-eb' })
  await until(() => eng.starts.length >= 1, '首段启动')
  await until(() => {
    const raw = fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent('t-eb') + '.json')
    return raw && JSON.parse(raw).segments.length >= 1
  }, '基线上下文登记（含内核加载）')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'eb' } })
  events.get('workflow/log')({ id: 'run-1' }, freezeLine(1, real))
  ckptLog(events, 'run-1', 'execute', { confirm: { route: 'READY', contract_digest: real } })
  // 原段被中止收束（闸门在段结算后等待冻结结果并自动恢复）
  settle(eng, events, 'run-1', 'cancelled')
  await until(() => eng.starts.length >= 2, '基线恢复段启动')
  // 冻结成功后原段被中止，恢复段从检查点注入已核验引用
  const resumeReq = eng.starts[1]
  assert.equal(resumeReq.args.entry, 'execute')
  assert.equal(resumeArgsDigest(resumeReq), real)
  assert.equal(resumeReq.args.evaluation_baseline.version, 1)
  assert.equal(resumeReq.args.evaluation_baseline.status, 'verified')
  assert.ok(resumeReq.args.evaluation_baseline.artifact_path.includes('evaluation-baselines/v1/evaluation-contract.md'))
  assert.equal(resumeReq.args.results.confirm.contract_digest, real)
  settle(eng, events, 'run-2', 'completed', { status: 'DONE', results: { confirm: { route: 'READY', contract_digest: real }, execute: { route: 'READY' }, evaluate: { route: 'PASS', contract_digest: real }, closeout: { status: 'DELIVERED' } }, completion: { type: 'EVALUATION_PASSED', node: 'closeout', path: '$.status' } })
  const out = JSON.parse(await p)
  assert.equal(out.stopReason, 'completed')
  assert.equal(out.runId, 'run-2')
  assert.equal(out.value.status, 'DONE')
  const logical = readLogical(fs, 't-eb')
  assert.equal(logical.evaluation_baseline.status, 'verified')
  assert.equal(logical.evaluation_baseline.digest, real)
  assert.equal(logical.evaluation_baselines.length, 1)
  const kinds = logical.control_events.map((e) => e.type)
  assert.ok(kinds.includes('evaluation_baseline_freeze_requested'))
  assert.ok(kinds.includes('evaluation_baseline_frozen'))
  assert.ok(kinds.includes('evaluation_baseline_resumed'))
  assert.equal(logical.segments.length, 2)
  assert.equal(logical.segments[1].trigger, 'evaluation_baseline_resume')
  assert.equal(logical.lifecycle.state, 'COMPLETED')
  rmSync(wsx.tmp, { recursive: true, force: true })
})

test('EB2 摘要与模型声称值不符：BLOCKED 不放行，不恢复', async () => {
  const wsx = workspaceFixture('# 契约\n判据：A\n')
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ workspaceSource: path.join(wsx.tmp, 'source'), engine: eng })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'eb-spec', taskId: 't-eb', runDir: '.agent-runs/t-eb' })
  await until(() => eng.starts.length >= 1, '首段启动')
  await until(() => fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent('t-eb') + '.json'), '逻辑运行登记')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'eb' } })
  events.get('workflow/log')({ id: 'run-1' }, freezeLine(1, 'deadbeef-not-real'))
  ckptLog(events, 'run-1', 'execute', { confirm: { route: 'READY', contract_digest: 'deadbeef-not-real' } })
  settle(eng, events, 'run-1', 'cancelled')
  const out = JSON.parse(await p)
  assert.equal(eng.starts.length, 1, '不得恢复进入执行')
  assert.equal(out.value.status, 'BLOCKED')
  assert.equal(out.value.code, 'EVALUATION_BASELINE_DIGEST_MISMATCH')
  assert.ok(out.value.message.includes('声称 deadbeef-not-real'))
  assert.equal(readLogical(fs, 't-eb').lifecycle.state, 'BLOCKED')
  rmSync(wsx.tmp, { recursive: true, force: true })
})

test('EB3 原评价文件缺失：BLOCKED（不进入执行）', async () => {
  const wsx = workspaceFixture(undefined)
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ workspaceSource: path.join(wsx.tmp, 'source'), engine: eng })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'eb-spec', taskId: 't-eb', runDir: '.agent-runs/t-eb' })
  await until(() => eng.starts.length >= 1, '首段启动')
  await until(() => fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent('t-eb') + '.json'), '逻辑运行登记')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'eb' } })
  events.get('workflow/log')({ id: 'run-1' }, freezeLine(1, 'whatever'))
  ckptLog(events, 'run-1', 'execute', { confirm: { route: 'READY', contract_digest: 'whatever' } })
  settle(eng, events, 'run-1', 'cancelled')
  const out = JSON.parse(await p)
  assert.equal(eng.starts.length, 1, '缺失时不得恢复进入执行')
  assert.equal(out.value.status, 'BLOCKED')
  assert.equal(out.value.code, 'EVALUATION_BASELINE_FILE_MISSING')
  rmSync(wsx.tmp, { recursive: true, force: true })
})

test('EB4 冻结后原路径被改写：段收尾核验出基线冲突 BLOCKED，冻结副本保留', async () => {
  const wsx = workspaceFixture('# 契约\n判据：A\n')
  const real = createHash('sha256').update(readFileSync(wsx.contractPath)).digest('hex')
  const eng = makeEngine()
  const { events, definedTools, fs } = env({ workspaceSource: path.join(wsx.tmp, 'source'), engine: eng })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'eb-spec', taskId: 't-eb', runDir: '.agent-runs/t-eb' })
  await until(() => eng.starts.length >= 1, '首段启动')
  await until(() => fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent('t-eb') + '.json'), '逻辑运行登记')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'eb' } })
  events.get('workflow/log')({ id: 'run-1' }, freezeLine(1, real))
  ckptLog(events, 'run-1', 'execute', { confirm: { route: 'READY', contract_digest: real } })
  settle(eng, events, 'run-1', 'cancelled')
  await until(() => eng.starts.length >= 2, '恢复段启动')
  // 恢复段运行期间原路径被改写（模拟执行/评估窗口内契约被替换）
  writeFileSync(wsx.contractPath, '# 被篡改的契约\n', 'utf8')
  settle(eng, events, 'run-2', 'completed', { status: 'WAITING_HUMAN', reason: 'ESCALATED_DECISION', results: { evaluate: { route: 'CONFIRM', contract_digest: real } } })
  const out = JSON.parse(await p)
  assert.equal(out.value.status, 'BLOCKED')
  assert.equal(out.value.code, 'EVALUATION_BASELINE_CONFLICT')
  assert.ok(out.value.message.includes('SOURCE_REWRITTEN'))
  assert.ok(existsSync(wsx.copyV1), '冻结副本必须保留')
  assert.equal(readFileSync(wsx.copyV1, 'utf8'), '# 契约\n判据：A\n')
  const logical = readLogical(fs, 't-eb')
  assert.equal(logical.evaluation_baseline.status, 'conflict')
  assert.equal(logical.lifecycle.state, 'BLOCKED')
  assert.ok(logical.control_events.map((e) => e.type).includes('evaluation_baseline_conflict'))
  rmSync(wsx.tmp, { recursive: true, force: true })
})

test('EB5 未声明 evaluationBaseline：不观察不冻结，正常流程零改动', async () => {
  const eng = makeEngine()
  const wsx = { tmp: mkdtempSync(path.join(tmpdir(), 'vwf-eb-plain-')) }
  const { events, definedTools, fs } = env({ template: PLAIN_BP, workspaceSource: path.join(wsx.tmp, 'source'), engine: eng })
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p = wfRun.execute({ templateId: 'eb-plain', taskId: 't-plain', runDir: '.agent-runs/t-plain' })
  await until(() => eng.starts.length >= 1, '首段启动')
  await until(() => fs._files.get(LOGICAL_DIR + '/' + encodeURIComponent('t-plain') + '.json'), '逻辑运行登记')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'plain' } })
  events.get('workflow/log')({ id: 'run-1' }, freezeLine(1, 'x'))
  ckptLog(events, 'run-1', 'execute', { confirm: { route: 'READY', contract_digest: 'x' } })
  settle(eng, events, 'run-1', 'completed', { status: 'DONE', results: { closeout: { status: 'DELIVERED' } }, completion: { type: 'EVALUATION_PASSED', node: 'closeout', path: '$.status' } })
  const out = JSON.parse(await p)
  assert.equal(eng.starts.length, 1, '无声明模板不产生中止与恢复段')
  assert.equal(out.value.status, 'DONE')
  const logical = readLogical(fs, 't-plain')
  assert.equal(logical.evaluation_baseline, null, '无声明模板不产生基线入档')
  rmSync(wsx.tmp, { recursive: true, force: true })
})

function resumeArgsDigest(req) {
  return req.args && req.args.evaluation_baseline ? req.args.evaluation_baseline.digest : null
}

// 引用内核冒烟：宿主经 dist 加载的内核必须与仓库源同源（防分发缺件）
test('内核可加载且导出完整（宿主 dist 加载契约）', () => {
  for (const k of ['snippetSource', 'parseFreezeRequest', 'freezePayload', 'parseSubprocessJson', 'gateBlockOf', 'baselineRefOf', 'resumeArgsOf', 'verifyPayloadOf', 'conflictOf']) {
    assert.equal(typeof ebKernel[k], 'function', '缺导出：' + k)
  }
})
