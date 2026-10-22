import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { auditInstalledSkills } from '../installed-skill-audit.mjs'
import { DEFAULT_TEMPLATES_DIR, installBuiltinSkills } from '../install-builtin-skills.mjs'

const script = fileURLToPath(new URL('../installed-skill-audit.mjs', import.meta.url))
const fixture = (t, install = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-skill-audit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'product')
  const skillRoot = path.join(home, 'skills')
  if (install) assert.ok(installBuiltinSkills({ skillRoot }).every(r => r.ok))
  return { dir, home, skillRoot }
}
const checked = (skillRoots, extra = {}) => auditInstalledSkills({ skillRoots, ...extra })
const snapshot = root => fs.readdirSync(root, { recursive: true }).sort().map(rel => {
  const abs = path.join(root, rel)
  const stat = fs.statSync(abs)
  return { rel, mtime: stat.mtimeMs, content: stat.isFile() ? fs.readFileSync(abs).toString('base64') : null }
})

test('WFM-77：真实安装器生成的四套自包含包一致，检查前后内容与 mtime 不变', t => {
  const { skillRoot } = fixture(t)
  const before = snapshot(skillRoot)
  const result = checked([skillRoot])
  assert.equal(result.status, 'PASS')
  assert.equal(result.ok, true)
  assert.equal(result.manifest.length, 4)
  assert.equal(result.results[0].changes.length, 0)
  assert.equal(result.results[0].checkedFiles, result.manifest.reduce((n, item) => n + item.files.length, 0))
  for (const item of result.manifest) {
    assert.ok(item.files.includes('SKILL.md'))
    assert.ok(item.files.includes('script.mjs'))
    assert.ok(item.files.includes('meta.json'))
    assert.ok(item.files.some(file => file.startsWith('roles/')))
    assert.ok(!item.files.includes('vwf-dsl.json'), '编辑器产物不属于安装包')
  }
  assert.deepEqual(snapshot(skillRoot), before, '闸门必须只读')
})

test('WFM-77：模板描述前进但未重装时稳定检出旧安装，并定位首处差异', t => {
  const { dir, skillRoot } = fixture(t)
  const templatesDir = path.join(dir, 'templates')
  fs.cpSync(DEFAULT_TEMPLATES_DIR, templatesDir, { recursive: true })
  const file = path.join(templatesDir, 'wf-explore.json')
  const bp = JSON.parse(fs.readFileSync(file, 'utf8'))
  bp.description += ' [新代描述，尚未重装]'
  fs.writeFileSync(file, JSON.stringify(bp))
  const result = checked([skillRoot], { templatesDir })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.ok, false)
  const drift = result.results[0].changes.find(change => change.template === 'wf-explore' && change.file === 'SKILL.md')
  assert.equal(drift.kind, 'changed')
  assert.ok(drift.diff.line > 0)
  assert.ok(drift.diff.expected.includes('新代描述'))
  assert.ok(!drift.diff.actual.includes('新代描述'))
  assert.notEqual(drift.expectedSha256, drift.installedSha256)
  assert.ok(Number.isFinite(Date.parse(drift.installedMtime)))
  assert.deepEqual(checked([skillRoot], { templatesDir }), result, '同一旧安装反复检查结论稳定')
})

test('WFM-77：脚本、meta、引用角色的变化、漏件和遗留多余文件均被发现', t => {
  const { skillRoot } = fixture(t)
  const dir = path.join(skillRoot, 'wf-explore')
  fs.appendFileSync(path.join(dir, 'script.mjs'), '\n// old engine branch\n')
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}\n')
  const role = fs.readdirSync(path.join(dir, 'roles')).sort()[0]
  fs.unlinkSync(path.join(dir, 'roles', role))
  fs.writeFileSync(path.join(dir, 'roles', 'retired.md'), 'legacy role')
  const result = checked([skillRoot])
  assert.equal(result.status, 'FAIL')
  const changes = result.results[0].changes
  assert.ok(changes.some(c => c.file === 'script.mjs' && c.kind === 'changed'))
  assert.ok(changes.some(c => c.file === 'meta.json' && c.kind === 'changed'))
  assert.ok(changes.some(c => c.file === 'roles/' + role && c.kind === 'missing'))
  assert.ok(changes.some(c => c.file === 'roles/retired.md' && c.kind === 'extra'))
})

test('WFM-77：可达的空安装根或缺失整套模板不能伪装成不可达跳过', t => {
  const { dir, skillRoot } = fixture(t)
  fs.rmSync(path.join(skillRoot, 'wf-optimize'), { recursive: true })
  const result = checked([skillRoot])
  assert.equal(result.status, 'FAIL')
  assert.ok(result.results[0].changes.some(c => c.template === 'wf-optimize' && c.file === 'script.mjs' && c.kind === 'missing'))
  const empty = path.join(dir, 'empty-skills')
  fs.mkdirSync(empty)
  assert.equal(checked([empty]).status, 'FAIL')
})

