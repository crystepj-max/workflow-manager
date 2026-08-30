import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import validatorCore from '../validate-core.cjs';
const {
  validateBlueprint,
  HUMAN_DECISION_ID,
  HD_REASONS,
  HD_CONTROL_RESULTS,
  HD_PACKAGE_REQUIRED,
  HD_PACKAGE_OPTIONAL_UNKNOWN,
  HD_EVENT_FIELDS,
  HD_RESUME_FIELDS,
} = validatorCore;

const here = path.dirname(fileURLToPath(import.meta.url));
const good = JSON.parse(readFileSync(path.join(here, '../../templates/dev-workflow-2-0.json'), 'utf8'));
const fanoutGood = JSON.parse(readFileSync(path.join(here, 'fixtures/fanout-blueprint.json'), 'utf8'));

test('S1 合法蓝图（dev-workflow-2-0 全量）通过校验', () => {
  const r = validateBlueprint(good);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.counts.nodes, 7);
  assert.equal(r.counts.edges, 13);
});

test('fanout 合法夹具通过校验，worker 缺省 kind 保持兼容', () => {
  const r = validateBlueprint(fanoutGood);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(fanoutGood.nodes[1].kind, undefined);
});

test('fanout kind/items/goal/failOn 规则逐字段拒绝并携带 fieldKey', () => {
  const cases = [
    ['kind', (b) => { b.nodes[0].kind = 'parallel' }, 'node:fan:kind'],
    ['items 缺失', (b) => { delete b.nodes[0].items }, 'node:fan:items'],
    ['items 格式', (b) => { b.nodes[0].items = '$.unknown.items' }, 'node:fan:items'],
    ['goal 占位', (b) => { b.nodes[0].goal = '处理任务' }, 'node:fan:goal'],
    ['failOn 字符串', (b) => { b.nodes[0].failOn = 'some' }, 'node:fan:failOn'],
    ['failOn 负数', (b) => { b.nodes[0].failOn = -1 }, 'node:fan:failOn'],
  ];
  for (const [label, mutate, fieldKey] of cases) {
    const b = JSON.parse(JSON.stringify(fanoutGood));
    mutate(b);
    const r = validateBlueprint(b);
    assert.equal(r.ok, false, label + ' 应拒绝');
    assert.ok(r.errors.some((e) => e.fieldKey === fieldKey), label + ' 缺坐标：' + JSON.stringify(r.errors));
  }
});

test('fanout 禁止 successCondition/manualCheck/verifyBranch，且必须有 failure 出边', () => {
  const cases = [
    ['successCondition', (b) => { b.nodes[0].output.successCondition = '$.value == "x"' }, 'node:fan:output.successCondition'],
    ['manualCheck', (b) => { b.nodes[0].manualCheck = true }, 'node:fan:manualCheck'],
    ['verifyBranch', (b) => { b.nodes[0].verifyBranch = true }, 'node:fan:verifyBranch'],
    ['failure 出边', (b) => { b.edges = b.edges.filter((e) => !(e.from === 'fan' && e.on === 'failure')) }, 'node:fan:kind'],
  ];
  for (const [label, mutate, fieldKey] of cases) {
    const b = JSON.parse(JSON.stringify(fanoutGood));
    mutate(b);
    const r = validateBlueprint(b);
    assert.equal(r.ok, false, label + ' 应拒绝');
    assert.ok(r.errors.some((e) => e.fieldKey === fieldKey), label + ' 缺坐标：' + JSON.stringify(r.errors));
  }
});

test('worker 出现 items/failOn 拒绝，fanout failOn 缺省 all 与非负整数合法', () => {
  for (const field of ['items', 'failOn']) {
    const b = JSON.parse(JSON.stringify(fanoutGood));
    b.nodes[1][field] = field === 'items' ? '$.args.items' : 'all';
    const r = validateBlueprint(b);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.fieldKey === 'node:finish:' + field), JSON.stringify(r.errors));
  }
  for (const value of [undefined, 'any', 'all', 0, 2]) {
    const b = JSON.parse(JSON.stringify(fanoutGood));
    if (value === undefined) delete b.nodes[0].failOn;
    else b.nodes[0].failOn = value;
    assert.equal(validateBlueprint(b).ok, true, 'failOn=' + value + ' 应合法');
  }
});

