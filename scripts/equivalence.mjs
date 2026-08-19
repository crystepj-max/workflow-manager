// 等价断言（T-IMP-05，T-05 决策：10 项静态断言，验证生成脚本忠实表达蓝图）
// 纯函数：assertEquivalence(script, bp) → { ok, failures: string[] }
// 语义：旧 mjs 已退役（T-05 Q3），等价 = 产物 vs 蓝图的语义忠实（语义等价 + 新契约统一）。

const COND_RE = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/;

// 从脚本提取内嵌常量（NODES/EDGES/FOLDS/MODELS 为 JSON 常量，用括号配对避免被内嵌数组截断）
function extractConst(script, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*([\\[\\{])').exec(script);
  if (!m) return null;
  const open = m[1];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < script.length; i++) {
    const c = script[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < script.length && script[i] !== q) {
        if (script[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  try { return JSON.parse(script.slice(m.index + m[0].length - 1, i + 1)); } catch { return undefined; }
}

export function assertEquivalence(script, bp) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const nodes = extractConst(script, 'NODES');
  const edges = extractConst(script, 'EDGES');
  const folds = extractConst(script, 'FOLDS');
  const models = extractConst(script, 'MODELS');
  const maxRounds = /const MAX_ROUNDS = (\d+)/.exec(script);

  // ① 入口与续跑：默认 entry = 蓝图 entry；运行时可 A.entry 覆盖；manualCheck resume 载荷
  if (!new RegExp("A\\.entry \\|\\| '" + bp.entry + "'").test(script)) fail('入口：默认 entry 应为 ' + bp.entry + '（可 A.entry 覆盖）');
  if (!script.includes('AWAITING_HUMAN_')) fail('入口：缺 AWAITING_HUMAN_ 挂起语义');
  if (!script.includes('resume:')) fail('入口：缺 resume 续跑载荷');

  // ② 拓扑：节点/边数量与 $end
  if (!nodes || nodes.length !== bp.nodes.length) fail('拓扑：NODES 数量 ' + (nodes ? nodes.length : '缺失') + ' ≠ 蓝图 ' + bp.nodes.length);
  if (!edges || edges.length !== bp.edges.length) fail('拓扑：EDGES 数量 ' + (edges ? edges.length : '缺失') + ' ≠ 蓝图 ' + bp.edges.length);
  if (!edges || !edges.some((e) => e.to === '$end')) fail('拓扑：缺 $end 边');
  if (nodes && nodes.map((n) => n.id).sort().join(',') !== bp.nodes.map((n) => n.id).sort().join(',')) fail('拓扑：节点 id 集合不一致');

  // ③ 折叠：FOLDS 与蓝图 route 节点推导一致（两路 when 同路径 true/false）
  if (bp.nodes.some((n) => {
    const out = bp.edges.filter((e) => e.from === n.id && e.on === 'success');
    return out.length === 2 && out.every((e) => e.when);
  })) {
    if (!folds || Object.keys(folds).length === 0) fail('折叠：蓝图存在可折叠路由节点，但脚本 FOLDS 为空');
  }
  if (folds) {
    for (const [id, f] of Object.entries(folds)) {
      const out = bp.edges.filter((e) => e.from === id && e.on === 'success');
      const m1 = out[0] && COND_RE.exec(out[0].when || '');
      const m2 = out[1] && COND_RE.exec(out[1].when || '');
      if (m1 && m2 && m1[1] === m2[1]) {
        if (f.path !== m1[1]) fail('折叠[' + id + ']：路径 ' + f.path + ' ≠ 蓝图 ' + m1[1]);
      }
    }
  }

  // ④ 人工门禁：manualCheck 节点在脚本中挂起
  for (const n of bp.nodes.filter((x) => x.manualCheck)) {
    if (!script.includes("AWAITING_HUMAN_' + current")) fail('门禁：manualCheck 节点 ' + n.id + ' 未编译为 AWAITING_HUMAN_ 挂起');
  }

  // ⑤ 轮次与超限归因：MAX_ROUNDS 与 failure 打回；auto-reschedule → 归因注入
  const wantRounds = (bp.control && bp.control.maxRounds) || 9;
  if (!maxRounds || Number(maxRounds[1]) !== wantRounds) fail('轮次：MAX_ROUNDS=' + (maxRounds && maxRounds[1]) + ' ≠ 蓝图 ' + wantRounds);
  if (!edges || !edges.some((e) => e.on === 'failure')) fail('轮次：缺 failure 打回边');
  if (!script.includes('FAILED_MAX_ROUNDS')) fail('轮次：缺 FAILED_MAX_ROUNDS 终止');
  if (bp.onMaxRounds === 'auto-reschedule' && !script.includes('超限归因')) fail('归因：onMaxRounds=auto-reschedule 但未注入超限归因 agent（label=超限归因）');

  // ⑥ 可信度闸门：verifyBranch 节点注入闸门
  const vbNodes = bp.nodes.filter((n) => n.verifyBranch);
  if (vbNodes.length && !script.includes('claimError')) fail('闸门：verifyBranch 节点存在但缺 claimError 硬校验');
  if (vbNodes.length && !script.includes('verifyBranchStep')) fail('闸门：verifyBranch 节点存在但缺开工分支自检');

  // ⑦ 异源：heteroCheck + dev/review 绑定 → 比对注入
  const bm = (bp.bindings && bp.bindings.models) || {};
  if (bp.heteroCheck && bm.dev && bm.review && !script.includes('modelTag')) fail('异源：heteroCheck 未注入 dev/review 比对');
  if (bp.heteroCheck && bm.dev && bm.review) {
    const dev = bm.dev.provider + '/' + bm.dev.model;
    const rev = bm.review.provider + '/' + bm.review.model;
    if (dev === rev && !script.includes('异源警告')) fail('异源：dev/review 同模型但缺警告注入');
  }

  // ⑧ 文件契约：output.files 注入运行时上下文
  const fileNodes = bp.nodes.filter((n) => n.output && n.output.files);
  if (fileNodes.length && !script.includes('【本节点应产出文件】')) fail('files：蓝图声明 output.files 但脚本未注入文件清单');
  for (const n of fileNodes) {
    for (const p of Object.keys(n.output.files)) {
      if (!script.includes(p)) fail('files：节点 ' + n.id + ' 的产出文件 ' + p + ' 未注入脚本');
    }
  }

  // ⑨ 角色注入：roleRef 函数存在 + NODES 每节点携带 profile（与蓝图一致；.md 路径为运行时拼接）
  if (!script.includes('【角色定义】开工前先用读文件工具读取')) fail('角色：缺 roleRef 注入');
  if (nodes) {
    const want = bp.nodes.map((n) => n.profile).sort().join(',');
    const got = nodes.map((n) => n.profile || '').sort().join(',');
    if (got !== want) fail('角色：NODES profile 集合 ' + got + ' ≠ 蓝图 ' + want);
  }

  // ⑩ 三要素 schema：dispatch 节点含 missing/reason
  const dispatch = nodes && nodes.find((n) => n.id === 'dispatch');
  if (dispatch && dispatch.output && dispatch.output.schema) {
    const props = dispatch.output.schema.properties || {};
    if (!('missing' in props) || !('reason' in props)) fail('三要素：dispatch schema 缺 missing/reason 字段');
  }

  return { ok: failures.length === 0, failures };
}