test('WFM-77：安装根不存在或目录不可读时显式 SKIP，ok 不为 true，也不创建目录', t => {
  const { skillRoot } = fixture(t, false)
  const missing = checked([skillRoot])
  assert.equal(missing.status, 'SKIP')
  assert.equal(missing.ok, false)
  assert.match(missing.results[0].skipReasons[0], /不可达.*ENOENT/)
  assert.equal(fs.existsSync(skillRoot), false)
  const io = { ...fs, statSync: () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }) } }
  const denied = checked([skillRoot], { io })
  assert.equal(denied.status, 'SKIP')
  assert.match(denied.results[0].skipReasons[0], /EACCES/)
})

test('WFM-77：单文件读取受阻不会把其余可读文件的通过泛化为整池通过', t => {
  const { skillRoot } = fixture(t)
  const denied = path.join(skillRoot, 'wf-explore', 'script.mjs')
  const io = { ...fs, readFileSync: (file, ...args) => {
    if (file === denied) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
    return fs.readFileSync(file, ...args)
  } }
  const result = checked([skillRoot], { io })
  assert.equal(result.status, 'SKIP')
  assert.equal(result.ok, false)
  assert.ok(result.results[0].checkedFiles > 0)
  assert.deepEqual(result.results[0].skipReasons, ['wf-explore/script.mjs 不可读取：EACCES'])
})

test('WFM-77：多池分别保留结果，任何未读池使整体 SKIP，任何漂移仍 FAIL', t => {
  const { dir, skillRoot } = fixture(t)
  const absent = path.join(dir, 'absent-pool')
  const partial = checked([skillRoot, absent])
  assert.equal(partial.status, 'SKIP')
  assert.deepEqual(partial.results.map(r => r.status), ['PASS', 'SKIP'])
  fs.appendFileSync(path.join(skillRoot, 'wf-explore', 'SKILL.md'), '\nstale')
  const failed = checked([skillRoot, absent])
  assert.equal(failed.status, 'FAIL')
  assert.deepEqual(failed.results.map(r => r.status), ['FAIL', 'SKIP'])
})

test('WFM-77：不检查用户技能，支持桥接后整个内置技能目录的软链接', t => {
  const { dir, skillRoot } = fixture(t)
  const pool = path.join(dir, 'pool')
  fs.mkdirSync(pool)
  for (const name of fs.readdirSync(skillRoot)) fs.symlinkSync(path.join(skillRoot, name), path.join(pool, name), 'junction')
  fs.mkdirSync(path.join(pool, 'user-workflow'))
  fs.writeFileSync(path.join(pool, 'user-workflow', 'SKILL.md'), '不在正式内置范围内')
  const result = checked([pool])
  assert.equal(result.status, 'PASS')
  assert.equal(result.manifest.length, 4)
})

test('WFM-77：无效或空权威源必须 FAIL，不能借安装环境不可达静默跳过', t => {
  const { dir, skillRoot } = fixture(t, false)
  const templatesDir = path.join(dir, 'templates')
  fs.mkdirSync(templatesDir)
  assert.equal(checked([skillRoot], { templatesDir }).status, 'FAIL')
  fs.writeFileSync(path.join(templatesDir, 'broken.json'), '{')
  const invalid = checked([skillRoot], { templatesDir })
  assert.equal(invalid.status, 'FAIL')
  assert.match(invalid.sourceError, /权威源不可生成/)
})

test('WFM-77 CLI：一致 exit 0、旧安装 exit 1、不可达 exit 0 且明确 SKIP', t => {
  const { dir, home, skillRoot } = fixture(t)
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
  const good = run(['--format', 'json'])
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).status, 'PASS')
  fs.appendFileSync(path.join(skillRoot, 'wf-explore', 'script.mjs'), '\nstale')
  const bad = run([home, '--format', 'json'])
  assert.equal(bad.status, 1, bad.stderr)
  assert.equal(JSON.parse(bad.stdout).status, 'FAIL')
  const absent = run([path.join(dir, 'missing-product')])
  assert.equal(absent.status, 0)
  assert.match(absent.stdout, /SKIP/)
  assert.match(absent.stdout, /SKIP 不等于通过/)
  assert.ok(!absent.stdout.includes('✅'))
})

test('WFM-77 CLI：--pool 追加指定共享池，参数错误非零退出', t => {
  const { dir, home } = fixture(t)
  const pool = path.join(dir, 'pool')
  assert.ok(installBuiltinSkills({ skillRoot: pool }).every(r => r.ok))
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
  const good = run([home, '--pool=' + pool, '--format', 'json'])
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).results.length, 2)
  assert.equal(run(['--format', 'yaml']).status, 1)
  assert.equal(run(['--unknown']).status, 1)
})
