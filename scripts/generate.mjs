// 生成器（T-IMP-04，契约见 docs/design/blueprint-schema.md §4 与 v1-task-plan T-IMP-04）
// 纯函数：generateAll(templatesDir) → { files: Map<relpath, content>, report }
// CLI：node scripts/generate.mjs [templatesDir] → 写 .generated/<id>/，重生成幂等比对
// 来源：T-02 原型 .scratch/generator-prototype 提升（单编译器 + 增强编译选项）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 统一校验内核（候选二 T-IMP-13，CJS 单文件——引擎 import / 宿主 vm eval 双形态）
import validatorCore from './validate-core.cjs';
// Blueprint ↔ VWF DSL 投影内核（候选一）：生成器与 Host 共用同一份字段契约。
import projectionCore from './projection-core.cjs';
// 角色库内核（候选二深化）：内置角色清单唯一事实源 = dsh/roles/builtin-roles.json；
// 正文安全读取与「被引用角色文件打包」共享内核实现（含自定义角色——dispatcher 等）。
import roleLibrary from './role-library.cjs';

const { buildSnapshot, readRoleFileSafe, collectReferencedRoleFiles } = roleLibrary;
const { projectToVwf } = projectionCore;

const { validateBlueprint, compileInputSizeViolation, COND_RE, HUMAN_DECISION_ID, HD_CONTROL_RESULTS, HD_PACKAGE_REQUIRED, HD_UNKNOWN, HD_EVENT_RECORD_KIND, HD_EVENT_TRIGGER, effectiveHeteroMode } = validatorCore;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TPL_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', '.generated');
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'dsh', 'roles', 'builtin-roles.json');

