// cwf-env-recycle.mjs（决策六：单实例 + 任务命名隔离）
// 覆盖：激活登记门禁、精确命名空间回收、未回收项如实上报、只读预演、CLI 行为
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { envResourcesFor } from '../cwf-run-init.mjs'
import { writeActiveTask } from '../workspace-paths.mjs'
import { recycleRun, recycleTargets, renderRecycleReport } from '../cwf-env-recycle.mjs'

const scriptPath = fileURLToPath(new URL('../cwf-env-recycle.mjs', import.meta.url))

/** 造一个开发 Home 现场：本任务的工作区记录 + 登记册条目 + 旧独占 Home 遗留 + 他人条目 */
function setupDevHome(ns = 'loc-020-r1') {
  const devHome = mkdtempSync(join(tmpdir(), 'cwf-recycle-'))
  mkdirSync(join(devHome, 'tasks', ns), { recursive: true })
  writeFileSync(join(devHome, 'tasks', ns, 'task-env.json'), JSON.stringify({ run_id: ns }))
  mkdirSync(join(devHome, 'workspaces', 'records', ns), { recursive: true })
  writeFileSync(join(devHome, 'workspaces', 'records', ns, 'identity.json'), '{}')
  mkdirSync(join(devHome, 'workspaces', 'records', 'someone-else'), { recursive: true })
  mkdirSync(join(devHome, 'workspaces', '.vwf-registry'), { recursive: true })
  writeFileSync(
    join(devHome, 'workspaces', '.vwf-registry', 'state.json'),
    JSON.stringify({
      workspaces: {
        [ns]: { logical_run_id: ns, workspace_path: `/gone/ws-${ns}` },
        'someone-else': { logical_run_id: 'someone-else' },
      },
    }, null, 2),
  )
  mkdirSync(join(devHome, 'visual-workflow', 'logical-runs'), { recursive: true })
  writeFileSync(join(devHome, 'visual-workflow', 'logical-runs', `${ns}.json`), '{}')
  return devHome
}

const runFor = (ns) => ({ run_id: ns, env_resources: envResourcesFor(ns) })

test('recycleTargets：只按精确命名空间匹配——不误伤他人条目', () => {
  const ns = 'loc-020-r1'
  const devHome = setupDevHome(ns)
  const plan = recycleTargets(runFor(ns), devHome)
  const byKind = Object.fromEntries(plan.targets.map((t) => [t.kind, t]))
  assert.equal(plan.namespace, ns)
  assert.equal(byKind.legacy_home_dir.path, join(devHome, 'tasks', ns))
  assert.equal(byKind.legacy_home_dir.exists, true)
  assert.equal(byKind.workspace_records_dir.exists, true)
  assert.deepEqual(byKind.workspace_registry_entries.keys, [ns])
  // 运行记录只列入清单、不进入删除集合
  assert.deepEqual(plan.reported, [join(devHome, 'visual-workflow', 'logical-runs', `${ns}.json`)])
  assert.equal(plan.targets.some((t) => t.path.includes('someone-else')), false)
})

test('recycle：激活登记中无「已停用注销」记录 → refused，一个字节都不动', () => {
  const ns = 'loc-020-r1'
  const devHome = setupDevHome(ns)
  const removed = []
  const result = recycleRun(runFor(ns), devHome, { remove: (p) => removed.push(p) })
  assert.equal(result.status, 'refused')
  assert.equal(result.ok, false)
  assert.match(result.reason, /无法证明本任务的插件已停用/)
  assert.match(result.reason, /dev:plugin -- stop --task loc-020-r1/)
  assert.deepEqual(removed, [])
  assert.equal(existsSync(join(devHome, 'tasks', ns)), true)
})

test('recycle：已登记注销 → 清本任务项，他人条目与运行记录原样保留', () => {
  const ns = 'loc-020-r1'
  const devHome = setupDevHome(ns)
  writeActiveTask(devHome, {
    current: null,
    releases: [{ namespace: ns, released_at: '2026-09-13T12:00:00.000Z', unresolved: null }],
  })
  const result = recycleRun(runFor(ns), devHome, { now: () => new Date('2026-09-13T12:10:00.000Z') })
  assert.equal(result.status, 'recycled')
  assert.equal(result.recycled_at, '2026-09-13T12:10:00.000Z')
  assert.equal(existsSync(join(devHome, 'tasks', ns)), false)
  assert.equal(existsSync(join(devHome, 'workspaces', 'records', ns)), false)
  const registry = JSON.parse(readFileSync(join(devHome, 'workspaces', '.vwf-registry', 'state.json'), 'utf-8'))
  assert.deepEqual(Object.keys(registry.workspaces), ['someone-else'])
  // 他人现场与运行记录不动
  assert.equal(existsSync(join(devHome, 'workspaces', 'records', 'someone-else')), true)
  assert.equal(existsSync(join(devHome, 'visual-workflow', 'logical-runs', `${ns}.json`)), true)
  assert.match(renderRecycleReport(result), /决策六：单实例 \+ 任务命名隔离[\s\S]*✅ 已回收/)
  assert.match(renderRecycleReport(result), /仅列出未处理/)
})

test('recycle：停用未完成（unresolved）→ 判定为未回收（exit 1），原因进报告——不得谎报', () => {
  const ns = 'loc-020-r2'
  const devHome = setupDevHome(ns)
  writeActiveTask(devHome, {
    current: null,
    releases: [{ namespace: ns, released_at: '2026-09-13T12:00:00.000Z', unresolved: '归属会话已消失，插件面板里仍可见' }],
  })
  const result = recycleRun(runFor(ns), devHome)
  assert.equal(result.ok, false, '未完成「已停用并注销」不得视为收口完成')
  assert.equal(result.status, 'recycled_unresolved')
  assert.match(result.reason, /停用未完成：归属会话已消失/)
  assert.match(result.reason, /需人工在 DSH 插件面板中清理/)
  const report = renderRecycleReport(result)
  assert.match(report, /❌ 未回收（插件停用未完成，需人工在插件面板清理）/)
  assert.match(report, /插件停用注销：未完成（归属会话已消失/)
})

