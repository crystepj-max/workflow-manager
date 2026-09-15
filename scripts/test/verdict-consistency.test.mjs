// LOC-025（WR-002）：阻止互相矛盾的裁决进入下一质量关口。
// 契约：docs/tasks/specs/verdict-consistency/task-spec-V1.md §9 / §15。
// 机制：节点在 output.consistency 声明配对表 { field, pairs }（校验器注册 + 生成脚本在
// 路由选择前做同一确定性检查）；表外 route/verdict、route/result 组合是契约错误
// （CONTRACT_INCONSISTENT），不作专业通过判断。语义随模板：建设 review/test 的 6 个
// 合法组合声明在 templates/wf-construction-full-feature.json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint, projectToVwf } from '../generate.mjs'
import validatorCore from '../validate-core.cjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const { validateBlueprint, projectToBlueprint } = validatorCore
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '../..')
const mini = JSON.parse(readFileSync(path.join(here, 'fixtures/verdict-consistency-mini.json'), 'utf8'))
const constructionBp = JSON.parse(readFileSync(path.join(root, 'templates/wf-construction-full-feature.json'), 'utf8'))
const reviewMd = readFileSync(path.join(root, 'dsh/roles/review.md'), 'utf8')
const testMd = readFileSync(path.join(root, 'dsh/roles/test.md'), 'utf8')

const REVIEW_PAIRS = { APPROVE: 'APPROVE', RETURN_DEV: 'REQUEST_CHANGES', BLOCKED: 'COMMENT_ONLY' }
const TEST_PAIRS = { PASS: 'PASSED', RETURN_DEV: 'FAILED', BLOCKED: 'BLOCKED' }

const clone = (bp) => JSON.parse(JSON.stringify(bp))
const expectOk = (bp, label) => {
  const r = validateBlueprint(bp)
  assert.equal(r.ok, true, (label || 'ok') + '：' + JSON.stringify(r.errors))
}
const expectReject = (bp, needle, label) => {
  const r = validateBlueprint(bp)
  assert.equal(r.ok, false, label + '：应拒绝')
  assert.ok(
    r.errors.some((e) => String(e.message).includes(needle) || String(e.fieldKey || '').includes(needle)),
    label + '：应含「' + needle + '」，实际 ' + JSON.stringify(r.errors),
  )
}

const runMini = async (table, args = {}) => {
  const { script } = compileBlueprint(mini)
  const agent = makeAgentScript(table)
  const { result, logs } = await runGeneratedScript(script, { args, agent })
  return { result, agent, logs }
}

// ---------- 声明注册：模板与校验器 ----------

test('LOC-025 建设蓝图声明恰好 6 个合法组合，蓝图校验通过（AC-04 模板侧）', () => {
  const review = constructionBp.nodes.find((n) => n.id === 'review')
  const testNode = constructionBp.nodes.find((n) => n.id === 'test')
  assert.deepEqual(review.output.consistency, { field: 'verdict', pairs: REVIEW_PAIRS })
  assert.deepEqual(testNode.output.consistency, { field: 'result', pairs: TEST_PAIRS })
  expectOk(constructionBp, 'wf-construction-full-feature')
})

test('LOC-025 夹具声明通过校验；未声明的既有蓝图零迁移仍通过', () => {
  expectOk(mini, 'verdict-consistency-mini')
  const bare = clone(mini)
  delete bare.nodes.find((n) => n.id === 'review').output.consistency
  delete bare.nodes.find((n) => n.id === 'test').output.consistency
  expectOk(bare, 'no-declaration')
})

test('LOC-025 校验器：pairs 未覆盖路由枚举即拒绝（防未声明组合绕过）', () => {
  const b = clone(mini)
  delete b.nodes.find((n) => n.id === 'review').output.consistency.pairs.BLOCKED
  expectReject(b, '缺少配对', 'missing-BLOCKED')
})

test('LOC-025 校验器：pairs 键不在 outcomePath 枚举内拒绝', () => {
  const b = clone(mini)
  b.nodes.find((n) => n.id === 'review').output.consistency.pairs.SKIP = 'COMMENT_ONLY'
  expectReject(b, '不在 outcomePath 枚举内', 'extra-route')
})

test('LOC-025 校验器：pairs 值不在结论字段枚举内拒绝', () => {
  const b = clone(mini)
  b.nodes.find((n) => n.id === 'review').output.consistency.pairs.APPROVE = 'NOPE'
  expectReject(b, '不在字段 verdict 枚举内', 'bad-verdict-value')
})

