import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills, listBuiltinBlueprintFiles, resolveSkillRoot, resolveInstallTargets, DEFAULT_SKILL_POOL } from '../install-builtin-skills.mjs';

const makeTmp = () => mkdtempSync(path.join(os.tmpdir(), 'vwf-builtin-skill-'));
const rmTmp = (dir) => { try { execFileSync('/bin/rm', ['-rf', dir]) } catch (e) {} };

// 四套正式内置（规格 §10）：任一缺失即回归 —— 历史上只有第一套装过，其余三套从未进入 DSH 技能目录
const EXPECTED_IDS = ['wf-construction-full-feature', 'wf-diagnose', 'wf-explore', 'wf-optimize'];

test('内置模板技能包：四套全部安装成功，产物自包含', () => {
  const tmp = makeTmp();
  try {
    const results = installBuiltinSkills({ skillRoot: tmp });
    const ids = results.map((r) => r.id).sort();
    assert.deepEqual(ids, [...EXPECTED_IDS].sort(), '四套正式内置模板全部安装');
    for (const r of results) {
      assert.equal(r.ok, true, r.id + ' 安装失败：' + r.error);
      for (const rel of ['SKILL.md', 'script.mjs', 'meta.json']) {
        assert.ok(fs.existsSync(path.join(r.dir, rel)), r.id + ' 缺少 ' + rel);
      }
      // 自包含角色包：产品工作区没有 dsh/roles/ 时仍能运行
      assert.ok(fs.readdirSync(path.join(r.dir, 'roles')).length > 0, r.id + ' 缺少角色包');
      const skill = readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8');
      assert.ok(skill.includes('name: ' + r.id), r.id + ' frontmatter name 应为模板 id');
      // LOC-015：起跑必须首选 wf_run，否则运行记录退化为单段
      assert.ok(skill.includes('wf_run'), r.id + ' runbook 未首选 wf_run');
    }
  } finally { rmTmp(tmp); }
});

test('内置模板技能包：重复安装幂等（内容一致、无残留）', () => {
  const tmp = makeTmp();
  try {
    const first = installBuiltinSkills({ skillRoot: tmp });
    const before = first.map((r) => readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8'));
    const second = installBuiltinSkills({ skillRoot: tmp });
    assert.deepEqual(second.map((r) => r.ok), first.map(() => true), '二次安装同样全部成功');
    assert.deepEqual(second.map((r) => readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8')), before, '二次安装内容一致');
    assert.deepEqual(fs.readdirSync(tmp).sort(), [...EXPECTED_IDS].sort(), '无暂存目录残留');
  } finally { rmTmp(tmp); }
});

test('技能根解析：缺省取 $DSH_HOME/skills，回退 ~/.dsh/skills', () => {
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-x';
    assert.equal(resolveSkillRoot(), path.join('/tmp/dsh-home-x', 'skills'));
    process.env.DSH_HOME = '';
    assert.equal(resolveSkillRoot(), path.join(os.homedir(), '.dsh', 'skills'));
  } finally { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved; }
});

test('安装目标解析：缺省只装 DSH，--pool 追加共享技能池', () => {
  const dsh = resolveSkillRoot();
  assert.deepEqual(resolveInstallTargets([]), [dsh]);
  assert.deepEqual(resolveInstallTargets(['--pool']), [dsh, DEFAULT_SKILL_POOL]);
  assert.deepEqual(resolveInstallTargets(['--pool=/x/pool']), [dsh, '/x/pool']);
  // 位置参数（dshHome）+ 多个池，顺序稳定
  assert.deepEqual(resolveInstallTargets(['/tmp/dsh-x', '--pool', '--pool=/x/pool']),
    [path.join('/tmp/dsh-x', 'skills'), DEFAULT_SKILL_POOL, '/x/pool']);
});

test('共享技能池安装：与 DSH 产物同形态，可重复执行', () => {
  const tmp = makeTmp();
  try {
    const results = installBuiltinSkills({ skillRoot: tmp });
    assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
    // 池内产物必须自带 SKILL.md，否则桥接到各 agent 后读不到技能说明
    for (const r of results) {
      assert.ok(readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8').startsWith('---'), r.id);
    }
  } finally { rmTmp(tmp); }
});

test('内置清单只含正式内置：不含 custom-seeds 历史种子', () => {
  const files = listBuiltinBlueprintFiles().map((f) => path.basename(f, '.json')).sort();
  assert.deepEqual(files, [...EXPECTED_IDS].sort());
});
