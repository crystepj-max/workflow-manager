import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateAll } from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tplDir = path.join(here, '../../templates');

test('S2 生成器：产物四件套齐全', () => {
  const { files, report } = generateAll(tplDir);
  const id = 'dev-workflow-2-0';
  for (const rel of ['script.mjs', 'vwf-dsl.json', 'SKILL.md', 'meta.json']) {
    assert.ok(files.has(id + '/' + rel), '缺产物：' + rel);
  }
  assert.equal(report.length, 1);
  assert.equal(report[0].ok, true);
});

test('S2 生成器：route 折叠识别（FOLDS 注入）', () => {
  const { files, report } = generateAll(tplDir);
  assert.deepEqual(report[0].folds, ['route']);
  const script = files.get('dev-workflow-2-0/script.mjs');
  assert.ok(script.includes('"route"'), '脚本应内嵌 FOLDS 含 route');
});

test('S2 生成器：vwf-dsl 注入模型绑定（bindings 编译期固化）', () => {
  const { files } = generateAll(tplDir);
  const dsl = JSON.parse(files.get('dev-workflow-2-0/vwf-dsl.json'));
  const dev = dsl.nodes.find((n) => n.id === 'dev');
  assert.equal(dev.model.model, 'deepseek-v4-pro');
  const accept = dsl.nodes.find((n) => n.id === 'accept');
  assert.equal(accept.manualCheck, true);
});

test('S2 生成器：增强字段不进 vwf DSL', () => {
  const { files } = generateAll(tplDir);
  const dsl = JSON.parse(files.get('dev-workflow-2-0/vwf-dsl.json'));
  assert.ok(dsl.nodes.every((n) => !('verifyBranch' in n)));
  assert.ok(!('onMaxRounds' in dsl));
});

test('S2 生成器：SKILL.md 触发词含 displayName 与 id', () => {
  const { files } = generateAll(tplDir);
  const skill = files.get('dev-workflow-2-0/SKILL.md');
  assert.ok(skill.includes('name: dev-workflow-2-0'));
  assert.ok(skill.includes('开发工作流 2.0'));
});

test('S2 生成器：幂等（两次调用产物完全一致）', () => {
  const a = generateAll(tplDir);
  const b = generateAll(tplDir);
  assert.deepEqual([...a.files.keys()].sort(), [...b.files.keys()].sort());
  for (const [rel, content] of a.files) {
    assert.equal(content, b.files.get(rel), '产物不一致：' + rel);
  }
});

test('S2 生成器：非法蓝图编译失败并报错（不产出）', () => {
  const badDir = path.join(here, 'fixtures/bad-blueprint');
  const { files, report } = generateAll(badDir);
  assert.equal(report[0].ok, false);
  assert.equal(files.size, 0);
});