test('fanout results 表达式只能引用 success 路径上的前序节点', () => {
  const b = JSON.parse(JSON.stringify(fanoutGood));
  b.entry = 'source';
  b.nodes.unshift({ id: 'source', profile: 'dispatcher', goal: '准备数组' });
  b.edges.unshift({ from: 'source', to: 'fan', on: 'success' });
  b.nodes[1].items = '$.results.source.payload.items';
  assert.equal(validateBlueprint(b).ok, true, JSON.stringify(validateBlueprint(b).errors));

  b.nodes[1].items = '$.results.finish.payload.items';
  const after = validateBlueprint(b);
  assert.equal(after.ok, false);
  assert.ok(after.errors.some((e) => e.fieldKey === 'node:fan:items' && e.message.includes('success')));

  b.nodes[1].items = '$.results.ghost.items';
  const missing = validateBlueprint(b);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.fieldKey === 'node:fan:items' && e.message.includes('不存在')));
});

// —— 场景辅助：基于合法蓝图做单点破坏 ——
const clone = () => JSON.parse(JSON.stringify(good));
const expectReject = (bp, needle, label) => {
  const r = validateBlueprint(bp);
  assert.equal(r.ok, false, label + '：应拒绝');
  assert.ok(r.errors.some((e) => e.message.includes(needle)), label + '：应报「' + needle + '」，实际 ' + JSON.stringify(r.errors));
};

test('S1 多入口拒绝（显式 entry 不豁免）', () => {
  const b = clone();
  b.edges = b.edges.filter((e) => e.from !== 'dispatch');
  expectReject(b, '入口不唯一', 'multiEntry');
});

test('S1 缺 $end 与无出边拒绝', () => {
  const b = clone();
  b.edges = b.edges.filter((e) => e.to !== '$end');
  const r = validateBlueprint(b);
  assert.ok(r.errors.some((e) => e.message.includes('$end')), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => e.message.includes('没有出边')), JSON.stringify(r.errors));
});

test('S1 多 success 出边缺 when 拒绝', () => {
  const b = clone();
  b.edges[4].when = undefined;
  expectReject(b, '多条 success 出边必须全部带 when', 'whenMissing');
});

test('S1 successCondition 路径不在 schema 拒绝', () => {
  const b = clone();
  b.nodes[0].output.successCondition = '$.nope == true';
  expectReject(b, '成功表达式路径未在', 'condPath');
});

test('S1 verifyBranch 联动：required 缺 verified_* 拒绝', () => {
  const b = clone();
  b.nodes[3].output.schema.required = ['result', 'reason', 'evidence'];
  expectReject(b, 'verified_branch', 'verify');
});

test('S1 bindings.models 引用不存在节点拒绝', () => {
  const b = clone();
  b.bindings.models.ghost = { provider: 'x', model: 'y' };
  expectReject(b, 'ghost', 'binding');
});

test('S1 success 环拒绝（打回走 failure 边）', () => {
  const b = clone();
  b.edges.push({ from: 'test', to: 'route', on: 'success' });
  expectReject(b, '环', 'cycle');
});

// —— 走通性规则（候选三 Q12：有成功条件即可判失败的节点必须有 failure 出口）——
test('S1 走通性：有 successCondition 的节点缺 failure 边拒绝', () => {
  const b = clone();
  b.edges = b.edges.filter((e) => !(e.from === 'dev' && e.on === 'failure'));
  expectReject(b, 'failure 出边', 'walkability');
});

