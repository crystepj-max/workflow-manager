const A = args || {}
const TASK = A.taskId || 'task'
const RUNDIR = A.runDir || ('.agent-runs/' + TASK)
const ROLE_DIR = A.roleDir || 'dsh/roles'
const BASE = A.baseBranch || 'main'
const WORK = 'dev2/' + TASK
const MAX_ROUNDS = 9
const NODES = [{"id":"dispatch","profile":"dispatcher","label":"调度","model":{"provider":"deepseek-official","model":"deepseek-v4-pro"},"goal":"读取 GitHub issue（或原始需求文本），校验三要素（任务目标/涉及范围/验收标准）并判定是否需要集成测试；三要素缺失如实判定缺失，不追问不编造。写 dispatch-result.json 并更新 STATE.md。","output":{"schema":{"type":"object","properties":{"complete":{"type":"boolean"},"missing":{"type":"array","items":{"type":"string"}},"objective":{"oneOf":[{"type":"string"},{"type":"null"}]},"scope":{"oneOf":[{"type":"string"},{"type":"null"}]},"acceptance":{"oneOf":[{"type":"string"},{"type":"null"}]},"need_integration_test":{"type":"boolean"},"reason":{"type":"string"}},"required":["complete","missing","need_integration_test","reason"],"additionalProperties":false},"successCondition":"$.complete == true"}},{"id":"dev","profile":"dev","label":"开发","model":{"provider":"deepseek-official","model":"deepseek-v4-pro"},"goal":"在工作分支施工（tdd：先写会失败的测试再写实现），本地验证全绿后提交（不推送、不建 PR）；写 dev-report.md 并更新 STATE.md。环境受阻时 status 报 blocked。","output":{"schema":{"type":"object","properties":{"status":{"type":"string","enum":["completed","blocked"]},"summary":{"type":"string"},"files_changed":{"type":"array","items":{"type":"string"}},"self_verify":{"type":"string"},"risks":{"type":"string"}},"required":["status","summary","self_verify"],"additionalProperties":false},"successCondition":"$.status == \"completed\""}},{"id":"route","profile":"dispatcher","label":"分流","model":{"provider":"deepseek-official","model":"deepseek-v4-flash"},"goal":"读取 dispatch-result.json，如实输出是否需要集成测试的判定，不重新分析三要素。","output":{"schema":{"type":"object","properties":{"need_integration_test":{"type":"boolean"},"reason":{"type":"string"}},"required":["need_integration_test","reason"],"additionalProperties":false}}},{"id":"test","profile":"test","label":"测试","model":{"provider":"deepseek-official","model":"deepseek-v4-flash"},"goal":"对实现做运行态验证（证据驱动判定），专杀假测试；不修改业务代码；写 test-report.md 并更新 STATE.md。环境阻塞时 result 报 BLOCKED。","output":{"schema":{"type":"object","properties":{"result":{"type":"string","enum":["PASSED","FAILED","BLOCKED"]},"reason":{"type":"string"},"evidence":{"type":"string"},"failed_cases":{"type":"string"}},"required":["result","reason","evidence"],"additionalProperties":false},"successCondition":"$.result == \"PASSED\""}},{"id":"review","profile":"review","label":"审核","model":{"provider":"deepseek-official","model":"deepseek-v4-flash"},"goal":"双轴独立审查（需求符合性优先 + 代码质量），只读源代码；写 review-report.md 并更新 STATE.md；存在阻塞问题必须 REQUEST_CHANGES。","output":{"schema":{"type":"object","properties":{"verdict":{"type":"string","enum":["APPROVE","REQUEST_CHANGES","COMMENT_ONLY"]},"blockers":{"type":"string"},"compliance":{"type":"string"},"summary":{"type":"string"}},"required":["verdict","summary"],"additionalProperties":false},"successCondition":"$.verdict != \"REQUEST_CHANGES\""}},{"id":"accept","profile":"accept","label":"人工验收","model":{"provider":"deepseek-official","model":"deepseek-v4-pro"},"manualCheck":true,"goal":"逐条核对验收标准（证据缺失时只读验证），写 acceptance-summary.md 与 accept-report.md 并更新 STATE.md；不代签人工结论。","output":{"schema":{"type":"object","properties":{"verdict":{"type":"string","enum":["PASS","FAIL","INCOMPLETE"]},"summary_for_human":{"type":"string"},"details":{"type":"string"}},"required":["verdict","summary_for_human"],"additionalProperties":false}}},{"id":"closeout","profile":"closeout","label":"收口","model":{"provider":"deepseek-official","model":"deepseek-v4-flash"},"goal":"一致性收口；写 cleanup-report.md；推送工作分支、创建并合并 Draft PR（squash + 删分支）、关闭 issue；收束本地工作区。禁止绕过 PR 直推 base 分支。","output":{"schema":{"type":"object","properties":{"status":{"type":"string","enum":["done"]},"summary":{"type":"string"},"followups":{"type":"string"}},"required":["status","summary"],"additionalProperties":false}}}]
const EDGES = [{"from":"dispatch","to":"dev","on":"success"},{"from":"dispatch","to":"$end","on":"failure"},{"from":"dev","to":"route","on":"success"},{"from":"route","to":"test","on":"success","when":"$.need_integration_test == true"},{"from":"route","to":"review","on":"success","when":"$.need_integration_test == false"},{"from":"test","to":"review","on":"success"},{"from":"test","to":"dev","on":"failure"},{"from":"review","to":"accept","on":"success"},{"from":"review","to":"dev","on":"failure"},{"from":"accept","to":"closeout","on":"success"},{"from":"accept","to":"dev","on":"failure"},{"from":"closeout","to":"$end","on":"success"}]
const BYID = {}
for (const n of NODES) BYID[n.id] = n
function cond(expr, res) {
  if (!expr) return true
  const m = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/.exec(expr)
  if (!m) return false
  let v = res
  for (const k of m[1].split('.')) { if (v == null) return false; v = v[k] }
  let want
  if (m[3] === 'true') want = true
  else if (m[3] === 'false') want = false
  else if (m[3] === 'null') want = null
  else if (m[4] !== undefined) want = m[4]
  else want = Number(m[3])
  return m[2] === '==' ? v === want : v !== want
}
function issueBlock() {
  if (A.issueBody) return 'GitHub issue ' + (A.issueRef || '') + '\n标题：' + (A.issueTitle || '（未提供）') + '\n正文：\n' + A.issueBody + (A.issueComments ? '\n\n需求确认相关评论：\n' + A.issueComments : '')
  if (A.requirement) return '原始需求文本（运行时直接给出，以此为准）：\n' + A.requirement
  return '（本任务未提供 issue 或需求文本，请以前序产物为准）'
}
function roleRef(name) {
  return '【角色定义】开工前先用读文件工具读取 ' + ROLE_DIR + '/' + name + '.md（相对当前工作区根目录），严格遵循其中的定位、工作流程、产出模板、判定标准与硬规则——该文件是你在本节点的唯一角色依据。\n'
}
function runtimeCtx(nodeId, extra) {
  const n = BYID[nodeId]
  return '\n\n---\n\n## 运行上下文（编排注入，以此为准）\n\n' + '【节点目标】\n' + (n.goal || '') + '\n\n【任务输入】\n' + issueBlock() + '\n\n- 任务标识：' + TASK + '\n- run 产物目录：' + RUNDIR + '/（不存在则创建；本节点只允许在该目录内写文件）\n- base 分支：' + BASE + '；工作分支：' + WORK + '\n- 当前节点：' + (n.label || nodeId) + '\n- 完成本节点后更新 ' + RUNDIR + '/STATE.md（stage / round / status / updated，时间用 date -u +%FT%TZ）\n' + (extra ? '\n' + extra + '\n' : '') + '\n## 最终回复要求\n完成全部工作（含写报告、更新 STATE.md）后，最终回复只给出结构化结果本身，不要复述报告全文。\n'
}
async function callNode(id, round, feedback) {
  const n = BYID[id]
  const opts = { label: (n.label || id) + (round > 0 ? ' R' + round : ''), ...(n.model || {}) }
  if (n.output && n.output.schema) opts.schema = n.output.schema
  const fb = feedback ? '【上轮打回反馈——必须逐条修复】\n' + feedback + '\n\n' : ''
  const prompt = roleRef(n.profile) + runtimeCtx(id, fb)
  phase(n.label || id)
  return await agent(prompt, opts)
}
function outEdges(id) { return EDGES.filter(e => e.from === id) }
function route(id, res, ok) {
  const out = outEdges(id)
  if (ok) {
    for (const e of out) if (e.on === 'success' && e.when && cond(e.when, res)) return e
    for (const e of out) if (e.on === 'success' && !e.when) return e
  } else {
    for (const e of out) if (e.on === 'failure') return e
  }
  return null
}
let current = A.entry || 'dispatch'
let round = A.startRound || 0
let feedback = A.feedback || ''
const results = {}
const history = A.history || []
while (current !== '$end') {
  const n = BYID[current]
  if (!n) return { status: 'ERROR', detail: '未知节点：' + current }
  if (n.manualCheck) {
    if (A.approved !== true) {
      const res = await callNode(current, round, feedback)
      results[current] = res
      return { status: 'AWAITING_HUMAN_' + current, taskId: TASK, node: current, round: round, result: res, history: history, resume: { entry: current, approved: true, startRound: round, history: history, feedback: feedback } }
    }
    const e = route(current, results[current], true)
    if (!e) return { status: 'ERROR', detail: '人工裁决后无出边：' + current }
    current = e.to
    continue
  }
  const res = await callNode(current, round, feedback)
  if (res === null) {
    history.push({ round: round, stage: current, verdict: 'AGENT_FAILED', reason: '节点 agent 未返回有效结果' })
    const ef = route(current, null, false)
    if (!ef || ef.to === '$end') return { status: 'TECHNICAL_FAILURE', stage: current, round: round, results: results, history: history }
    current = ef.to; round++; feedback = '【' + (BYID[current].label || current) + ' agent 技术失败】请重试并自查。'; continue
  }
  results[current] = res
  const ok = n.output && n.output.successCondition ? cond(n.output.successCondition, res) : true
  log((n.label || current) + ' → ' + (ok ? '通过' : '未通过'))
  const e = route(current, res, ok)
  if (!e) return { status: ok ? 'ENDED_NO_SUCCESS_EDGE' : 'ENDED_NO_FAILURE_EDGE', stage: current, results: results, history: history }
  if (e.on === 'failure') {
    round++
    if (e.to === '$end') return { status: 'FAILED_AT_' + current, stage: current, result: res, results: results, history: history }
    if (round >= MAX_ROUNDS) return { status: 'FAILED_MAX_ROUNDS', taskId: TASK, rounds: MAX_ROUNDS, results: results, history: history, dispatch: results['dispatch'] || null }
    history.push({ round: round, stage: current, verdict: 'REJECTED', reason: JSON.stringify(res) })
    feedback = '【' + (n.label || current) + '未通过 · 第 ' + round + ' 轮】' + JSON.stringify(res)
  } else {
    feedback = ''
  }
  current = e.to
}
return { status: 'DONE', taskId: TASK, round: round, results: results, history: history }