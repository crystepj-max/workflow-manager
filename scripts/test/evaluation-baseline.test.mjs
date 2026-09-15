// LOC-027 评价基线冻结契约（evaluationBaseline）：
//   A. 编译脚本运行时——producer READY 冻结请求行/版本递增/取代链、消费节点基线注入、
//      摘要与活动基线不一致的拒绝（A/B 漂移无法走完流程）、RECONFIRM V2 失效 V1 PASS、
//      续跑注入已核验引用后的闸门行为（AC-01/AC-03/AC-04 脚本级）
//   B. evaluation-baseline.cjs 内核——冻结/核验子进程真实语义（字节级 SHA-256、不可变
//      副本、原路径改写冲突）与纯函数判定
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileBlueprint, projectToVwf } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'
import eb from '../evaluation-baseline.cjs'

const { validateBlueprint, projectToBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const optimizeBp = JSON.parse(readFileSync(path.join(here, '../../templates/wf-optimize.json'), 'utf8'))

const compile = (bp) => compileBlueprint(bp)
const runEngine = (bp, table, args = {}) => {
  const { script } = compile(bp)
  const agent = makeAgentScript(table)
  return runGeneratedScript(script, { args, agent })
}
const freezeLogs = (logs) => logs.filter((l) => l.indexOf('[eb-freeze]') === 0).map((l) => JSON.parse(l.slice('[eb-freeze]'.length)))

test('LOC-027 蓝图声明合法且投影往返无损（编辑器另存不丢字段）', () => {
  assert.equal(validateBlueprint(optimizeBp).ok, true, JSON.stringify(validateBlueprint(optimizeBp).errors))
  assert.deepEqual(optimizeBp.evaluationBaseline, { artifact: 'evaluation-contract.md', digestField: 'contract_digest', producerNode: 'confirm' })
  const dsl = projectToVwf(optimizeBp)
  assert.deepEqual(dsl.evaluationBaseline, optimizeBp.evaluationBaseline)
  const back = projectToBlueprint(dsl)
  assert.deepEqual(back.evaluationBaseline, optimizeBp.evaluationBaseline)
})

test('LOC-027 非法声明 loud-fail：producerNode 指向不存在节点时编译拒绝', () => {
  const bp = JSON.parse(JSON.stringify(optimizeBp))
  bp.evaluationBaseline.producerNode = 'ghost'
  assert.throws(() => compile(bp), /producerNode/)
})

test('AC-04 正常路径：冻结请求行 + 基线注入提示，全流程自动完成无额外人工节点', async () => {
  const { result, logs, agentCalls } = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'd1' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: { route: 'PASS', summary: '满足判据', contract_digest: 'd1', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  }, { taskId: 't-ok', runDir: '.agent-runs/t-ok' })
  assert.equal(result.status, 'DONE')
  const reqs = freezeLogs(logs)
  assert.equal(reqs.length, 1)
  assert.equal(reqs[0].version, 1)
  assert.equal(reqs[0].claimed_digest, 'd1')
  assert.equal(reqs[0].source, '.agent-runs/t-ok/evaluation-contract.md')
  assert.equal(reqs[0].copy, '.agent-runs/t-ok/evaluation-baselines/v1/evaluation-contract.md')
  assert.equal(reqs[0].supersedes, null)
  const labels = agentCalls.map((c) => c.label)
  assert.deepEqual(labels, ['目标确认', '执行', '评估', '收口'], '不得额外增加人工确认节点')
  const execPrompt = agentCalls.find((c) => c.label === '执行').prompt
  const evalPrompt = agentCalls.find((c) => c.label === '评估').prompt
  assert.ok(execPrompt.includes('evaluation-baselines/v1/evaluation-contract.md'), '执行节点提示携带冻结副本路径')
  assert.ok(evalPrompt.includes('sha256=d1'), '评估节点提示携带活动基线摘要')
  assert.ok(evalPrompt.includes('尚未经运行时核验'), '未核验引用如实标注')
})

test('AC-01 A/B 漂移：评估摘要与活动基线不一致被拦截，修正后才能通过', async () => {
  let evals = 0
  const { result } = await runEngine(optimizeBp, {
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'A' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: () => {
      evals += 1
      // 第一轮上报 B（漂移复现），被闸门拒绝后按反馈改报 A
      return { route: evals === 1 ? 'PASS' : 'PASS', summary: '满足判据', contract_digest: evals === 1 ? 'B' : 'A', gaps: '' }
    },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  })
  assert.equal(result.status, 'DONE')
  assert.equal(evals, 2, '漂移结论必须先被拒绝重做')
  const conflicts = result.history.filter((h) => h.verdict === 'BASELINE_CONFLICT')
  assert.equal(conflicts.length, 1)
  assert.ok(conflicts[0].reason.includes('A'), '拒绝原因必须指明活动基线摘要')
  assert.equal(result.results.evaluate.contract_digest, 'A', '入档结果为修正后的基线摘要')
  assert.equal(result.results.evaluate.route, 'PASS')
})

