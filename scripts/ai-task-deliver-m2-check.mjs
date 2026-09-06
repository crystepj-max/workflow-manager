#!/usr/bin/env node
/**
 * M2 机械验收：单任务交付主链文档/入口/三态/返工上限/实施前检查。
 * 用法：node scripts/ai-task-deliver-m2-check.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const errors = []
function fail(msg) { errors.push(msg) }
function ok(cond, msg) { if (!cond) fail(msg) }
function read(rel) {
  const p = path.join(root, rel)
  ok(fs.existsSync(p), `缺少: ${rel}`)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

const m2 = read('docs/design/ai-task-define-delivery/single-task-delivery-m2.md')
ok(/实施前检查/.test(m2) && /WAITING_HUMAN|等待验收/.test(m2), 'M2 文档须含实施前检查与等待验收')
ok(/auto_rework_limit\s*=\s*3|上限\*\*3\*\*|返工上限\*\*3\*\*/.test(m2), 'M2 须写明返工上限 3')
ok(/conditional_pass|有条件通过/.test(m2), 'M2 须含有条件通过')
ok(/定义外置|已定义/.test(m2), 'M2 须声明定义外置/已定义开工')

read('docs/design/ai-task-define-delivery/preflight-check.md')
read('docs/design/ai-task-define-delivery/uat-card-template.md')
read('docs/design/ai-task-define-delivery/construction-bridge-m2.md')

const skill = read('dsh/skills/construction-bootstrap/SKILL.md')
ok(/实施前检查/.test(skill), '建设 Skill 须含实施前检查')
ok(/已定义/.test(skill), '建设 Skill 须从已定义开工')
ok(/conditional_pass|有条件通过/.test(skill), '建设 Skill 须含有条件通过')
ok(/auto_rework_limit\s*=\s*3|上限\*\*3\*\*|返工上限\*\*3\*\*/.test(skill), '建设 Skill 须写明返工 3')
ok(!/本 Profile 主链尚未跳过 requirements/.test(skill), '不得再声称主链尚未跳过 requirements')

const runbook = read('dsh/skills/construction-bootstrap/runbook.md')
ok(/实施前检查/.test(runbook) && /UAT/.test(runbook), 'runbook 须含实施前检查与 UAT')
ok(/conditional_pass/.test(runbook), 'runbook 须含 conditional_pass')
ok(/user_accepted/.test(runbook) === false || /禁止.*user_accepted|废弃.*user_accepted/.test(runbook), 'runbook 不得仍把 user_accepted 当正式路径')

const schema = read('docs/design/construction-workflow/handoff.schema.json')
ok(/"conditional_pass"/.test(schema), 'schema 须含 conditional_pass')
ok(!/"user_accepted"/.test(schema), 'schema 不得再含 user_accepted 枚举')

const preflight = path.join(root, 'scripts/ai-task-preflight-check.mjs')
ok(fs.existsSync(preflight), '缺少 ai-task-preflight-check.mjs')

const fixtures = path.join(root, 'scripts/test/fixtures/ai-task-define-m1')
for (const name of ['simple-clear-cache', 'complex-with-decisions']) {
  const issue = path.join(fixtures, name, 'issue-basics.md')
  const spec = path.join(fixtures, name, 'task-spec-V1.md')
  const r = spawnSync(process.execPath, [preflight, issue, spec, '--run-baseline', 'V1'], { encoding: 'utf8' })
  ok(r.status === 0, `预检应通过: ${name}\n${r.stdout}\n${r.stderr}`)
  if (r.status === 0) ok(/"auto_rework_limit": 3/.test(r.stdout), `${name} 预检输出须含 auto_rework_limit: 3`)
}

// 负例：非已定义应失败
const tmp = path.join(root, 'scripts/test/fixtures/ai-task-define-m1/.tmp-bad-issue.md')
const goodIssue = fs.readFileSync(path.join(fixtures, 'simple-clear-cache', 'issue-basics.md'), 'utf8')
fs.writeFileSync(tmp, goodIssue.replace('已定义', '定义中'))
const bad = spawnSync(process.execPath, [
  preflight, tmp, path.join(fixtures, 'simple-clear-cache', 'task-spec-V1.md'),
], { encoding: 'utf8' })
ok(bad.status !== 0, '非已定义任务预检必须失败')
try { fs.unlinkSync(tmp) } catch { /* ignore */ }

if (errors.length) {
  console.error('M2 检查失败：')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, milestone: 'M2', auto_rework_limit: 3, acceptance: ['accept', 'reject', 'conditional_pass'] }, null, 2))
