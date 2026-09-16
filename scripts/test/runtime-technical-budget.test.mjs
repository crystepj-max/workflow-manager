// LOC-031（WR-011）技术预算运行时测试：限制技术重试、超时与无进展循环。
// 契约：docs/tasks/specs/technical-budget/task-spec-V1.md §9/§15（AC-01..AC-05）。
// 排练厅黑盒执行编译产物（接口断言），虚拟时钟验证 deadline 与退避（可注入时钟）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'
import validatorCore from '../validate-core.cjs'

const { validateBlueprint, validateRetryPolicy, RETRY_POLICY_DEFAULTS, RETRY_POLICY_LIMITS } = validatorCore

const here = path.dirname(fileURLToPath(import.meta.url))
const evaluateBp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-evaluate-mini.json'), 'utf8'))
const reconfirmBp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-reconfirm-mini.json'), 'utf8'))
const hello = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'))

const compile = (bp) => compileBlueprint(bp).script
const runEngine = (bp, table, args = {}) => {
  const agent = makeAgentScript(table)
  return runGeneratedScript(compile(bp), { args, agent }).then((r) => Object.assign(r, { agent }))
}

// ---------- 蓝图契约：control.retryPolicy 校验与投影 ----------

test('LOC-031 夹具卫生：evaluate/reconfirm 蓝图通过校验', () => {
  for (const bp of [evaluateBp, reconfirmBp]) {
    assert.equal(validateBlueprint(bp).ok, true, JSON.stringify(validateBlueprint(bp).errors))
  }
})

test('LOC-031 retryPolicy 校验：合法声明通过，非法值/未知键报坐标', () => {
  const ok = validateRetryPolicy({ max_attempts: 2, backoff_ms: [500], attempt_timeout_ms: 60000, run_auto_time_ms: 3600000, no_progress_repeats: 3 })
  assert.equal(ok.length, 0)
  const bad = validateRetryPolicy({ max_attempts: 0, backoff_ms: [], attempt_timeout_ms: 10, run_auto_time_ms: -1, no_progress_repeats: 'x', evil: 1 })
  assert.equal(bad.filter((e) => e.at.includes('max_attempts')).length, 1)
  assert.equal(bad.filter((e) => e.at.includes('backoff_ms')).length, 1)
  assert.equal(bad.filter((e) => e.at.includes('attempt_timeout_ms')).length, 1)
  assert.equal(bad.filter((e) => e.at.includes('run_auto_time_ms')).length, 1)
  assert.equal(bad.filter((e) => e.at.includes('no_progress_repeats')).length, 1)
  assert.equal(bad.filter((e) => e.at.includes('evil')).length, 1)
  assert.ok(bad.every((e) => e.at.startsWith('$.control.retryPolicy')))
})

test('LOC-031 蓝图校验：control.retryPolicy 非法进入 validateBlueprint 错误列表', () => {
  const bp = JSON.parse(JSON.stringify(evaluateBp))
  bp.control.retryPolicy = { max_attempts: 99 }
  const v = validateBlueprint(bp)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.at === '$.control.retryPolicy.max_attempts'))
})

test('LOC-031 投影互逆：control.retryPolicy 蓝图 ↔ DSL 双向保留', async () => {
  const gen = await import('../generate.mjs')
  const bp = JSON.parse(JSON.stringify(evaluateBp))
  bp.control.retryPolicy = { max_attempts: 5 }
  const dsl = gen.projectToVwf(bp)
  assert.equal(dsl.control.retryPolicy.max_attempts, 5)
  const bp2 = validatorCore.projectToBlueprint(dsl)
  assert.equal(bp2.control.retryPolicy.max_attempts, 5)
  // 未声明时不伪造
  const dsl2 = gen.projectToVwf(evaluateBp)
  assert.equal(dsl2.control.retryPolicy, undefined)
})

test('LOC-031 编译注入：策略常量与 V1 默认值同源（单一事实源 parity）', () => {
  const script = compile(evaluateBp)
  assert.ok(script.includes('const RETRY_POLICY_BASE = ' + JSON.stringify(RETRY_POLICY_DEFAULTS)), '默认策略与 validate-core 同源')
  assert.ok(script.includes('const RETRY_POLICY_LIMITS = ' + JSON.stringify(RETRY_POLICY_LIMITS)))
})

// ---------- AC-01：持续无效输出最多 3 次即停止；格式修复与技术自环共用预算 ----------

