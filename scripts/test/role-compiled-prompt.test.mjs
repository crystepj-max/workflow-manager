// LOC-033（WR-013）：角色加载/编译快照测试——验证「实际注入 prompt 的文本」，
// 不只对 Markdown 做关键词检查（AC-04）。
// 方法：compileBlueprint 真实编译四模板 → 运行时排练厅走主链 → 捕获每个节点实际
// 收到的 prompt → 断言注入的角色定义与 dsh/roles/*.md 逐字一致（编译冻结快照）、
// 节点场景信息（三态/回归产物/非 Git 场景/PLAN_READY 等）真实出现在注入文本中。
// AC-01 的结构对照（矩阵文档 + 模板 profile 覆盖）也在此守护。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileBlueprint } from '../generate.mjs'
import roleLibrary from '../role-library.cjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const { buildSnapshot } = roleLibrary

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const ROLES_DIR = path.join(root, 'dsh', 'roles')
const manifest = JSON.parse(readFileSync(path.join(ROLES_DIR, 'builtin-roles.json'), 'utf8'))
const BUILTIN_IDS = manifest.builtins.map((b) => b.id)

const loadTpl = (f) => JSON.parse(readFileSync(path.join(root, 'templates', f), 'utf8'))
const BPS = {
  construction: loadTpl('wf-construction-full-feature.json'),
  optimize: loadTpl('wf-optimize.json'),
  diagnose: loadTpl('wf-diagnose.json'),
  explore: loadTpl('wf-explore.json'),
}

const roleFile = (id) => readFileSync(path.join(ROLES_DIR, id + '.md'), 'utf8')

// ---------- 注入文本提取（prompt 内联角色定义段） ----------
const ROLE_MARKER = '【角色定义】（内置角色，编译期内联，与打包快照同源）：\n'
const CTX_MARKER = '\n\n---\n\n## 运行上下文'

function injectedRoleDef(prompt) {
  const start = prompt.indexOf(ROLE_MARKER)
  assert.ok(start >= 0, 'prompt 未含内联角色定义标记（编译期注入缺失）')
  const from = start + ROLE_MARKER.length
  const end = prompt.indexOf(CTX_MARKER, from)
  assert.ok(end > from, 'prompt 未含运行上下文分隔，无法定位注入段')
  return prompt.slice(from, end)
}

// 快照断言：注入的角色定义与角色文件正文逐字一致（编译冻结 = 打包快照同源）
function assertSnapshot(prompt, roleId, label) {
  const def = injectedRoleDef(prompt)
  assert.equal(def, roleFile(roleId), label + '：注入的角色定义与 dsh/roles/' + roleId + '.md 不一致（编译快照漂移）')
  return def
}

const call = (agent, label) => {
  const c = agent.calls.find((x) => x.label === label)
  assert.ok(c, '未捕获节点调用：' + label + '（实际 ' + JSON.stringify(agent.calls.map((x) => x.label)) + '）')
  return c.prompt
}

const branch = 'dev-loc-033-r1'

// ---------- AC-04 前置：角色库加载快照（覆盖含 designer 在内全部 12 角色） ----------

test('AC-04 加载快照：12 内置角色经角色库构建，正文与 dsh/roles/*.md 逐字一致', () => {
  const snap = buildSnapshot({ manifestPath: path.join(ROLES_DIR, 'builtin-roles.json'), rolesDir: ROLES_DIR, io: fs })
  assert.deepEqual(snap.builtinIds, BUILTIN_IDS)
  for (const id of BUILTIN_IDS) {
    assert.equal(snap.roleDefs[id], roleFile(id), '角色 ' + id + ' 的加载快照与文件正文不一致')
  }
})

test('AC-01 结构对照：矩阵文档覆盖 12 角色与四模板；模板 profile 全部落在内置清单内', () => {
  const matrix = readFileSync(path.join(root, 'docs', 'design', 'role-node-matrix.md'), 'utf8')
  for (const id of BUILTIN_IDS) assert.ok(matrix.includes('`' + id + '`') || matrix.includes('| ' + id + ' '), '职责矩阵缺少角色 ' + id)
  for (const tpl of Object.keys(BPS)) assert.ok(matrix.includes(tpl), '职责矩阵缺少模板 ' + tpl)
  for (const [tpl, bp] of Object.entries(BPS)) {
    for (const n of bp.nodes) {
      assert.ok(
        BUILTIN_IDS.includes(n.profile),
        tpl + ' 节点 ' + n.id + ' 的 profile ' + n.profile + ' 不在 12 内置角色清单内',
      )
    }
  }
})

