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
  assert.equal(r.counts.edges, 12);
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
  b.edges[3].when = undefined;
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
