// 生成器（T-IMP-04，契约见 docs/design/blueprint-schema.md §4 与 v1-task-plan T-IMP-04）
// 纯函数：generateAll(templatesDir) → { files: Map<relpath, content>, report }
// CLI：node scripts/generate.mjs [templatesDir] → 写 .generated/<id>/，重生成幂等比对
// 来源：T-02 原型 .scratch/generator-prototype 提升（单编译器 + 增强编译选项）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBlueprint } from './validate-blueprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TPL_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', '.generated');

// ---------- vwf 侧投影（契约 §4.1） ----------
export function projectToVwf(bp) {
  const models = (bp.bindings && bp.bindings.models) || {};
  return {
    id: bp.id,
    name: bp.displayName,
    description: bp.description || '',
    entry: bp.entry,
    control: { maxRounds: (bp.control && bp.control.maxRounds) || 9 },
    nodes: bp.nodes.map((n) => {
      const o = { id: n.id, profile: n.profile, label: n.label || n.id, goal: n.goal };
      if (n.output) o.output = n.output;
      if (n.manualCheck) o.manualCheck = true;
      if (models[n.id]) o.model = models[n.id];
      return o;
    }),
    edges: bp.edges.map((e) => ({ from: e.from, to: e.to, on: e.on, when: e.when })),
  };
}

// ---------- route 折叠识别（契约 §4.2） ----------
const COND_RE = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/;

function foldableNodes(bp) {
  const folds = {};
  bp.nodes.forEach((n) => {
    const out = bp.edges.filter((e) => e.from === n.id && e.on === 'success');
    if (out.length !== 2 || !out.every((e) => e.when)) return;
    const parsed = out.map((e) => { const m = COND_RE.exec(e.when); return m ? { to: e.to, path: m[1], value: m[3] } : null; });
    if (!parsed[0] || !parsed[1] || parsed[0].path !== parsed[1].path || parsed[0].value === parsed[1].value) return;
    const src = bp.edges.find((e) => e.to === n.id && e.on === 'success');
    folds[n.id] = {
      from: src ? src.from : null,
      path: parsed[0].path,
      trueTo: parsed[0].value === 'true' ? parsed[0].to : parsed[1].to,
      falseTo: parsed[0].value === 'true' ? parsed[1].to : parsed[0].to,
    };
  });
  return folds;
}

