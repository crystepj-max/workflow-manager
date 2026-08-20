// 蓝图校验器（T-IMP-03，规则全集见 docs/design/blueprint-schema.md §3）
// 纯函数：validateBlueprint(bp) → { ok, errors:[{at,message}], counts:{nodes,edges} }
// 来源：T-01 原型 .scratch/schema-prototype（19 项断言场景）提升。
// 异源硬规则（契约 §3.1 规则 7）由 T-IMP-07 接入。

const COND_RE = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/;
const RESERVED = ['$end', '$entry', '$new-round'];
const FILES_KINDS = ['json', 'markdown', 'text'];
const ON_MAX_ROUNDS = ['return', 'auto-reschedule'];

function pathInSchema(schema, segments) {
  let cursor = schema;
  for (const key of segments) {
    if (Array.isArray(cursor)) cursor = cursor[0];
    if (!cursor || typeof cursor !== 'object') return false;
    if (cursor.type === 'array' && cursor.items) cursor = cursor.items;
    const props = cursor.properties;
    if (!props || typeof props !== 'object' || !(key in props)) return false;
    cursor = props[key];
  }
  return true;
}

function deriveEntryCandidates(nodes, edges) {
  const ids = {};
  nodes.forEach((n) => { if (n && n.id) ids[n.id] = true; });
  const incoming = {};
  edges.forEach((e) => {
    if (!e || !ids[e.from] || !ids[e.to]) return;
    if (e.on === 'success' && e.to !== '$end') incoming[e.to] = true;
  });
  return nodes.map((n) => n && n.id).filter((id) => id && !incoming[id]);
}

function reachable(entry, nodes, edges) {
  const reach = {};
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop();
    if (reach[cur]) continue;
    reach[cur] = true;
    edges.forEach((e) => { if (e && e.from === cur && e.on === 'success' && e.to !== '$end' && !reach[e.to]) stack.push(e.to); });
  }
  return reach;
}

function hasSuccessCycle(entry, nodes, edges) {
  const color = {};
  let cyclic = false;
  const dfs = (u) => {
    color[u] = 1;
    edges.forEach((e) => {
      if (cyclic || e.from !== u || e.on !== 'success' || e.to === '$end') return;
      if (color[e.to] === 1) { cyclic = true; return; }
      if (color[e.to] === undefined) dfs(e.to);
    });
    color[u] = 2;
  };
  if (entry) dfs(entry);
  return cyclic;
}

