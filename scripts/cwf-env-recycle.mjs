#!/usr/bin/env node
// 任务环境回收（约定 §决策六：单实例 + 任务命名隔离）。
//
// 与 #185 时代的区别：开发 DSH 已单实例化、不再有每 Run 独占 Home，
// 因此回收语义从「按归属双证删除整个 Home」简化为：
//   ① 确认本任务的插件已停用并注销（依据 dev-plugin 的激活登记）
//   ② 清掉本任务在开发 Home 内独占的登记与工作区记录
//   ③ 输出可核对的回收报告（含未回收项与原因，不得谎报）
//
// 用法：
//   node scripts/cwf-env-recycle.mjs plan <runDir>
//       —— 只读预演：列出将清项，不改动任何文件
//   node scripts/cwf-env-recycle.mjs recycle <runDir> [--report <cleanup-report.md>]
//       —— 执行回收。exit 0 = 已回收 / 无登记 / 已回收过；exit 1 = 拒绝或未完成

import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  devDshHome, readActiveTask, releaseFor, pluginNamespaceFor,
} from './workspace-paths.mjs'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/**
 * 计算回收目标（纯逻辑，可注入 exists/readdir 供测试）。
 * 只认「精确命名空间匹配」——不按模糊前缀删除任何东西。
 */
export function recycleTargets(run, devHome, { exists = existsSync, readdir = readdirSync } = {}) {
  const ns = run?.env_resources?.plugin_namespace
  if (!ns) return null
  const targets = []

  const push = (kind, path, note) => {
    targets.push({ kind, path, exists: exists(path), note })
  }

  // ① #185 遗留的独占 Home 目录（过渡期一并收敛）
  push('legacy_home_dir', join(devHome, 'tasks', ns), '旧「每 Run 独占 Home」时代的遗留目录')

  // ② 工作区记录目录（DSH 侧按 logical_run_id 存放）
  push('workspace_records_dir', join(devHome, 'workspaces', 'records', ns), '本任务的工作区记录')

  // ③ 工作区登记册条目
  const registryPath = join(devHome, 'workspaces', '.vwf-registry', 'state.json')
  let registryKeys = []
  if (exists(registryPath)) {
    try {
      const registry = readJson(registryPath)
      registryKeys = Object.entries(registry.workspaces || {})
        .filter(([key, v]) => key === ns || key === `ws-${ns}` || v.logical_run_id === ns)
        .map(([key]) => key)
    } catch {
      registryKeys = []
    }
  }
  targets.push({
    kind: 'workspace_registry_entries',
    path: registryPath,
    exists: exists(registryPath),
    keys: registryKeys,
    note: `本任务在登记册中的条目（${registryKeys.length} 条）`,
  })

  // ④ 仅列出、不删除：同属本任务但属「运行记录」范畴的文件（证据/归档另有机制）
  const reported = []
  const logicalRunsDir = join(devHome, 'visual-workflow', 'logical-runs')
  if (exists(logicalRunsDir)) {
    for (const name of readdir(logicalRunsDir)) {
      if (name === `${ns}.json`) reported.push(join(logicalRunsDir, name))
    }
  }
  return { namespace: ns, targets, reported }
}

/**
 * 定向回收：纯逻辑，可注入 remove / now 供测试。
 * 门禁：激活登记里必须已有本任务的「已停用注销」记录；否则拒绝（不猜、不静默）。
 */
