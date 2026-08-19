import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateAll } from '../generate.mjs';
import { assertEquivalence } from '../equivalence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tplDir = path.join(here, '../../templates');
const bp = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'));
const { files } = generateAll(tplDir);
const script = files.get('dev-workflow-2-0/script.mjs');

test('S3 等价断言：生成脚本与蓝图全等（10 项全过）', () => {
  const r = assertEquivalence(script, bp);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('S3 等价断言：负例——篡改脚本拓扑（删节点）失败', () => {
  const hacked = script.replace('"route"', '"hacked"');
  const r = assertEquivalence(hacked, bp);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('拓扑')), JSON.stringify(r.failures));
});

test('S3 等价断言：负例——删除超限归因注入失败', () => {
  const hacked = script.replace("label: '超限归因'", "label: '超限'");
  const r = assertEquivalence(hacked, bp);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('归因')), JSON.stringify(r.failures));
});

test('S3 等价断言：负例——破坏文件契约注入失败', () => {
  const hacked = script.replace('【本节点应产出文件】', '【本节点产出文件】');
  const r = assertEquivalence(hacked, bp);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('files')), JSON.stringify(r.failures));
});
