import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateBlueprint } from '../validate-blueprint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const good = JSON.parse(readFileSync(path.join(here, '../../templates/dev-workflow-2-0.json'), 'utf8'));

test('S1 合法蓝图（dev-workflow-2-0 全量）通过校验', () => {
  const r = validateBlueprint(good);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.counts.nodes, 7);
  assert.equal(r.counts.edges, 13);
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
