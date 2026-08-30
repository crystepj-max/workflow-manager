// 生成器（T-IMP-04，契约见 docs/design/blueprint-schema.md §4 与 v1-task-plan T-IMP-04）
// 纯函数：generateAll(templatesDir) → { files: Map<relpath, content>, report }
// CLI：node scripts/generate.mjs [templatesDir] → 写 .generated/<id>/，重生成幂等比对
// 来源：T-02 原型 .scratch/generator-prototype 提升（单编译器 + 增强编译选项）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 统一校验内核（候选二 T-IMP-13，CJS 单文件——引擎 import / 宿主 vm eval 双形态）
import validatorCore from './validate-core.cjs';

const { validateBlueprint, COND_RE } = validatorCore;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TPL_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', '.generated');

// ---------- vwf 侧投影（契约 §4.1；候选二 Q7 修订：业务规则字段进入 DSL） ----------
export function projectToVwf(bp) {
  const models = (bp.bindings && bp.bindings.models) || {};
  const out = {
    id: bp.id,
    name: bp.displayName,
    description: bp.description || '',
    entry: bp.entry,
    control: { maxRounds: (bp.control && bp.control.maxRounds) || 9 },
    nodes: bp.nodes.map((n) => {
      const o = { id: n.id, profile: n.profile, label: n.label || n.id, goal: n.goal };
      if (n.kind !== undefined) o.kind = n.kind;
      if (n.items !== undefined) o.items = n.items;
      if (n.failOn !== undefined) o.failOn = n.failOn;
      if (n.output) o.output = n.output;
      if (n.manualCheck) o.manualCheck = true;
      if (models[n.id]) o.model = models[n.id];
      return o;
    }),
    edges: bp.edges.map((e) => ({ from: e.from, to: e.to, on: e.on, when: e.when })),
  };
  // 业务规则字段（编辑器可配置）：onMaxRounds / heteroCheck 进入 DSL；
  // verifyBranch 为节点级字段，编辑器无 UI，暂不进入（契约修订，MAP 记录）
  if (bp.onMaxRounds !== undefined) out.onMaxRounds = bp.onMaxRounds;
  if (bp.heteroCheck) out.heteroCheck = true;
  if (bp.bundleRoles) out.bundleRoles = true;
  return out;
}

// ---------- route 折叠识别（契约 §4.2） ----------
// COND_RE 单一来源 = 校验内核（候选二）；生成脚本内嵌正则与其一致性由测试断言

function foldableNodes(bp) {
  const folds = {};
  bp.nodes.forEach((n) => {
    const out = bp.edges.filter((e) => e.from === n.id && e.on === 'success');
    if (out.length !== 2 || !out.every((e) => e.when)) return;
    const parsed = out.map((e) => { const m = COND_RE.exec(e.when); return m ? { to: e.to, path: m[1], value: m[3] } : null; });
    if (!parsed[0] || !parsed[1] || parsed[0].path !== parsed[1].path || parsed[0].value === parsed[1].value) return;
    // 折叠转发源（运行时排练厅 T1 暴露的 bug 修复）：优先取「输出 schema 声明了
    // when 路径」的节点（上游判定者，如模板中 need_integration_test 产自 dispatch），
    // 兜底取 success 入边来源（值直接产自前驱的场景，如 F8 折叠测试）。
    // 旧实现固定取入边来源：模板中入边来源是 dev，dev 结果无 need_integration_test，
    // 折叠永远走 false 分支（跳过测试环节）——与契约「严格转发上游判定」相悖。
    const declaring = bp.nodes.find((x) => x !== n && x.output && x.output.schema
      && x.output.schema.properties && x.output.schema.properties[parsed[0].path] !== undefined);
    const src = bp.edges.find((e) => e.to === n.id && e.on === 'success');
    folds[n.id] = {
      from: declaring ? declaring.id : (src ? src.from : null),
      path: parsed[0].path,
      trueTo: parsed[0].value === 'true' ? parsed[0].to : parsed[1].to,
      falseTo: parsed[0].value === 'true' ? parsed[1].to : parsed[0].to,
    };
  });
  return folds;
}

