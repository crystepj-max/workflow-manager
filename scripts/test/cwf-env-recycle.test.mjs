// cwf-env-recycle.mjs：定向回收（双证归属、占用拒删）与 GC 兜底（dry-run 默认、--force 只删合格项）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { allocateDevDshHome, envResourcesFor, DEV_DSH_HOME_MARKER } from '../cwf-run-init.mjs'
import { recycleRunHome, renderRecycleReport, scanTaskHomes, gcTaskHomes, DEFAULT_MAX_AGE_DAYS } from '../cwf-env-recycle.mjs'

const scriptPath = fileURLToPath(new URL('../cwf-env-recycle.mjs', import.meta.url))
const noOccupancy = () => []
const identity = (runId) => ({ run_id: runId, issue_or_task_identity: '#185', work_branch: `dev-${runId}`, workspace_id: `wt-dev-${runId}`, repository: 'org/repo' })

function setupRun(runId, { registeredAt = '2026-09-01T00:00:00.000Z' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cwf-recycle-'))
  const home = allocateDevDshHome({ tasksRoot: root, identity: identity(runId), now: () => new Date(registeredAt) })
  const run = { run_id: runId, work_branch: `dev-${runId}`, env_resources: envResourcesFor(home) }
  return { root, home, run }
}

test('recycle：run.json 与 marker 归属一致且无占用 → 删除 Home 并给出 recycled', () => {
  const { home, run } = setupRun('cwf-185-01')
  const result = recycleRunHome(run, { occupancy: noOccupancy, now: () => new Date('2026-09-08T06:00:00.000Z') })
  assert.equal(result.status, 'recycled')
  assert.equal(result.ok, true)
  assert.equal(result.marker_run_id, 'cwf-185-01')
  assert.equal(result.recycled_at, '2026-09-08T06:00:00.000Z')
  assert.equal(existsSync(home.path), false)
  assert.match(renderRecycleReport(result), /环境回收.*\n.*\n- 独占开发 DSH Home：.*✅ 已回收/s)
})

test('recycle：无登记 / 已回收 / 目录已不存在 三种非动作状态均 ok 且不删除任何东西', () => {
  assert.equal(recycleRunHome({ run_id: 'old-run' }, { occupancy: noOccupancy }).status, 'nothing_registered')
  const { home, run } = setupRun('cwf-185-02')
  const already = recycleRunHome({ ...run, env_resources: { dev_dsh_home: { ...run.env_resources.dev_dsh_home, recycled_at: 'x' } } }, { occupancy: noOccupancy })
  assert.equal(already.status, 'already_recycled')
  assert.equal(existsSync(home.path), true, '已回收登记不得再动目录')
  const missing = recycleRunHome({ ...run, env_resources: { dev_dsh_home: { path: join(home.path, 'nope') } } }, { occupancy: noOccupancy })
  assert.equal(missing.status, 'missing')
  assert.equal(missing.ok, true)
})

test('recycle：marker 归属他人 / 缺失 / 损坏 → refused 且目录原样保留', () => {
  const { home, run } = setupRun('cwf-185-03')
  const removed = []
  const remove = (p) => removed.push(p)
  writeFileSync(home.marker, JSON.stringify({ run_id: 'cwf-999-01' }))
  const other = recycleRunHome(run, { occupancy: noOccupancy, remove })
  assert.equal(other.status, 'refused')
  assert.match(other.reason, /归属 cwf-999-01 ≠ 本 Run cwf-185-03/)
  writeFileSync(home.marker, '{broken')
  assert.match(recycleRunHome(run, { occupancy: noOccupancy, remove }).reason, /marker 损坏/)
  const bare = mkdtempSync(join(tmpdir(), 'cwf-recycle-bare-'))
  const noMarker = recycleRunHome({ run_id: 'cwf-185-03', env_resources: { dev_dsh_home: { path: bare } } }, { occupancy: noOccupancy, remove })
  assert.equal(noMarker.status, 'refused')
  assert.match(noMarker.reason, /无归属 marker/)
  assert.deepEqual(removed, [], '拒绝态不得调用删除')
  assert.equal(existsSync(home.path), true)
})

test('recycle：仍有进程占用 → occupied，不删除并列出 PID', () => {
  const { home, run } = setupRun('cwf-185-04')
  const result = recycleRunHome(run, { occupancy: () => [4242, 4243] })
  assert.equal(result.status, 'occupied')
  assert.equal(result.ok, false)
  assert.deepEqual(result.occupants, [4242, 4243])
  assert.equal(existsSync(home.path), true)
  assert.match(renderRecycleReport(result), /⚠️ 仍被占用，未删除[\s\S]*PID 4242, 4243/)
})

function setupGcRoot(now) {
  const root = mkdtempSync(join(tmpdir(), 'cwf-gc-'))
  const days = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)
  allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-1-01'), now: () => days(30) }) // 过期
  allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-2-01'), now: () => days(2) })  // 新鲜
  allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-3-01'), now: () => days(40) }) // 过期但被占用
  mkdirSync(join(root, 'orphan-no-marker'))                                                   // 无 marker
  const old = days(60)
  utimesSync(join(root, 'orphan-no-marker'), old, old)
  writeFileSync(join(root, 'stray-file.txt'), 'x')                                             // 非目录，忽略
  return root
}