test('AC-01 无 technical 出口时漂移直接 TECHNICAL_FAILURE（不放行）', async () => {
  const bp = {
    id: 'eb-mini', displayName: 'EB mini', description: '', entry: 'confirm',
    control: { maxRounds: 3 },
    bindings: { models: { confirm: { provider: 'p', model: 'm' }, evaluate: { provider: 'p', model: 'm' }, closeout: { provider: 'p', model: 'm' } } },
    nodes: [
      { id: 'confirm', profile: 'requirements', label: '确认', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['READY'] }, contract_digest: { type: 'string' } }, required: ['route', 'contract_digest'], additionalProperties: false }, outcomePath: '$.route' } },
      { id: 'evaluate', profile: 'evaluator', label: '评估', goal: 'g', output: { schema: { type: 'object', properties: { route: { type: 'string', enum: ['PASS'] }, contract_digest: { type: 'string' } }, required: ['route', 'contract_digest'], additionalProperties: false }, outcomePath: '$.route' } },
      { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }, completionPath: '$.result' } },
    ],
    edges: [
      { from: 'confirm', to: 'evaluate', outcome: 'READY' },
      { from: 'evaluate', to: 'closeout', outcome: 'PASS' },
      { from: 'closeout', to: '$end', on: 'success' },
    ],
    evaluationBaseline: { artifact: 'evaluation-contract.md', digestField: 'contract_digest', producerNode: 'confirm' },
  }
  assert.equal(validateBlueprint(bp).ok, true, JSON.stringify(validateBlueprint(bp).errors))
  const { result } = await runEngine(bp, {
    确认: { route: 'READY', contract_digest: 'A' },
    评估: { route: 'PASS', contract_digest: 'B' },
    收口: { result: 'done' },
  })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.ok(result.detail.includes('基线冲突'))
  assert.ok(!result.results['收口'] && !result.results.closeout, '漂移运行不得走到收口')
})

test('AC-03 RECONFIRM 产生 V2：执行/评估提示指向 V2，V1 的 PASS 摘要被拒绝', async () => {
  let execs = 0
  let evals = 0
  let confirms = 0
  const { result, logs, agentCalls } = await runEngine(optimizeBp, {
    目标确认: () => {
      confirms += 1
      return { route: 'READY', summary: '契约冻结', contract_digest: confirms === 1 ? 'd1' : 'd2' }
    },
    执行: () => {
      execs += 1
      if (execs === 1) return { route: 'RECONFIRM_REQUIRED', summary: '契约已不可执行', changed: '' }
      return { route: 'READY', summary: '最小修改', changed: 'a.md' }
    },
    评估: () => {
      evals += 1
      // V2 生效后仍报 V1 摘要 → 拒绝；按反馈改报 V2 → 通过
      return { route: 'PASS', summary: '满足判据', contract_digest: evals === 1 ? 'd1' : 'd2', gaps: '' }
    },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  }, { taskId: 't-v2', runDir: '.agent-runs/t-v2' })
  assert.equal(result.status, 'DONE')
  const reqs = freezeLogs(logs)
  assert.equal(reqs.length, 2, '两次确认各产生一次冻结请求')
  assert.equal(reqs[1].version, 2)
  assert.deepEqual(reqs[1].supersedes, { version: 1, digest: 'd1' }, 'V2 显式记录取代关系')
  assert.equal(result.budgetUsed, 0, 'RECONFIRM 不消耗额度')
  const evalCalls = agentCalls.filter((c) => c.label === '评估')
  const execCalls = agentCalls.filter((c) => c.label === '执行')
  assert.ok(execCalls[1].prompt.includes('evaluation-baselines/v2/evaluation-contract.md'), '第二次执行提示指向 V2 冻结副本')
  assert.ok(execCalls[1].prompt.includes('取代 v1'), '执行提示声明取代关系')
  assert.ok(evalCalls[0].prompt.includes('sha256=d2'), '重确认后评估提示指向 V2 摘要')
  assert.ok(evalCalls[0].prompt.includes('取代 v1') && evalCalls[0].prompt.includes('旧基线下的 PASS 与结论不再适用'), '提示明确旧 PASS 失效')
  assert.equal(evals, 2, '携带 V1 摘要（d1）的 PASS 在 V2 下被拒绝重做')
  assert.equal(result.history.filter((h) => h.verdict === 'BASELINE_CONFLICT').length, 1)
  assert.equal(result.results.evaluate.contract_digest, 'd2', '入档评估结果为 V2 摘要')
})