// ---------- DSH 侧编译（契约 §4.2/§4.3，移植 host.js compileDsl + 增强） ----------
// 统一编译器（候选一 T-IMP-12）：DSH 与 vwf 双入口的唯一翻译员。
// 宿主侧 compileDsl 已删除，经管道消费本函数产物（磁盘产物优先 + CLI compile 兜底）。
export function compileBlueprint(bp, opts = {}) {
  const maxRounds = (bp.control && bp.control.maxRounds) || 9;
  const models = (bp.bindings && bp.bindings.models) || {};
  const folds = foldableNodes(bp);
  const hetero = bp.heteroCheck && models.dev && models.review;
  const autoReschedule = bp.onMaxRounds === 'auto-reschedule';

  const lines = [
    'const A = args || {}',
    'const TASK = A.taskId || \'task\'',
    'const RUNDIR = A.runDir || (\'.agent-runs/\' + TASK)',
    'const WORK = \'dev2/\' + TASK',
    'const MAX_ROUNDS = ' + maxRounds,
    'const ITEM_CAP = 4096',
    'const AGENT_CAP = 1000',
    'const NODES = ' + JSON.stringify(bp.nodes),
    'const EDGES = ' + JSON.stringify(bp.edges),
    'const MODELS = ' + JSON.stringify(models),
    'const FOLDS = ' + JSON.stringify(folds),
    'const BYID = {}',
    'for (const n of NODES) BYID[n.id] = n',
  ];
  if (hetero) {
    lines.push(
      'function modelTag(id) { const m = MODELS[id]; return m ? (m.provider || \'default\') + \'/\' + (m.model || \'default\') : \'default\' }',
      'if (modelTag(\'dev\') === modelTag(\'review\')) log(\'⚠️ 异源警告（蓝图 heteroCheck）：dev 与 review 同模型 \' + modelTag(\'dev\') + \'，请修改 bindings.models\')',
      'else log(\'异源检查通过：dev=\' + modelTag(\'dev\') + \' / review=\' + modelTag(\'review\'))',
    );
  }
  lines.push(
    'function cond(expr, res) {',
    '  if (!expr) return true',
    '  const m = /^\\$\\.([A-Za-z0-9_.]+)\\s*(==|!=)\\s*(true|false|null|"([^"]*)"|-?\\d+(\\.\\d+)?)$/.exec(expr)',
    '  if (!m) return false',
    '  let v = res',
    '  for (const k of m[1].split(\'.\')) { if (v == null) return false; v = v[k] }',
    '  let want',
    '  if (m[3] === \'true\') want = true',
    '  else if (m[3] === \'false\') want = false',
    '  else if (m[3] === \'null\') want = null',
    '  else if (m[4] !== undefined) want = m[4]',
    '  else want = Number(m[3])',
    '  return m[2] === \'==\' ? v === want : v !== want',
    '}',
    'function readPath(root, path) {',
    '  let value = root',
    '  if (!path) return value',
    '  for (const key of path.split(\'.\')) { if (value == null) return undefined; value = value[key] }',
    '  return value',
    '}',
    'function resolveItems(expr, results) {',
    '  if (expr === \'$.args\') return A',
    '  if (expr.indexOf(\'$.args.\') === 0) return readPath(A, expr.slice(7))',
    '  if (expr.indexOf(\'$.results.\') === 0) {',
    '    const parts = expr.slice(10).split(\'.\')',
    '    const source = results[parts.shift()]',
    '    return readPath(source, parts.join(\'.\'))',
    '  }',
    '  return undefined',
    '}',
    'function valueType(value) { return value === null ? \'null\' : Array.isArray(value) ? \'array\' : typeof value }',
    'function itemText(item) { if (typeof item === \'string\') return item; const text = JSON.stringify(item); return text === undefined ? String(item) : text }',
    'function fanoutFailed(failOn, total, failedCount) {',
    '  if (failOn === \'any\') return failedCount >= 1',
    '  if (failOn === \'all\' || failOn === undefined) return total > 0 && failedCount === total',
    '  return failedCount > failOn',
    '}',
    'function issueBlock() {',
    '  if (A.issueBody) return \'GitHub issue \' + (A.issueRef || \'\') + \'\\n标题：\' + (A.issueTitle || \'（未提供）\') + \'\\n正文：\\n\' + A.issueBody + (A.issueComments ? \'\\n\\n需求确认相关评论：\\n\' + A.issueComments : \'\')',
    '  if (A.requirement) return \'原始需求文本（运行时直接给出，以此为准）：\\n\' + A.requirement',
    '  return \'（本任务未提供 issue 或需求文本，请以前序产物为准）\'',
    '}',
    'function roleRef(name) {',
    opts.noRole
      ? '  return \'【角色定义】原型模式：本节点无角色文件要求，以 goal 为唯一依据。\\n\''
      // Codex PR#124 第三轮 P1（评论 3889725481）：工作区优先，打包角色包兜底。
      // 编辑 dispatcher 等迁移角色时种子到工作区 dsh/roles/，但 bundleRoles 模板
      // 仍向引擎传 c.roleDir（打包快照路径），旧 roleRef 只读打包快照，工作区编辑
      // 不生效。改为先读工作区 dsh/roles/<name>.md，缺失再读 A.roleDir 打包快照——
      // 既不修改 .generated（生成产物身份不变），又让工作区编辑对 bundled run 生效。
      : '  return \'【角色定义】开工前先用读文件工具读取工作区 dsh/roles/\' + name + \'.md（相对当前工作区根目录，工作区优先）；若该文件不存在，则改读打包角色包 \' + (A.roleDir || \'dsh/roles\') + \'/\' + name + \'.md。严格遵循其中的定位、工作流程、产出模板、判定标准与硬规则——该文件是你在本节点的唯一角色依据。\\n\'',
    '}',
    'function runtimeCtx(nodeId, extra, goalOverride) {',
    '  const n = BYID[nodeId]',
    '  let s = \'\\n\\n---\\n\\n## 运行上下文（编排注入，以此为准）\\n\\n\' + \'【节点目标】\\n\' + (goalOverride === undefined ? (n.goal || \'\') : goalOverride) + \'\\n\\n【任务输入】\\n\' + issueBlock() + \'\\n\\n- 任务标识：\' + TASK + \'\\n- run 产物目录：\' + RUNDIR + \'/（不存在则创建；本节点只允许在该目录内写文件）\\n- 当前节点：\' + (n.label || nodeId) + \'\\n- 完成本节点后更新 \' + RUNDIR + \'/STATE.md（stage / round / status / updated，时间用 date -u +%FT%TZ）\\n\'',
    '  if (n.output && n.output.files) s += \'【本节点应产出文件】\' + JSON.stringify(n.output.files) + \'\\n\'',
    '  s += (extra ? \'\\n\' + extra + \'\\n\' : \'\') + \'\\n## 最终回复要求\\n完成全部工作（含写报告、更新 STATE.md）后，最终回复只给出结构化结果本身，不要复述报告全文。\\n\'',
    '  return s',
    '}',
    'function verifyBranchStep(id) {',
    '  return \'开工前置（强制）：确认 worktree 分支 = \' + WORK + \'（git -C \' + RUNDIR + \'/worktree rev-parse --abbrev-ref HEAD）且 HEAD 一致；验证结论必须记录 verified_branch 与 verified_head。\'',
    '}',
    'async function callNode(id, round, feedback) {',
    '  const n = BYID[id]',
    '  const model = MODELS[id] || {}',
    '  const opts = { label: (n.label || id) + (round > 0 ? \' R\' + round : \'\') }',
    '  if (model.provider) opts.provider = model.provider',
    '  if (model.model) opts.model = model.model',
    '  if (n.output && n.output.schema) opts.schema = n.output.schema',
    '  const fb = feedback ? \'【上轮打回反馈——必须逐条修复】\\n\' + feedback + \'\\n\\n\' : \'\'',
    '  const prompt = roleRef(n.profile) + runtimeCtx(id, fb + (n.verifyBranch ? verifyBranchStep(id) : \'\'))',
    '  phase(n.label || id)',
    '  return await agent(prompt, opts)',
    '}',
    'function outEdges(id) { return EDGES.filter(e => e.from === id) }',
    'function route(id, res, ok) {',
    '  const out = outEdges(id)',
    '  if (ok) {',
    '    for (const e of out) if (e.on === \'success\' && e.when && cond(e.when, res)) return e',
    '    for (const e of out) if (e.on === \'success\' && !e.when) return e',
    '  } else {',
    '    for (const e of out) if (e.on === \'failure\') return e',
    '  }',
    '  return null',
    '}',
    'function claimError(res, stage) {',
    '  const head = res && res.verified_head',
    '  const headOk = typeof head === \'string\' && head.trim().length > 0',
    '  if (res && res.verified_branch === WORK && headOk) return null',
    '  return stage + \' 结论校验失败：verified_branch=\' + JSON.stringify(res && res.verified_branch) + \'（应为 \' + WORK + \'），verified_head=\' + JSON.stringify(head)',
    '}',
  );
  if (autoReschedule) {
    lines.push(
      'function reschedulePrompt(historyText) {',
      '  return \'【超限重调度分析】该任务已在开发循环中打回超过 \' + MAX_ROUNDS + \' 轮。历史记录：\\n\' + historyText + \'\\n必须给出 reschedule：失败归因（卡在哪个环节）、拆分建议（可独立验收的子任务列表）、人工介入建议。\\n\\n【产物】把调度结论 JSON 写入 \' + RUNDIR + \'/dispatch-result.json（允许写此文件）。\'',
      '}',
    );
  }
  lines.push(
    'let current = A.entry || \'' + (bp.entry || '') + '\'',
    'let round = A.startRound || 0',
    'let feedback = A.feedback || \'\'',
    'const results = {}',
    'const history = A.history || []',
    'let agentsUsed = 0',
    'while (current !== \'$end\') {',
    '  const n = BYID[current]',
    '  if (!n) return { status: \'ERROR\', detail: \'未知节点：\' + current }',
    '  if (FOLDS[current]) {',
    '    const f = FOLDS[current]',
    '    const src = f.from ? results[f.from] : null',
    '    const v = src ? src[f.path] : undefined',
    '    log(\'[\' + current + \'] 分流折叠（无 LLM）：\' + f.path + \' = \' + v)',
    '    results[current] = v === true ? { [f.path]: true } : { [f.path]: false }',
    '    const e = route(current, results[current], true)',
    '    if (!e) return { status: \'ERROR\', detail: \'折叠节点无出边：\' + current }',
    '    current = e.to',
    '    continue',
    '  }',
    '  if (n.manualCheck) {',
    '    if (A.approved !== true) {',
    '      if (agentsUsed + 1 > AGENT_CAP) return { status: \'FAILED_AGENT_CAP\', stage: current, used: agentsUsed, requested: 1, limit: AGENT_CAP, results: results, history: history }',
    '      agentsUsed++',
    '      const res = await callNode(current, round, feedback)',
    '      results[current] = res',
    '      return { status: \'AWAITING_HUMAN_\' + current, taskId: TASK, node: current, round: round, result: res, history: history, resume: { entry: current, approved: true, startRound: round, history: history, feedback: feedback } }',
    '    }',
    '    const e = route(current, results[current], true)',
    '    if (!e) return { status: \'ERROR\', detail: \'人工裁决后无出边：\' + current }',
    '    current = e.to',
    '    continue',
    '  }',
    '  let res',
    '  let ok',
    '  if (n.kind === \'fanout\') {',
    '    const source = resolveItems(n.items, results)',
    '    if (!Array.isArray(source)) return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: \'fanout items 表达式 \' + n.items + \' 运行时结果必须是数组，实际：\' + valueType(source), results: results, history: history }',
    '    if (source.length > ITEM_CAP) return { status: \'FAILED_ITEM_CAP\', stage: current, actual: source.length, limit: ITEM_CAP, results: results, history: history }',
    '    if (agentsUsed + source.length > AGENT_CAP) return { status: \'FAILED_AGENT_CAP\', stage: current, used: agentsUsed, requested: source.length, limit: AGENT_CAP, results: results, history: history }',
    '    agentsUsed += source.length',
    '    phase(n.label || current)',
    '    if (source.length === 0) log((n.label || current) + \'：items 为空数组，跳过子代理并按成功处理\')',
    '    const indexed = source.map(function (item, index) { return { item: item, index: index } })',
    '    const itemResults = source.length === 0 ? [] : await pipeline(indexed, async function (entry) {',
    '      const model = MODELS[current] || {}',
    '      const itemOpts = { label: (n.label || current) + \' #\' + (entry.index + 1) + (round > 0 ? \' R\' + round : \'\') }',
    '      if (model.provider) itemOpts.provider = model.provider',
    '      if (model.model) itemOpts.model = model.model',
    '      if (n.output && n.output.schema) itemOpts.schema = n.output.schema',
    '      const renderedGoal = (n.goal || \'\').split(\'{{item}}\').join(itemText(entry.item))',
    '      const prompt = roleRef(n.profile) + runtimeCtx(current, feedback ? \'【上轮打回反馈——必须逐条修复】\\n\' + feedback : \'\', renderedGoal)',
    '      return await agent(prompt, itemOpts)',
    '    })',
    '    const failedCount = itemResults.filter(function (item) { return item === null }).length',
    '    res = { total: source.length, okCount: source.length - failedCount, failedCount: failedCount, items: itemResults }',
    '    ok = !fanoutFailed(n.failOn, res.total, res.failedCount)',
    '  } else {',
    '    if (agentsUsed + 1 > AGENT_CAP) return { status: \'FAILED_AGENT_CAP\', stage: current, used: agentsUsed, requested: 1, limit: AGENT_CAP, results: results, history: history }',
    '    agentsUsed++',
    '    res = await callNode(current, round, feedback)',
    '    if (res === null) {',
    '      history.push({ round: round, stage: current, verdict: \'AGENT_FAILED\', reason: \'节点 agent 未返回有效结果\' })',
    '      const ef = route(current, null, false)',
    '      if (!ef || ef.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, results: results, history: history }',
    '      current = ef.to; round++; feedback = \'【\' + (BYID[current].label || current) + \' agent 技术失败】请重试并自查。\'; continue',
    '    }',
    '    ok = n.output && n.output.successCondition ? cond(n.output.successCondition, res) : true',
    '  }',
    '  if (n.verifyBranch) {',
    '    const ce = claimError(res, current)',
    '    if (ce) return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: ce, results: results, history: history }',
    '  }',
    '  results[current] = res',
    '  log((n.label || current) + \' → \' + (ok ? \'通过\' : \'未通过\'))',
    '  const e = route(current, res, ok)',
    '  if (!e) return { status: ok ? \'ENDED_NO_SUCCESS_EDGE\' : \'ENDED_NO_FAILURE_EDGE\', stage: current, results: results, history: history }',
    '  if (e.on === \'failure\') {',
    '    round++',
    '    if (e.to === \'$end\') return { status: \'FAILED_AT_\' + current, stage: current, result: res, results: results, history: history }',
    '    if (round >= MAX_ROUNDS) {',
    ...(autoReschedule ? [
      '      const historyText = history.map(function (h) { return \'第 \' + h.round + \' 轮 [\' + h.stage + \'] \' + h.verdict + \'：\' + h.reason }).join(\'\\n\')',
      '      if (agentsUsed + 1 > AGENT_CAP) return { status: \'FAILED_AGENT_CAP\', stage: current, used: agentsUsed, requested: 1, limit: AGENT_CAP, results: results, history: history }',
      '      agentsUsed++',
      '      const re = await agent(reschedulePrompt(historyText), { label: \'超限归因\', schema: { type: \'object\', properties: { reschedule: { oneOf: [{ type: \'object\', properties: { attribution: { type: \'string\' }, split: { type: \'array\', items: { type: \'string\' } }, human_action: { type: \'string\' } }, required: [\'attribution\', \'split\', \'human_action\'], additionalProperties: false }, { type: \'null\' }] }, reason: { type: \'string\' } }, required: [\'reason\'], additionalProperties: false } })',
      '      return { status: \'FAILED_MAX_ROUNDS\', taskId: TASK, rounds: MAX_ROUNDS, results: results, history: history, reschedule: re && re.reschedule ? re.reschedule : null }',
    ] : [
      '      return { status: \'FAILED_MAX_ROUNDS\', taskId: TASK, rounds: MAX_ROUNDS, results: results, history: history }',
    ]),
    '    }',
    '    history.push({ round: round, stage: current, verdict: \'REJECTED\', reason: JSON.stringify(res) })',
    '    feedback = \'【\' + (n.label || current) + \'未通过 · 第 \' + round + \' 轮】\' + JSON.stringify(res)',
    '  } else {',
    '    feedback = \'\'',
    '  }',
    '  current = e.to',
    '}',
    'return { status: \'DONE\', taskId: TASK, round: round, results: results, history: history }',
  );
  return { script: lines.join('\n'), folds };
}