test('S1 走通性：manualCheck 节点无 successCondition 不强制 failure 边', () => {
  const b = clone();
  b.edges = b.edges.filter((e) => !(e.from === 'accept' && e.on === 'failure'));
  const r = validateBlueprint(b);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('S1 output.files：非法相对路径拒绝', () => {
  const b = clone();
  b.nodes[0].output.files['../escape.json'] = 'json';
  expectReject(b, '合法相对路径', 'filesBad');
});

test('S1 output.files：保留文件 STATE.md 拒绝', () => {
  const b = clone();
  b.nodes[1].output.files['STATE.md'] = 'markdown';
  expectReject(b, 'STATE.md', 'filesState');
});

test('S1 output.files：类型枚举拒绝', () => {
  const b = clone();
  b.nodes[1].output.files['x.yaml'] = 'yaml';
  expectReject(b, 'json | markdown | text', 'filesKind');
});

test('S1 id 非 kebab-case 拒绝', () => {
  const b = clone();
  b.id = 'Dev_Workflow';
  expectReject(b, 'kebab-case', 'idCase');
});

test('S1 displayName 缺失拒绝', () => {
  const b = clone();
  delete b.displayName;
  expectReject(b, 'displayName', 'displayName');
});

test('S1 name 与 id 不一致拒绝（单标识）', () => {
  const b = clone();
  b.name = 'other-id';
  expectReject(b, '单标识', 'nameMismatch');
});

test('S1 heteroCheck=true 但缺 dev/review 节点拒绝', () => {
  const b = clone();
  b.nodes = b.nodes.filter((n) => n.id !== 'review');
  b.edges = b.edges.filter((e) => e.from !== 'review' && e.to !== 'review');
  expectReject(b, 'dev 与 review', 'heteroNodes');
});

// —— 打回上限系统约束（候选二 Q7：maxRounds ∈ [1,9]，系统约定上限 9）——
test('S1 maxRounds：缺省 = 合法（默认 9）', () => {
  const b = clone();
  delete b.control;
  const r = validateBlueprint(b);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('S1 maxRounds：1 与 9 边界合法', () => {
  const a = clone();
  a.control.maxRounds = 1;
  assert.equal(validateBlueprint(a).ok, true, JSON.stringify(validateBlueprint(a).errors));
  const z = clone();
  z.control.maxRounds = 9;
  assert.equal(validateBlueprint(z).ok, true, JSON.stringify(validateBlueprint(z).errors));
});

test('S1 maxRounds：0 / 10 / 3.5 / 非数拒绝（系统上限 9）', () => {
  for (const bad of [0, 10, 3.5, -1, '9']) {
    const b = clone();
    b.control.maxRounds = bad;
    const r = validateBlueprint(b);
    assert.equal(r.ok, false, 'maxRounds=' + bad + ' 应拒绝');
    assert.ok(r.errors.some((e) => e.fieldKey === 'control:maxRounds'), 'maxRounds=' + bad + ' 应带 control:maxRounds 坐标');
  }
});

// —— 契约一致性（候选五 C5 规则 A：goal 反引号文件名 ⊆ 全局 output.files ∪ STATE.md）——
test('S1 契约一致性：goal 提及未声明文件名拒绝（带 node:<id>:goal 坐标）', () => {
  const b = clone();
  b.nodes.find((n) => n.id === 'dev').goal = '写 `dev-report-v2.md` 并更新 STATE.md。';
  const r = validateBlueprint(b);
  assert.equal(r.ok, false);
  const hit = r.errors.find((e) => e.fieldKey === 'node:dev:goal');
  assert.ok(hit, '应带 node:dev:goal 坐标，实际：' + JSON.stringify(r.errors));
  assert.ok(hit.message.includes('dev-report-v2.md'), '报错应指出未声明文件名');
});

test('S1 契约一致性：goal 裸提及（无反引号）不检查（避免 package.json 类误报）', () => {
  const b = clone();
  b.nodes.find((n) => n.id === 'dev').goal = '修改 package.json 的 scripts 后施工。';
  const r = validateBlueprint(b);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// —— 异源硬规则（契约 §3.1 规则 7，T-06 六用例；T6=update 路径在宿主层，此处 T1-T5）——
const withHetero = (dev, review) => {
  const b = clone();
  b.bindings.models.dev = dev;
  b.bindings.models.review = review;
  return b;
};

test('S1 异源 T1：完全同模型（同 provider 同 model）拒绝', () => {
  expectReject(withHetero(
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  ), '模型相同', 'heteroT1');
});

test('S1 异源 T2：弱异源（同 provider 不同 model）通过 + warning', () => {
  const r = validateBlueprint(withHetero(
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  ));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.length > 0, '应产生弱异源 warning');
  assert.ok(r.warnings[0].includes('弱异源'), JSON.stringify(r.warnings));
});

test('S1 异源 T3：真异源（不同 provider）通过无警告', () => {
  const r = validateBlueprint(withHetero(
    { provider: 'kimi-coding', model: 'k3' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  ));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

test('S1 异源 T4：dev 缺绑定拒绝（无法证明异源）', () => {
  const b = clone();
  delete b.bindings.models.dev;
  expectReject(b, '无法证明异源', 'heteroT4');
});

test('S1 异源 T5：无 dev/review 节点的蓝图跳过异源校验', () => {
  const b = {
    id: 'no-dev-review', displayName: '无 dev/review（fixture）', entry: 'dispatch',
    nodes: [
      { id: 'dispatch', profile: 'dispatcher', goal: 'x',
        output: { schema: { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'], additionalProperties: false } } },
      { id: 'test', profile: 'test', goal: 'x',
        output: { schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false } } },
      { id: 'accept', profile: 'accept', goal: 'x', manualCheck: true,
        output: { schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false } } },
      { id: 'closeout', profile: 'closeout', goal: 'x',
        output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false } } },
    ],
    edges: [
      { from: 'dispatch', to: 'test', on: 'success' },
      { from: 'dispatch', to: '$end', on: 'failure' },
      { from: 'test', to: 'accept', on: 'success' },
      { from: 'accept', to: 'closeout', on: 'success' },
      { from: 'closeout', to: '$end', on: 'success' },
    ],
  };
  const r = validateBlueprint(b);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});

test('S1 异源 T7：profile（角色）为 dev/review 的节点同样纳入检查（节点 id 为 node-N）', () => {
  const b = clone();
  const mapId = { dev: 'node-1', review: 'node-2' };
  b.nodes = b.nodes.map((n) => (mapId[n.id] ? { ...n, id: mapId[n.id] } : n));
  b.edges = b.edges.map((e) => ({ ...e, from: mapId[e.from] || e.from, to: mapId[e.to] || e.to }));
  b.entry = mapId[b.entry] || b.entry;
  b.bindings = { models: {} };
  b.nodes.forEach((n) => { if (n.profile === 'dev' || n.profile === 'review') b.bindings.models[n.id] = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }; });
  expectReject(b, '模型相同', 'heteroT7-profile');
});

test('S1 异源 T8：profile 定位 + 真异源通过无警告', () => {
  const b = clone();
  const mapId = { dev: 'node-1', review: 'node-2' };
  b.nodes = b.nodes.map((n) => (mapId[n.id] ? { ...n, id: mapId[n.id] } : n));
  b.edges = b.edges.map((e) => ({ ...e, from: mapId[e.from] || e.from, to: mapId[e.to] || e.to }));
  b.entry = mapId[b.entry] || b.entry;
  b.bindings = { models: { 'node-1': { provider: 'kimi-coding', model: 'k3' }, 'node-2': { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } };
  const r = validateBlueprint(b);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});

// —— Human Decision 契约（#116 / #72）：键名钉死 + 非法配置拒绝；不测挂起运行时 ——
const hdGood = JSON.parse(readFileSync(path.join(here, 'fixtures/human-decision-blueprint.json'), 'utf8'));
const hdClone = () => JSON.parse(JSON.stringify(hdGood));

test('#116 契约键名：Human Decision 控制面英文键钉死', () => {
  assert.equal(HUMAN_DECISION_ID, '$human-decision');
  assert.deepEqual(HD_REASONS, ['HUMAN_ACCEPTANCE', 'ESCALATED_DECISION', 'MAX_ROUNDS_REACHED']);
  assert.deepEqual(HD_CONTROL_RESULTS, ['USER_ACCEPTED', 'ADD_BUDGET', 'STOP']);
  assert.deepEqual(HD_PACKAGE_REQUIRED, ['why', 'current_state', 'options', 'subsequent_effects']);
  assert.deepEqual(HD_PACKAGE_OPTIONAL_UNKNOWN, ['cost', 'benefit', 'risk', 'recommendation']);
  assert.deepEqual(HD_EVENT_FIELDS, [
    'record_kind', 'trigger', 'lifecycle_at_request', 'decision_id', 'run_ref',
    'node_id', 'attempt', 'reason', 'triggering_node_outcome', 'decision_package',
    'user_choice', 'impact', 'subsequent_path', 'created_at',
  ]);
  assert.deepEqual(HD_RESUME_FIELDS, ['decision_id', 'user_choice']);
});

test('#116 合法 Human Decision 蓝图通过校验；$human-decision 不得当节点 id', () => {
  const ok = validateBlueprint(hdGood);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const stolen = hdClone();
  stolen.nodes.push({ id: '$human-decision', profile: 'accept', goal: '伪节点' });
  stolen.edges.push({ from: '$human-decision', to: '$end', on: 'success' });
  const r = validateBlueprint(stolen);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => String(e.message).includes('保留') && String(e.message).includes('$human-decision')), JSON.stringify(r.errors));
});

test('#116 残留 manualCheck 蓝图仍通过校验', () => {
  const leftover = JSON.parse(readFileSync(path.join(here, 'fixtures/hello-blueprint.json'), 'utf8'));
  const r = validateBlueprint(leftover);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(validateBlueprint(good).ok, true, JSON.stringify(validateBlueprint(good).errors));
});

test('#116 fanout 节点声明升级到 $human-decision 被拒', () => {
  const b = JSON.parse(JSON.stringify(fanoutGood));
  b.edges = [
    { from: 'fan', to: '$human-decision', on: 'success' },
    { from: '$human-decision', to: 'finish', on: 'success', result: 'SHIP' },
    { from: 'fan', to: '$end', on: 'failure' },
    { from: 'finish', to: '$end', on: 'success' },
  ];
  const r = validateBlueprint(b);
  assert.equal(r.ok, false, 'fanout 升 Human Decision 应拒绝');
  assert.ok(r.errors.some((e) => (e.fieldKey || '').includes('fan') || String(e.message).includes('fanout')), JSON.stringify(r.errors));
});

test('#116 使用 Human Decision 的新蓝图携带 approved 被拒', () => {
  const top = hdClone();
  top.approved = true;
  const r1 = validateBlueprint(top);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.fieldKey === 'approved' || String(e.message).includes('approved')), JSON.stringify(r1.errors));

  const node = hdClone();
  node.nodes[0].approved = false;
  const r2 = validateBlueprint(node);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => String(e.fieldKey || '').includes('approved') || String(e.message).includes('approved')), JSON.stringify(r2.errors));
});

test('#116 额度耗尽默认控制选项可覆盖但不可删到零', () => {
  const subset = hdClone();
  subset.humanDecision = { maxRoundsReachedOptions: ['STOP'] };
  assert.equal(validateBlueprint(subset).ok, true, JSON.stringify(validateBlueprint(subset).errors));

  const empty = hdClone();
  empty.humanDecision = { maxRoundsReachedOptions: [] };
  const r = validateBlueprint(empty);
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.fieldKey === 'humanDecision:maxRoundsReachedOptions'), true, JSON.stringify(r.errors));
});

test('#116 HD 与 manualCheck 同图拒绝；出边 result 不得占用控制类 Result 名', () => {
  const mixed = hdClone();
  mixed.nodes[0].manualCheck = true;
  const r1 = validateBlueprint(mixed);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => String(e.message).includes('manualCheck')), JSON.stringify(r1.errors));

  const ctrl = hdClone();
  ctrl.edges[1].result = 'STOP';
  const r2 = validateBlueprint(ctrl);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.fieldKey === 'edge:1:result'), JSON.stringify(r2.errors));
});