test('AC-01 技术自环：持续无效输出恰 3 次调用后受阻，不再依赖 AGENT_CAP', async () => {
  let evals = 0
  const { result } = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return null
    },
  })
  assert.equal(evals, 3, '最多 3 次模型尝试（首次 + 格式修复 + 技术自环重入）')
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'TECHNICAL_BUDGET_EXHAUSTED')
  assert.equal(result.failure.code, 'INVALID_OUTPUT')
  const evalKey = Object.keys(result.technical_budget.activations).find((k) => k.startsWith('evaluate|'))
  assert.equal(result.technical_budget.activations[evalKey], 3)
  assert.ok(result.technical_budget.activations[evalKey] < 1000, '不再跑到 AGENT_CAP=1000')
})

test('AC-01 共享预算：第 3 次尝试沿技术自环重入，不因换路径偷偷续期', async () => {
  // 调用序列：首败(1) → 格式修复(2) → 技术自环重入(3) → 第 3 次成功则走通
  let evals = 0
  const { result, agentCalls } = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return evals < 3 ? null : { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
    },
  })
  assert.equal(result.status, 'DONE', '第 3 次（激活预算内最后一次）成功即走通')
  assert.equal(evals, 3)
  assert.equal(agentCalls.filter((c) => c.label.startsWith('evaluate')).length, 3)
  assert.ok(result.history.some((h) => h.on === 'technical' && h.countRound === false), '技术自环有记录')
  assert.equal(result.budgetUsed, 0, '业务返工计数不因技术重试增加（AC-03 前半）')
})

test('AC-01 旧模式：技术性失败沿 failure 边重入同样共享激活预算', async () => {
  // hello：dispatch 无 outcomePath；dispatch 持续无效 → 2 次（首败+格式修复）后沿 failure 边到 $end → TECHNICAL_FAILURE
  let calls = 0
  const { result } = await runEngine(hello, {
    dispatch: () => {
      calls += 1
      return { foo: 1 }
    },
  })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.ok(calls <= 3, '旧模式技术失败同样受激活预算约束')
  assert.equal(result.history[0].verdict, 'AGENT_FAILED')
})

// ---------- AC-02：暂时错误退避（可控时钟）、不可重试 1 次即停、超时停新调用 ----------

test('AC-02 暂时错误：按 backoff_ms [1000,2000] 退避（可注入时钟验证），第 3 次成功', async () => {
  let now = 1000
  const sleeps = []
  let calls = 0
  const agent = async (prompt, opts = {}) => {
    calls += 1
    const label = opts.label || ''
    if (calls <= 2) throw new Error('upstream 500 temporarily overloaded')
    if (label.startsWith('intake')) return { go: 'NEXT' }
    if (label.startsWith('execute')) return { status: 'DONE' }
    return { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
  }
  agent.calls = []
  const { result } = await runGeneratedScript(compile(evaluateBp), {
    args: {
      clock_now: () => now,
      clock_sleep: (ms) => {
        sleeps.push(ms)
        now += ms
        return Promise.resolve()
      },
    },
    agent,
  })
  assert.equal(result.status, 'DONE')
  assert.deepEqual(sleeps, [1000, 2000], '退避档位 = backoff_ms 逐档取用')
})

test('AC-02 不可重试错误：权限拒绝 1 次即停，不重试不重跑', async () => {
  let calls = 0
  const agent = async () => {
    calls += 1
    throw new Error('403 forbidden: permission denied')
  }
  agent.calls = []
  const { result } = await runGeneratedScript(compile(evaluateBp), { args: {}, agent })
  assert.equal(calls, 1, '不可重试错误最多调用 1 次')
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'NON_RETRYABLE_ERROR')
  assert.equal(result.failure.cls, 'fatal_error')
})