test('续跑注入已核验引用：核验标注切换、闸门以宿主摘要为准', async () => {
  const { result, agentCalls } = await runEngine(optimizeBp, {
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: () => ({ route: 'PASS', summary: '满足判据', contract_digest: 'real1', gaps: '' }),
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  }, {
    taskId: 't-resume',
    runDir: '.agent-runs/t-resume',
    entry: 'execute',
    results: { confirm: { route: 'READY', summary: '冻结', contract_digest: 'real1' } },
    evaluation_baseline: { run_id: 't-resume', version: 1, artifact_path: '.agent-runs/t-resume/evaluation-baselines/v1/evaluation-contract.md', algorithm: 'sha256', digest: 'real1', status: 'verified' },
    evaluation_baseline_version: 1,
  })
  assert.equal(result.status, 'DONE')
  const evalPrompt = agentCalls.find((c) => c.label === '评估').prompt
  assert.ok(evalPrompt.includes('已经运行时按原始字节核验'), '已核验引用如实标注')
})

// ── B. evaluation-baseline.cjs 内核（真实子进程字节语义） ──────────────────────

function kernelEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'eb-kernel-test-'))
  const runDir = join(dir, '.agent-runs', 't1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'evaluation-contract.md'), '# 契约 A\n判据行\n', 'utf8')
  return { dir, runDir, src: join(runDir, 'evaluation-contract.md') }
}
const runSnippet = (payload) => JSON.parse(execFileSync(process.execPath, ['-e', eb.snippetSource(), JSON.stringify(payload)], { encoding: 'utf8' }))
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex')

test('内核 freeze：字节级 SHA-256 + 版本隔离副本 + 清单；声称值不一致只报告不纠正', () => {
  const envd = kernelEnv()
  try {
    const real = sha256Of(readFileSync(envd.src))
    const req = { version: 1, claimed_digest: real, supersedes: null }
    const payload = eb.freezePayload({ artifact: 'evaluation-contract.md', cwd: envd.dir, runDir: '.agent-runs/t1', taskId: 't1', req })
    const out = runSnippet(payload)
    assert.equal(out.ok, true)
    assert.equal(out.match, true)
    assert.equal(out.digest, real)
    const copyPath = join(payload.copy_dir, 'evaluation-contract.md')
    assert.ok(existsSync(copyPath), '不可变副本必须落盘')
    assert.equal(sha256Of(readFileSync(copyPath)), real, '副本与原文件逐字节一致')
    const manifest = JSON.parse(readFileSync(join(payload.copy_dir, 'baseline.json'), 'utf8'))
    assert.equal(manifest.algorithm, 'sha256')
    assert.equal(manifest.digest, real)
    assert.equal(manifest.version, 1)
    assert.equal(manifest.match, true)

    const bad = runSnippet({ ...payload, claimed_digest: 'deadbeef' })
    assert.equal(bad.ok, true, '摘要不一致是可报告结果而非进程故障')
    assert.equal(bad.match, false, '声称值不一致如实报告')

    writeFileSync(envd.src, '# 契约 B\n被替换\n', 'utf8')
    const conflict = runSnippet({ ...payload, claimed_digest: null })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'IMMUTABLE_CONFLICT')
    assert.equal(sha256Of(readFileSync(copyPath)), real, '已存在副本不被覆写')
  } finally { rmSync(envd.dir, { recursive: true, force: true }) }
})

test('内核 freeze：原评价文件缺失/不可读是阻塞', () => {
  const envd = kernelEnv()
  try {
    rmSync(envd.src)
    const payload = eb.freezePayload({ artifact: 'evaluation-contract.md', cwd: envd.dir, runDir: '.agent-runs/t1', taskId: 't1', req: { version: 1, claimed_digest: 'x', supersedes: null } })
    const out = runSnippet(payload)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'FILE_MISSING')
  } finally { rmSync(envd.dir, { recursive: true, force: true }) }
})