// ---------- DSH 侧编译（契约 §4.2/§4.3，移植 host.js compileDsl + 增强） ----------
export function compileDsh(bp, opts = {}) {
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
    'function issueBlock() {',
    '  if (A.issueBody) return \'GitHub issue \' + (A.issueRef || \'\') + \'\\n标题：\' + (A.issueTitle || \'（未提供）\') + \'\\n正文：\\n\' + A.issueBody + (A.issueComments ? \'\\n\\n需求确认相关评论：\\n\' + A.issueComments : \'\')',
    '  if (A.requirement) return \'原始需求文本（运行时直接给出，以此为准）：\\n\' + A.requirement',
    '  return \'（本任务未提供 issue 或需求文本，请以前序产物为准）\'',
    '}',
    'function roleRef(name) {',
    opts.noRole
      ? '  return \'【角色定义】原型模式：本节点无角色文件要求，以 goal 为唯一依据。\\n\''
      : '  return \'【角色定义】开工前先用读文件工具读取 \' + (A.roleDir || \'dsh/roles\') + \'/\' + name + \'.md（相对当前工作区根目录），严格遵循其中的定位、工作流程、产出模板、判定标准与硬规则——该文件是你在本节点的唯一角色依据。\\n\'',
    '}',
    'function runtimeCtx(nodeId, extra) {',
    '  const n = BYID[nodeId]',
    '  let s = \'\\n\\n---\\n\\n## 运行上下文（编排注入，以此为准）\\n\\n\' + \'【节点目标】\\n\' + (n.goal || \'\') + \'\\n\\n【任务输入】\\n\' + issueBlock() + \'\\n\\n- 任务标识：\' + TASK + \'\\n- run 产物目录：\' + RUNDIR + \'/（不存在则创建；本节点只允许在该目录内写文件）\\n- 当前节点：\' + (n.label || nodeId) + \'\\n- 完成本节点后更新 \' + RUNDIR + \'/STATE.md（stage / round / status / updated，时间用 date -u +%FT%TZ）\\n\'',
    '  if (n.output && n.output.files) s += \'【本节点应产出文件】\' + JSON.stringify(n.output.files) + \'\\n\'',
    '  s += (extra ? \'\\n\' + extra + \'\\n\' : \'\') + \'\\n## 最终回复要求\\n完成全部工作（含写报告、更新 STATE.md）后，最终回复只给出结构化结果本身，不要复述报告全文。\\n\'',
    '  return s',
    '}',
    'function verifyBranchStep(id) {',
    '  return \'开工前置（强制）：确认 worktree 分支 = \' + WORK + \'（git -C \' + RUNDIR + \'/worktree rev-parse --abbrev-ref HEAD）且 HEAD 一致；验证结论必须记录 verified_branch 与 verified_head。\'',
    '}',
    'async function callNode(id, round, feedback) {',
    '  const n = BYID[id]',
    '  const opts = { label: (n.label || id) + (round > 0 ? \' R\' + round : \'\'), ...(MODELS[id] || {}) }',
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
    '      const res = await callNode(current, round, feedback)',
    '      results[current] = res',
    '      return { status: \'AWAITING_HUMAN_\' + current, taskId: TASK, node: current, round: round, result: res, history: history, resume: { entry: current, approved: true, startRound: round, history: history, feedback: feedback } }',
    '    }',
    '    const e = route(current, results[current], true)',
    '    if (!e) return { status: \'ERROR\', detail: \'人工裁决后无出边：\' + current }',
    '    current = e.to',
    '    continue',
    '  }',
    '  const res = await callNode(current, round, feedback)',
    '  if (res === null) {',
    '    history.push({ round: round, stage: current, verdict: \'AGENT_FAILED\', reason: \'节点 agent 未返回有效结果\' })',
    '    const ef = route(current, null, false)',
    '    if (!ef || ef.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, results: results, history: history }',
    '    current = ef.to; round++; feedback = \'【\' + (BYID[current].label || current) + \' agent 技术失败】请重试并自查。\'; continue',
    '  }',
    '  if (n.verifyBranch) {',
    '    const ce = claimError(res, current)',
    '    if (ce) return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: ce, results: results, history: history }',
    '  }',
    '  results[current] = res',
    '  const ok = n.output && n.output.successCondition ? cond(n.output.successCondition, res) : true',
    '  log((n.label || current) + \' → \' + (ok ? \'通过\' : \'未通过\'))',
    '  const e = route(current, res, ok)',
    '  if (!e) return { status: ok ? \'ENDED_NO_SUCCESS_EDGE\' : \'ENDED_NO_FAILURE_EDGE\', stage: current, results: results, history: history }',
    '  if (e.on === \'failure\') {',
    '    round++',
    '    if (e.to === \'$end\') return { status: \'FAILED_AT_\' + current, stage: current, result: res, results: results, history: history }',
    '    if (round >= MAX_ROUNDS) {',
    ...(autoReschedule ? [
      '      const historyText = history.map(function (h) { return \'第 \' + h.round + \' 轮 [\' + h.stage + \'] \' + h.verdict + \'：\' + h.reason }).join(\'\\n\')',
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
    '   - `FAILED_AT_<节点id>`：流程终止；呈节点结果（如 dispatch 含 missing/reason 三要素缺失判定），人工补齐后重跑 entry=dispatch。',
    '   - `FAILED_MAX_ROUNDS`：呈 reschedule（归因/拆分/人工介入建议）→ 人工决策。',
    '   - `BLOCKED` / `TECHNICAL_FAILURE`：呈原因，人工介入后按需续跑。',
    '   - `REJECTED_INCOMPLETE`：见 FAILED_AT_dispatch（新契约统一）。',
    '   - `DONE`：呈 cleanup 报告与合并 commit，流程结束。',
    '',
    '## 生成信息',
    '',
    '- 蓝图：`templates/' + bp.id + '.json`',
    '- 节点：' + bp.nodes.length + ' · 边：' + bp.edges.length + ' · 最大轮次：' + ((bp.control && bp.control.maxRounds) || 9),
    '',
  ].join('\n');
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
    const dsh = compileDsh(bp);
    const vwf = projectToVwf(bp);
    const skill = skillWrap(bp);
    const rel = (p) => bp.id + '/' + p;
    files.set(rel('script.mjs'), dsh.script);
    files.set(rel('vwf-dsl.json'), JSON.stringify(vwf, null, 2) + '\n');
    files.set(rel('SKILL.md'), skill);
    files.set(rel('meta.json'), JSON.stringify(
      { name: 'vwf-' + bp.id, description: bp.displayName, phases: bp.nodes.map((n) => ({ title: n.label || n.id })) }, null, 2) + '\n');
    report.push({ id: bp.id, ok: true, nodes: v.counts.nodes, edges: v.counts.edges, folds: Object.keys(dsh.folds), scriptBytes: dsh.script.length });
  }
  return { files, report };
}

// ---------- 用户模板 → 自包含 skill 三件套（T-03 save 即闭环；vwf.save 经 CLI 调用） ----------
export function generateUserSkill(bp) {
  const dsh = compileDsh(bp);
  return new Map([
    ['SKILL.md', skillWrap(bp)],
    ['script.mjs', dsh.script],
    ['meta.json', JSON.stringify(
      { name: 'vwf-' + bp.id, description: bp.displayName, phases: bp.nodes.map((n) => ({ title: n.label || n.id })) }, null, 2) + '\n'],
  ]);
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
    const dir = path.join(path.resolve(skillDir), bp.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of generateUserSkill(bp)) fs.writeFileSync(path.join(dir, rel), content);
    console.log('✅ 用户 skill 已生成：' + dir);
    if (v.warnings.length) console.log('⚠️ ' + v.warnings.join('；'));
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