test('AC-02 单次截止：超过 attempt_timeout_ms 后停止发起新调用，结果弃用并标注取消限制', async () => {
  let calls = 0
  const agent = async (prompt, opts = {}) => {
    calls += 1
    if ((opts.label || '').startsWith('execute')) {
      await new Promise((r) => setTimeout(r, 1500))
      return { status: 'DONE' }
    }
    return { go: 'NEXT' }
  }
  agent.calls = []
  const { result } = await runGeneratedScript(compile(evaluateBp), {
    args: { retry_policy_overrides: { attempt_timeout_ms: 1040, run_auto_time_ms: 3600000 } },
    agent,
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'ATTEMPT_TIMEOUT')
  assert.ok(result.failure.detail.includes('超过截止'))
  assert.ok(result.technical_budget.cancellation.note.includes('无法强制终止'), 'AC-05：取消能力限制如实标注')
})

test('AC-02 Run 自动时间：累计超 run_auto_time_ms 后不再发起新调用（人工等待不计入）', async () => {
  let now = 0
  let calls = 0
  const agent = async (prompt, opts = {}) => {
    calls += 1
    const label = opts.label || ''
    if (label.startsWith('intake')) return { go: 'NEXT' }
    if (label.startsWith('execute')) return { status: 'DONE' }
    return { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
  }
  agent.calls = []
  // 时钟按读取推进，模拟自动时间消耗；上限收紧到 1100ms
  const { result } = await runGeneratedScript(compile(evaluateBp), {
    args: { clock_now: () => (now += 400), retry_policy_overrides: { run_auto_time_ms: 1100 } },
    agent,
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'RUN_TIME_BUDGET_EXHAUSTED')
  assert.equal(result.technical_budget.auto_limit_ms, 1100, '冻结策略可见（AC-05）')
})

// ---------- AC-03：业务额度不受技术重试影响；恢复不重置；扩容须显式 grant ----------

test('AC-03 业务额度不受技术重试影响：OPTIMIZE 照常计数与挂起', async () => {
  const bp = JSON.parse(JSON.stringify(evaluateBp))
  bp.control.maxRounds = 2
  let evals = 0
  const { result } = await runEngine(bp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return { verdict: 'OPTIMIZE', completion_type: 'loop' }
    },
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'MAX_ROUNDS_REACHED', '业务回退仍由 MAX_ROUNDS 管辖')
  assert.equal(result.budgetUsed, 2)
  assert.equal(evals, 3)
})

test('AC-03 受阻恢复不重置：不带 grant 原样恢复 = 0 次新调用并再次受阻', async () => {
  let evals = 0
  const first = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return null
    },
  })
  assert.equal(first.result.reason, 'TECHNICAL_BUDGET_EXHAUSTED')
  const before = evals
  const second = await runEngine(evaluateBp, {
    '/^evaluate/': () => {
      evals += 1
      return null
    },
  }, {
    entry: first.result.resume.entry,
    results: first.result.resume.results,
    history: first.result.resume.history,
    startRound: first.result.resume.startRound,
    feedback: first.result.resume.feedback,
    budgetUsed: first.result.resume.budgetUsed,
    maxRounds: first.result.resume.maxRounds,
    decisionSeq: first.result.resume.decisionSeq,
    technical_budget: first.result.resume.technical_budget,
  })
  assert.equal(evals - before, 0, '不提供 grant 而原样恢复不会重跑激活')
  assert.equal(second.result.status, 'WAITING_HUMAN')
  assert.equal(second.result.reason, 'TECHNICAL_BUDGET_EXHAUSTED')
})

test('AC-03 显式提额：grant（增量+原因）后可继续，写入历史；坏 grant 拒绝', async () => {
  let evals = 0
  const first = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return null
    },
  })
  // 继续：+2 次后第 2 次成功
  let resumedCalls = 0
  const second = await runEngine(evaluateBp, {
    '/^evaluate/': () => {
      resumedCalls += 1
      return resumedCalls < 2 ? null : { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
    },
  }, {
    entry: first.result.resume.entry,
    results: first.result.resume.results,
    history: first.result.resume.history,
    startRound: first.result.resume.startRound,
    feedback: first.result.resume.feedback,
    budgetUsed: first.result.resume.budgetUsed,
    maxRounds: first.result.resume.maxRounds,
    decisionSeq: first.result.resume.decisionSeq,
    technical_budget: first.result.resume.technical_budget,
    technical_budget_grant: { add_attempts: 2, reason: '夜间批次临时额度' },
  })
  assert.equal(second.result.status, 'DONE')
  assert.equal(resumedCalls, 2)
  const grants = second.result.history.filter((h) => h.via === 'TECHNICAL_BUDGET_GRANT')
  assert.equal(grants.length, 1)
  assert.equal(grants[0].add_attempts, 2)
  assert.equal(grants[0].reason, '夜间批次临时额度')
  assert.equal(second.result.technical_budget.grants[first.result.resume.technical_budget.activation_key], 2)

  // 坏 grant：缺 reason → ERROR，不启动
  const third = await runEngine(evaluateBp, { '/^evaluate/': () => null }, {
    entry: first.result.resume.entry,
    technical_budget: first.result.resume.technical_budget,
    technical_budget_grant: { add_attempts: 2 },
  })
  assert.equal(third.result.status, 'ERROR')
  assert.ok(third.result.detail.includes('reason'))
})

