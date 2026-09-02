// 生成器（T-IMP-04，契约见 docs/design/blueprint-schema.md §4 与 v1-task-plan T-IMP-04）
// 纯函数：generateAll(templatesDir) → { files: Map<relpath, content>, report }
// CLI：node scripts/generate.mjs [templatesDir] → 写 .generated/<id>/，重生成幂等比对
// 来源：T-02 原型 .scratch/generator-prototype 提升（单编译器 + 增强编译选项）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 统一校验内核（候选二 T-IMP-13，CJS 单文件——引擎 import / 宿主 vm eval 双形态）
import validatorCore from './validate-core.cjs';

const { validateBlueprint, COND_RE, HUMAN_DECISION_ID, HD_CONTROL_RESULTS, HD_PACKAGE_REQUIRED, HD_UNKNOWN, HD_EVENT_RECORD_KIND, HD_EVENT_TRIGGER } = validatorCore;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TPL_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', '.generated');

// ---------- 内置角色清单（单一来源 = 宿主注册表 host.js BUILTIN_ROLES）----------
// 生成脚本需区分「内置角色」与「自定义角色」：内置角色只读、以打包快照为准（Codex
// PR#124 第四轮 P1，评论 3889756922），自定义角色以工作区 dsh/roles 为准。此处不在
// 本文件复制名单，改注册表即生效；解析失败 loud-fail，避免静默退化成全部走工作区。
export function loadBuiltinRoleIds(hostSrc) {
  const src = hostSrc === undefined
    ? fs.readFileSync(path.join(__dirname, '..', 'packages', 'dsh-visual-workflow', 'src', 'host.js'), 'utf8')
    : hostSrc;
  const block = /const BUILTIN_ROLES = \[([\s\S]*?)\n\s*\]/.exec(src);
  if (!block) throw new Error('内置角色清单解析失败：未在 host.js 找到 BUILTIN_ROLES 数组');
  const ids = Array.from(block[1].matchAll(/\{\s*id:\s*'([^']+)'/g)).map((m) => m[1]);
  if (!ids.length) throw new Error('内置角色清单解析失败：BUILTIN_ROLES 中未解析到任何 id');
  return ids;
}
let _builtinRoleIdsCache = null;
function builtinRoleIdsCached() {
  if (!_builtinRoleIdsCache) _builtinRoleIdsCache = loadBuiltinRoleIds();
  return _builtinRoleIdsCache;
}

// ---------- 内置角色正文（#129 遗留项 2：临时/未保存图编译自包含） ----------
// 把内置角色 .md 正文内联进编译脚本（ROLE_DEFS）：agent 无需依赖工作区 dsh/roles 或
// 打包角色包即可拿到角色定义；stale 产物缺 ROLE_DEFS 时 roleRef 安全回退到读文件路径。
// 仅收录内置角色（ids 即内置清单）；角色文件缺失/非法 id 时跳过，保留读路径回退。
// rolesDir 默认 <repo>/dsh/roles（与 collectBuiltinRoles 同源，编译期内联 = 打包快照）。
// 角色文件安全读取（与 collectBuiltinRoles 共享）：标识只允许中英文/数字/下划线/短横线，
// 且解析后路径必须仍在角色源目录内（路径穿越防护）；文件缺失/非法返回 null。
function readRoleFileSafe(rolesDir, id, io) {
  if (!/^[\w一-龥-]+$/.test(id)) return null
  const file = path.join(rolesDir, id + '.md')
  const rel = path.relative(rolesDir, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  try { return io.readFileSync(file, 'utf8') } catch (e) { return null }
}
export function loadBuiltinRoleDefs(ids, rolesDir = DEFAULT_ROLES_DIR, io = fs) {
  const out = {};
  for (const id of ids) {
    const content = readRoleFileSafe(rolesDir, id, io);
    if (content != null) out[id] = content;
  }
  return out;
}

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
    edges: bp.edges.map((e) => {
      const o = { from: e.from, to: e.to };
      if (e.on !== undefined) o.on = e.on;
      if (e.when !== undefined) o.when = e.when;
      if (e.result !== undefined) o.result = e.result;
      if (e.outcome !== undefined) o.outcome = e.outcome;
      if (e.countRound !== undefined) o.countRound = e.countRound;
      return o;
    }),
  };
  // 业务规则字段（编辑器可配置）：onMaxRounds / heteroCheck 进入 DSL；
  // verifyBranch 为节点级字段，编辑器无 UI，暂不进入（契约修订，MAP 记录）
  if (bp.onMaxRounds !== undefined) out.onMaxRounds = bp.onMaxRounds;
  if (bp.heteroCheck) out.heteroCheck = true;
  if (bp.bundleRoles) out.bundleRoles = true;
  if (bp.humanDecision !== undefined) out.humanDecision = bp.humanDecision;
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
    const boolPair = [parsed[0].value, parsed[1].value].slice().sort().join(',');
    if (boolPair !== 'false,true') return;
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
  // 内置角色清单：opts 注入优先（测试用），否则读宿主注册表并缓存
  const builtinRoleIds = opts.builtinRoleIds || builtinRoleIdsCached();
  // 内置角色正文（#129 遗留项 2）：临时/未保存图编译自包含——正文内联进 ROLE_DEFS。
  // 只内联蓝图实际引用到的内置角色（Codex PR#130 P1，评论 3900290054）：全部 12 个
  // 内联会让最小临时图编译产物 >65KB，超过宿主 runNode stdout maxBytes:64*1024 捕获
  // 上限（host.js:137），JSON.parse 前被截断/拒绝，vwf.script / wf_run 临时图崩溃。
  const referencedProfiles = new Set((bp.nodes || []).map((n) => n && n.profile).filter(Boolean))
  const allDefs = opts.builtinRoleDefs || loadBuiltinRoleDefs(builtinRoleIds);
  const builtinRoleDefs = {};
  for (const id of Object.keys(allDefs)) if (referencedProfiles.has(id)) builtinRoleDefs[id] = allDefs[id];

  const lines = [
    'const A = args || {}',
    'const TASK = A.taskId || \'task\'',
    'const RUNDIR = A.runDir || (\'.agent-runs/\' + TASK)',
    'const WORK = \'dev2/\' + TASK',
    'const MAX_ROUNDS = ' + maxRounds,
    'const ITEM_CAP = 4096',
    'const AGENT_CAP = 1000',
    // #93: workspace 现场注入——宿主 allocateWorkspace 后传入，脚本优先使用
    'const WS = A.workspace_path || null',
    'const SOURCE = A.source_path || null',
    'const RECORDS = A.records_path || null',
    'const WORK_BRANCH = A.work_branch || WORK',
    'const SOURCE_REVISION = A.source_revision || null',
    'const NODES = ' + JSON.stringify(bp.nodes),
    'const EDGES = ' + JSON.stringify(bp.edges),
    'const MODELS = ' + JSON.stringify(models),
    'const FOLDS = ' + JSON.stringify(folds),
    // 内置角色清单（单一来源 = 宿主注册表）：roleRef 据此决定内置/自定义读取优先级
    'const BUILTIN_ROLE_IDS = ' + JSON.stringify(builtinRoleIds),
    // 内置角色正文（#129 遗留项 2）：编译期内联，临时编译自包含；缺失时 roleRef 走读路径回退
    'const ROLE_DEFS = ' + JSON.stringify(builtinRoleDefs),
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
      // 内置角色正文优先内联（#129 遗留项 2）：编译期内联 = 打包快照同源，临时编译
      // 自包含；stale 产物缺 ROLE_DEFS 声明时（typeof 三元守卫，评论 3900312838）
      // 显式回退 undefined 走读文件路径——`ROLE_DEFS && …` 会抛 ReferenceError，
      // `typeof !== 'undefined' && …` 会得到 false（而非 undefined）误触发内联分支。
      // 自定义角色（如迁移后的 dispatcher）不在 ROLE_DEFS，继续走工作区优先读路径。
      : [
          '  const _def = typeof ROLE_DEFS === \'undefined\' ? undefined : ROLE_DEFS[name]',
          '  if (_def !== undefined) return \'【角色定义】（内置角色，编译期内联，与打包快照同源）：\\n\' + _def',
          '  const _b = BUILTIN_ROLE_IDS.indexOf(name) >= 0',
        ].join('\n'),
    // 读路径兜底（内置/自定义身份切分，Codex PR#124 第四轮 P1）：内置先打包快照再工作区，
    // 自定义先工作区再打包快照（如迁移后的 dispatcher，编辑种子到工作区后对 bundled run 生效）。
    '  const _ws = \'dsh/roles/\' + name + \'.md\'',
    '  const _bundle = (A.roleDir || \'dsh/roles\') + \'/\' + name + \'.md\'',
    '  const _order = _b ? [_bundle, _ws] : [_ws, _bundle]',
    '  const _uniq = _order.filter((p, i) => _order.indexOf(p) === i)',
    '  return \'【角色定义】开工前先用读文件工具依次尝试读取以下路径中的角色文件（前者优先，读不到再读后者）：\' + _uniq.join(\'、\') + \'。严格遵循其中的定位、工作流程、产出模板、判定标准与硬规则——首个读到的文件是你在本节点的唯一角色依据。\\n\'',
    '}',
    'function runtimeCtx(nodeId, extra, goalOverride) {',
    '  const n = BYID[nodeId]',
    '  let s = \'\\n\\n---\\n\\n## 运行上下文（编排注入，以此为准）\\n\\n\' + \'【节点目标】\\n\' + (goalOverride === undefined ? (n.goal || \'\') : goalOverride) + \'\\n\\n【任务输入】\\n\' + issueBlock() + \'\\n\\n- 任务标识：\' + TASK + \'\\n- run 产物目录：\' + RUNDIR + \'/（记录、报告、STATE.md 等 run 产物写这里）\'',
    '  if (SOURCE) s += \'\\n- **业务源码读写目录（本节点唯一允许写业务文件的位置）：\' + SOURCE + \'（#93 Git worktree 现场，分支 \' + (WORK_BRANCH || WORK) + \'）**——所有源码/业务文件改动必须发生在该目录内，禁止写主仓库或共享 cwd\'',
    '  if (WS) s += \'\\n- workspace 路径：\' + WS + \'（#93 隔离工作区，其下 source=业务源码、records=Formal Records、tmp/build/cache=按 Run 隔离资源）\'',
    '  if (RECORDS) s += \'\\n- records 路径：\' + RECORDS + \'（Formal Records 证据记录目录，业务证据写入此目录）\'',
    '  s += \'\\n- 当前节点：\' + (n.label || nodeId) + \'\\n- 完成本节点后更新 \' + RUNDIR + \'/STATE.md（stage / round / status / updated，时间用 date -u +%FT%TZ）\\n\'',
    '  if (n.output && n.output.files) s += \'【本节点应产出文件】\' + JSON.stringify(n.output.files) + \'\\n\'',
    '  s += (extra ? \'\\n\' + extra + \'\\n\' : \'\') + \'\\n## 最终回复要求\\n完成全部工作（含写报告、更新 STATE.md）后，最终回复只给出结构化结果本身，不要复述报告全文。\\n\'',
    '  return s',
    '}',
    'function verifyBranchStep(id) {',
    '  const branch = WORK_BRANCH || WORK',
    '  return \'开工前置（强制）：确认 worktree 分支 = \' + branch + \'（git -C \' + (SOURCE || RUNDIR + \'/worktree\') + \' rev-parse --abbrev-ref HEAD）且 HEAD 一致；验证结论必须记录 verified_branch 与 verified_head。\'',
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
    'function hasOutcomePath(node) { return !!(node && node.output && node.output.outcomePath) }',
    'function routeOutcome(id, res) {',
    '  const node = BYID[id]',
    '  const path = node.output.outcomePath',
    '  const raw = String(path).indexOf(\'$.\') === 0 ? String(path).slice(2) : String(path)',
    '  const value = readPath(res, raw)',
    '  const out = outEdges(id)',
    '  for (const e of out) {',
    '    if (Object.prototype.hasOwnProperty.call(e, \'outcome\') && e.outcome === value) return e',
    '  }',
    '  return null',
    '}',
    'function routeTechnical(id) {',
    '  const out = outEdges(id)',
    '  for (const e of out) if (e.on === \'technical\') return e',
    '  return null',
    '}',
    'function completionOf(nodeId) {',
    '  const node = BYID[nodeId]',
    '  if (!node || !node.output || !node.output.completionPath) return null',
    '  const path = node.output.completionPath',
    '  const raw = String(path).indexOf(\'$.\') === 0 ? String(path).slice(2) : String(path)',
    '  const type = readPath(results[nodeId], raw)',
    '  if (typeof type !== \'string\' || !type.trim()) return null',
    '  return { type: type, node: nodeId, path: path }',
    '}',
    'const HD_ID = ' + JSON.stringify(HUMAN_DECISION_ID),
    'const HD_CONTROL = ' + JSON.stringify(HD_CONTROL_RESULTS),
    'const HD_PKG_REQUIRED = ' + JSON.stringify(HD_PACKAGE_REQUIRED),
    'const HD_CFG = ' + JSON.stringify(bp.humanDecision || {}),
    'function hdDeclared() {',
    '  if (HD_CFG && Object.keys(HD_CFG).length) return true',
    '  return EDGES.some(function (e) { return e && (e.to === HD_ID || e.from === HD_ID) })',
    '}',
    'function nodeDeclaresHd(nodeId) {',
    '  return EDGES.some(function (e) { return e && e.from === nodeId && e.to === HD_ID })',
    '}',
    'function mapHaltReason(raw) {',
    '  if (raw === \'MAX_ROUNDS_REACHED\') return \'MAX_ROUNDS_REACHED\'',
    '  if (raw === \'HUMAN_ACCEPTANCE\') return \'HUMAN_ACCEPTANCE\'',
    '  return \'ESCALATED_DECISION\'',
    '}',
    'function controlOptionEffects() {',
    '  return { USER_ACCEPTED: \'完成当前 Run，不改写原节点业务结果\', ADD_BUDGET: \'保留原 Outcome，沿被额度拦住的自动边再走\', STOP: \'停止本 Run，不派生新 Run\' }',
    '}',
    'function assembleDecisionPackage(nodeId, outcome, reason, override) {',
    '  if (override && typeof override === \'object\') return override',
    '  const pkg = { why: \'\', current_state: \'\', options: [], subsequent_effects: {}, cost: ' + JSON.stringify(HD_UNKNOWN) + ', benefit: ' + JSON.stringify(HD_UNKNOWN) + ', risk: ' + JSON.stringify(HD_UNKNOWN) + ', recommendation: ' + JSON.stringify(HD_UNKNOWN) + ' }',
    '  if (outcome && typeof outcome === \'object\') {',
    '    if (typeof outcome.why === \'string\' && outcome.why.trim()) pkg.why = outcome.why',
    '    else if (typeof outcome.summary_for_human === \'string\' && outcome.summary_for_human.trim()) pkg.why = outcome.summary_for_human',
    '    else if (typeof outcome.reason === \'string\' && outcome.reason.trim()) pkg.why = outcome.reason',
    '    if (typeof outcome.current_state === \'string\' && outcome.current_state.trim()) pkg.current_state = outcome.current_state',
    '    ;[\'cost\', \'benefit\', \'risk\', \'recommendation\'].forEach(function (k) { if (typeof outcome[k] === \'string\' && outcome[k].trim()) pkg[k] = outcome[k] })',
    '  }',
    '  if (!pkg.why) pkg.why = \'Blueprint routed node \' + nodeId + \' to Human Decision\'',
    '  if (!pkg.current_state) pkg.current_state = JSON.stringify(outcome == null ? null : outcome)',
    '  const effects = controlOptionEffects()',
    '  if (reason === \'MAX_ROUNDS_REACHED\') {',
    '    const names = (HD_CFG.maxRoundsReachedOptions && HD_CFG.maxRoundsReachedOptions.length) ? HD_CFG.maxRoundsReachedOptions : HD_CONTROL.slice()',
    '    names.forEach(function (id) { pkg.options.push({ id: id }); pkg.subsequent_effects[id] = effects[id] || (\'选择 \' + id) })',
    '  } else {',
    '    EDGES.filter(function (e) { return e && e.from === HD_ID && e.on === \'success\' && e.result }).forEach(function (e) {',
    '      pkg.options.push({ id: e.result })',
    '      pkg.subsequent_effects[e.result] = e.subsequent_effect || (\'选择 \' + e.result + \' 后沿蓝图出边继续\')',
    '    })',
    '    ;[\'USER_ACCEPTED\', \'STOP\'].forEach(function (id) {',
    '      if (!pkg.subsequent_effects[id]) { pkg.options.push({ id: id }); pkg.subsequent_effects[id] = effects[id] }',
    '    })',
    '  }',
    '  return pkg',
    '}',
    'function missingPackageKeys(pkg) {',
    '  const miss = []',
    '  if (!pkg || typeof pkg !== \'object\') return HD_PKG_REQUIRED.slice()',
    '  HD_PKG_REQUIRED.forEach(function (k) {',
    '    const v = pkg[k]',
    '    if (k === \'options\') { if (!Array.isArray(v) || v.length === 0) miss.push(k) }',
    '    else if (k === \'subsequent_effects\') { if (!v || typeof v !== \'object\' || !Object.keys(v).length) miss.push(k) }',
    '    else if (typeof v !== \'string\' || !v.trim()) miss.push(k)',
    '  })',
    '  return miss',
    '}',
    'function haltWaitingHuman(nodeId, outcome, reason, blockedEdge, overridePkg, reuseId) {',
    '  const pkg = assembleDecisionPackage(nodeId, outcome, reason, overridePkg)',
    '  const miss = missingPackageKeys(pkg)',
    '  if (miss.length) return { status: \'ERROR\', detail: \'Decision Package 缺必填：\' + miss.join(\',\') }',
    '  const reuse = (reuseId && String(reuseId).trim()) ? String(reuseId) : \'\'',
    '  if (!reuse) decisionSeq += 1',
    '  const decisionId = reuse || (TASK + \':\' + nodeId + \':\' + round + \':\' + decisionSeq)',
    '  const ev = {',
    '    record_kind: ' + JSON.stringify(HD_EVENT_RECORD_KIND) + ',',
    '    trigger: ' + JSON.stringify(HD_EVENT_TRIGGER) + ',',
    '    lifecycle_at_request: \'WAITING_HUMAN\',',
    '    decision_id: decisionId,',
    '    run_ref: TASK,',
    '    node_id: nodeId,',
    '    attempt: decisionSeq,',
    '    reason: reason,',
    '    triggering_node_outcome: outcome == null ? null : JSON.parse(JSON.stringify(outcome)),',
    '    decision_package: pkg,',
    '    user_choice: null,',
    '    impact: null,',
    '    subsequent_path: null,',
    '    budget_used: budgetUsed,',
    '    max_rounds: maxRounds,',
    '    created_at: new Date().toISOString(),',
    '  }',
    '  return {',
    '    status: \'WAITING_HUMAN\', taskId: TASK, node: nodeId, reason: reason, decision_id: decisionId, decisionSeq: decisionSeq,',
    '    decision_package: pkg, control_event: ev, blocked_edge: blockedEdge || null,',
    '    result: outcome, results: results, history: history, round: round,',
    '    budgetUsed: budgetUsed, maxRounds: maxRounds,',
    '    resume: { entry: nodeId, decision_id: decisionId, startRound: round, history: history, feedback: feedback, results: results, blocked_edge: blockedEdge || null, budgetUsed: budgetUsed, maxRounds: maxRounds, decisionSeq: decisionSeq }',
    '  }',
    '}',
    'function countsBudget(e) { return !!(e && e.countRound === true) }',
    'function recordFlow(fromId, e) {',
    '  history.push({ round: round, stage: fromId, from: fromId, to: e ? e.to : null, outcome: e && Object.prototype.hasOwnProperty.call(e, \'outcome\') ? e.outcome : undefined, countRound: countsBudget(e) })',
    '}',
    'function consumeOrHalt(fromId, outcome, e) {',
    '  if (countsBudget(e) && budgetUsed >= maxRounds) {',
    '    history.push({ round: round, stage: fromId, from: fromId, to: e.to, outcome: e.outcome, countRound: true, halted: true, reason: \'MAX_ROUNDS_REACHED\' })',
    '    return haltWaitingHuman(fromId, outcome, \'MAX_ROUNDS_REACHED\', e)',
    '  }',
    '  recordFlow(fromId, e)',
    '  if (countsBudget(e)) budgetUsed++',
    '  return null',
    '}',
    'function choiceControlEvent(choice, subsequentPath) {',
    '  const effects = controlOptionEffects()',
    '  return {',
    '    record_kind: ' + JSON.stringify(HD_EVENT_RECORD_KIND) + ',',
    '    trigger: ' + JSON.stringify(HD_EVENT_TRIGGER) + ',',
    '    lifecycle_at_request: \'WAITING_HUMAN\',',
    '    decision_id: A.decision_id,',
    '    run_ref: TASK,',
    '    node_id: A.entry || null,',
    '    attempt: decisionSeq,',
    '    reason: null,',
    '    triggering_node_outcome: null,',
    '    decision_package: null,',
    '    user_choice: choice,',
    '    impact: effects[choice] || (\'选择 \' + choice + \' 后沿蓝图出边继续\'),',
    '    subsequent_path: subsequentPath || choice,',
    '    created_at: new Date().toISOString(),',
    '  }',
    '}',
    'function claimError(res, stage) {',
    '  const head = res && res.verified_head',
    '  const headOk = typeof head === \'string\' && head.trim().length > 0',
    '  const expectedBranch = WORK_BRANCH || WORK',
    '  if (res && res.verified_branch === expectedBranch && headOk) return null',
    '  return stage + \' 结论校验失败：verified_branch=\' + JSON.stringify(res && res.verified_branch) + \'（应为 \' + expectedBranch + \'），verified_head=\' + JSON.stringify(head)',
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
    'let budgetUsed = Number(A.budgetUsed) || 0',
    'let maxRounds = (A.maxRounds == null || A.maxRounds === \'\') ? MAX_ROUNDS : Math.trunc(Number(A.maxRounds))',
    'if (!Number.isFinite(maxRounds) || maxRounds < 1) maxRounds = MAX_ROUNDS',
    'let decisionSeq = Math.trunc(Number(A.decisionSeq) || 0)',
    'if (!Number.isFinite(decisionSeq) || decisionSeq < 0) decisionSeq = 0',
    'let feedback = A.feedback || \'\'',
    'const results = {}',
    'const history = A.history || []',
    'let agentsUsed = 0',
    'let choiceEvent = null',
    'let lastNode = null',
    'if (A.results && typeof A.results === \'object\') Object.keys(A.results).forEach(function (k) { results[k] = A.results[k] })',
    'if (A.injectHalt) {',
    '  const inj = A.injectHalt',
    '  const reason0 = mapHaltReason(inj.reason)',
    '  const allowed = reason0 === \'MAX_ROUNDS_REACHED\' ? hdDeclared() : nodeDeclaresHd(inj.node)',
    '  if (!allowed) return { status: \'ERROR\', detail: \'无蓝图声明不得升级到 Human Decision\' }',
    '}',
    'if (A.decision_id && A.user_choice) {',
    '  const choice = A.user_choice',
    '  if (choice === \'STOP\') {',
    '    choiceEvent = choiceControlEvent(choice, \'STOP\')',
    '    return { status: \'STOPPED\', taskId: TASK, decision_id: A.decision_id, results: results, history: history, user_choice: choice, control_event: choiceEvent }',
    '  }',
    '  if (choice === \'USER_ACCEPTED\') {',
    '    choiceEvent = choiceControlEvent(choice, \'USER_ACCEPTED\')',
    '    return { status: \'DONE\', taskId: TASK, decision_id: A.decision_id, results: results, history: history, user_choice: choice, control_event: choiceEvent, completion: null }',
    '  }',
    '  if (choice === \'ADD_BUDGET\') {',
    '    const blocked = A.blocked_edge',
    '    if (!blocked || !blocked.to) return { status: \'ERROR\', detail: \'ADD_BUDGET 需要 blocked_edge\' }',
    '    maxRounds = maxRounds + 1',
    '    if (countsBudget(blocked)) budgetUsed++',
    '    history.push({ round: round, stage: blocked.from || current, from: blocked.from, to: blocked.to, outcome: blocked.outcome, countRound: countsBudget(blocked), via: \'ADD_BUDGET\' })',
    '    choiceEvent = choiceControlEvent(choice, String(blocked.to))',
    '    choiceEvent.reason = \'MAX_ROUNDS_REACHED\'',
    '    choiceEvent.budget_delta = 1',
    '    choiceEvent.max_rounds_after = maxRounds',
    '    choiceEvent.budget_used = budgetUsed',
    '    current = blocked.to',
    '  } else {',
    '    const edge = EDGES.filter(function (e) { return e && e.from === HD_ID && e.result === choice })[0]',
    '    if (!edge || !edge.to) {',
    '      const nodeId = A.entry || \'' + (bp.entry || '') + '\'',
    '      const waiting = haltWaitingHuman(nodeId, results[nodeId], \'ESCALATED_DECISION\', A.blocked_edge || null, null, A.decision_id)',
    '      if (waiting && waiting.status === \'WAITING_HUMAN\') waiting.rejected_choice = choice',
    '      return waiting',
    '    }',
    '    choiceEvent = choiceControlEvent(choice, String(edge.to))',
    '    current = edge.to',
    '  }',
    '}',
    'while (current !== \'$end\') {',
    '  lastNode = current',
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
    '      if (hasOutcomePath(n)) {',
    '        const et = routeTechnical(current)',
    '        if (!et || et.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, results: results, history: history }',
    '        history.push({ round: round, stage: current, from: current, to: et.to, on: \'technical\', countRound: false })',
    '        current = et.to',
    '        feedback = \'【\' + (BYID[current].label || current) + \' agent 技术失败】请重试并自查。\'',
    '        continue',
    '      }',
    '      const ef = route(current, null, false)',
    '      if (!ef || ef.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, results: results, history: history }',
    '      current = ef.to; round++; feedback = \'【\' + (BYID[current].label || current) + \' agent 技术失败】请重试并自查。\'; continue',
    '    }',
    '    ok = n.output && n.output.successCondition ? cond(n.output.successCondition, res) : true',
    '  }',
    '  if (n.verifyBranch) {',
    '    const ce = claimError(res, current)',
    '    if (ce) {',
    '      if (hasOutcomePath(n)) {',
    '        const et = routeTechnical(current)',
    '        if (!et || et.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: ce, results: results, history: history }',
    '        history.push({ round: round, stage: current, from: current, to: et.to, on: \'technical\', countRound: false })',
    '        current = et.to',
    '        feedback = \'【\' + (n.label || current) + \' 可信度闸门失败】\' + ce',
    '        continue',
    '      }',
    '      return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: ce, results: results, history: history }',
    '    }',
    '  }',
    '  results[current] = res',
    '  log((n.label || current) + \' → \' + (ok ? \'通过\' : \'未通过\'))',
    '  if (A.injectHalt && A.injectHalt.node === current) {',
    '    return haltWaitingHuman(current, res, mapHaltReason(A.injectHalt.reason), A.injectHalt.blocked_edge || null, A.injectHalt.decision_package)',
    '  }',
    '  if (hasOutcomePath(n)) {',
    '    const e = routeOutcome(current, res)',
    '    if (!e) return { status: \'ENDED_NO_OUTCOME_EDGE\', stage: current, results: results, history: history, budgetUsed: budgetUsed, maxRounds: maxRounds }',
    '    log((n.label || current) + \' → \' + String(e.outcome))',
    '    const halted = consumeOrHalt(current, res, e)',
    '    if (halted) return halted',
    '    if (e.to === HD_ID) {',
    '      return { status: \'ROUTE_HALTED\', reason: \'HUMAN_DECISION\', taskId: TASK, node: current, round: round, results: results, history: history, budgetUsed: budgetUsed, maxRounds: maxRounds }',
    '    }',
    '    current = e.to',
    '    continue',
    '  }',
    '  const e = route(current, res, ok)',
    '  if (!e) return { status: ok ? \'ENDED_NO_SUCCESS_EDGE\' : \'ENDED_NO_FAILURE_EDGE\', stage: current, results: results, history: history }',
    '  if (e.to === HD_ID) return haltWaitingHuman(current, res, \'ESCALATED_DECISION\', null)',
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
    'const done = { status: \'DONE\', taskId: TASK, round: round, results: results, history: history, completion: completionOf(lastNode), budgetUsed: budgetUsed, maxRounds: maxRounds }',
    'if (choiceEvent) { done.decision_id = A.decision_id; done.user_choice = A.user_choice; done.control_event = choiceEvent }',
    'return done',
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
    '   - `AWAITING_HUMAN_<节点id>`：呈报告 + 人工确认卡；通过 → 以该门禁节点为 entry 且 approved=true 续跑（只走 success 出边）；非 true（含 false）→ 仍以同一门禁节点续跑，引擎再挂起，不走 failure。',
    '   - `WAITING_HUMAN`：呈 Decision Package（why / current_state / options / subsequent_effects）；按 `decision_id` + `user_choice` 续跑。控制类 Result：`STOP` 停止本 Run、`USER_ACCEPTED` 完成且不改写原 Outcome、`ADD_BUDGET` 显式 +1 额度并沿被拦边再走（须写入 Decision/Control Record，不得隐式恢复）。`reason=MAX_ROUNDS_REACHED` 表示自动回退额度耗尽，原 Node Business Outcome 必须原样保留。业务 Result 沿该蓝图 `$human-decision` 出边继续；无对应出边则拒绝该选择并保持等待。',
    '   - `STOPPED`：本 Run 已停止，不派生新 Run。',
    '   - `FAILED_MAX_ROUNDS`：仅旧蓝图 failure 边打回超限（过渡兼容）；新模式额度耗尽走 `WAITING_HUMAN` + `MAX_ROUNDS_REACHED`。',
    '   - `FAILED_ITEM_CAP`：fanout 项数超过单次上限 4096，缩小 items 或拆分批次后续跑；该终态在任何子代理启动前返回。',
    '   - `FAILED_AGENT_CAP`：本次运行累计子代理将超过上限 1000，缩小 fanout 或拆分工作流后续跑；该终态在本批子代理启动前返回。',
    '   - `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` / `ENDED_NO_OUTCOME_EDGE` / `TECHNICAL_FAILURE`：呈原因（图缺陷/技术失败），人工介入后按需续跑。',
    '   - `ROUTE_HALTED`：蓝图命中 `$human-decision`，自动流转停机（reason=HUMAN_DECISION）；保留节点业务结果，不改写 Outcome。',
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
    // 安全读取（readRoleFileSafe 共享，Codex PR#124 第四轮 P1，评论 3889756923）：
    // profile 此前只校验非空，'../../AGENTS' 之类会被拼出 roles/ 目录之外的路径，
    // 随 skill 写到暂存目录外。角色标识只允许中英文/数字/下划线/短横线且路径必须在
    // 角色源目录内；文件缺失/非法返回 null → 跳过（自定义角色运行时按工作区 dsh/roles 解析）。
    const content = readRoleFileSafe(rolesDir, profile, io)
    if (content != null) out.set('roles/' + profile + '.md', content)
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
