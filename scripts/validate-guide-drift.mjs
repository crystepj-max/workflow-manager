#!/usr/bin/env node
// LOC-040：生成 Skill runbook 与蓝图漂移检查
// ① 内存重生成 SKILL.md 与 .generated/ 逐字比对
// ② 四内置模板语义探针（探索/优化/诊断不得泛化 merge/PR；建设须保留 UAT 门）
// 用法：node scripts/validate-guide-drift.mjs [repoRoot]
// exit 0 = 通过；exit 1 = 漂移或语义违规

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from './generate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const TPL = path.join(root, 'templates');
const GEN = path.join(root, '.generated');

const LEGACY_GENERIC_DONE = '呈 cleanup 报告与合并 commit，流程结束。';
const BUILTIN_FOUR = [
  'wf-construction-full-feature',
  'wf-explore',
  'wf-diagnose',
  'wf-optimize',
];

/** @param {string} repoRoot */
export function validateGuideDrift(repoRoot) {
  const templatesDir = path.join(repoRoot, 'templates');
  const genDir = path.join(repoRoot, '.generated');
  const errors = [];

  if (!fs.existsSync(genDir)) {
    return { ok: false, errors: ['缺少 .generated/（请先 npm run generate）'] };
  }

  const { files } = generateAll(templatesDir);
  for (const [rel, content] of files) {
    if (!rel.endsWith('/SKILL.md')) continue;
    const abs = path.join(genDir, rel);
    if (!fs.existsSync(abs)) {
      errors.push('缺少生成 Skill：' + rel);
      continue;
    }
    const onDisk = fs.readFileSync(abs, 'utf8');
    if (onDisk !== content) {
      errors.push(rel + ' 与蓝图重生成不一致（手改 .generated 或未 npm run generate）');
    }
  }

  for (const id of BUILTIN_FOUR) {
    const abs = path.join(genDir, id, 'SKILL.md');
    if (!fs.existsSync(abs)) {
      errors.push('缺少四内置模板 Skill：' + id);
      continue;
    }
    const skill = fs.readFileSync(abs, 'utf8');
    if (skill.includes(LEGACY_GENERIC_DONE)) {
      errors.push(id + ' 仍含已退役的全模板泛化 DONE 句（merge commit）');
    }
    if (!skill.includes('m2-vs-portable-delivery.md')) {
      errors.push(id + ' 模板能力摘要缺少 M2/Portable 权威链接');
    }
    if (!skill.includes('workflow-capability-index.md')) {
      errors.push(id + ' 模板能力摘要缺少能力索引链接');
    }
    const doneChunk = skill.split('### `DONE` 收口要求')[1] || '';
    if (id === 'wf-explore') {
      if (!/不要求 merge commit|禁止.*merge commit/.test(skill)) {
        errors.push('wf-explore 缺少「不要求 merge commit」收口说明');
      }
      if (/closeout.*合并|呈 cleanup.*合并 commit/.test(doneChunk)) {
        errors.push('wf-explore DONE 段仍要求 closeout/合并');
      }
    }
    if (id === 'wf-optimize' || id === 'wf-diagnose') {
      if (!/不要求 PR|禁止.*PR/.test(doneChunk)) {
        errors.push(id + ' DONE 段缺少「不要求 PR」说明');
      }
    }
    if (id === 'wf-construction-full-feature') {
      if (!/\buat\b/.test(doneChunk) || !/三态|ACCEPT|REJECT|CONDITIONAL_PASS/.test(doneChunk)) {
        errors.push('wf-construction-full-feature DONE 段缺少 UAT 人工三态说明');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const result = validateGuideDrift(root);
if (result.ok) {
  console.log('✅ 生成 Skill runbook 与蓝图一致（' + BUILTIN_FOUR.length + ' 个内置模板语义探针通过）');
  process.exit(0);
}
console.log('❌ 生成指南漂移或语义违规（' + result.errors.length + '）：');
for (const e of result.errors) console.log('  - ' + e);
process.exit(1);