test('AC-03 业务输入新版本恢复：新激活签名获得全新预算，不继承已耗尽次数', async () => {
  let evals = 0
  const first = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return null
    },
  })
  assert.equal(first.result.reason, 'TECHNICAL_BUDGET_EXHAUSTED')
  // 业务输入修订（feedback 变化）后恢复：激活 = 同节点 + 同输入版本，新签名必须走全新键与全新预算，
  // 不得沿用冻结键继承已耗用量（沿用则 0 次新调用立即再受阻）。
  const resumedFeedback = first.result.resume.feedback + '\n[业务输入新版本 V2：验收标准已修订]'
  let resumedCalls = 0
  const second = await runEngine(evaluateBp, {
    '/^evaluate/': () => {
      resumedCalls += 1
      return resumedCalls < 2 ? null : { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' }
    },
  }, {
    entry: first.result.resume.entry,
    results: first.result.resume.results,
    history: first.result.resume.history,
    startRound: first.result.resume.startRound,
    feedback: resumedFeedback,
    budgetUsed: first.result.resume.budgetUsed,
    maxRounds: first.result.resume.maxRounds,
    decisionSeq: first.result.resume.decisionSeq,
    technical_budget: first.result.resume.technical_budget,
  })
  assert.ok(resumedCalls > 0, '新业务输入必须获得全新激活预算（不得 0 次新调用即再受阻）')
  assert.equal(second.result.status, 'DONE')
  assert.notEqual(
    second.result.technical_budget.activation_key,
    first.result.resume.technical_budget.activation_key,
    '输入版本变化后不得沿用受阻现场的激活键',
  )
})

// ---------- AC-04：无进展回边（RECONFIRM 类）连续 2 次受阻；新目标/新基线不误判 ----------

test('AC-04 无进展回边：第 2 次相同签名即受阻，业务额度 0 消耗', async () => {
  let execs = 0
  const { result } = await runEngine(reconfirmBp, {
    kickoff: { go: 'START' },
    '/^intake/': { go: 'NEXT' },
    execute: () => {
      execs += 1
      return execs <= 2 ? { status: 'RECONFIRM_REQUIRED' } : { status: 'DONE' }
    },
    evaluate: { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' },
  })
  assert.equal(result.status, 'WAITING_HUMAN')
  assert.equal(result.reason, 'NO_PROGRESS_BLOCKED')
  assert.equal(execs, 2)
  assert.equal(result.budgetUsed, 0)
  assert.equal(result.results.execute.status, 'RECONFIRM_REQUIRED', '原 Outcome 保留')
  assert.ok(result.history.some((h) => h.halted === true && h.reason === 'NO_PROGRESS_BLOCKED'))
})

test('AC-04 反例：结果轮替（真实变化）不被误判', async () => {
  let execs = 0
  const { result } = await runEngine(reconfirmBp, {
    kickoff: { go: 'START' },
    '/^intake/': { go: 'NEXT' },
    execute: () => {
      execs += 1
      return execs % 2 === 1 ? { status: 'RECONFIRM_REQUIRED' } : { status: 'DONE' }
    },
    evaluate: { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' },
  })
  assert.equal(result.status, 'DONE', '结果取值变化 → 签名不同 → 不受阻')
})

test('AC-04 反例：业务返工（countRound:true）不受无进展规则抢占', async () => {
  const bp = JSON.parse(JSON.stringify(evaluateBp))
  bp.control.maxRounds = 2
  let evals = 0
  const { result } = await runEngine(bp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => {
      evals += 1
      return { verdict: 'OPTIMIZE', completion_type: 'loop' }
    },
  })
  assert.equal(result.reason, 'MAX_ROUNDS_REACHED', '计费回退到达上限走既有 MAX_ROUNDS_REACHED')
})

// ---------- AC-05：冻结限制与实际消耗可见；取消能力限制标注 ----------

test('AC-05 消耗可见：DONE 与受阻结果携带冻结策略与实际消耗', async () => {
  const { result } = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    evaluate: { verdict: 'PASS', completion_type: 'EVALUATION_PASSED' },
  })
  assert.equal(result.status, 'DONE')
  const tb = result.technical_budget
  assert.equal(tb.policy.max_attempts, 3)
  assert.deepEqual(tb.policy.backoff_ms, [1000, 2000])
  assert.equal(tb.policy.attempt_timeout_ms, 1800000)
  assert.equal(tb.policy.run_auto_time_ms, 14400000)
  assert.equal(tb.policy.no_progress_repeats, 2)
  assert.ok(tb.activations && Object.keys(tb.activations).length >= 3, '逐激活消耗可见')
  assert.equal(tb.auto_limit_ms, 14400000)
  assert.ok(tb.cancellation.note.includes('无法强制终止'))
})

test('AC-05 受阻卡：停止原因指出预算种类、已用量与下一步', async () => {
  const { result } = await runEngine(evaluateBp, {
    intake: { go: 'NEXT' },
    '/^execute/': { status: 'DONE' },
    '/^evaluate/': () => null,
  })
  const why = result.decision_package.why
  assert.ok(why.includes('TECHNICAL_BUDGET_EXHAUSTED'), '预算种类')
  assert.ok(why.includes('自动时间'), '已用量（时间）')
  assert.ok(why.includes('激活'), '已用量（次数）')
  assert.ok(why.includes('technical_budget_grant'), '下一步')
  assert.ok(result.decision_package.options.some((o) => o.id === 'STOP'))
  assert.equal(result.resume.technical_budget.activation_key.startsWith('evaluate|'), true)
})