// ---------- dev：自测禁令消失 + 场景契约（建设） ----------

test('AC-01/AC-04 建设开发节点：注入 dev 角色无自测禁令，节点场景声明自测允许、独立证明归测试节点', async () => {
  const { script } = compileBlueprint(BPS.construction)
  const agent = makeAgentScript({
    实施前检查: { route: 'PASS', summary: 's', blockers: '无', baseline_version: 'V1' },
    开发: { route: 'READY', summary: 's', self_check: 'ok' },
    收敛审查: { route: 'APPROVE', verdict: 'APPROVE', summary: 's', blockers: '', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    测试: { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
  })
  const { result } = await runGeneratedScript(script, { args: { work_branch: branch }, agent })
  assert.equal(result.status, 'WAITING_HUMAN')

  const prompt = call(agent, '开发')
  assertSnapshot(prompt, 'dev', '建设开发')
  // 旧矛盾文本不得再出现在实际注入文本中（禁令与 TDD 并存即失败）
  assert.ok(!prompt.includes('你不写测试、不执行测试'), '注入文本仍含 dev 自测禁令（首段）')
  assert.ok(!prompt.includes('禁止写测试并执行'), '注入文本仍含 dev 自测禁令（硬规则）')
  // 允许自测 + 不自签独立证明（角色能力边界）
  assert.ok(prompt.includes('允许必要自测与实现相关测试'), '注入文本缺自测允许表述')
  assert.ok(prompt.includes('不自签独立测试证明'), '注入文本缺「不自签独立测试证明」')
  // 节点场景契约（goal 注入）
  assert.ok(prompt.includes('独立测试证明由后续独立测试节点出具'), '节点目标缺独立测试归归属声明')
  assert.ok(prompt.includes('worktree 路径与工作分支以运行上下文/run.json 为准'), '节点目标缺 worktree 场景来源声明')
  assert.ok(prompt.includes('dev-report.md'), '节点产物契约 dev-report.md 未注入')
})

// ---------- AC-02：优化执行节点非 Git 文档场景 ----------

test('AC-02 优化执行节点：注入文本声明非 Git 场景，不要求 dispatch-result/worktree/PR', async () => {
  const { script } = compileBlueprint(BPS.optimize)
  const agent = makeAgentScript({
    目标确认: { route: 'READY', summary: '契约冻结', contract_digest: 'c1' },
    执行: { route: 'READY', summary: '最小修改', changed: 'a.md' },
    评估: { route: 'PASS', summary: '满足判据', contract_digest: 'c1', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 'done', followups: '' },
  })
  const { result } = await runGeneratedScript(script, { args: { work_branch: branch }, agent })
  assert.equal(result.status, 'DONE')

  const prompt = call(agent, '执行')
  assertSnapshot(prompt, 'dev', '优化执行')
  // 节点场景契约：非 Git 任务可完整执行
  assert.ok(prompt.includes('不要求 dispatch-result'), '节点目标未声明不要求 dispatch-result')
  assert.ok(prompt.includes('不要求创建 worktree/分支/PR'), '节点目标未声明不要求 worktree/分支/PR')
  assert.ok(prompt.includes('非 Git 任务同样可完整执行'), '节点目标未声明非 Git 任务可完整执行')
  // 角色侧护栏：无 Git 现场时不得自行发明前置条件
  assert.ok(prompt.includes('不要自行发明建分支、建 worktree 或建 PR 的前置条件'), '注入角色文本缺「不得自行发明 Git 前置」护栏')
  assert.ok(prompt.includes('execute-report.md'), '节点产物契约 execute-report.md 未注入')
})

// ---------- AC-03：建设 accept 三态 + 诊断回归产物 ----------

test('AC-03 建设 UAT 节点：注入文本带严格三态，二态不得覆盖；accept 角色快照一致', async () => {
  const { script } = compileBlueprint(BPS.construction)
  const agent = makeAgentScript({
    实施前检查: { route: 'PASS', summary: 's', blockers: '无', baseline_version: 'V1' },
    开发: { route: 'READY', summary: 's', self_check: 'ok' },
    收敛审查: { route: 'APPROVE', verdict: 'APPROVE', summary: 's', blockers: '', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    测试: { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
  })
  await runGeneratedScript(script, { args: { work_branch: branch }, agent })

  const prompt = call(agent, 'UAT 准备')
  assertSnapshot(prompt, 'accept', '建设 UAT')
  assert.ok(prompt.includes('ACCEPT（通过）/ REJECT（退回）/ CONDITIONAL_PASS（有条件通过）'), '注入文本缺严格三态枚举')
  assert.ok(prompt.includes('不得用通过/不通过二态表述覆盖'), '注入文本缺二态覆盖禁令')
  assert.ok(prompt.includes('uat-card.md') && prompt.includes('acceptance-summary.md'), '节点产物契约 uat-card.md / acceptance-summary.md 未注入')
  // 注入的 accept 角色不再自带二态裁决枚举
  const def = injectedRoleDef(prompt)
  assert.ok(!def.includes('裁决 PASS / FAIL / INCOMPLETE'), '注入 accept 角色仍自带二态/旧裁决枚举')
})

test('AC-03 诊断回归节点：注入文本声明回归产物 regression-report.md；test 角色冲突职责已移除', async () => {
  const { script } = compileBlueprint(BPS.diagnose)
  const agent = makeAgentScript({
    缺陷诊断: { route: 'DIAGNOSED', root_cause: 'rc', evidence: 'e', verified_head: 'h0' },
    修复: { route: 'FIXED', summary: 's', changed: 'f' },
    审核: { route: 'APPROVE', verdict_reason: 'ok', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    回归验证: { route: 'PASS', verdict_reason: 'ok', regression_evidence: 're', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    收口: { status: 'DELIVERED', summary: 's', followups: '' },
  })
  const { result } = await runGeneratedScript(script, { args: { work_branch: branch }, agent })
  assert.equal(result.status, 'DONE')

  const prompt = call(agent, '回归验证')
  assertSnapshot(prompt, 'test', '诊断回归')
  assert.ok(prompt.includes('regression-report.md'), '回归产物契约 regression-report.md 未注入')
  assert.ok(prompt.includes('不自行解决'), '注入文本缺「冲突不自行解决」边界')
  const def = injectedRoleDef(prompt)
  assert.ok(!def.includes('按冲突解决流程处理'), '注入 test 角色仍自带解决冲突职责')
  // test.md 报告名随节点声明（角色不再写死唯一报告名）
  assert.ok(def.includes('文件名以所在节点 output 契约为准'), '注入 test 角色缺「报告名随节点契约」声明')
})

// ---------- §9 探索三角色：枚举与模板一致 ----------

test('AC-04 探索模板：orchestrator 注入 PLAN_READY、researcher 注入小写 confidence，快照一致', async () => {
  const { script } = compileBlueprint(BPS.explore)
  const agent = makeAgentScript({
    探索统筹: {
      route: 'PLAN_READY',
      round_type: 'BROAD',
      research_question: 'Q',
      expert_briefs: [
        { expert_id: 'expert-1', focus: 'f1', brief: 'b1' },
        { expert_id: 'expert-2', focus: 'f2', brief: 'b2' },
      ],
      plan_summary: '方案',
    },
    '/^专家研究 #/': {
      expert_id: 'expert-1',
      findings: '发现',
      evidence: ['证据'],
      counter_evidence: ['反证'],
      assumptions: ['假设'],
      uncertainties: ['未知'],
      confidence: 'medium',
    },
    综合分析: { route: 'SYNTHESIS_READY', consensus: ['c'], disagreements: ['d'], evidence_map: 'm', open_gaps: ['g'], synthesis_summary: 's' },
    结论评估: { verdict: 'PASS', why: 'w', summary_for_human: 'h', current_state: 'st' },
  })
  const { result } = await runGeneratedScript(script, { args: { work_branch: branch }, agent })
  assert.equal(result.status, 'DONE')

  const orch = call(agent, '探索统筹')
  const orchDef = assertSnapshot(orch, 'orchestrator', '探索统筹')
  assert.ok(orchDef.includes('探索模板的 orchestrate 节点声明为 `PLAN_READY`'), '注入 orchestrator 角色缺 PLAN_READY 对齐声明')
  assert.ok(!orchDef.includes('`READY`：') && !orchDef.includes('`BLOCKED`：'), '注入 orchestrator 角色仍自带 READY/BLOCKED 枚举')

  const research = agent.calls.find((x) => /^专家研究 #/.test(x.label))
  assert.ok(research, '未捕获 fanout 专家研究调用')
  const resDef = assertSnapshot(research.prompt, 'researcher', '专家研究')
  assert.ok(resDef.includes('- high\n- medium\n- low'), '注入 researcher 角色缺小写 confidence 枚举')
  assert.ok(!resDef.includes('- HIGH'), '注入 researcher 角色仍含大写 HIGH 枚举')
  assert.ok(research.prompt.includes('research-<你的 expert_id>.md'), '研究报告名（节点声明）未注入')

  const syn = call(agent, '综合分析')
  assertSnapshot(syn, 'synthesizer', '综合分析')
  const ev = call(agent, '结论评估')
  const evDef = assertSnapshot(ev, 'evaluator', '结论评估')
  assert.ok(evDef.includes('本角色不内置任何具体评价枚举'), '注入 evaluator 角色缺「枚举随节点」声明')
})

// ---------- 全量覆盖：四模板实际注入的角色快照集合 ----------

test('AC-04 全量：四模板编译注入的角色定义并集覆盖除 designer 外全部内置角色，且逐字一致', async () => {
  const run = async (bp, table) => {
    const { script } = compileBlueprint(bp)
    const agent = makeAgentScript(table)
    await runGeneratedScript(script, { args: { work_branch: branch }, agent })
    return agent
  }
  const construction = await run(BPS.construction, {
    实施前检查: { route: 'PASS', summary: 's', blockers: '无', baseline_version: 'V1' },
    开发: { route: 'READY', summary: 's', self_check: 'ok' },
    收敛审查: { route: 'APPROVE', verdict: 'APPROVE', summary: 's', blockers: '', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    测试: { route: 'PASS', result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
  })
  const optimize = await run(BPS.optimize, {
    目标确认: { route: 'READY', summary: 's', contract_digest: 'c1' },
    执行: { route: 'READY', summary: 's', changed: 'a' },
    评估: { route: 'PASS', summary: 's', contract_digest: 'c1', gaps: '' },
    收口: { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: 's', followups: '' },
  })
  const diagnose = await run(BPS.diagnose, {
    缺陷诊断: { route: 'DIAGNOSED', root_cause: 'rc', evidence: 'e', verified_head: 'h0' },
    修复: { route: 'FIXED', summary: 's', changed: 'f' },
    审核: { route: 'APPROVE', verdict_reason: 'ok', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    回归验证: { route: 'PASS', verdict_reason: 'ok', regression_evidence: 're', verified_branch: branch, verified_head: 'h1', candidate_sha256: 'c' },
    收口: { status: 'DELIVERED', summary: 's', followups: '' },
  })
  const explore = await run(BPS.explore, {
    探索统筹: {
      route: 'PLAN_READY', round_type: 'BROAD', research_question: 'Q',
      expert_briefs: [{ expert_id: 'expert-1', focus: 'f', brief: 'b' }],
      plan_summary: '方案',
    },
    '/^专家研究 #/': {
      expert_id: 'expert-1', findings: 'f', evidence: ['e'], counter_evidence: ['c'], assumptions: ['a'], uncertainties: ['u'], confidence: 'low',
    },
    综合分析: { route: 'SYNTHESIS_READY', consensus: ['c'], disagreements: ['d'], evidence_map: 'm', open_gaps: ['g'], synthesis_summary: 's' },
    结论评估: { verdict: 'PASS', why: 'w', summary_for_human: 'h', current_state: 'st' },
  })

  const injected = new Map() // roleId -> 已注入正文（须与文件逐字一致）
  for (const agent of [construction, optimize, diagnose, explore]) {
    for (const c of agent.calls) {
      const def = injectedRoleDef(c.prompt)
      const matches = BUILTIN_IDS.filter((id) => roleFile(id) === def)
      assert.equal(matches.length, 1, '节点 ' + c.label + ' 注入的角色定义不匹配任何内置角色文件（快照漂移）')
      injected.set(matches[0], def)
    }
  }
  const expected = BUILTIN_IDS.filter((id) => id !== 'designer') // designer 只作定义/自定义资产，无模板节点绑定
  for (const id of expected) {
    assert.ok(injected.has(id), '四模板主链未注入角色 ' + id + '（绑定对照缺口）')
    assert.equal(injected.get(id), roleFile(id), '角色 ' + id + ' 注入正文与文件不一致')
  }
  assert.ok(!injected.has('designer'), 'designer 不应有模板节点绑定（保留为定义/自定义工作流资产）')
})
