import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateAll, generateUserSkill } from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tplDir = path.join(here, '../../templates');
const bp = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'));

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

test('S2 生成器：业务规则字段进 vwf DSL（候选二 Q7 修订），节点级 verifyBranch 不进', () => {
  const { files } = generateAll(tplDir);
  const dsl = JSON.parse(files.get('dev-workflow-2-0/vwf-dsl.json'));
  assert.ok(dsl.nodes.every((n) => !('verifyBranch' in n)), 'verifyBranch 节点级字段无编辑器 UI，不进 DSL');
  assert.equal(dsl.onMaxRounds, 'auto-reschedule', 'onMaxRounds 业务规则进 DSL（前端可配置）');
  assert.equal(dsl.heteroCheck, true, 'heteroCheck 业务规则进 DSL（前端可配置）');
  assert.equal(dsl.control.maxRounds, 9);
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

test('S2 generateUserSkill：用户模板 → 自包含 skill 三件套（T-03 save 即闭环）', () => {
  const files = generateUserSkill(bp);
  for (const rel of ['SKILL.md', 'script.mjs', 'meta.json']) {
    assert.ok(files.has(rel), '缺产物：' + rel);
  }
  const skill = files.get('SKILL.md');
  assert.ok(skill.includes('name: dev-workflow-2-0'), 'skill frontmatter name');
  assert.ok(skill.includes('开发工作流 2.0'), 'skill 触发词（displayName）');
  const script = files.get('script.mjs');
  assert.ok(script.includes('AWAITING_HUMAN_'), 'script 含人工门禁语义');
  assert.ok(script.includes('超限归因'), 'script 含超限归因（auto-reschedule）');
  const meta = JSON.parse(files.get('meta.json'));
  assert.equal(meta.name, 'vwf-dev-workflow-2-0');
});
