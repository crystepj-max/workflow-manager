import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { generateAll, generateUserSkill, writeUserSkill } from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tplDir = path.join(here, '../../templates');
const bp = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'));

test('S2 生成器：产物四件套齐全', () => {
  const { files, report } = generateAll(tplDir);
  const id = 'dev-workflow-2-0';
  for (const rel of ['script.mjs', 'vwf-dsl.json', 'SKILL.md', 'meta.json']) {
    assert.ok(files.has(id + '/' + rel), '缺产物：' + rel);
  }
  assert.equal(report.length, 2, '两个蓝图（dev-workflow-2-0 + default-workflow）都产出');
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

test('S2 生成器：bundleRoles 蓝图角色自包含分发（默认工作流用户级内置模板）', () => {
  const { files, report } = generateAll(tplDir);
  const rep = report.find((r) => r.id === 'default-workflow');
  assert.ok(rep && rep.ok, 'default-workflow 生成成功');
  assert.ok(files.has('default-workflow/roles/dispatcher.md'), '角色包随模板分发：dispatcher.md');
  assert.ok(files.has('default-workflow/roles/review.md'), '角色包随模板分发：review.md');
  const dsl = JSON.parse(files.get('default-workflow/vwf-dsl.json'));
  assert.equal(dsl.bundleRoles, true, 'DSL 投影携带 bundleRoles 标记');
  assert.ok(files.get('default-workflow/SKILL.md').includes('默认工作流'), 'SKILL.md 触发词含 displayName');
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

// ── 候选四 T-IMP-14 · 原子写盘（失败零残留） ──
const makeTmp = () => mkdtempSync(path.join(tmpdir(), 'vwf-skill-'))
const rmTmp = (dir) => { try { execFileSync('/bin/rm', ['-rf', dir]) } catch (e) {} }
const realIo = {
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  writeFileSync: (p, c) => fs.writeFileSync(p, c),
  renameSync: (a, b) => fs.renameSync(a, b),
  readdirSync: (p) => fs.readdirSync(p),
  statSync: (p) => fs.statSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
  rmdirSync: (p) => fs.rmdirSync(p),
}

test('C4 原子写盘-成功：三件套落盘且与 generateUserSkill 内容一致，无暂存残留', () => {
  const tmp = makeTmp()
  try {
    const r = writeUserSkill(bp, tmp, realIo)
    assert.equal(r.ok, true, r.error)
    for (const rel of ['SKILL.md', 'script.mjs', 'meta.json']) {
      assert.equal(readFileSync(path.join(r.dir, rel), 'utf8'), generateUserSkill(bp).get(rel), rel + ' 内容一致')
    }
    const kids = fs.readdirSync(tmp)
    assert.deepEqual(kids, ['dev-workflow-2-0'], '无暂存目录残留')
  } finally { rmTmp(tmp) }
})

test('C4 原子写盘-中途失败：暂存与已写文件零残留（注入第 2 个文件写失败）', () => {
  const tmp = makeTmp()
  try {
    let writes = 0
    const failingIo = {
      ...realIo,
      writeFileSync: (p, c) => { writes++; if (writes === 2) throw new Error('磁盘满（模拟）'); return fs.writeFileSync(p, c) },
    }
    const r = writeUserSkill(bp, tmp, failingIo)
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('磁盘满'))
    assert.deepEqual(fs.readdirSync(tmp), [], '失败后目录零残留（含暂存区）')
  } finally { rmTmp(tmp) }
})

test('C4 原子写盘-更新失败：旧版本目录不受影响（换入未发生）', () => {
  const tmp = makeTmp()
  try {
    const finalDir = path.join(tmp, 'dev-workflow-2-0')
    fs.mkdirSync(finalDir, { recursive: true })
    fs.writeFileSync(path.join(finalDir, 'OLD.md'), '旧版本')
    let writes = 0
    const failingIo = {
      ...realIo,
      writeFileSync: (p, c) => { writes++; if (writes === 2) throw new Error('磁盘满（模拟）'); return fs.writeFileSync(p, c) },
    }
    const r = writeUserSkill(bp, tmp, failingIo)
    assert.equal(r.ok, false)
    assert.equal(readFileSync(path.join(finalDir, 'OLD.md'), 'utf8'), '旧版本', '更新失败时旧版本完整保留')
  } finally { rmTmp(tmp) }
})