test('LOC-025 校验器：同一结论取值配对多个路由拒绝（一种结论只有一种路由）', () => {
  const b = clone(mini)
  b.nodes.find((n) => n.id === 'review').output.consistency.pairs.APPROVE = 'REQUEST_CHANGES'
  expectReject(b, '不得配对多个路由取值', 'not-injective')
})

test('LOC-025 校验器：field 与 outcomePath 字段同名 / 未在 schema 声明 / 不可穷举均拒绝', () => {
  const same = clone(mini)
  same.nodes.find((n) => n.id === 'review').output.consistency.field = 'route'
  expectReject(same, '同名', 'degenerate-field')

  const ghost = clone(mini)
  ghost.nodes.find((n) => n.id === 'review').output.consistency.field = 'ghost'
  expectReject(ghost, '未在 output.schema 中声明', 'ghost-field')

  const free = clone(mini)
  free.nodes.find((n) => n.id === 'review').output.schema.properties.verdict = { type: 'string' }
  expectReject(free, '可穷举', 'free-string-field')
})

test('LOC-025 校验器：consistency 形态错误与缺 outcomePath 拒绝', () => {
  const notObj = clone(mini)
  notObj.nodes.find((n) => n.id === 'review').output.consistency = 'x'
  expectReject(notObj, '必须是对象', 'not-object')

  const emptyPairs = clone(mini)
  emptyPairs.nodes.find((n) => n.id === 'review').output.consistency.pairs = {}
  expectReject(emptyPairs, '必填', 'empty-pairs')

  const noPath = clone(mini)
  delete noPath.nodes.find((n) => n.id === 'review').output.outcomePath
  expectReject(noPath, '仅支持声明了 outcomePath', 'no-outcome-path')
})

// ---------- AC-01：6 个合法组合走预期边 ----------

