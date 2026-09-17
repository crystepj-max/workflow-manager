import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  analyzeTemplateGuide,
  buildDoneRunbookLine,
  generateAll,
  skillWrap,
  templateGuideSection,
} from '../generate.mjs';
import { validateGuideDrift } from '../validate-guide-drift.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const tplDir = path.join(root, 'templates');

test('LOC-040：四内置模板 DONE 行不得泛化 merge commit', () => {
  for (const id of ['wf-explore', 'wf-optimize', 'wf-diagnose', 'wf-construction-full-feature']) {
    const bp = JSON.parse(readFileSync(path.join(tplDir, id + '.json'), 'utf8'));
    const line = buildDoneRunbookLine(bp);
    assert.equal(line.includes('呈 cleanup 报告与合并 commit'), false, id + ' 仍泛化 merge');
    if (id === 'wf-explore' || id === 'wf-optimize' || id === 'wf-diagnose') {
      assert.ok(/不要求|禁止/.test(line), id + ' 应声明不要求 PR/merge');
    }
  }
});

test('LOC-040：探索模板能力摘要禁止 merge/PR', () => {
  const bp = JSON.parse(readFileSync(path.join(tplDir, 'wf-explore.json'), 'utf8'));
  const section = templateGuideSection(bp);
  assert.ok(/禁止.*merge commit|不要求 merge commit/.test(section));
  assert.ok(section.includes('m2-vs-portable-delivery.md'));
  const a = analyzeTemplateGuide(bp);
  assert.equal(a.hasCloseout, false);
  assert.ok(a.endOutcomes.some((e) => e.outcome === 'INSUFFICIENT'));
});

test('LOC-040：建设模板保留 uat 人工门摘要', () => {
  const bp = JSON.parse(readFileSync(path.join(tplDir, 'wf-construction-full-feature.json'), 'utf8'));
  const section = templateGuideSection(bp);
  assert.ok(section.includes('uat'));
  assert.ok(/ACCEPT|REJECT|CONDITIONAL_PASS/.test(section));
  assert.ok(analyzeTemplateGuide(bp).m2BlockedExhausted);
});

test('LOC-040：validateGuideDrift 能发现手改 SKILL.md', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guide-drift-'));
  const gen = path.join(dir, '.generated', 'wf-explore');
  fs.mkdirSync(gen, { recursive: true });
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  for (const f of fs.readdirSync(tplDir).filter((x) => x.endsWith('.json'))) {
    fs.copyFileSync(path.join(tplDir, f), path.join(dir, 'templates', f));
  }
  const { files } = generateAll(path.join(dir, 'templates'));
  for (const [rel, content] of files) {
    const out = path.join(dir, '.generated', rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, content);
  }
  assert.equal(validateGuideDrift(dir).ok, true);
  const skillPath = path.join(dir, '.generated', 'wf-explore', 'SKILL.md');
  writeFileSync(skillPath, readFileSync(skillPath, 'utf8') + '\n<!-- drift -->');
  const bad = validateGuideDrift(dir);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('wf-explore/SKILL.md')));
});

test('LOC-040：skillWrap 不再输出退役泛化 DONE 句', () => {
  const explore = JSON.parse(readFileSync(path.join(tplDir, 'wf-explore.json'), 'utf8'));
  const skill = skillWrap(explore);
  assert.equal(skill.includes('呈 cleanup 报告与合并 commit，流程结束。'), false);
  assert.ok(skill.includes('模板能力摘要'));
});
