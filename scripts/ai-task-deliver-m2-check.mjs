#!/usr/bin/env node
/**
 * M2 机械验收：单任务交付主链文档/入口/三态/返工上限/实施前检查/验收项执行时机。
 * 用法：node scripts/ai-task-deliver-m2-check.mjs [--root <目录>]
 *   --root 用于指定被检查的根目录（默认 = 本脚本所在仓库根）；测试借它构造临时根，
 *   验证「模板缺字段时检查必须失败」。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootArgIndex = process.argv.indexOf('--root')
const root = rootArgIndex >= 0 ? path.resolve(process.argv[rootArgIndex + 1]) : path.resolve(__dirname, '..')
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
const uatCard = read('docs/design/ai-task-define-delivery/uat-card-template.md')
// 验收项执行时机规则（CHORE-36）：卡片模板必须带「执行时机」字段。缺了它，收口后项会与
// 裁决清单混排，交付操作者照单执行即得到假红灯（2026-09-15 LOC-023 实测）。
// 只断言字段存在性，不解析自由文本——语义正确性由 Definition Check 的人工项与 UAT 演示兜底。
ok(/执行时机/.test(uatCard), 'UAT 卡模板须含「执行时机」字段（验收项执行时机规则，CHORE-36）')
read('docs/design/ai-task-define-delivery/construction-bridge-m2.md')
read('docs/design/ai-task-define-delivery/task-workspace-env.md')

ok(fs.existsSync(path.join(root, 'scripts/ai-task-workspace-env.mjs')), '缺少 ai-task-workspace-env.mjs')

// M2 交付入口的载体 = 正式内置蓝图 + DSH 轨道 runbook。
// 原 `dsh/skills/construction-bootstrap/`（Bootstrap 执行 Profile）已随 #102 收敛退役，
// 九项 shim 的逐项收敛记录见 construction-workflow-portable-contract.md §9.6。
const runbook = read('docs/runbooks/construction-dsh/runbook.md')
ok(/实施前检查/.test(runbook) && /UAT/.test(runbook), 'DSH runbook 须含实施前检查与 UAT')
ok(/已定义/.test(runbook), 'DSH runbook 须从已定义开工')
ok(/conditional_pass|有条件通过/.test(runbook), 'DSH runbook 须含有条件通过')
ok(/auto_rework_limit\s*=\s*3|上限\*\*3\*\*|返工上限\*\*3\*\*|上限 3/.test(runbook), 'DSH runbook 须写明返工 3')
ok(/ai-task-workspace-env|施工环境/.test(runbook), 'DSH runbook 须提及施工环境/工作区解析')
ok(/wf_run/.test(runbook), 'DSH runbook 须以 wf_run 为起跑入口（引擎驱动，不由会话手工路由）')
ok(/user_accepted/.test(runbook) === false || /禁止.*user_accepted|废弃.*user_accepted/.test(runbook), 'DSH runbook 不得仍把 user_accepted 当正式路径')
ok(!/construction-bootstrap/.test(runbook), 'DSH runbook 不得再指向已退役的 construction-bootstrap Profile')

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