// ---------- 内置角色清单（单一事实源 = dsh/roles/builtin-roles.json）----------
// 生成脚本需区分「内置角色」与「自定义角色」：内置角色只读、以打包快照为准（Codex
// PR#124 第四轮 P1，评论 3889756922），自定义角色以工作区 dsh/roles 为准。清单读
// manifest 并强校验（schema/顺序不变量/dispatcher 不得为内置），解析失败 loud-fail，
// 禁止静默退化成全部走工作区。不再反向解析 host.js 源码（旧 regex 缝已拆）。
export function loadBuiltinRoleIds(manifestPath = DEFAULT_MANIFEST_PATH) {
  try {
    // 统一走 RoleLibrary 的同步构建投影：保持 compileBlueprint 同步，避免第二套
    // manifest 解析/校验实现。buildSnapshot 同时验证 12 个角色正文可读取性投影。
    return buildSnapshot({ manifestPath, rolesDir: DEFAULT_ROLES_DIR, io: fs }).builtinIds;
  } catch (e) {
    const message = String((e && e.message) || e)
    if (message.includes('内置角色清单解析失败')) throw e
    throw new Error('内置角色清单解析失败：' + message)
  }
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
// 角色文件安全读取（readRoleFileSafe 共享自 role-library.cjs，Codex PR#124 第四轮 P1，
// 评论 3889756923）：标识只允许中英文/数字/下划线/短横线，且解析后路径必须仍在角色源
// 目录内（路径穿越防护）；文件缺失/非法返回 null。
export function loadBuiltinRoleDefs(ids, rolesDir = DEFAULT_ROLES_DIR, io = fs) {
  const out = {};
  for (const id of ids) {
    const content = readRoleFileSafe(rolesDir, id, io);
    if (content != null) out[id] = content;
  }
  return out;
}

// ---------- vwf 侧投影（候选一：兼容保留既有 named export） ----------
export { projectToVwf };

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
// 宿主侧 compileDsl 经管道消费本函数产物：一律现编译优先（与引擎契约同源），
// 磁盘预编译产物仅在无子进程环境整体回落（UAT-80 实证过期产物与引擎不兼容）。
export function compileBlueprint(bp, opts = {}) {
  // 编译输入尺寸闸门（#131）：CLI compile 不做蓝图校验，vwf.script / wf_run 的临时图
  // 直达此处——主闸必须在编译器入口，保证任何进入编译的文档响应必小于通道上限。
  // 限额与计量同源自 validate-core（单点定义，防两闸口径漂移）。
  const sizeViolation = compileInputSizeViolation(bp);
  if (sizeViolation) throw new Error('工作流文档过大：' + sizeViolation.message);
  const maxRounds = (bp.control && bp.control.maxRounds) || 9;
  const models = (bp.bindings && bp.bindings.models) || {};
  const folds = foldableNodes(bp);
  // LOC-021 异源档位三态：运行时日志与校验内核共用同一归一口径（关档不注入日志）；
  // 识别口径统一为「按节点 id 或 profile」（诊断模板开发节点 id=fix、profile=dev，不再被漏判）。
  const heteroMode = effectiveHeteroMode(bp.heteroCheck);
  const heteroDev = bp.nodes.find((n) => n && (n.id === 'dev' || n.profile === 'dev'));
  const heteroReview = bp.nodes.find((n) => n && (n.id === 'review' || n.profile === 'review'));
  const hetero = heteroMode !== 'off' && heteroDev && heteroReview && models[heteroDev.id] && models[heteroReview.id];
  const autoReschedule = bp.onMaxRounds === 'auto-reschedule';
  // LOC-025 裁决一致性：仅声明了 output.consistency 的蓝图才注入路由前契约校验。
  const hasConsistencyDecl = Array.isArray(bp.nodes) && bp.nodes.some((n) => n && n.output && n.output.consistency);
  // 内置角色清单：opts 注入优先（测试用），否则读 manifest 并缓存
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
    'const __VWF_WS_DEFAULTS__ = {}',
    'const A = Object.assign({}, __VWF_WS_DEFAULTS__, args || {})',
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
    // LOC-013：宿主经 args.workspace_mode 注入 #93 隔离模式（ISOLATED_READ 时 source 只读）
    'const WS_MODE = A.workspace_mode || null',
    'const NODES = ' + JSON.stringify(bp.nodes),
    'const EDGES = ' + JSON.stringify(bp.edges),
    // #79：续跑快照修订仅允许更换 Provider/Model——宿主经 args.model_overrides 注入
    // （节点id → {provider,model}，$default 只作用于未显式覆盖的绑定节点），合并进
    // MODELS；合并语义与宿主 appendSnapshotRevision 一致（显式覆盖优先）。
    'const MODELS = (function () {',
    '  const M = ' + JSON.stringify(models),
    '  const ov = (A.model_overrides && typeof A.model_overrides === \'object\' && !Array.isArray(A.model_overrides)) ? A.model_overrides : {}',
    '  const def = (ov[\'$default\'] && typeof ov[\'$default\'] === \'object\') ? ov[\'$default\'] : null',
    '  for (const k of Object.keys(M)) {',
    '    const o = (ov[k] && typeof ov[k] === \'object\') ? ov[k] : def',
    '    if (!o) continue',
    '    const cur = M[k] || {}',
    '    M[k] = {',
    '      provider: (o.provider !== undefined && o.provider !== \'\') ? String(o.provider) : String(cur.provider || \'default\'),',
    '      model: (o.model !== undefined && o.model !== \'\') ? String(o.model) : String(cur.model || \'default\'),',
    '    }',
    '  }',
    '  return M',
    '})()',
    // #93 兼容垫片（R6 复核保留，防御性）：部分引擎版本的 agent() 选项白名单不含
    // cwd（UNSUPPORTED_OPTION）。带 cwd 被拒时自动去 cwd 重试：新引擎退化为会话
    // 默认 cwd（文件访问仍走 vwf.workspace.* 显式路径），旧引擎照常获得 cwd。
    'async function runAgent(prompt, opts) {',
    '  try { return await agent(prompt, opts) } catch (e) {',
    '    if (opts && opts.cwd && /UNSUPPORTED_OPTION|not recognized/i.test(String((e && e.message) || e))) {',
    '      const rest = Object.assign({}, opts); delete rest.cwd;',
    '      return await agent(prompt, rest);',
    '    }',
    '    throw e;',
    '  }',
    '}',
    'const FOLDS = ' + JSON.stringify(folds),
    // 内置角色清单（单一事实源 = dsh/roles/builtin-roles.json）：roleRef 据此决定内置/自定义读取优先级
    'const BUILTIN_ROLE_IDS = ' + JSON.stringify(builtinRoleIds),
    // 内置角色正文（#129 遗留项 2）：编译期内联，临时编译自包含；缺失时 roleRef 走读路径回退
    'const ROLE_DEFS = ' + JSON.stringify(builtinRoleDefs),
    'const BYID = {}',
    'for (const n of NODES) BYID[n.id] = n',
    // #80 暂停/中断恢复现场：每个节点完成路由后输出检查点行（current/results/history 全量）。
    // 引擎取消后脚本返回值被强制丢弃（value=null），宿主据此行重建 resume 载荷；
    // 解析失败或缺失时宿主诚实降级（要求人工指定 entry，不猜现场）。
    'function pwCk(next) { try { log(\'[pw-ckpt]\' + JSON.stringify({ c: next, r: results, h: history, rd: round, fb: feedback, bu: budgetUsed, mr: maxRounds, ds: decisionSeq })) } catch (e) { /* 检查点失败不影响运行 */ } }',
  ];
  if (hetero) {
    lines.push(
      'function modelTag(id) { const m = MODELS[id]; return m ? (m.provider || \'default\') + \'/\' + (m.model || \'default\') : \'default\' }',
      '(function () {',
      '  const MODE = ' + JSON.stringify(heteroMode),
      '  const DEV = ' + JSON.stringify(heteroDev.id),
      '  const REVIEW = ' + JSON.stringify(heteroReview.id),
      '  const roleOf = (n) => (n && n.profile) || \'\'',
      '  const dTag = modelTag(DEV), rTag = modelTag(REVIEW)',
      '  const pair = DEV + \'（\' + roleOf(BYID[DEV]) + \'） / \' + REVIEW + \'（\' + roleOf(BYID[REVIEW]) + \'）\'',
      '  if (dTag === rTag) log(\'⚠️ 异源警告（异源档位 \' + MODE + \'）：\' + pair + \' 同模型 \' + dTag + \'，请修改 bindings.models\')',
      '  else if (MODELS[DEV].provider === MODELS[REVIEW].provider) log(\'⚠️ 弱异源（异源档位 \' + MODE + \'）：\' + pair + \' 同 provider \' + MODELS[DEV].provider + \' 不同模型（\' + dTag + \' / \' + rTag + \'）\' + (MODE === \'strong\' ? \'——强档要求不同 provider，保存校验应已拦截\' : \'，建议配置不同 provider 满足真异源\'))',
      '  else log(\'异源检查通过（异源档位 \' + MODE + \'）：\' + pair + \'，\' + DEV + \'=\' + dTag + \' / \' + REVIEW + \'=\' + rTag)',
      '})()',
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
    // ---------- LOC-024 显式交接节点输入（inputs 声明 → resolved_inputs） ----------
    // 解析发生在调用代理之前；缺必需引用在调用消费节点前返回可定位错误（node/binding/reason），
    // 不静默退用另一轮旧结果；version_ref 为临时执行引用（执行序号 + 内容摘要），正式 Record
    // 接入后由实际 Revision 替代。旧蓝图（未声明 inputs）维持原行为并标注 legacy 输入模式。
    'function digest8(v) {',
    '  const s = typeof v === \'string\' ? v : (v === undefined ? \'undefined\' : JSON.stringify(v))',
    '  let h = 0x811c9dc5',
    '  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }',
    '  return (\'00000000\' + h.toString(16)).slice(-8)',
    '}',
    'function inputModeOf(id) {',
    '  const n = BYID[id]',
    '  return (n && Array.isArray(n.inputs) && n.inputs.length) ? \'declared\' : \'legacy\'',
    '}',
    'function clipText(v) {',
    '  const s = typeof v === \'string\' ? v : JSON.stringify(v)',
    '  if (s === undefined) return String(v)',
    '  return s.length > 2000 ? s.slice(0, 2000) + \'……（内容已按声明裁剪，完整值以 resolved_inputs 清单与文件引用为准）\' : s',
    '}',
    'function inputItem(b, producer, value, source, versionRef) {',
    '  const item = { binding: b.name, selector: b.from, producer: producer, source: source, version_ref: versionRef }',
    '  if (b.artifact) item.artifact_ref = RUNDIR + \'/\' + b.artifact',
    '  if (value !== undefined) item.value = value',
    '  return item',
    '}',
    'function versionRefOf(rec) {',
    '  return rec ? \'tmp-exec:\' + rec.seq + \':\' + digest8(rec.result) : \'\'',
    '}',
    'function resolveBinding(consumerId, b) {',
    '  const from = typeof b.from === \'string\' ? b.from : \'\'',
    '  if (from === \'$.task\' || from.indexOf(\'$.task.\') === 0) {',
    '    const taskPath = from === \'$.task\' ? \'\' : from.slice(7)',
    '    const tv = readPath(A, taskPath)',
    '    if (tv === undefined) {',
    '      if (b.required === true && !Object.prototype.hasOwnProperty.call(b, \'default\')) return { error: \'任务输入缺少 \' + (taskPath || \'整体\') + \'（required 且未声明首次运行默认值）\' }',
    '      if (Object.prototype.hasOwnProperty.call(b, \'default\')) return { item: inputItem(b, null, b.default, \'first_run_default\', \'first-run-default\') }',
    '      return { item: null }',
    '    }',
    '    return { item: inputItem(b, null, tv, \'task_input\', \'task:\' + digest8(tv)) }',
    '  }',
    '  const m = /^\\$\\.results\\.([a-z0-9]+(?:-[a-z0-9]+)*)((?:\\.[A-Za-z0-9_-]+)*)$/.exec(from)',
    '  if (!m) return { error: \'选择器非法（仅支持 $.task[.字段链] / $.results.<节点id>[.字段链]；禁止 eval、路径穿越与目录扫描）：\' + from }',
    '  const producer = m[1]',
    '  const fieldPath = m[2] ? m[2].slice(1) : \'\'',
    '  const rec = EXEC_OF[producer] || null',
    '  if (!rec) {',
    '    if (b.required === true && !Object.prototype.hasOwnProperty.call(b, \'default\')) return { error: \'生产节点 \' + producer + \' 尚无本次流转可引用的产出（required 且未声明首次运行默认值；禁止静默退用其他轮次旧结果）\' }',
    '    if (Object.prototype.hasOwnProperty.call(b, \'default\')) return { item: inputItem(b, producer, b.default, \'first_run_default\', \'first-run-default\') }',
    '    return { item: null }',
    '  }',
    '  const rv = readPath(rec.result, fieldPath)',
    '  if (rv === undefined) {',
    '    if (b.required === true) return { error: \'生产节点 \' + producer + \' 的结果缺少字段 \' + (fieldPath || \'整体\') + \'（required 输入，禁止静默退用默认值或旧轮结果）\' }',
    '    if (Object.prototype.hasOwnProperty.call(b, \'default\')) return { item: inputItem(b, producer, b.default, \'first_run_default\', \'first-run-default\') }',
    '    return { item: null }',
    '  }',
    '  return { item: inputItem(b, producer, rv, \'producer_result\', versionRefOf(rec)) }',
    '}',
    'function resolveNodeInputs(id) {',
    '  const n = BYID[id]',
    '  if (!n || !Array.isArray(n.inputs) || !n.inputs.length) return { mode: \'legacy\', items: [], errors: [] }',
    '  const items = []',
    '  const errors = []',
    '  for (const b of n.inputs) {',
    '    let r',
    '    try { r = resolveBinding(id, b) } catch (e) { r = { error: \'解析异常：\' + String((e && e.message) || e) } }',
    '    if (r.error) { errors.push({ node: id, binding: b.name, reason: r.error }); continue }',
    '    if (r.item) items.push(Object.freeze(r.item))',
    '  }',
    '  return { mode: \'declared\', items: Object.freeze(items), errors: errors }',
    '}',
    'function inputsBlock(items) {',
    '  if (!items || !items.length) return \'\'',
    '  let s = \'\\n【节点输入（编排已按本节点 inputs 声明解析；只采信本清单及其中版本引用，禁止引用其他轮次的旧结果）】\\n\'',
    '  for (const it of items) {',
    '    s += \'- 输入 \' + it.binding + \' ← \' + it.selector',
    '    if (it.producer) s += \'（生产节点 \' + it.producer + \'，版本 \' + it.version_ref + \'）\'',
    '    else s += \'（任务输入，版本 \' + it.version_ref + \'）\'',
    '    if (it.source === \'first_run_default\') s += \'【首次运行默认值——真实输入尚未产生】\'',
    '    s += \'：\'',
    '    if (it.artifact_ref) s += \'正文以文件引用交付：请读取 \' + it.artifact_ref + (it.value === undefined ? \'\' : \'；摘要：\' + clipText(it.value))',
    '    else s += \'\\n\' + clipText(it.value) + \'\\n\'',
    '  }',
    '  return s',
    '}',
    'function valueType(value) { return value === null ? \'null\' : Array.isArray(value) ? \'array\' : typeof value }',
    'function itemText(item) { if (typeof item === \'string\') return item; const text = JSON.stringify(item); return text === undefined ? String(item) : text }',
    'function fanoutFailed(failOn, total, failedCount) {',
    '  if (failOn === \'any\') return failedCount >= 1',
    '  if (failOn === \'all\' || failOn === undefined) return total > 0 && failedCount === total',
    '  return failedCount > failOn',
    '}',
    'function issueBlock() {',
    '  let s = \'\'',
    '  if (A.issueBody) s = \'GitHub issue \' + (A.issueRef || \'\') + \'\\n标题：\' + (A.issueTitle || \'（未提供）\') + \'\\n正文：\\n\' + A.issueBody + (A.issueComments ? \'\\n\\n需求确认相关评论：\\n\' + A.issueComments : \'\')',
    '  else if (A.requirement) s = \'原始需求文本（运行时直接给出，以此为准）：\\n\' + A.requirement',
    '  else s = \'（本任务未提供 issue 或需求文本，请以前序产物为准）\'',
    '  if (A.baseline_amendment) s += \'\\n\\n【需求基线修订（用户暂停期间显式变更，以此为准覆盖原基线相应内容）】\\n\' + A.baseline_amendment',
    '  return s',
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
    'function runtimeCtx(nodeId, extra, goalOverride, opts) {',
    '  const n = BYID[nodeId]',
    '  let s = \'\\n\\n---\\n\\n## 运行上下文（编排注入，以此为准）\\n\\n\' + \'【节点目标】\\n\' + (goalOverride === undefined ? (n.goal || \'\') : goalOverride) + \'\\n\\n【任务输入】\\n\' + issueBlock() + \'\\n\\n- 任务标识：\' + TASK + \'\\n- run 产物目录：\' + RUNDIR + \'/（记录、报告、STATE.md 等 run 产物写这里；不存在则创建）\'',
    '  if (SOURCE && WS_MODE === \'ISOLATED_READ\') s += \'\\n- **共享 source（只读现场，禁止写入任何文件）：\' + SOURCE + \'**——本工作流为只读研究现场，产出只能写入 run 产物目录或你的专属 scratch\'',
    '  else if (SOURCE) s += \'\\n- **业务源码读写目录（本节点唯一允许写业务文件的位置）：\' + SOURCE + \'（#93 Git worktree 现场，分支 \' + (WORK_BRANCH || WORK) + \'）**——所有源码/业务文件改动必须发生在该目录内，禁止写主仓库或共享 cwd\'',
    '  if (WS) s += \'\\n- workspace 路径：\' + WS + \'（#93 隔离工作区，其下 source=业务源码、records=Formal Records、tmp/build/cache=按 Run 隔离资源）\'',
    '  if (RECORDS) s += \'\\n- records 路径：\' + RECORDS + \'（Formal Records 证据记录目录，业务证据写入此目录）\'',
    '  if (A.workspace_capability && !(opts && opts.hideCapability)) s += \'\\n- workspace RPC 能力令牌（调用 vwf.workspace.* / vwf_workspace 时必须原样携带）：\' + A.workspace_capability + \'（仅限本 Run 使用，禁止用于其他 Run 的 taskId）\'',
    '  if (A.guidance_text) s += \'\\n【用户指导（用户暂停期间补充的执行指导，必须遵循）】\\n\' + A.guidance_text + \'\\n\'',
    '  s += \'\\n- 当前节点：\' + (n.label || nodeId) + \'\\n- 完成本节点后更新 \' + RUNDIR + \'/STATE.md（stage / round / status / updated，时间用 date -u +%FT%TZ）\\n\'',
    '  if (n.output && n.output.files) {',
    '    const _hints = Object.entries(n.output.files).map(([p,k]) => p + \'(\' + k + \')\' + ({ html: \'（完整 HTML 文档）\', canvas: \'（JSON 画布结构）\', flowchart: \'（JSON 流程图）\', diagram: \'（JSON 结构图）\' }[k] || \'\'))',
    '    s += \'【本节点应产出 Formal Artifact】\' + JSON.stringify(n.output.files) + \'\\n\' + (_hints.length ? \'格式提示：\' + _hints.join(\'、\') + \'\\n\' : \'\')',
    '  }',
    '  if (n.output && n.output.schema && typeof n.output.schema === \'object\') {',
    '    const _props = n.output.schema.properties || {}',
    '    const _keys = Object.keys(_props)',
    '    const _req = Array.isArray(n.output.schema.required) && n.output.schema.required.length ? \'，必填：\' + n.output.schema.required.join(\', \') : \'\'',
    '    if (_keys.length) s += \'【本节点最终回复 JSON schema】允许字段仅：\' + _keys.join(\', \') + _req + \'（禁止多余字段）\\n\'',
    '  }',
    '  s += (extra ? \'\\n\' + extra + \'\\n\' : \'\') + \'\\n## 最终回复要求\\n完成后，最终回复必须提交一个符合本节点 output.schema 的结构化结果（若运行环境提供结构化输出工具/通道，如 structured_output，请调用它提交；若环境只认文本最终回复，则最终文本只含该 JSON，不要 markdown 围栏或前后缀文字）。不要把报告全文当最终回复。\\n\'',
    '  return s',
    '}',
    'function verifyBranchStep(id) {',
    '  const branch = WORK_BRANCH || WORK',
    '  let s = \'开工前置（强制）：确认 worktree 分支 = \' + branch + \'（git -C \' + (SOURCE || RUNDIR + \'/worktree\') + \' rev-parse --abbrev-ref HEAD）且 HEAD 一致；验证结论必须记录 verified_branch 与 verified_head。\'',
    '  if (A.workspace_capability) s += \'候选绑定（LOC-026 强制）：在正式开始审阅/测试任何成果之前，先调用 vwf_workspace 工具（op=captureCandidate，logical_run_id=\' + TASK + \'，capability 使用运行上下文注入的 workspace_capability 令牌）获取宿主生成的候选证明，把返回的 version.content_sha256 原样写入最终回复的 candidate_sha256 字段；结束后可再次调用确认候选未变化。候选摘要由宿主实况计算，禁止自行编造或用 git rev-parse 冒充；本节点期间不得修改业务源码文件，否则候选证明失效。\'',
    '  return s',
    '}',
    'function coerceStructured(v, schema) {',
    '  const root = schema && schema.type',
    '  if (root !== \'object\' && root !== \'array\') return v',
    '  if (typeof v === \'string\') {',
    '    const trimmed = v.trim()',
    '    const candidates = [trimmed]',
    '    const noFence = trimmed.replace(/^```(?:json)?\\s*/i, \'\').replace(/\\s*```$/, \'\').trim()',
    '    if (noFence !== trimmed) candidates.push(noFence)',
    '    const start = noFence.indexOf(root === \'array\' ? \'[\' : \'{\')',
    '    if (start > 0) candidates.push(noFence.slice(start))',
    '    for (const c of candidates) {',
    '      try {',
    '        const p = JSON.parse(c)',
    '        if (root === \'array\' && Array.isArray(p)) return p',
    '        if (root === \'object\' && p && typeof p === \'object\' && !Array.isArray(p)) return p',
    '      } catch (e) {}',
    '    }',
    '  }',
    '  return v',
    '}',
    'async function callNode(id, round, feedback) {',
    '  const n = BYID[id]',
    '  const model = MODELS[id] || {}',
    '  const opts = { label: (n.label || id) + (round > 0 ? \' R\' + round : \'\') }',
    '  if (model.provider) opts.provider = model.provider',
    '  if (model.model) opts.model = model.model',
    '  if (n.output && n.output.schema) opts.schema = n.output.schema',
    '  // #93 工作区 cwd 由引擎 run 级 startReq.cwd 承载，不再逐节点传 opts.cwd——',
    '  // 引擎 agent() 选项白名单（label/phase/schema/provider/model）遇 cwd 即拒。',
    '  const fb = feedback ? \'【上轮打回反馈——必须逐条修复】\\n\' + feedback + \'\\n\\n\' : \'\'',
    // LOC-024：解析节点声明输入（调用方已在代理调用前拦截缺必需引用；此处二次解析用于注入）
    '  const ir = resolveNodeInputs(id)',
    '  if (ir.errors.length) throw Object.assign(new Error(\'节点 \' + id + \' 输入解析失败（应在调用代理前被拦截）：\' + ir.errors.map(function (e) { return e.binding + \'：\' + e.reason }).join(\'；\')), { inputResolutionErrors: ir.errors })',
    '  const inputExtra = inputsBlock(ir.items)',
    '  const prompt = roleRef(n.profile) + runtimeCtx(id, fb + inputExtra + (n.verifyBranch ? verifyBranchStep(id) : \'\'))',
    '  phase(n.label || id)',
    '  return coerceStructured(await agent(prompt, opts), n.output && n.output.schema)',
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
    '    const configured = HD_CFG.maxRoundsReachedOptions',
    '    const names = (configured === undefined || configured === null)',
    '      ? HD_CONTROL.slice()',
    '      : (Array.isArray(configured) ? configured.filter(function (id) { return typeof id === \'string\' && id.trim() }) : [])',
    '    names.forEach(function (id) { pkg.options.push({ id: id }); pkg.subsequent_effects[id] = effects[id] || (\'选择 \' + id) })',
    '  } else {',
    '    EDGES.filter(function (e) {',
    '      if (!e || e.from !== HD_ID) return false',
    '      if (e.on === \'success\' && e.result) return true',
    '      return e.outcome !== undefined && e.outcome !== null && e.outcome !== \'\'',
    '    }).forEach(function (e) {',
    '      const id = e.result || String(e.outcome)',
    '      if (!id || pkg.subsequent_effects[id]) return',
    '      pkg.options.push({ id: id })',
    '      pkg.subsequent_effects[id] = e.subsequent_effect || (\'选择 \' + id + \' 后沿蓝图出边继续\')',
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
    '    if (k === \'options\') {',
    '      if (!Array.isArray(v) || v.length === 0) miss.push(k)',
    '      else if (!v.every(function (o) { return o && typeof o === \'object\' && typeof o.id === \'string\' && o.id.trim() })) miss.push(k)',
    '    } else if (k === \'subsequent_effects\') {',
    '      if (!v || typeof v !== \'object\' || Array.isArray(v) || !Object.keys(v).length) miss.push(k)',
    '      else if (!Object.keys(v).every(function (id) { return typeof v[id] === \'string\' && String(v[id]).trim() })) miss.push(k)',
    '    } else if (typeof v !== \'string\' || !v.trim()) miss.push(k)',
    '  })',
    '  if (miss.indexOf(\'options\') < 0 && miss.indexOf(\'subsequent_effects\') < 0 && pkg.options && pkg.subsequent_effects) {',
    '    const effects = pkg.subsequent_effects',
    '    if (pkg.options.some(function (o) { return typeof effects[o.id] !== \'string\' || !String(effects[o.id]).trim() })) miss.push(\'subsequent_effects\')',
    '  }',
    '  return miss',
    '}',
    'function haltWaitingHuman(nodeId, outcome, reason, blockedEdge, overridePkg, reuseId) {',
    '  const pkg = assembleDecisionPackage(nodeId, outcome, reason, overridePkg)',
    '  if (reason === \'MAX_ROUNDS_REACHED\' && (!pkg || !Array.isArray(pkg.options) || pkg.options.length === 0)) {',
    '    return { status: \'ERROR\', detail: \'运行时禁止把默认控制选项删光\' }',
    '  }',
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
    '    result: outcome == null ? null : outcome, results: results, history: history, round: round,',
    '    budgetUsed: budgetUsed, maxRounds: maxRounds,',
    '    resume: { entry: nodeId, decision_id: decisionId, startRound: round, history: history, feedback: feedback, results: results, blocked_edge: blockedEdge || null, budgetUsed: budgetUsed, maxRounds: maxRounds, decisionSeq: decisionSeq }',
    '  }',
    '}',
    'function translateRouteHalted(halt, outcome, overridePkg, blockedEdge) {',
    '  const nodeId = halt && halt.node',
    '  if (!nodeDeclaresHd(nodeId)) return { status: \'ERROR\', detail: \'无蓝图声明不得升级 Human Decision\' }',
    '  return haltWaitingHuman(nodeId, outcome, mapHaltReason(halt && halt.reason), blockedEdge || null, overridePkg)',
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
    '  // LOC-026：候选证明绑定——宿主注入 workspace capability 的新运行，审核/测试结论',
    '  // 必须携带经 vwf_workspace op=captureCandidate 取得的候选摘要（模型自报仅作诊断，',
    '  // 权威候选由宿主在 Proof 签发与集成闸门比较）；无 workspace 的旧形态保持原规则。',
    '  const cand = res && res.candidate_sha256',
    '  const candOk = !A.workspace_capability || (typeof cand === \'string\' && cand.trim().length > 0)',
    '  if (res && res.verified_branch === expectedBranch && headOk && candOk) return null',
    '  let detail = stage + \' 结论校验失败：verified_branch=\' + JSON.stringify(res && res.verified_branch) + \'（应为 \' + expectedBranch + \'），verified_head=\' + JSON.stringify(head)',
    '  if (A.workspace_capability && !candOk) detail += \'，candidate_sha256=\' + JSON.stringify(cand === undefined ? null : cand) + \'（须先经 vwf_workspace op=captureCandidate 获取宿主候选证明，禁止自报）\'',
    '  return detail',
    '}',
    // 裁决一致性（LOC-025 / WR-002）：节点在 output.consistency 声明配对表时，结构合法
    // （schema 已通过）之后、路由选择之前做同一确定性检查——表外 route/verdict、route/result
    // 组合是契约错误，不作为专业通过判断；错误携带字段与允许组合（CONTRACT_INCONSISTENT，
    // 供错误分类消费）。仅当蓝图声明 consistency 才注入检查——未声明蓝图的产物与改动前
    // 逐字节一致（旧蓝图/旧快照零迁移，只迁移新生成建设脚本）。
    ...(hasConsistencyDecl ? [
      'function contractCheck(id, res) {',
      '  const n = BYID[id]',
      '  const c = n && n.output && n.output.consistency',
      '  if (!c || typeof c !== \'object\' || !c.field || !c.pairs || typeof res !== \'object\' || res === null) return null',
      '  const raw = String(n.output.outcomePath).indexOf(\'$.\') === 0 ? String(n.output.outcomePath).slice(2) : String(n.output.outcomePath)',
      '  const key = String(readPath(res, raw))',
      '  if (!Object.prototype.hasOwnProperty.call(c.pairs, key)) return null',
      '  const expected = c.pairs[key]',
      '  const actual = readPath(res, c.field)',
      '  if (actual === expected) return null',
      '  const combos = Object.keys(c.pairs).map(function (k) { return k + \'/\' + c.pairs[k] }).join(\'、\')',
      '  const detail = \'CONTRACT_INCONSISTENT：节点 \' + (n.label || id) + \' 的 route=\' + key + \' 与 \' + c.field + \'=\' + String(actual) + \' 互相矛盾，属契约错误，不作为专业通过判断（允许的组合 route/\' + c.field + \'：\' + combos + \'）\'',
      '  return { node: id, field: c.field, route_path: n.output.outcomePath, route: readPath(res, raw) === undefined ? null : readPath(res, raw), actual: actual === undefined ? null : actual, expected: expected, allowed_combos: c.pairs, detail: detail }',
      '}',
    ] : []),
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
    // LOC-024：节点执行台账（seq + 最新结果）与 resolved_inputs 清单（含逐节点输入模式标注）
    'let EXEC_SEQ = 0',
    'const EXEC_OF = {}',
    'const RESOLVED_INPUTS = {}',
    'function markExec(id, res) { EXEC_SEQ += 1; EXEC_OF[id] = { seq: EXEC_SEQ, node: id, result: res } }',
    'const INPUT_MODE = (function () {',
    '  const ids = Object.keys(BYID).filter(function (k) { return BYID[k].kind !== \'fanout\' })',
    '  if (!ids.length) return \'legacy\'',
    '  const declared = ids.filter(function (k) { return inputModeOf(k) === \'declared\' })',
    '  return declared.length === 0 ? \'legacy\' : (declared.length === ids.length ? \'declared\' : \'mixed\')',
    '})()',
    'if (A.results && typeof A.results === \'object\') Object.keys(A.results).forEach(function (k) { results[k] = A.results[k]; markExec(k, A.results[k]) })',
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
    '    const edge = EDGES.filter(function (e) {',
    '      if (!e || e.from !== HD_ID) return false',
    '      const id = e.result || (e.outcome !== undefined && e.outcome !== null && e.outcome !== \'\' ? String(e.outcome) : null)',
    '      return id === choice',
    '    })[0]',
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
    '    markExec(current, results[current])',
    '    const e = route(current, results[current], true)',
    '    if (!e) return { status: \'ERROR\', detail: \'折叠节点无出边：\' + current }',
    '    current = e.to',
    '    pwCk(current)',
    '    continue',
    '  }',
    '  if (n.manualCheck) {',
    '    if (A.approved !== true) {',
    '      const irGate = resolveNodeInputs(current)',
    '      if (irGate.errors.length) return { status: \'ERROR\', reason: \'INPUT_RESOLUTION_FAILED\', stage: current, node: current, round: round, errors: irGate.errors, detail: \'节点输入解析失败：\' + irGate.errors.map(function (e) { return e.binding + \'：\' + e.reason }).join(\'；\'), results: results, history: history, resolved_inputs: RESOLVED_INPUTS, input_mode: INPUT_MODE }',
    '      RESOLVED_INPUTS[current] = { mode: irGate.mode, items: irGate.items }',
    '      if (agentsUsed + 1 > AGENT_CAP) return { status: \'FAILED_AGENT_CAP\', stage: current, used: agentsUsed, requested: 1, limit: AGENT_CAP, results: results, history: history }',
    '      agentsUsed++',
    '      let gateRes = await callNode(current, round, feedback)',
    '      if (gateRes === null && agentsUsed + 1 <= AGENT_CAP) {',
    '        agentsUsed++',
    '        log((n.label || current) + \' 门禁首次结果无效 → 节点内重试一次\')',
    '        const gateFb = (feedback ? feedback + \'\\n\' : \'\') + \'【格式要求】上一轮未返回可解析的结构化结果（运行环境只认 structured_output 等结构化通道的提交，或纯文本最终回复必须是严格符合本节点 output.schema 的裸 JSON——不认 markdown 围栏/前后缀/报告全文）。请重试：报告与产物写文件，最终回复按本节点 schema 用可解析 JSON 收尾。\'',
    '        gateRes = await callNode(current, round, gateFb)',
    '      }',
    '      if (gateRes === null) {',
    '        const gateLabel = BYID[current].label || current',
    '        history.push({ round: round, stage: current, verdict: \'AGENT_FAILED\', reason: \'门禁节点 agent 未返回有效结果（不得以空结果挂起人工门禁）\' })',
    '        return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: gateLabel + \' 门禁结果无效，未挂起\', results: results, history: history }',
    '      }',
    '      results[current] = gateRes',
    '      markExec(current, gateRes)',
    '      return { status: \'AWAITING_HUMAN_\' + current, taskId: TASK, node: current, round: round, result: gateRes, history: history, resume: { entry: current, approved: true, startRound: round, history: history, feedback: feedback } }',
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
    '      // 工作区 cwd 同 callNode：由引擎 run 级 startReq.cwd 承载，不再逐节点传',
    '      const renderedGoal = (n.goal || \'\').split(\'{{item}}\').join(itemText(entry.item))',
    '      let itemExtra = feedback ? \'【上轮打回反馈——必须逐条修复】\\n\' + feedback : \'\'',
    // LOC-013：fanout 子代理独立 scratch 接线——有 workspace 现场时为每个 item 注入
    // 专属 scratch 路径与兄弟隔离禁令（#93 §5/§6.4 探索语义）；无现场时行为不变。
    '      if (WS) {',
    '        const __wid = current + \'-\' + (entry.index + 1)',
    '        itemExtra += \'\\n【并行子任务工作区（编排注入，必须遵守）】\\n- 你的专属 scratch 目录（工作笔记与中间产出只能写这里）：\' + WS + \'/workers/\' + __wid + \'/\\n- 禁止读取或写入其他并行子任务的 scratch 目录（workers/ 下其他子目录），也不得参考其他子任务的结论\\n- 正式交付物写入 run 产物目录：\' + RUNDIR + \'/\' + (SOURCE && WS_MODE === \'ISOLATED_READ\' ? \'\\n- 共享 source 为只读现场，禁止写入：\' + SOURCE : \'\') + \'\\n\'',
    '      }',
    // LOC-013 R2 修复：worker 提示不下发 Run 级 capability——fanout worker 无需调用
    // workspace RPC（文件直写专属 scratch / run 目录）；无凭据则任何 RPC 调用被宿主拒绝，
    // 从 RPC 面杜绝「持 Run 令牌冒用可预测 worker_id 读兄弟 scratch」（规格 E2 严格口径）。
    '      const prompt = roleRef(n.profile) + runtimeCtx(current, itemExtra, renderedGoal, { hideCapability: true })',
    '      return coerceStructured(await agent(prompt, itemOpts), n.output && n.output.schema)',
    '    })',
    '    const failedCount = itemResults.filter(function (item) { return item === null }).length',
    '    res = { total: source.length, okCount: source.length - failedCount, failedCount: failedCount, items: itemResults }',
    '    ok = !fanoutFailed(n.failOn, res.total, res.failedCount)',
    '  } else {',
    '    const irMain = resolveNodeInputs(current)',
    '    if (irMain.errors.length) return { status: \'ERROR\', reason: \'INPUT_RESOLUTION_FAILED\', stage: current, node: current, round: round, errors: irMain.errors, detail: \'节点输入解析失败：\' + irMain.errors.map(function (e) { return e.binding + \'：\' + e.reason }).join(\'；\'), results: results, history: history, resolved_inputs: RESOLVED_INPUTS, input_mode: INPUT_MODE }',
    '    RESOLVED_INPUTS[current] = { mode: irMain.mode, items: irMain.items }',
    '    if (agentsUsed + 1 > AGENT_CAP) return { status: \'FAILED_AGENT_CAP\', stage: current, used: agentsUsed, requested: 1, limit: AGENT_CAP, results: results, history: history }',
    '    agentsUsed++',
    '    res = await callNode(current, round, feedback)',
    '    if (res === null && agentsUsed + 1 <= AGENT_CAP) {',
    '      agentsUsed++',
    '      log((n.label || current) + \' 首次最终回复未通过格式校验 → 节点内重试一次\')',
    '      const formatFb = (feedback ? feedback + \'\\n\' : \'\') + \'【格式要求】上一轮未返回可解析的结构化结果（运行环境只认 structured_output 等结构化通道的提交，或纯文本最终回复必须是严格符合本节点 output.schema 的裸 JSON——不认 markdown 围栏/前后缀/报告全文）。请重试：报告与产物写文件，最终回复按本节点 schema 用可解析 JSON 收尾。\'',
    '      res = await callNode(current, round, formatFb)',
    '    }',
    '    if (res === null) {',
    '      const failId = current',
    '      const failLabel = BYID[failId].label || failId',
    '      history.push({ round: round, stage: failId, verdict: \'AGENT_FAILED\', reason: \'节点 agent 未返回有效结果\' })',
    '      if (hasOutcomePath(n)) {',
    '        const et = routeTechnical(failId)',
    '        if (!et || et.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: failId, round: round, results: results, history: history }',
    '        history.push({ round: round, stage: failId, from: failId, to: et.to, on: \'technical\', countRound: false })',
    '        current = et.to',
    '        feedback = \'【\' + failLabel + \' agent 技术失败】请重试并自查（上一轮最终回复未通过格式校验，请只输出符合本节点 output.schema 的裸 JSON）。\'',
    '        pwCk(current)',
    '        continue',
    '      }',
    '      const ef = route(failId, null, false)',
    '      if (!ef || ef.to === \'$end\') return { status: \'TECHNICAL_FAILURE\', stage: failId, round: round, results: results, history: history }',
    '      current = ef.to; round++; feedback = \'【\' + failLabel + \' agent 技术失败】请重试并自查（上一轮最终回复未通过格式校验，请只输出符合本节点 output.schema 的裸 JSON）。\'; pwCk(current); continue',
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
    '        pwCk(current)',
    '        continue',
    '      }',
    '      return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, detail: ce, results: results, history: history }',
    '    }',
    '  }',
    // 裁决一致性（LOC-025）：路由选择与 UAT 组装之前的同一确定性检查；矛盾结果不写入
    // results（不把矛盾结果存成有效通过证明），直接以结构化 CONTRACT_INCONSISTENT 终止。
    ...(hasConsistencyDecl ? [
      '  if (hasOutcomePath(n)) {',
      '    const cc = contractCheck(current, res)',
      '    if (cc) {',
      '      history.push({ round: round, stage: current, verdict: \'CONTRACT_INCONSISTENT\', reason: cc.detail })',
      '      return { status: \'TECHNICAL_FAILURE\', stage: current, round: round, reason: \'CONTRACT_INCONSISTENT\', detail: cc.detail, contract: cc, results: results, history: history }',
      '    }',
      '  }',
    ] : []),
    '  results[current] = res',
    '  markExec(current, res)',
    '  log((n.label || current) + \' → \' + (ok ? \'通过\' : \'未通过\'))',
    '  if (A.injectHalt && A.injectHalt.node === current) {',
    '    if (!nodeDeclaresHd(current)) return { status: \'ERROR\', detail: \'无蓝图声明不得升级 Human Decision\' }',
    '    if (A.injectHalt.status === \'ROUTE_HALTED\') {',
    '      return translateRouteHalted({ status: \'ROUTE_HALTED\', reason: A.injectHalt.reason || \'HUMAN_DECISION\', node: current }, res, A.injectHalt.decision_package, A.injectHalt.blocked_edge || null)',
    '    }',
    '    return haltWaitingHuman(current, res, mapHaltReason(A.injectHalt.reason), A.injectHalt.blocked_edge || null, A.injectHalt.decision_package)',
    '  }',
    '  if (hasOutcomePath(n)) {',
    '    const e = routeOutcome(current, res)',
    '    if (!e) return { status: \'ENDED_NO_OUTCOME_EDGE\', stage: current, results: results, history: history, budgetUsed: budgetUsed, maxRounds: maxRounds }',
    '    log((n.label || current) + \' → \' + String(e.outcome))',
    '    const halted = consumeOrHalt(current, res, e)',
    '    if (halted) return halted',
    '    if (e.to === HD_ID) {',
    '      return translateRouteHalted({ status: \'ROUTE_HALTED\', reason: \'HUMAN_DECISION\', node: current }, res)',
    '    }',
    '    current = e.to',
    '    pwCk(current)',
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
    '  pwCk(current)',
    '}',
    'const done = { status: \'DONE\', taskId: TASK, round: round, results: results, history: history, completion: completionOf(lastNode), budgetUsed: budgetUsed, maxRounds: maxRounds, input_mode: INPUT_MODE, resolved_inputs: RESOLVED_INPUTS }',
    'if (choiceEvent) { done.decision_id = A.decision_id; done.user_choice = A.user_choice; done.control_event = choiceEvent }',
    'return done',
  );
  return { script: lines.join('\n'), folds };
}

// ---------- skill 包装（契约 FR-2/FR-6；runbook 覆盖全部返回状态，T-IMP-09） ----------
/** 正式内置在 templates/<id>.json；历史迁出的自定义种子在 templates/custom-seeds/。 */
export function blueprintSourceRel(bpId) {
  if (bpId === 'default-workflow' || bpId === 'dev-workflow-2-0') {
    return 'templates/custom-seeds/' + bpId + '.json';
  }
  return 'templates/' + bpId + '.json';
}

export function skillWrap(bp) {
  const src = blueprintSourceRel(bp.id);
  return [
    '---',
    'name: ' + bp.id,
    'description: "' + (bp.displayName + '：' + (bp.description || '') + '。当用户说『' + bp.displayName + '』『' + bp.id + '』或用自然语言要求以该工作流完成需求时使用。').replace(/"/g, '\\"') + '"',
    '---',
    '',
    '# ' + bp.displayName + '（生成 skill）',
    '',
    '本 skill 由生成器从蓝图 `' + src + '` 编译产出（NFR-1：生成物不可手改，改蓝图重生成）。',
    '',
    '## runbook',
    '',
    '1. 装配 args（taskId / runDir / entry / issueBody 或 requirement / 续跑参数），见蓝图契约 `docs/design/blueprint-schema.md`；模型绑定已在编译时固化（bindings.models），运行时不传 models。optimize 类模板按需补 `resource_kind`（git / files / document / config / other）。',
    '2. 调用 `wf_run` 工具起跑：`templateId` = `' + bp.id + '`，`taskId` = 任务标识（如 issue-12），其余字段照 args。**首选此路径**——由插件自身发起，本次运行即同一 Logical Run（分段 / 任务归属 / 完成类型齐全，看板可续跑、暂停、指导）。',
    '   - 回退（仅当 `wf_run` 不可用、报错提示无法访问 workflowEngine 时）：改用内置 `workflow` 工具执行编译产物——`script` = `.generated/' + bp.id + '/script.mjs` 全文，`meta` = `.generated/' + bp.id + '/meta.json`；并**在会话输出中显式提示「本次运行记录将退化为单段、无完成类型，且不可从看板续跑」**，不得声称记录完整。',
    '3. 按返回状态机驱动：',
    '   - `AWAITING_HUMAN_<节点id>`：呈报告 + 人工确认卡；通过 → 以该门禁节点为 entry 且 approved=true 续跑（只走 success 出边）；非 true（含 false）→ 仍以同一门禁节点续跑，引擎再挂起，不走 failure。',
    '   - `WAITING_HUMAN`：呈 Decision Package（why / current_state / options / subsequent_effects）；按 `decision_id` + `user_choice` 续跑。控制类 Result：`STOP` 停止本 Run、`USER_ACCEPTED` 完成且不改写原 Outcome、`ADD_BUDGET` 显式 +1 额度并沿被拦边再走（须写入 Decision/Control Record，不得隐式恢复）。`reason=MAX_ROUNDS_REACHED` 表示自动回退额度耗尽，原 Node Business Outcome 必须原样保留。业务 Result 沿该蓝图 `$human-decision` 出边继续；无对应出边则拒绝该选择并保持等待。',
    '   - `STOPPED`：本 Run 已停止，不派生新 Run。',
    '   - `FAILED_MAX_ROUNDS`：仅旧蓝图 failure 边打回超限（过渡兼容）；新模式额度耗尽走 `WAITING_HUMAN` + `MAX_ROUNDS_REACHED`。',
    '   - `FAILED_ITEM_CAP`：fanout 项数超过单次上限 4096，缩小 items 或拆分批次后续跑；该终态在任何子代理启动前返回。',
    '   - `FAILED_AGENT_CAP`：本次运行累计子代理将超过上限 1000，缩小 fanout 或拆分工作流后续跑；该终态在本批子代理启动前返回。',
    '   - `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` / `ENDED_NO_OUTCOME_EDGE` / `TECHNICAL_FAILURE`：呈原因（图缺陷/技术失败），人工介入后按需续跑。',
    '   - `ERROR`（`reason=INPUT_RESOLUTION_FAILED`）：节点输入声明解析失败（errors 逐项含 node / binding / reason），未调用该节点代理、已有节点结果原样保留；修正蓝图 inputs 声明或补齐上游产出后再续跑。',
    '   - `ROUTE_HALTED`：#77 引擎停机信号（reason=HUMAN_DECISION）。命中 `$human-decision` 时本脚本翻译为 `WAITING_HUMAN` 并装配 Decision Package，不把 `ROUTE_HALTED` 作为对外终态返回。',
    '   - 旧 `REJECTED_INCOMPLETE` / `BLOCKED`：已由 `FAILED_AT_<节点id>` 承接（run 级无 BLOCKED；受阻语义 = 节点结果，如 dev status=blocked → FAILED_AT_dev）。',
    '   - `DONE`：呈 cleanup 报告与合并 commit，流程结束。',
    '',
    '## 生成信息',
    '',
    '- 蓝图：`' + src + '`',
    '- 节点：' + bp.nodes.length + ' · 边：' + bp.edges.length + ' · 最大轮次：' + ((bp.control && bp.control.maxRounds) || 9),
    '',
  ].join('\n');
}

// ---------- meta 组装（三处共用：generateAll / generateUserSkill / CLI compile） ----------
export function buildMeta(bp) {
  return { name: 'vwf-' + bp.id, description: bp.displayName, phases: bp.nodes.map((n) => ({ title: n.label || n.id })) };
}

/** 正式内置：templates/*.json；历史自定义种子：templates/custom-seeds/*.json（#82）。 */
export function listBlueprintJsonFiles(templatesDir) {
  const out = [];
  if (!fs.existsSync(templatesDir)) return out;
  for (const f of fs.readdirSync(templatesDir).filter((x) => x.endsWith('.json')).sort()) {
    out.push(path.join(templatesDir, f));
  }
  const seeds = path.join(templatesDir, 'custom-seeds');
  if (fs.existsSync(seeds)) {
    for (const f of fs.readdirSync(seeds).filter((x) => x.endsWith('.json')).sort()) {
      out.push(path.join(seeds, f));
    }
  }
  return out;
}

// ---------- 生成（纯函数） ----------
export function generateAll(templatesDir) {
  const files = new Map();
  const report = [];
  const tpls = listBlueprintJsonFiles(templatesDir);
  for (const abs of tpls) {
    const f = path.basename(abs);
    let bp;
    try {
      bp = JSON.parse(fs.readFileSync(abs, 'utf8'));
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
// 注意命名误导（保留导出名以兼容既有调用与测试）：本函数打包的是「蓝图引用且角色
// 文件存在」的全部角色，**包含自定义角色**（如已迁出内置的 dispatcher）——绝不能误
// 改为仅过滤内置，否则用户 skill 的历史自定义角色自包含行为会回归。语义实现已收敛进
// role-library.cjs 的 collectReferencedRoleFiles（单一实现）。
export function collectBuiltinRoles(bp, rolesDir = DEFAULT_ROLES_DIR, io = fs) {
  return collectReferencedRoleFiles(bp, rolesDir, io)
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

// ---------- 生成物比对与孤儿清理（LOC-006：单一权威，generate CLI 与 validate 步骤② 共用） ----------

function readGeneratedDir(outDir) {
  if (!fs.existsSync(outDir)) return null;
  return new Map(
    fs.readdirSync(outDir, { recursive: true })
      .filter((f) => fs.statSync(path.join(outDir, f)).isFile())
      .map((f) => [f, fs.readFileSync(path.join(outDir, f), 'utf8')])
  );
}

/**
 * 三态 diff：missing = map 有磁盘无（将新增）；extra = 磁盘有 map 无（孤儿，由 prune 收敛）；
 * changed = 两侧都有但内容不同（生成物过期或手改）。
 */
export function compareGeneratedFiles(files, outDir) {
  const disk = readGeneratedDir(outDir);
  if (!disk) return { missing: [...files.keys()], extra: [], changed: [] };
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [k, v] of files) {
    if (!disk.has(k)) missing.push(k);
    else if (disk.get(k) !== v) changed.push(k);
  }
  for (const k of disk.keys()) if (!files.has(k)) extra.push(k);
  return { missing, extra, changed };
}

/**
 * 清理孤儿产物目录：outDir 下目录名不在当前 files map 顶层 id 集内的整目录移除
 * （.generated 本为生成物目录，仓库规则禁手改）。返回被移除的目录名。
 */
export function pruneGenerated(files, outDir) {
  const removed = [];
  if (!fs.existsSync(outDir)) return removed;
  const liveIds = new Set([...files.keys()].map((f) => f.split('/')[0]));
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || liveIds.has(entry.name)) continue;
    fs.rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
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

  // 子命令 compile：
  //   node scripts/generate.mjs compile <蓝图json路径>
  //   node scripts/generate.mjs compile --inline '<蓝图json>'
  //   —— 统一编译器管道兜底（候选一 T-IMP-12）：宿主 vwf 侧临时图/编辑器实时查看
  //   经 CLI 取译文。宿主先做 DSL 校验（validateDsl），此处不重复校验（保持行为对齐）。
  //   stdout 输出 JSON：{ ok:true, script, meta } 或 { ok:false, error }。
  if (process.argv[2] === 'compile') {
    const inline = process.argv[3] === '--inline';
    const src = inline ? process.argv[4] : process.argv[3];
    if (!src) {
      console.error('用法：node scripts/generate.mjs compile <蓝图json路径> | compile --inline \'<蓝图json>\'');
      process.exit(1);
    }
    let bp;
    try {
      bp = JSON.parse(inline ? src : fs.readFileSync(path.resolve(src), 'utf8'));
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
  const hadDisk = fs.existsSync(outDir);
  const { files, report } = generateAll(tplDir);
  const diff = compareGeneratedFiles(files, outDir);
  writeAll(files, outDir);
  const pruned = pruneGenerated(files, outDir);
  // 幂等报告（LOC-006：比对单一权威；孤儿产物已由 prune 就地收敛）
  const idemReason = diff.missing.length ? '新增文件：' + diff.missing[0]
    : diff.extra.length ? '缺失文件：' + diff.extra[0] + '（孤儿产物已清理）'
    : diff.changed.length ? '内容不一致：' + diff.changed[0] + '（生成物过期或手改，已重建）'
    : null;
  for (const r of report) {
    if (r.ok) console.log('✅ ' + r.id + '：' + r.nodes + ' 节点 / ' + r.edges + ' 边' + (r.folds.length ? ' / 折叠：' + r.folds.join(',') : ''));
    else { console.log('❌ ' + r.id + '：' + r.errors.map((e) => e.at + ' ' + e.message).join('；')); }
  }
  if (pruned.length) console.log('🧹 清理孤儿产物目录：' + pruned.join('、'));
  if (hadDisk) console.log(idemReason ? '⚠️ ' + idemReason : '✅ 幂等：生成物与上次一致');
  if (report.some((r) => !r.ok)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