// ---------- skill 包装（契约 FR-2/FR-6；runbook 覆盖全部返回状态，T-IMP-09） ----------
export function skillWrap(bp) {
  return [
    '---',
    'name: ' + bp.id,
    'description: "' + (bp.displayName + '：' + (bp.description || '') + '。当用户说『' + bp.displayName + '』『' + bp.id + '』或用自然语言要求以该工作流完成需求时使用。').replace(/"/g, '\\"') + '"',
    '---',
    '',
    '# ' + bp.displayName + '（生成 skill）',
    '',
    '本 skill 由生成器从蓝图 `templates/' + bp.id + '.json` 编译产出（NFR-1：生成物不可手改，改蓝图重生成）。',
    '',
    '## runbook',
    '',
    '1. 装配 args（taskId / runDir / entry / issueBody 或 requirement / 续跑参数），见蓝图契约 `docs/design/blueprint-schema.md`；模型绑定已在编译时固化（bindings.models），运行时不传 models。',
    '2. 调用 `workflow` 工具：`script` = 编译产物 `.generated/' + bp.id + '/script.mjs` 全文，`meta` = `.generated/' + bp.id + '/meta.json`。',
    '3. 按返回状态机驱动：',
    '   - `AWAITING_HUMAN_<节点id>`：呈 acceptance 报告 + 人工确认卡；通过 → entry=<节点id> + approved=true 续跑；不通过 → entry=dev + feedback + startRound+1 续跑。',
    '   - `FAILED_AT_<节点id>`：流程终止；呈节点结果（如 dispatch 含 missing/reason 三要素判定、dev status=blocked 受阻），人工补齐后按需续跑。',
    '   - `FAILED_MAX_ROUNDS`：呈 reschedule（归因/拆分/人工介入建议）→ 人工决策。',
    '   - `FAILED_ITEM_CAP`：fanout 项数超过单次上限 4096，缩小 items 或拆分批次后续跑；该终态在任何子代理启动前返回。',
    '   - `FAILED_AGENT_CAP`：本次运行累计子代理将超过上限 1000，缩小 fanout 或拆分工作流后续跑；该终态在本批子代理启动前返回。',
    '   - `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` / `TECHNICAL_FAILURE`：呈原因（图缺陷/技术失败），人工介入后按需续跑。',
    '   - 旧 `REJECTED_INCOMPLETE` / `BLOCKED`：已由 `FAILED_AT_<节点id>` 承接（run 级无 BLOCKED；受阻语义 = 节点结果，如 dev status=blocked → FAILED_AT_dev）。',
    '   - `DONE`：呈 cleanup 报告与合并 commit，流程结束。',
    '',
    '## 生成信息',
    '',
    '- 蓝图：`templates/' + bp.id + '.json`',
    '- 节点：' + bp.nodes.length + ' · 边：' + bp.edges.length + ' · 最大轮次：' + ((bp.control && bp.control.maxRounds) || 9),
    '',
  ].join('\n');
}

// ---------- meta 组装（三处共用：generateAll / generateUserSkill / CLI compile） ----------
export function buildMeta(bp) {
  return { name: 'vwf-' + bp.id, description: bp.displayName, phases: bp.nodes.map((n) => ({ title: n.label || n.id })) };
}

// ---------- 生成（纯函数） ----------
export function generateAll(templatesDir) {
  const files = new Map();
  const report = [];
  const tpls = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.json')).sort();
  for (const f of tpls) {
    let bp;
    try {
      bp = JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf8'));
    } catch (e) {
      report.push({ id: f.replace(/\.json$/, ''), ok: false, errors: [{ at: '$', message: 'JSON 解析失败：' + e.message }] });
      continue;
    }
    const v = validateBlueprint(bp);
    if (!v.ok) {
      report.push({ id: bp.id || f, ok: false, errors: v.errors });
      continue;
    }
    const dsh = compileBlueprint(bp);
    const vwf = projectToVwf(bp);
    const skill = skillWrap(bp);
    const rel = (p) => bp.id + '/' + p;
    files.set(rel('script.mjs'), dsh.script);
    files.set(rel('vwf-dsl.json'), JSON.stringify(vwf, null, 2) + '\n');
    files.set(rel('SKILL.md'), skill);
    files.set(rel('meta.json'), JSON.stringify(buildMeta(bp), null, 2) + '\n');
    // bundleRoles：角色随模板自包含分发（默认工作流等用户级内置模板）——
    // 把仓库 dsh/roles/*.md 复制进生成目录，syncBuiltins 随之同步到宿主根
    if (bp.bundleRoles) {
      const rolesSrc = path.join(path.dirname(templatesDir), 'dsh', 'roles');
      let roleFiles;
      try {
        roleFiles = fs.readdirSync(rolesSrc).filter((f) => f.endsWith('.md')).sort();
      } catch (e) {
        roleFiles = null;
      }
      if (!roleFiles || roleFiles.length === 0) {
        report.push({ id: bp.id, ok: false, errors: [{ at: '$.bundleRoles', message: 'bundleRoles=true 但角色源目录缺失或为空：' + rolesSrc }] });
        continue;
      }
      for (const rf of roleFiles) files.set(rel('roles/' + rf), fs.readFileSync(path.join(rolesSrc, rf), 'utf8'));
    }
    report.push({ id: bp.id, ok: true, nodes: v.counts.nodes, edges: v.counts.edges, folds: Object.keys(dsh.folds), scriptBytes: dsh.script.length });
  }
  return { files, report };
}

// ---------- 用户模板 → 自包含 skill 三件套（T-03 save 即闭环；vwf.save 经 CLI 调用） ----------
export function generateUserSkill(bp) {
  const dsh = compileBlueprint(bp);
  return new Map([
    ['SKILL.md', skillWrap(bp)],
    ['script.mjs', dsh.script],
    ['meta.json', JSON.stringify(buildMeta(bp), null, 2) + '\n'],
  ]);
}

// ---------- 内置角色定义捆绑（issue-81：Codex PR#124 第三轮 P1，评论 3889725489）----------
// 自定义工作流（user skill）在产品工作区运行时，工作区通常没有 dsh/roles/ 树。
// generateUserSkill 只产出三件套，没有 roles/ 目录，导致 compileViaPipeline 不带 roleDir，
// 运行时 roleRef 让 agent 读 dsh/roles/<profile>.md 却找不到——新增的 7 个内置角色
// （requirements/designer/evaluator/diagnose/orchestrator/researcher/synthesizer）
// 在自定义工作流里实际无法运行。修复：save 闭环时把蓝图节点引用到的角色文件随 skill
// 一起写到 roles/ 子目录，compileViaPipeline 命中即带出 roleDir，运行时自包含。
// 角色源缺失或某角色文件不存在时静默跳过——可能是自定义角色（运行时按工作区 dsh/roles 解析）。
const DEFAULT_ROLES_DIR = path.join(__dirname, '..', 'dsh', 'roles')
export function collectBuiltinRoles(bp, rolesDir = DEFAULT_ROLES_DIR, io = fs) {
  const out = new Map()
  if (!bp || !Array.isArray(bp.nodes)) return out
  const profiles = new Set()
  for (const n of bp.nodes) {
    if (n && typeof n.profile === 'string' && n.profile) profiles.add(n.profile)
  }
  for (const profile of profiles) {
    const file = path.join(rolesDir, profile + '.md')
    try {
      const content = io.readFileSync(file, 'utf8')
      out.set('roles/' + profile + '.md', content)
    } catch (e) { /* 角色源缺失或该角色文件不存在：跳过（自定义角色运行时按工作区 dsh/roles 解析） */ }
  }
  return out
}

// ---------- 用户 skill 原子写盘（候选四 T-IMP-14） ----------
// 失败零残留：先写暂存目录 → 原子换入（同父目录 rename）→ 任一步失败清理暂存并报错。
// 更新场景：旧版本目录在换入前整体移除——失败时旧版本不受影响（换入未发生）。
// io 可注入（测试用）；删除用 unlink/rmdir（避免宿主 NODE_OPTIONS safe-delete 钩子）。
// rolesDir 可注入（测试用）：默认 <repo>/dsh/roles/，save 闭环时捆绑蓝图引用的内置角色定义
// （issue-81：Codex PR#124 第三轮 P1，评论 3889725489——产品工作区无 dsh/roles/ 时
// 自定义工作流仍可运行）。
export function writeUserSkill(bp, skillDir, io = fs, rolesDir = DEFAULT_ROLES_DIR) {
  const finalDir = path.join(path.resolve(skillDir), bp.id);
  const stage = finalDir + '.tmp-' + process.pid + '-' + Date.now();
  const removeTree = (dir) => {
    let entries = [];
    try { entries = io.readdirSync(dir); } catch (e) { return; }
    for (const f of entries) {
      const p = path.join(dir, f);
      let st = null;
      try { st = io.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) removeTree(p);
      else { try { io.unlinkSync(p); } catch (e) {} }
    }
    try { io.rmdirSync(dir); } catch (e) {}
  };
  try {
    io.mkdirSync(stage, { recursive: true });
    const base = generateUserSkill(bp)
    // issue-81：捆绑蓝图引用的内置角色定义（产品工作区无 dsh/roles/ 时自定义工作流可运行）
    for (const [rel, content] of collectBuiltinRoles(bp, rolesDir, io)) base.set(rel, content)
    for (const [rel, content] of base) {
      const p = path.join(stage, rel)
      io.mkdirSync(path.dirname(p), { recursive: true })
      io.writeFileSync(p, content)
    }
    removeTree(finalDir);            // 原子换入前半：移除旧版
    io.renameSync(stage, finalDir);  // 同父目录 rename = 原子换入
    return { ok: true, dir: finalDir };
  } catch (e) {
    removeTree(stage);               // 失败零残留：清理暂存与已写文件
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- CLI（薄壳：参数解析 + 写盘 + 幂等比对，T-IMP-10 接入 validate） ----------
function writeAll(files, outDir) {
  for (const [rel, content] of files) {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function main() {
  // 子命令 user：node scripts/generate.mjs user <蓝图json路径> <skill输出目录>
  //   —— vwf.save 落盘后同步生成自包含 skill 三件套（T-03 save 即闭环）
  if (process.argv[2] === 'user') {
    const [bpPath, skillDir] = process.argv.slice(3);
    if (!bpPath || !skillDir) {
      console.error('用法：node scripts/generate.mjs user <蓝图json路径> <skill输出目录>');
      process.exit(1);
    }
    const bp = JSON.parse(fs.readFileSync(path.resolve(bpPath), 'utf8'));
    const v = validateBlueprint(bp);
    if (!v.ok) {
      console.error('❌ 蓝图校验失败：' + v.errors.map((e) => e.at + ' ' + e.message).join('；'));
      if (v.warnings.length) console.error('⚠️ ' + v.warnings.join('；'));
      process.exit(1);
    }
    // 原子写盘（候选四 T-IMP-14）：暂存 + 换入，失败零残留
    const r = writeUserSkill(bp, skillDir);
    if (!r.ok) {
      console.error('❌ 用户 skill 生成失败（已清理，无残留）：' + r.error);
      process.exit(1);
    }
    console.log('✅ 用户 skill 已生成：' + r.dir);
    if (v.warnings.length) console.log('⚠️ ' + v.warnings.join('；'));
    return;
  }

  // 子命令 compile：node scripts/generate.mjs compile <蓝图json路径>
  //   —— 统一编译器管道兜底（候选一 T-IMP-12）：宿主 vwf 侧临时图/编辑器实时查看
  //   经 CLI 取译文。宿主先做 DSL 校验（validateDsl），此处不重复校验（保持行为对齐）。
  //   stdout 输出 JSON：{ ok:true, script, meta } 或 { ok:false, error }。
  if (process.argv[2] === 'compile') {
    const bpPath = process.argv[3];
    if (!bpPath) {
      console.error('用法：node scripts/generate.mjs compile <蓝图json路径>');
      process.exit(1);
    }
    let bp;
    try {
      bp = JSON.parse(fs.readFileSync(path.resolve(bpPath), 'utf8'));
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: '蓝图解析失败：' + e.message }));
      process.exit(1);
    }
    try {
      const { script } = compileBlueprint(bp);
      console.log(JSON.stringify({ ok: true, script, meta: buildMeta(bp) }));
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: '编译失败：' + String((e && e.message) || e) }));
      process.exit(1);
    }
    return;
  }

  const tplDir = process.argv[2] || DEFAULT_TPL_DIR;
  const outDir = process.argv[3] || DEFAULT_OUT_DIR;
  const prev = fs.existsSync(outDir)
    ? new Map(fs.readdirSync(outDir, { recursive: true }).filter((f) => fs.statSync(path.join(outDir, f)).isFile())
      .map((f) => [f, fs.readFileSync(path.join(outDir, f), 'utf8')]))
    : null;
  const { files, report } = generateAll(tplDir);
  writeAll(files, outDir);
  let idem = null;
  if (prev) {
    const keys = new Set([...prev.keys(), ...files.keys()]);
    let identical = true;
    let reason = '';
    for (const k of keys) {
      if (!prev.has(k)) { identical = false; reason = '新增文件：' + k; break; }
      if (!files.has(k)) { identical = false; reason = '缺失文件：' + k; break; }
      if (prev.get(k) !== files.get(k)) { identical = false; reason = '内容不一致：' + k + '（生成物过期或手改，已重建）'; break; }
    }
    idem = { identical, reason };
  }
  for (const r of report) {
    if (r.ok) console.log('✅ ' + r.id + '：' + r.nodes + ' 节点 / ' + r.edges + ' 边' + (r.folds.length ? ' / 折叠：' + r.folds.join(',') : ''));
    else { console.log('❌ ' + r.id + '：' + r.errors.map((e) => e.at + ' ' + e.message).join('；')); }
  }
  if (idem) console.log(idem.identical ? '✅ 幂等：生成物与上次一致' : '⚠️ ' + idem.reason);
  if (report.some((r) => !r.ok)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