export function recycleRun(run, devHome, {
  remove = (p) => rmSync(p, { recursive: true, force: true }),
  now = () => new Date(),
  dryRun = false,
} = {}) {
  const res = run?.env_resources
  if (!res?.plugin_namespace) {
    return {
      ok: true,
      status: 'nothing_registered',
      message: 'run.json 未登记插件命名空间（早于本改造的 Run），无需回收',
    }
  }
  if (res.recycled_at) {
    return { ok: true, status: 'already_recycled', namespace: res.plugin_namespace, recycled_at: res.recycled_at }
  }

  const namespace = pluginNamespaceFor(res.plugin_namespace)
  const ledger = readActiveTask(devHome)
  const release = releaseFor(ledger, namespace)

  if (!release) {
    return {
      ok: false,
      status: 'refused',
      namespace,
      reason:
        `激活登记中没有 ${namespace} 的「已停用注销」记录：无法证明本任务的插件已停用。` +
        '请先在 DSH 会话中 cordis_stop + cordis_undefine，再执行 ' +
        `npm run dev:plugin -- stop --task ${namespace}（停不掉时加 --unresolved "<原因>" 如实登记）。`,
    }
  }

  const plan = recycleTargets(run, devHome)
  if (dryRun) {
    return {
      ok: true,
      status: 'planned',
      namespace,
      targets: plan.targets,
      reported: plan.reported,
      release,
    }
  }

  const removed = []
  const skipped = []
  for (const target of plan.targets) {
    if (target.kind === 'workspace_registry_entries') {
      if (!target.exists || target.keys.length === 0) {
        skipped.push({ path: target.path, reason: '登记册无本任务条目' })
        continue
      }
      try {
        const registry = readJson(target.path)
        for (const key of target.keys) delete registry.workspaces[key]
        writeFileSync(target.path, JSON.stringify(registry, null, 2) + '\n')
        removed.push({ path: target.path, kind: target.kind, keys: target.keys })
      } catch (error) {
        skipped.push({ path: target.path, reason: `写入失败：${error.message}` })
      }
      continue
    }
    if (!target.exists) {
      skipped.push({ path: target.path, reason: '不存在（可能已被清理）' })
      continue
    }
    remove(target.path)
    removed.push({ path: target.path, kind: target.kind })
  }

  const recycled_at = now().toISOString()

  // 停用未完成：登记与工作区记录虽已清，但本任务的插件并未真正停用——按业务规则
  // 「未完成『已停用并注销』不得视为收口完成」，此处必须判定为未回收（exit 1），
  // 否则收口会把残留插件谎报成已回收。
  if (release.unresolved) {
    return {
      ok: false,
      status: 'recycled_unresolved',
      namespace,
      removed,
      skipped,
      reported: plan.reported,
      release,
      reason:
        `本任务插件停用未完成：${release.unresolved}。` +
        '需人工在 DSH 插件面板中清理该动态包后，重新执行 ' +
        `npm run dev:plugin -- stop --task ${namespace}（去掉 --unresolved）并再次回收。`,
    }
  }

  return {
    ok: true,
    status: 'recycled',
    namespace,
    removed,
    skipped,
    reported: plan.reported,
    release,
    recycled_at,
  }
}

export function renderRecycleReport(result) {
  const lines = ['', '## 环境回收（决策六：单实例 + 任务命名隔离）', '']
  const label = {
    recycled: '✅ 已回收',
    recycled_unresolved: '❌ 未回收（插件停用未完成，需人工在插件面板清理）',
    planned: 'ℹ️ 预演（未改动）',
    nothing_registered: 'ℹ️ 无登记资源',
    already_recycled: 'ℹ️ 此前已回收',
    refused: '❌ 拒绝回收',
  }[result.status] || result.status
  lines.push(`- 任务命名空间：${result.namespace || '—'} —— ${label}`)
  if (result.release) {
    lines.push(
      `- 插件停用注销：${
        result.release.unresolved
          ? `未完成（${result.release.unresolved}）`
          : `已登记（${result.release.released_at}）`
      }`,
    )
  }
  if (result.removed?.length) {
    for (const r of result.removed) {
      lines.push(`- 已清：${r.path}${r.keys ? `（条目 ${r.keys.join('、')}）` : ''}`)
    }
  }
  if (result.skipped?.length) {
    for (const s of result.skipped) lines.push(`- 未清：${s.path} —— ${s.reason}`)
  }
  if (result.reported?.length) {
    lines.push('- 仅列出未处理（属运行记录，由证据/归档机制管理）：')
    for (const p of result.reported) lines.push(`  · ${p}`)
  }
  if (result.reason) lines.push(`- 原因：${result.reason}`)
  if (result.message) lines.push(`- 说明：${result.message}`)
  if (result.recycled_at) lines.push(`- 时间：${result.recycled_at}`)
  lines.push('')
  return lines.join('\n')
}

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd !== 'plan' && cmd !== 'recycle') {
    console.error('用法: plan <runDir> | recycle <runDir> [--report <file>]')
    process.exit(2)
  }
  const runDir = rest.find((a) => !a.startsWith('--'))
  if (!runDir) {
    console.error(`用法: ${cmd} <runDir>${cmd === 'recycle' ? ' [--report <file>]' : ''}`)
    process.exit(2)
  }
  const runPath = join(resolve(runDir), 'run.json')
  const run = readJson(runPath)
  const devHome = resolve(devDshHome())
  const result = recycleRun(run, devHome, { dryRun: cmd === 'plan' })

  if (cmd === 'recycle' && result.status === 'recycled') {
    run.env_resources.recycled_at = result.recycled_at
    writeFileSync(runPath, JSON.stringify(run, null, 2) + '\n')
  } else if (cmd === 'recycle' && result.status === 'recycled_unresolved') {
    // 未回收：不写 recycled_at（重复执行仍会重试）；残留原因写进 run.json 供收口遗留事项引用
    run.env_resources.recycle_unresolved = result.release.unresolved
    writeFileSync(runPath, JSON.stringify(run, null, 2) + '\n')
  }
  if (cmd === 'recycle') {
    const report = flag(rest, '--report')
    if (report) appendFileSync(report, renderRecycleReport(result))
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