test('gc dry-run：只列清单不删除；过期无占用有 marker 才 eligible；无 marker 标注请人工确认', () => {
  const now = new Date('2026-09-08T06:00:00.000Z')
  const root = setupGcRoot(now)
  const occupancy = (home) => (home.endsWith('cwf-3-01') ? [777] : [])
  const out = gcTaskHomes(root, { occupancy, now: () => now })
  assert.equal(out.mode, 'dry-run')
  assert.equal(out.max_age_days, DEFAULT_MAX_AGE_DAYS)
  assert.deepEqual(out.deleted, [])
  const byId = Object.fromEntries(out.entries.map((e) => [e.run_id ?? e.home.split('/').pop(), e]))
  assert.equal(byId['cwf-1-01'].eligible, true)
  assert.equal(byId['cwf-1-01'].age_days, 30)
  assert.equal(byId['cwf-2-01'].eligible, false)
  assert.match(byId['cwf-2-01'].note, /未过期/)
  assert.equal(byId['cwf-3-01'].eligible, false)
  assert.deepEqual(byId['cwf-3-01'].occupants, [777])
  assert.equal(byId['orphan-no-marker'].has_marker, false)
  assert.equal(byId['orphan-no-marker'].eligible, false)
  assert.match(byId['orphan-no-marker'].needs_human, /无 marker/)
  assert.equal(byId['orphan-no-marker'].age_days >= 59, true, '无 marker 按目录 mtime 兜底计龄')
  assert.equal(out.entries.length, 4, '非目录条目不计入')
  for (const e of out.entries) assert.equal(existsSync(e.home), true)
})

test('gc --force：只删 eligible；新鲜 / 占用 / 无 marker 一律保留；阈值可调', () => {
  const now = new Date('2026-09-08T06:00:00.000Z')
  const root = setupGcRoot(now)
  const occupancy = (home) => (home.endsWith('cwf-3-01') ? [777] : [])
  const out = gcTaskHomes(root, { force: true, occupancy, now: () => now })
  assert.deepEqual(out.deleted, [join(root, 'cwf-1-01')])
  assert.equal(existsSync(join(root, 'cwf-1-01')), false)
  assert.equal(existsSync(join(root, 'cwf-2-01')), true)
  assert.equal(existsSync(join(root, 'cwf-3-01')), true)
  assert.equal(existsSync(join(root, 'orphan-no-marker')), true)
  // 阈值调到 1 天：新鲜项（2 天）也过期，但仍不动占用与无 marker
  const again = gcTaskHomes(root, { force: true, occupancy, now: () => now, maxAgeDays: 1 })
  assert.deepEqual(again.deleted, [join(root, 'cwf-2-01')])
  assert.equal(existsSync(join(root, 'cwf-3-01')), true)
  assert.equal(existsSync(join(root, 'orphan-no-marker')), true)
  assert.deepEqual(scanTaskHomes(join(root, 'not-exist')), [])
})

test('CLI recycle：回收后 run.json 登记 recycled_at，--report 追加环境回收小节；重复执行为 already_recycled', () => {
  const { root, home, run } = setupRun('cwf-185-05')
  const runDir = join(root, 'run')
  mkdirSync(runDir)
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2))
  const report = join(runDir, 'cleanup-report.md')
  writeFileSync(report, '# cleanup\n')
  const first = spawnSync(process.execPath, [scriptPath, 'recycle', runDir, '--report', report], { encoding: 'utf-8', env: { ...process.env, VWF_DEV_LSOF_BIN: '/nonexistent/lsof' } })
  assert.equal(first.status, 0, first.stderr)
  const result = JSON.parse(first.stdout)
  assert.equal(result.status, 'recycled')
  assert.equal(existsSync(home.path), false)
  const saved = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(saved.env_resources.dev_dsh_home.recycled_at, result.recycled_at)
  assert.match(readFileSync(report, 'utf-8'), /## 环境回收（#185 任务环境隔离）[\s\S]*✅ 已回收/)
  const second = spawnSync(process.execPath, [scriptPath, 'recycle', runDir], { encoding: 'utf-8', env: { ...process.env, VWF_DEV_LSOF_BIN: '/nonexistent/lsof' } })
  assert.equal(second.status, 0)
  assert.equal(JSON.parse(second.stdout).status, 'already_recycled')
})

test('CLI recycle：归属不符 exit 1 且不动目录；gc CLI 默认 dry-run exit 0', () => {
  const { root, home, run } = setupRun('cwf-185-06')
  writeFileSync(home.marker, JSON.stringify({ run_id: 'cwf-777-01' }))
  const runDir = join(root, 'run')
  mkdirSync(runDir)
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  const refused = spawnSync(process.execPath, [scriptPath, 'recycle', runDir], { encoding: 'utf-8', env: { ...process.env, VWF_DEV_LSOF_BIN: '/nonexistent/lsof' } })
  assert.equal(refused.status, 1)
  assert.equal(JSON.parse(refused.stdout).status, 'refused')
  assert.equal(existsSync(home.path), true)
  const gc = spawnSync(process.execPath, [scriptPath, 'gc', '--root', root, '--max-age-days', '0'], { encoding: 'utf-8', env: { ...process.env, VWF_DEV_LSOF_BIN: '/nonexistent/lsof' } })
  assert.equal(gc.status, 0, gc.stderr)
  const out = JSON.parse(gc.stdout)
  assert.equal(out.mode, 'dry-run')
  assert.deepEqual(out.deleted, [])
  assert.equal(existsSync(home.path), true)
  const bad = spawnSync(process.execPath, [scriptPath, 'gc', '--max-age-days', '-3'], { encoding: 'utf-8' })
  assert.equal(bad.status, 2)
})