export function validateBlueprint(bp) {
  const errors = [];
  const err = (at, message) => errors.push({ at, message });

  if (!bp || typeof bp !== 'object') return { ok: false, errors: [{ at: '$', message: '蓝图必须是对象' }] };
  if (typeof bp.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bp.id)) err('$.id', 'id 必填且为 kebab-case（小写英文+连字符），如 dev-workflow-2-0');
  if (typeof bp.displayName !== 'string' || !bp.displayName.trim()) err('$.displayName', 'displayName（中文展示名）必填非空 —— 生成 skill 的触发词之一（FR-6）');
  if (bp.name !== undefined && bp.name !== bp.id) err('$.name', 'name 与 id 必须一致（单标识方案，D1），或删除 name');
  if (bp.onMaxRounds !== undefined && !ON_MAX_ROUNDS.includes(bp.onMaxRounds)) err('$.onMaxRounds', 'onMaxRounds ∈ { return, auto-reschedule }');

  if (!Array.isArray(bp.nodes) || bp.nodes.length === 0) { err('$.nodes', 'nodes 至少一个节点'); return { ok: false, errors }; }
  const ids = {};
  const idCounts = {};
  const outgoing = {};
  bp.nodes.forEach((n) => {
    if (!n || typeof n !== 'object') { err('$.nodes', '节点必须是对象'); return; }
    if (typeof n.id !== 'string' || !n.id.trim()) { err('$.nodes', '节点 id 不能为空'); return; }
    if (RESERVED.includes(n.id)) err('$.nodes[' + n.id + ']', '节点 id 使用了系统保留 id ' + n.id);
    if (idCounts[n.id]) err('$.nodes[' + n.id + ']', '节点 id 重复');
    idCounts[n.id] = 1;
    ids[n.id] = true;
    if (typeof n.profile !== 'string' || !n.profile.trim()) err('$.nodes[' + n.id + '].profile', '节点未关联角色 profile（对应 dsh/roles/*.md）');
    if (typeof n.goal !== 'string' || !n.goal.trim()) err('$.nodes[' + n.id + '].goal', '节点缺 goal');
    if (n.output !== undefined && n.output !== null) {
      const o = n.output;
      if (!o.schema || typeof o.schema !== 'object') err('$.nodes[' + n.id + '].output.schema', 'output.schema 必填（对象）');
      if (o.successCondition !== undefined && o.successCondition !== null && o.successCondition !== '') {
        if (typeof o.successCondition !== 'string' || !COND_RE.test(o.successCondition)) {
          err('$.nodes[' + n.id + '].output.successCondition', 'successCondition 需为 $.path == value 形式');
        } else if (o.schema && typeof o.schema === 'object') {
          const segs = COND_RE.exec(o.successCondition)[1].split('.');
          if (!pathInSchema(o.schema, segs)) err('$.nodes[' + n.id + '].output.successCondition', '成功表达式路径未在 output.schema 中声明');
        }
      }
      if (o.files !== undefined) {
        if (!o.files || typeof o.files !== 'object' || Array.isArray(o.files)) {
          err('$.nodes[' + n.id + '].output.files', 'output.files 必须是对象 { "<相对路径>": "json|markdown|text" }');
        } else {
          Object.keys(o.files).forEach((p) => {
            const valid = typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.endsWith('/') && !p.includes('..') && p !== 'STATE.md';
            if (!valid) err('$.nodes[' + n.id + '].output.files.' + p, '文件路径须为合法相对路径（非空、不以 / 开头或结尾、不含 ..、不得为保留文件 STATE.md）');
            if (!FILES_KINDS.includes(o.files[p])) err('$.nodes[' + n.id + '].output.files.' + p, '文件类型须为 json | markdown | text，当前：' + o.files[p]);
          });
        }
      }
      if (n.verifyBranch) {
        const req = (o.schema && o.schema.required) || [];
        if (!req.includes('verified_branch') || !req.includes('verified_head'))
          err('$.nodes[' + n.id + '].verifyBranch', 'verifyBranch=true 时 output.schema 的 required 必须含 verified_branch 与 verified_head（DSH 可信度闸门）');
      }
    }
  });

  if (!Array.isArray(bp.edges)) { err('$.edges', 'edges 必填（数组）'); return { ok: false, errors }; }
  bp.edges.forEach((e, i) => {
    const at = '$.edges[' + i + ']';
    if (!e || typeof e !== 'object') { err(at, '边必须是对象'); return; }
    if (!e.from || !ids[e.from]) err(at + '.from', '边的来源节点 ' + e.from + ' 不存在');
    if (!e.to || (e.to !== '$end' && !ids[e.to])) err(at + '.to', '边的目标节点 ' + e.to + ' 不存在');
    if (e.on !== 'success' && e.on !== 'failure') { err(at + '.on', 'on ∈ { success, failure }'); return; }
    if (e.when !== undefined) {
      if (e.on !== 'success') err(at + '.when', 'when 只允许用于 success 边');
      else if (typeof e.when !== 'string' || !COND_RE.test(e.when)) err(at + '.when', 'when 需为 $.path == value 形式');
    }
    outgoing[e.from] = (outgoing[e.from] || 0) + 1;
  });

  if (!bp.edges.some((e) => e && e.to === '$end')) err('$.edges', '必须包含指向 $end 的边（结束节点）');
  const cands = deriveEntryCandidates(bp.nodes, bp.edges);
  const entryOk = bp.entry && ids[bp.entry];
  if (cands.length === 0) err('$.entry', '没有入口节点');
  else if (cands.length > 1) err('$.entry', '入口不唯一：' + cands.join('、') + '；请通过连线收敛为唯一入口（与 validateDsl 严格一致）');
  else if (!entryOk) err('$.entry', 'entry 必填，须为推导出的入口节点 ' + cands[0]);
  else if (bp.entry !== cands[0]) err('$.entry', 'entry 与推导入口不一致：' + bp.entry + ' ≠ ' + cands[0]);

  bp.nodes.forEach((n) => { if (n && (outgoing[n.id] || 0) === 0) err('$.nodes[' + n.id + ']', '节点没有出边，无法继续或结束'); });

  Object.keys(ids).forEach((id) => {
    const out = bp.edges.filter((e) => e && e.from === id);
    const succ = out.filter((e) => e.on === 'success');
    const fail = out.filter((e) => e.on === 'failure');
    if (succ.length > 1 && succ.some((e) => e.when === undefined)) err('$.nodes[' + id + ']', '多条 success 出边必须全部带 when 条件');
    if (fail.length > 1) err('$.nodes[' + id + ']', 'failure 边最多一条（打回唯一路径）');
  });

  const entry = entryOk ? bp.entry : (cands.length === 1 ? cands[0] : '');
  if (entry) {
    const reach = reachable(entry, bp.nodes, bp.edges);
    bp.nodes.forEach((n) => { if (n && !reach[n.id]) err('$.nodes[' + n.id + ']', '节点不可达（无法从入口沿 success 边到达）'); });
    if (hasSuccessCycle(entry, bp.nodes, bp.edges)) err('$.nodes', 'success 边存在环（打回请用 failure 边）');
  }

  if (bp.bindings) {
    const b = bp.bindings;
    if (b.models) Object.keys(b.models).forEach((k) => {
      if (!ids[k]) err('$.bindings.models.' + k, 'bindings.models 引用的节点 ' + k + ' 不存在');
    });
  }
  if (bp.heteroCheck && !(bp.nodes.some((n) => n && (n.id === 'dev' || n.profile === 'dev')) && bp.nodes.some((n) => n && (n.id === 'review' || n.profile === 'review')))) {
    err('$.heteroCheck', 'heteroCheck=true 需要存在 dev 与 review 节点（按节点 id 或 profile 识别，异源检查对象）');
  }

  // 异源硬规则（契约 §3.1 规则 7，T-06：全局强制，仅 dev↔review；
  // dev/review 按节点 id 或 profile（角色）识别——编辑器新建节点默认 id 为
  // node-N，用户以角色表达 dev/review 时同样纳入检查）
  const warnings = [];
  const devNode = bp.nodes.find((n) => n && (n.id === 'dev' || n.profile === 'dev'));
  const reviewNode = bp.nodes.find((n) => n && (n.id === 'review' || n.profile === 'review'));
  if (devNode && reviewNode) {
    const bm = (bp.bindings && bp.bindings.models) || {};
    const dm = bm[devNode.id];
    const rm = bm[reviewNode.id];
    if (!dm || !rm) {
      err('$.bindings.models', 'dev/review 未配置 bindings.models，无法证明异源，请显式配置');
    } else {
      const dt = (dm.provider || 'default') + '/' + (dm.model || 'default');
      const rt = (rm.provider || 'default') + '/' + (rm.model || 'default');
      if (dt === rt) {
        err('$.bindings.models', 'dev 与 review 模型相同（' + dt + '）：异源硬规则要求不同 provider 或不同模型，请调整 bindings.models');
      } else if (dm.provider === rm.provider) {
        warnings.push('弱异源：dev/review 同 provider（' + dm.provider + '）不同模型，建议配置不同 provider 满足真异源');
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, counts: { nodes: bp.nodes.length, edges: bp.edges.length } };
}
