#!/usr/bin/env node
/**
 * M3 机械验收：Execution Plan 文档/Skill/场景1（并发=2 补位）/有依赖未纳入。
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

const doc = read('docs/design/ai-task-define-delivery/execution-plan-m3.md')
ok(/最大并发/.test(doc) && /补位/.test(doc) && /批次汇总/.test(doc), 'M3 文档须含并发/补位/汇总')
ok(/不做需求分析|不负责需求分析|不.*需求分析/.test(doc) || /定位.*不/.test(doc), 'M3 须声明不做需求分析')

const skill = read('dsh/skills/execution-plan/SKILL.md')
ok(/Execution Plan|批量/.test(skill), '须有 execution-plan Skill')
ok(/最大并发|补位|快照/.test(skill), 'Skill 须含并发/补位/快照')
ok(/不做.*需求|不负责.*需求|不做需求分析/.test(skill), 'Skill 须禁止做需求分析')

const plan = path.join(root, 'scripts/ai-task-execution-plan.mjs')
ok(fs.existsSync(plan), '缺少 ai-task-execution-plan.mjs')

const fix = path.join(root, 'scripts/test/fixtures/ai-task-execution-plan-m3')
const batch = path.join(fix, 'batch.json')
const events = path.join(fix, 'events-scene1.json')
const r = spawnSync(process.execPath, [plan, batch, '--simulate', events], { encoding: 'utf8' })
ok(r.status === 0, `场景1 应成功\n${r.stdout}\n${r.stderr}`)
let out = {}
try { out = JSON.parse(r.stdout) } catch (e) { fail('场景1 输出非 JSON: ' + e.message) }
ok(out.autoPhaseDone === true, '场景1 自动施工应结束')
ok(JSON.stringify(out.launchOrder) === JSON.stringify(['A', 'B', 'C']), `启动序应为 A,B,C（A 释放后补 C），got ${JSON.stringify(out.launchOrder)}`)
ok(out.waiting && out.waiting.includes('A') && out.waiting.includes('B'), 'A/B 应在等待验收')
ok(out.completed && out.completed.includes('C'), 'C 应已完成')

// 有依赖未纳入
const batchDep = {
  name: 'm3-dep',
  maxConcurrency: 2,
  candidates: [
    { id: 'A', issueBasics: 'A/issue-basics.md', taskSpec: 'A/task-spec-V1.md' },
    { id: 'D', issueBasics: 'D/issue-basics.md', taskSpec: 'D/task-spec-V1.md' },
  ],
}
const tmpBatch = path.join(fix, '.tmp-batch-dep.json')
fs.writeFileSync(tmpBatch, JSON.stringify(batchDep, null, 2))
const r2 = spawnSync(process.execPath, [plan, tmpBatch], { encoding: 'utf8' })
ok(r2.status === 0, `依赖场景 dry-run 应成功\n${r2.stderr}`)
let out2 = {}
try { out2 = JSON.parse(r2.stdout) } catch (e) { fail('依赖场景输出非 JSON') }
ok(out2.excluded && out2.excluded.some((x) => x.id === 'D' && /前置依赖|暂不支持/.test(x.reason || '')), 'D 应未纳入并说明依赖')
ok(out2.snapshotIds && out2.snapshotIds.includes('A') && !out2.snapshotIds.includes('D'), '快照应含 A 不含 D')
try { fs.unlinkSync(tmpBatch) } catch { /* ignore */ }

if (errors.length) {
  console.error('M3 检查失败：')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, milestone: 'M3', scene1: { launchOrder: out.launchOrder, waiting: out.waiting, completed: out.completed } }, null, 2))