test('AC-01 review 三个合法组合各走预期边', async () => {
  const downstream = {
    '独立测试': { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e' },
    'UAT 准备': { route: 'READY_FOR_HUMAN' },
    '返工开发': { route: 'READY' },
  }
  for (const [route, verdict] of Object.entries(REVIEW_PAIRS)) {
    const { result } = await runMini({
      '启动': { route: 'NEXT' },
      '收敛审查': { route, verdict, summary: 's' },
      ...downstream,
    })
    assert.equal(result.status, route === 'APPROVE' ? 'WAITING_HUMAN' : 'DONE',
      route + '：APPROVE 升人工验收、其余走 $end，实际 ' + result.status)
    assert.equal(result.results.review.verdict, verdict, route + '：结论字段保留')
    const edge = result.history.find((h) => h.from === 'review' && h.outcome === route)
    const expectedTo = route === 'APPROVE' ? 'test' : route === 'RETURN_DEV' ? 'dev' : '$end'
    assert.equal(edge.to, expectedTo, route + '：应走 ' + expectedTo + ' 边，history=' + JSON.stringify(result.history))
  }
})

test('AC-01 test 三个合法组合各走预期边', async () => {
  for (const [route, result_] of Object.entries(TEST_PAIRS)) {
    const { result } = await runMini({
      '启动': { route: 'NEXT' },
      '收敛审查': { route: 'APPROVE', verdict: 'APPROVE', summary: 's' },
      '独立测试': { route, result: result_, reason: 'r', evidence: 'e' },
      'UAT 准备': { route: 'READY_FOR_HUMAN' },
      '返工开发': { route: 'READY' },
    })
    assert.equal(result.status, route === 'PASS' ? 'WAITING_HUMAN' : 'DONE',
      route + '：PASS 升人工验收、其余走 $end，实际 ' + result.status)
    const edge = result.history.find((h) => h.from === 'test' && h.outcome === route)
    const expectedTo = route === 'PASS' ? 'uat' : route === 'RETURN_DEV' ? 'dev' : '$end'
    assert.equal(edge.to, expectedTo, route + '：应走 ' + expectedTo + ' 边，history=' + JSON.stringify(result.history))
  }
})

test('AC-01 其余全部 route/verdict 组合被确定性拒绝（表外即契约错误）', async () => {
  for (const route of Object.keys(REVIEW_PAIRS)) {
    for (const verdict of Object.keys({ APPROVE: 1, REQUEST_CHANGES: 1, COMMENT_ONLY: 1 })) {
      if (REVIEW_PAIRS[route] === verdict) continue
      const { result, agent } = await runMini({
        '启动': { route: 'NEXT' },
        '收敛审查': { route, verdict, summary: 's' },
        '独立测试': { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e' },
        'UAT 准备': { route: 'READY_FOR_HUMAN' },
        '返工开发': { route: 'READY' },
      })
      assert.equal(result.status, 'TECHNICAL_FAILURE', route + '/' + verdict + '：应拒绝')
      assert.equal(result.reason, 'CONTRACT_INCONSISTENT', route + '/' + verdict + '：应报契约矛盾')
      assert.equal(result.results.review, undefined, route + '/' + verdict + '：矛盾结果不得存入 results')
      assert.ok(!agent.calls.some((c) => c.label === '独立测试' || c.label === 'UAT 准备' || c.label === '返工开发'),
        route + '/' + verdict + '：不得进入后续关口，实际调用 ' + JSON.stringify(agent.calls.map((c) => c.label)))
    }
  }
})

test('AC-01 其余全部 route/result 组合被确定性拒绝（表外即契约错误）', async () => {
  for (const route of Object.keys(TEST_PAIRS)) {
    for (const result_ of ['PASSED', 'FAILED', 'BLOCKED']) {
      if (TEST_PAIRS[route] === result_) continue
      const { result, agent } = await runMini({
        '启动': { route: 'NEXT' },
        '收敛审查': { route: 'APPROVE', verdict: 'APPROVE', summary: 's' },
        '独立测试': { route, result: result_, reason: 'r', evidence: 'e' },
        'UAT 准备': { route: 'READY_FOR_HUMAN' },
        '返工开发': { route: 'READY' },
      })
      assert.equal(result.status, 'TECHNICAL_FAILURE', route + '/' + result_ + '：应拒绝')
      assert.equal(result.reason, 'CONTRACT_INCONSISTENT', route + '/' + result_ + '：应报契约矛盾')
      assert.equal(result.results.test, undefined, route + '/' + result_ + '：矛盾结果不得存入 results')
      assert.ok(!agent.calls.some((c) => c.label === 'UAT 准备' || c.label === '返工开发'),
        route + '/' + result_ + '：不得进入后续关口')
    }
  }
})

// ---------- AC-02：复现中的两种矛盾 → UAT / 人工等待 / 收口均为 0 ----------

test('AC-02 复现一 review APPROVE 配 REQUEST_CHANGES：不进 UAT、不挂起、不收口', async () => {
  const { result, agent } = await runMini({
    '启动': { route: 'NEXT' },
    '收敛审查': { route: 'APPROVE', verdict: 'REQUEST_CHANGES', summary: '矛盾' },
    '独立测试': { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e' },
    'UAT 准备': { route: 'READY_FOR_HUMAN' },
    '返工开发': { route: 'READY' },
  })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.notEqual(result.status, 'WAITING_HUMAN')
  assert.equal(agent.calls.filter((c) => c.label === 'UAT 准备').length, 0, 'UAT 调用数必须为 0')
  assert.equal(agent.calls.filter((c) => c.label === '返工开发').length, 0)
  assert.equal(result.history[result.history.length - 1].verdict, 'CONTRACT_INCONSISTENT', '历史留痕可追溯')
})

test('AC-02 复现二 test PASS 配 FAILED：不进 UAT、不挂起、不收口', async () => {
  const { result, agent } = await runMini({
    '启动': { route: 'NEXT' },
    '收敛审查': { route: 'APPROVE', verdict: 'APPROVE', summary: 's' },
    '独立测试': { route: 'PASS', result: 'FAILED', reason: '矛盾', evidence: 'e' },
    'UAT 准备': { route: 'READY_FOR_HUMAN' },
    '返工开发': { route: 'READY' },
  })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.notEqual(result.status, 'WAITING_HUMAN')
  assert.equal(agent.calls.filter((c) => c.label === 'UAT 准备').length, 0, 'UAT 调用数必须为 0')
})

// ---------- 真实建设模板排练：矛盾在 UAT / 人工等待 / 收口之前被拦 ----------

test('AC-02 真实建设模板：收敛审查 APPROVE/REQUEST_CHANGES 到不了 UAT 与收口', async () => {
  const { script } = compileBlueprint(constructionBp)
  const branch = 'dev2/task'
  const agent = makeAgentScript({
    '实施前检查': { route: 'PASS', summary: 's', blockers: '无', baseline_version: 'V1' },
    '开发': { route: 'READY', summary: 's', self_check: 'ok' },
    '收敛审查': { route: 'APPROVE', verdict: 'REQUEST_CHANGES', summary: '矛盾', blockers: '', verified_branch: branch, verified_head: 'h1' },
    '测试': { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: branch, verified_head: 'h1' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
    '收口': { status: 'DELIVERED', completion_type: 'DELIVERED', summary: 's', followups: '' },
  })
  const { result } = await runGeneratedScript(script, { agent })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.equal(result.reason, 'CONTRACT_INCONSISTENT')
  assert.notEqual(result.status, 'WAITING_HUMAN')
  assert.equal(agent.calls.filter((c) => c.label === 'UAT 准备').length, 0, 'UAT 调用数 0')
  assert.equal(agent.calls.filter((c) => c.label === '收口').length, 0, '收口调用数 0')
  assert.equal(result.results.review, undefined, '矛盾结果不存为通过证明')
})

test('AC-02 真实建设模板：测试 PASS/FAILED 矛盾到不了 UAT 与收口', async () => {
  const { script } = compileBlueprint(constructionBp)
  const branch = 'dev2/task'
  const agent = makeAgentScript({
    '实施前检查': { route: 'PASS', summary: 's', blockers: '无', baseline_version: 'V1' },
    '开发': { route: 'READY', summary: 's', self_check: 'ok' },
    '收敛审查': { route: 'APPROVE', verdict: 'APPROVE', summary: 's', blockers: '', verified_branch: branch, verified_head: 'h1' },
    '测试': { route: 'PASS', result: 'FAILED', reason: '矛盾', evidence: 'e', verified_branch: branch, verified_head: 'h1' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
    '收口': { status: 'DELIVERED', completion_type: 'DELIVERED', summary: 's', followups: '' },
  })
  const { result } = await runGeneratedScript(script, { agent })
  assert.equal(result.status, 'TECHNICAL_FAILURE')
  assert.equal(result.reason, 'CONTRACT_INCONSISTENT')
  assert.equal(agent.calls.filter((c) => c.label === 'UAT 准备').length, 0, 'UAT 调用数 0')
  assert.equal(agent.calls.filter((c) => c.label === '收口').length, 0, '收口调用数 0')
})

test('真实建设模板合法主链不受影响：APPROVE/APPROVE + PASS/PASSED 走到人工验收等待', async () => {
  const { script } = compileBlueprint(constructionBp)
  const branch = 'dev2/task'
  const agent = makeAgentScript({
    '实施前检查': { route: 'PASS', summary: 's', blockers: '无', baseline_version: 'V1' },
    '开发': { route: 'READY', summary: 's', self_check: 'ok' },
    '收敛审查': { route: 'APPROVE', verdict: 'APPROVE', summary: 's', blockers: '', verified_branch: branch, verified_head: 'h1' },
    '测试': { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: branch, verified_head: 'h1' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
  })
  const { result } = await runGeneratedScript(script, { agent })
  assert.equal(result.status, 'WAITING_HUMAN', '合法主链仍应升人工验收')
  assert.ok(agent.calls.some((c) => c.label === 'UAT 准备'), 'UAT 准备正常调用')
})

// ---------- AC-03：契约矛盾与专业判断可区分；矛盾不存为通过证明 ----------

test('AC-03 RETURN_DEV/REQUEST_CHANGES 是合法专业判断（无契约错误）；矛盾才报 CONTRACT_INCONSISTENT', async () => {
  const legal = await runMini({
    '启动': { route: 'NEXT' },
    '收敛审查': { route: 'RETURN_DEV', verdict: 'REQUEST_CHANGES', summary: '实现不通过' },
    '返工开发': { route: 'READY' },
  })
  assert.equal(legal.result.status, 'DONE')
  assert.ok(!JSON.stringify(legal.result.history).includes('CONTRACT_INCONSISTENT'), '专业打回不是契约错误')

  const illegal = await runMini({
    '启动': { route: 'NEXT' },
    '收敛审查': { route: 'BLOCKED', verdict: 'APPROVE', summary: '矛盾' },
  })
  assert.equal(illegal.result.status, 'TECHNICAL_FAILURE')
  assert.equal(illegal.result.reason, 'CONTRACT_INCONSISTENT')
  assert.deepEqual(illegal.result.contract.allowed_combos, REVIEW_PAIRS, '错误携带允许组合')
  assert.equal(illegal.result.contract.field, 'verdict')
  assert.equal(illegal.result.contract.route, 'BLOCKED')
  assert.equal(illegal.result.contract.actual, 'APPROVE')
  assert.equal(illegal.result.contract.expected, 'COMMENT_ONLY')
  assert.ok(illegal.result.detail.includes('允许的组合'), '错误文案携带允许组合')
})

// ---------- AC-04：角色 / 模板 Schema / 运行时校验表述一致；旧字段仍可读取 ----------

test('AC-04 角色文案与模板、运行时对 6 个组合表述一致', () => {
  assert.ok(reviewMd.includes('APPROVE 配 route=APPROVE'), 'review.md：APPROVE 组合')
  assert.ok(reviewMd.includes('REQUEST_CHANGES 配 route=RETURN_DEV'), 'review.md：REQUEST_CHANGES 组合')
  assert.ok(reviewMd.includes('COMMENT_ONLY 配 route=BLOCKED'), 'review.md：COMMENT_ONLY 组合')
  assert.ok(reviewMd.includes('CONTRACT_INCONSISTENT'), 'review.md：契约错误名称')
  assert.ok(testMd.includes('PASSED 配 route=PASS'), 'test.md：PASSED 组合')
  assert.ok(testMd.includes('FAILED 配 route=RETURN_DEV'), 'test.md：FAILED 组合')
  assert.ok(testMd.includes('BLOCKED 配 route=BLOCKED'), 'test.md：BLOCKED 组合')
  assert.ok(testMd.includes('CONTRACT_INCONSISTENT'), 'test.md：契约错误名称')

  const review = constructionBp.nodes.find((n) => n.id === 'review')
  const testNode = constructionBp.nodes.find((n) => n.id === 'test')
  assert.ok(review.goal.includes('APPROVE/APPROVE、RETURN_DEV/REQUEST_CHANGES、BLOCKED/COMMENT_ONLY'), 'review goal 列出组合')
  assert.ok(review.goal.includes('COMMENT_ONLY 表示无法形成可放行裁决'), 'review goal 写明 COMMENT_ONLY 兼容含义')
  assert.ok(testNode.goal.includes('PASS/PASSED、RETURN_DEV/FAILED、BLOCKED/BLOCKED'), 'test goal 列出组合')

  const { script } = compileBlueprint(constructionBp)
  assert.ok(script.includes('CONTRACT_INCONSISTENT'), '生成脚本含契约错误')
  for (const [k, v] of Object.entries(REVIEW_PAIRS)) assert.ok(script.includes('"' + k + '":"' + v + '"'), '脚本内嵌 review 配对 ' + k + '/' + v)
  for (const [k, v] of Object.entries(TEST_PAIRS)) assert.ok(script.includes('"' + k + '":"' + v + '"'), '脚本内嵌 test 配对 ' + k + '/' + v)

  // 旧字段仍可读取：schema 同时保留 route 与 verdict / result
  assert.ok(review.output.schema.properties.verdict, 'review schema 保留 verdict 字段')
  assert.ok(testNode.output.schema.properties.result, 'test schema 保留 result 字段')
})

test('AC-04 未声明 consistency 的旧蓝图维持原行为：矛盾组合按 route 单字段路由（旧快照语义）', async () => {
  const bare = clone(mini)
  delete bare.nodes.find((n) => n.id === 'review').output.consistency
  delete bare.nodes.find((n) => n.id === 'test').output.consistency
  expectOk(bare, 'no-declaration')
  const { script } = compileBlueprint(bare)
  assert.ok(!script.includes('CONTRACT_INCONSISTENT：'), '未声明时脚本不启用契约拦截')
  const agent = makeAgentScript({
    '启动': { route: 'NEXT' },
    '收敛审查': { route: 'APPROVE', verdict: 'REQUEST_CHANGES', summary: '旧行为矛盾' },
    '独立测试': { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e' },
    'UAT 准备': { route: 'READY_FOR_HUMAN' },
  })
  const { result } = await runGeneratedScript(script, { agent })
  assert.equal(result.status, 'WAITING_HUMAN', '旧蓝图按 route 路由不受新增机制影响（走到人工验收等待）')
  assert.ok(result.history.some((h) => h.from === 'review' && h.to === 'test'), '旧快照行为：矛盾仍按 route 进入下一节点')
})

test('LOC-025 投影往返保留 consistency 声明（编辑器另存不丢）', () => {
  const dsl = projectToVwf(mini)
  assert.deepEqual(dsl.nodes.find((n) => n.id === 'review').output.consistency, { field: 'verdict', pairs: REVIEW_PAIRS })
  assert.deepEqual(dsl.nodes.find((n) => n.id === 'test').output.consistency, { field: 'result', pairs: TEST_PAIRS })
  const back = projectToBlueprint(dsl)
  assert.deepEqual(back.nodes.find((n) => n.id === 'review').output.consistency, { field: 'verdict', pairs: REVIEW_PAIRS })
  expectOk(back, 'roundtrip')
})