test('recycle：无登记（早于本改造的 Run）与已回收登记 → 幂等非动作', () => {
  const devHome = mkdtempSync(join(tmpdir(), 'cwf-recycle-'))
  assert.equal(recycleRun({ run_id: 'old-run' }, devHome).status, 'nothing_registered')
  const run = runFor('loc-020-r3')
  run.env_resources.recycled_at = '2026-09-13T12:00:00.000Z'
  const again = recycleRun(run, devHome)
  assert.equal(again.status, 'already_recycled')
  assert.equal(again.ok, true)
})

test('recycle：dryRun 只预演，不调用删除', () => {
  const ns = 'loc-020-r4'
  const devHome = setupDevHome(ns)
  writeActiveTask(devHome, {
    current: null,
    releases: [{ namespace: ns, released_at: '2026-09-13T12:00:00.000Z', unresolved: null }],
  })
  const removed = []
  const result = recycleRun(runFor(ns), devHome, { dryRun: true, remove: (p) => removed.push(p) })
  assert.equal(result.status, 'planned')
  assert.deepEqual(removed, [])
  assert.equal(existsSync(join(devHome, 'tasks', ns)), true)
  assert.match(renderRecycleReport(result), /ℹ️ 预演（未改动）/)
})

test('CLI recycle：回收后写回 recycled_at 并追加报告；plan 只读且不改动', () => {
  const ns = 'loc-020-r5'
  const devHome = setupDevHome(ns)
  writeActiveTask(devHome, {
    current: null,
    releases: [{ namespace: ns, released_at: '2026-09-13T12:00:00.000Z', unresolved: null }],
  })
  const runDir = join(devHome, 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runFor(ns), null, 2))
  const report = join(runDir, 'cleanup-report.md')
  writeFileSync(report, '# cleanup\n')
  const env = { ...process.env, VWF_DEV_DSH_HOME: devHome }

  const planned = spawnSync(process.execPath, [scriptPath, 'plan', runDir], { encoding: 'utf-8', env })
  assert.equal(planned.status, 0, planned.stderr)
  assert.equal(JSON.parse(planned.stdout).status, 'planned')
  assert.equal(existsSync(join(devHome, 'tasks', ns)), true)

  const first = spawnSync(process.execPath, [scriptPath, 'recycle', runDir, '--report', report], { encoding: 'utf-8', env })
  assert.equal(first.status, 0, first.stderr)
  const result = JSON.parse(first.stdout)
  assert.equal(result.status, 'recycled')
  assert.equal(existsSync(join(devHome, 'tasks', ns)), false)
  const saved = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(saved.env_resources.recycled_at, result.recycled_at)
  assert.match(readFileSync(report, 'utf-8'), /## 环境回收（决策六：单实例 \+ 任务命名隔离）[\s\S]*✅ 已回收/)

  const second = spawnSync(process.execPath, [scriptPath, 'recycle', runDir], { encoding: 'utf-8', env })
  assert.equal(second.status, 0)
  assert.equal(JSON.parse(second.stdout).status, 'already_recycled')
})

test('CLI recycle：停用未完成 exit 1、残留原因写进 run.json，人工清理后再次回收才成功', () => {
  const ns = 'loc-020-r7'
  const devHome = setupDevHome(ns)
  writeActiveTask(devHome, {
    current: null,
    releases: [{ namespace: ns, released_at: '2026-09-13T12:00:00.000Z', unresolved: '归属会话已消失' }],
  })
  const runDir = join(devHome, 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runFor(ns), null, 2))
  const env = { ...process.env, VWF_DEV_DSH_HOME: devHome }

  const first = spawnSync(process.execPath, [scriptPath, 'recycle', runDir], { encoding: 'utf-8', env })
  assert.equal(first.status, 1, first.stderr)
  const refused = JSON.parse(first.stdout)
  assert.equal(refused.status, 'recycled_unresolved')
  const saved = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.equal(saved.env_resources.recycle_unresolved, '归属会话已消失')
  assert.equal(saved.env_resources.recycled_at, undefined)

  // 人工在面板清理后重新登记（去掉 --unresolved），再次回收放行
  writeActiveTask(devHome, {
    current: null,
    releases: [{ namespace: ns, released_at: '2026-09-13T12:30:00.000Z', unresolved: null }],
  })
  const second = spawnSync(process.execPath, [scriptPath, 'recycle', runDir], { encoding: 'utf-8', env })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(JSON.parse(second.stdout).status, 'recycled')
  const final = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
  assert.ok(final.env_resources.recycled_at)
})

test('CLI recycle：未登记注销 exit 1 且不动任何目录；参数非法 exit 2', () => {
  const ns = 'loc-020-r6'
  const devHome = setupDevHome(ns)
  const runDir = join(devHome, 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runFor(ns)))
  const refused = spawnSync(process.execPath, [scriptPath, 'recycle', runDir], {
    encoding: 'utf-8',
    env: { ...process.env, VWF_DEV_DSH_HOME: devHome },
  })
  assert.equal(refused.status, 1)
  assert.equal(JSON.parse(refused.stdout).status, 'refused')
  assert.equal(existsSync(join(devHome, 'tasks', ns)), true)
  const bad = spawnSync(process.execPath, [scriptPath, 'gc'], { encoding: 'utf-8' })
  assert.equal(bad.status, 2, 'gc 已退役，不再是被识别的子命令')
})