test('内核 verify：原路径改写/删除=基线冲突；一致=放行；证据缺失 fail closed', () => {
  const envd = kernelEnv()
  try {
    const real = sha256Of(readFileSync(envd.src))
    const payload = eb.freezePayload({ artifact: 'evaluation-contract.md', cwd: envd.dir, runDir: '.agent-runs/t1', taskId: 't1', req: { version: 1, claimed_digest: real, supersedes: null } })
    assert.equal(runSnippet(payload).ok, true)
    // 运行时宿主以 '/' 拼接路径（与 verifyPayloadOf 的 '/' 口径一致），此处同构
    const ref = { artifact_path: payload.copy_dir + '/evaluation-contract.md', source_path: payload.source }
    const vp = eb.verifyPayloadOf(ref)
    assert.equal(runSnippet(vp).conflict, false, '未改动时核验通过')

    writeFileSync(envd.src, '# 被篡改\n', 'utf8')
    const rewritten = runSnippet(vp)
    assert.equal(rewritten.conflict, true)
    assert.equal(rewritten.code, 'SOURCE_REWRITTEN')
    assert.equal(rewritten.expected, real)

    rmSync(envd.src)
    const missing = runSnippet(vp)
    assert.equal(missing.conflict, true)
    assert.equal(missing.code, 'SOURCE_MISSING')

    rmSync(join(payload.copy_dir, 'baseline.json'))
    const noManifest = runSnippet(vp)
    assert.equal(noManifest.ok, false)
    assert.equal(noManifest.code, 'MANIFEST_MISSING', '证据缺失不得包装为成功')
    assert.deepEqual(eb.conflictOf(noManifest, { version: 1 }, 'confirm').detail_code, 'MANIFEST_MISSING')
  } finally { rmSync(envd.dir, { recursive: true, force: true }) }
})

test('内核纯函数：请求解析/阻断判定/引用构造/恢复参数装配', () => {
  const req = eb.parseFreezeRequest('前缀日志 [eb-freeze]{"version":2,"claimed_digest":"AB","supersedes":{"version":1,"digest":"cd"}}')
  assert.deepEqual(req, { version: 2, claimed_digest: 'AB', supersedes: { version: 1, digest: 'cd' } })
  assert.equal(eb.parseFreezeRequest('[eb-freeze] not-json'), null)
  assert.equal(eb.parseFreezeRequest('普通日志'), null)

  const missing = eb.gateBlockOf({ ok: false, code: 'FILE_MISSING' }, { version: 3, source: '/s' }, 'confirm')
  assert.equal(missing.code, 'EVALUATION_BASELINE_FILE_MISSING')
  assert.ok(missing.message.includes('v3'))
  const mismatch = eb.gateBlockOf({ ok: true, match: false, digest: 'z' }, { version: 3, claimed_digest: 'y' }, 'confirm')
  assert.equal(mismatch.code, 'EVALUATION_BASELINE_DIGEST_MISMATCH')
  assert.equal(eb.gateBlockOf({ ok: true, match: true, digest: 'z', copy_path: '/c' }, { version: 3 }, 'confirm'), null)

  const ref = eb.baselineRefOf({ ok: true, digest: 'z', copy_path: '/c' }, { version: 3, source: '/s', supersedes: { version: 2, digest: 'y' } }, 'run-x')
  assert.deepEqual(ref, { run_id: 'run-x', version: 3, artifact_path: '/c', source_path: '/s', algorithm: 'sha256', digest: 'z', status: 'verified', supersedes: { version: 2, digest: 'y' } })

  const resumeArgs = eb.resumeArgsOf({ taskId: 't' }, { entry: 'execute', results: { confirm: {} }, history: [], round: 1, budgetUsed: 2, maxRounds: 5, decisionSeq: 0 }, ref)
  assert.equal(resumeArgs.entry, 'execute')
  assert.equal(resumeArgs.evaluation_baseline_version, 3)
  assert.equal(resumeArgs.evaluation_baseline.digest, 'z')
  assert.equal(resumeArgs.decision_id, undefined)
  assert.equal(resumeArgs.user_choice, undefined)
  assert.equal(resumeArgs.approved, undefined)

  const conflict = eb.conflictOf({ ok: true, conflict: true, code: 'SOURCE_REWRITTEN', expected: 'e', observed: 'o' }, { version: 3 }, 'confirm')
  assert.equal(conflict.code, 'EVALUATION_BASELINE_CONFLICT')
  assert.equal(conflict.detail_code, 'SOURCE_REWRITTEN')
  assert.ok(conflict.message.includes('v3'))
  assert.equal(eb.conflictOf({ ok: true, conflict: false }, { version: 3 }, 'confirm'), null)
})
