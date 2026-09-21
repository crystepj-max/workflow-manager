#!/usr/bin/env node
/**
 * M5 真实唤起调度器：候选采集 → 快照冻结 → 机械门禁 → 并发拉起「独立 AI 会话」
 * → 看门狗与释放契约监工 → 补位 → 收工检查 → 夜间批次报告。
 *
 * 定位：只调度，不施工、不谈需求、不代签验收。筛选/排序/补位复用 M3 Execution Plan
 * 内核（assessAndSort + createBatchState/fillCapacity/applyRelease），本脚本不另写规则。
 *
 * 用法：
 *   node scripts/ai-task-dispatcher.mjs <schedule.json> [--now] [--wait-ms N] [--dry-run] [--simulate events.json]
 *
 * schedule.json:
 * {
 *   "project": "~/workspace/workflow-manager",   // 主检出（跨项目批次换这里）
 *   "batchName": "night-2026-09-17",
 *   "maxConcurrency": 2,
 *   "startAt": "2026-09-16T23:00:00+08:00",      // 可省略=立即
 *   "endAt": "2026-09-17T06:30:00+08:00",        // 可省略=不限；到点不再开新任务，在跑的收尾
 *   "blacklist": [],
 *   "permission": "full-access",                  // full-access | auto-edit（选 machine 模板键）
 *   "watchdogMinutes": 120,                       // 单会话墙钟上限，超时终止并记受阻
 *   "postValidateCommand": "npm run validate",    // 收工校验命令，可省略
 *   "machineConfig": ".scratch/night-batches/machine.json"  // 相对 project；不入库
 * }
 *
 * machine.json（每台机器自配，按本机 CLI 语法调整；不入库）：
 * {
 *   "agent": { "templates": {
 *       "full-access": { "command": "zcode",  "args": ["exec", …, "{promptFile}"] },
 *       "auto-edit":   { "command": "claude", "args": ["-p", …, "{promptFile}"] } } },
 *   "sceneInit": { "command": "node", "args": ["<project>/scripts/cwf-run-init.mjs", "{taskId}", "{runId}", "--local-base"] },
 *   "remoteIssueCommand": "gh issue list …",       // 可省略；仅报告性核验，失败不影响批次
 *   "taskSource": {                                // 可省略；省略即不启用 GitHub 任务源（保持旧行为）
 *     "readyLabel": "ready-for-agent",             // 远端「可施工」标签
 *     "wipLabel": "施工中",                        // 认领标签（他人已认领 → 本批不重开）
 *     "labelSync": true,                           // 门禁已过但远端缺标签时自动补打
 *     "onUnavailable": "block",                    // 远端不可信：block（默认，不开工）/ local-only（降级仅本地）
 *     "requireAnchor": false                       // true = 无 github#N 锚点的任务也排除（默认放行并标注）
 *   }
 * }
 * 占位符（args 通用）：{taskId} {runId} {runDir} {worktree} {promptFile} {project}
 *
 * 会话结束契约：会话退出前写 <runDir>/release-event.json
 *   {"to":"WAITING_HUMAN|BLOCKED|COMPLETED","blockedNode":…,"reason":…,"reworkCount":…,"nextStep":…}
 * 未写而退出 / 看门狗超时 → 记「执行受阻」，名额照常释放补位。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createBatchState,
  fillCapacity,
  applyRelease,
  autoPhaseDone,
  assessAndSort,
} from './ai-task-execution-plan.mjs'
import {
  collectLocalCandidates,
  slugForTaskId,
  scanOpenRuns,
  planTaskSourceAdmission,
  pendingLabelSync,
  STAGE_TASK_SOURCE,
} from './ai-task-candidate-collect.mjs'
import { fetchTaskSource, markReady } from './github-issues.mjs'
import { loadRegistry } from './local-task-registry.mjs'
import { runDirFor, worktreePathFor } from './workspace-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROMPT_TEMPLATE = path.join(__dirname, 'night-batch-session-prompt.md')

// ---------- 小工具 ----------

function expandPath(p) {
  if (!p) return p
  let out = String(p)
  if (out === '~') out = process.env.HOME || out
  else if (out.startsWith('~/')) out = path.join(process.env.HOME || '', out.slice(2))
  return out
}

function parseTime(v, label) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`无效 ${label}: ${v}`)
  return d
}

function pad(n) { return String(n).padStart(2, '0') }

function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function nowIso() { return new Date().toISOString() }

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renderPlaceholders(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
}

function renderPrompt(template, v) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? v[k] : m))
}

// ---------- 机器配置 ----------

function loadMachineConfig(schedule, main) {
  const p = path.resolve(main, expandPath(schedule.machineConfig || '.scratch/night-batches/machine.json'))
  if (!fs.existsSync(p)) {
    return { path: p, exists: false, config: null }
  }
  return { path: p, exists: true, config: JSON.parse(fs.readFileSync(p, 'utf8')) }
}

function pickAgentTemplate(machine, permission) {
  const agent = machine?.agent
  if (!agent) throw new Error(`machine.json 缺 agent 配置：${JSON.stringify(machine)}`)
  if (agent.command && Array.isArray(agent.args)) return agent // 兼容不分权限档的平铺写法
  const tpl = agent.templates?.[permission]
  if (!tpl) {
    const keys = Object.keys(agent.templates || {}).join('/') || '无'
    throw new Error(`machine.json agent.templates 缺少「${permission}」档（现有：${keys}）`)
  }
  return tpl
}

// ---------- run 现场 ----------

function allocRunId(main, taskId) {
  const slug = slugForTaskId(taskId)
  for (let n = 1; n < 1000; n++) {
    const runId = `${slug}-r${n}`
    if (!fs.existsSync(runDirFor(main, runId))) return runId
  }
  throw new Error(`无法为 ${taskId} 分配 run_id（r1~r999 均已占用）`)
}

function renderArgs(args, vars) {
  return args.map((a) => renderPlaceholders(a, vars))
}

// ---------- 报告 ----------

function waitingTable(state, sites) {
  if (!state.waiting.length) return ['- （无）']
  const rows = state.waiting.map((t) => {
    const s = sites.get(t.id) || {}
    const runDir = s.runDir ? `\`${s.runDir}\`` : '?'
    return [
      `| ${t.id} | ${t.name} | \`${s.branch || '?'}\` | \`${s.worktree || '?'}\` | ${runDir} | \`${path.join(s.runDir || '', 'uat-card.md')}\` |`,
    ]
  })
  return [
    '| 任务 | 名称 | 分支 | worktree 路径 | run 目录 | 验收卡 |',
    '|---|---|---|---|---|---|',
    ...rows,
  ]
}

function buildReport({ schedule, permission, state, sites, launched, leftoverQueue, leftoverLabel = '未启动（超出 endAt 截止，未开新任务）', snapshotCount, startedAt, endedAt, preHygiene, postHygiene, remoteCheck, initFailures, taskSourceLines = [] }) {
  const done = autoPhaseDone(state)
  const lines = [
    '【夜间批次报告】',
    '说明：本报告由 ai-task-dispatcher（M5 真实唤起）产生；筛选/排序/补位复用同一套 Execution Plan 内核（M3），每任务一个独立 AI 会话；未另写筛选/排序/补位规则。',
    '',
    `- 批次名称：${state.name}`,
    `- 项目主检出：${schedule.project}`,
    `- 预约窗口：startAt=${schedule.startAt || '（未设）'} / endAt=${schedule.endAt || '（未设）'}`,
    `- 实际启动时间：${startedAt}`,
    `- 自动施工结束时间：${endedAt}`,
    `- 快照任务总数：${snapshotCount} ｜ 最大并发：${state.maxConcurrency} ｜ 权限档：${permission} ｜ 看门狗：${schedule.watchdogMinutes} 分钟`,
    `- 批次结论：${done ? '自动施工阶段正常结束' : '仍有未完成任务（见未启动/受阻）'}`,
    '',
    '## 等待验收',
    '',
    ...waitingTable(state, sites),
    '',
    '## 执行受阻',
    '',
    ...(state.blocked.length
      ? state.blocked.map((t) => `- ${t.id} ${t.name}｜节点=${t.blockedNode || '?'}｜原因=${t.reason || '?'}｜返工=${t.reworkCount ?? '?'}｜下一步=${t.nextStep || '人工查看'}`)
      : ['- （无）']),
    ...(initFailures.length ? ['', '### 开工现场创建失败', ...initFailures.map((f) => `- ${f.id}：${f.reason}`)] : []),
    '',
    '## 已完成',
    '',
    ...(state.completed.length ? state.completed.map((t) => `- ${t.id} ${t.name}`) : ['- （无）']),
    '',
    `## ${leftoverLabel}`,
    '',
    ...(leftoverQueue.length ? leftoverQueue.map((id) => `- ${id}`) : ['- （无）']),
    '',
    '## 未纳入（完整清单）',
    '',
    ...(state.excluded.length ? state.excluded.map((t) => `- ${t.id} ${t.name}｜${t.stage || '机械门禁'}｜${t.reason}`) : ['- （无）']),
    '',
    '## 远端任务源（GitHub：ready-for-agent 筛选 + 施工中认领互斥）',
    '',
    ...(taskSourceLines.length ? taskSourceLines : ['- （未配置 taskSource，本批仅用本地登记册）']),
    '',
    '## 远端核验（报告性，不影响本批候选）',
    '',
    `- ${remoteCheck}`,
    '',
    '## 批次卫生',
    '',
    '### 开工前（只读预演）',
    '',
    `- 证据清理预演：${preHygiene.cleanup}`,
    `- worktree 孤儿登记：${preHygiene.prune}`,
    '### 收工后',
    '',
    `- npm run validate：${postHygiene.validate}`,
    '',
    '## 启动日志',
    '',
    ...state.launchLog.map((e) => `- ${e.at} ${e.action}${e.to ? ' → ' + e.to : ''} ${e.taskId}`),
    '',
  ]
  return lines.join('\n')
}

// ---------- 主流程 ----------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 1 || argv[0].startsWith('-')) {
    console.error('用法: node scripts/ai-task-dispatcher.mjs <schedule.json> [--now] [--wait-ms N] [--dry-run] [--simulate events.json]')
    process.exit(2)
  }
  const schedulePath = path.resolve(argv[0])
  const forceNow = argv.includes('--now')
  const dryRun = argv.includes('--dry-run')
  const simIdx = argv.indexOf('--simulate')
  const simulatePath = simIdx >= 0 ? path.resolve(argv[simIdx + 1]) : null
  let waitMs = 0
  const wIdx = argv.indexOf('--wait-ms')
  if (wIdx >= 0) waitMs = Number(argv[wIdx + 1] || 0)

  const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'))
  if (!schedule.project) { console.error('schedule.json 须含 project'); process.exit(2) }
  const main = path.resolve(expandPath(schedule.project))
  if (!fs.existsSync(main)) { console.error(`找不到项目主检出：${main}`); process.exit(2) }
  const maxConcurrency = Number(schedule.maxConcurrency)
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) { console.error('maxConcurrency 必须为正整数'); process.exit(2) }
  const startAt = parseTime(schedule.startAt, 'startAt')
  const endAt = parseTime(schedule.endAt, 'endAt')
  if (startAt && endAt && endAt <= startAt) { console.error('endAt 必须晚于 startAt'); process.exit(2) }
  const permission = schedule.permission || 'full-access'
  const watchdogMinutes = Number(schedule.watchdogMinutes ?? 120)
  if (!(watchdogMinutes > 0)) { console.error('watchdogMinutes 必须为正数'); process.exit(2) }
  const watchdogMs = watchdogMinutes * 60_000
  const pollMs = Number(schedule.pollMs ?? 5000)
  if (!(pollMs > 0)) { console.error('pollMs 必须为正数'); process.exit(2) }
  const blacklist = Array.isArray(schedule.blacklist) ? schedule.blacklist : []
  const batchName = String(schedule.batchName || 'night-batch')
  if (!/^[\w.-]+$/.test(batchName)) { console.error('batchName 只允许字母/数字/点/连字符/下划线'); process.exit(2) }
  const postValidateCommand = schedule.postValidateCommand || 'npm run validate'

  // 到点等待（与 M4 同语义：未到点且未给等待预算 → pending 退出码 3）
  const checkedAt = new Date()
  if (startAt && !forceNow && checkedAt < startAt) {
    const remain = startAt.getTime() - checkedAt.getTime()
    if (waitMs > 0) sleep(Math.min(waitMs, remain))
    if (new Date() < startAt && !forceNow) {
      console.log(JSON.stringify({ ok: false, pending: true, milestone: 'M5', runAt: startAt.toISOString(), message: '尚未到点，未启动批次' }, null, 2))
      process.exit(3)
    }
  }

  const machineEntry = loadMachineConfig(schedule, main)
  if (dryRun) {
    if (!machineEntry.exists) console.error(`提示：机器配置不存在（dry-run 继续）：${machineEntry.path}`)
  } else if (!machineEntry.exists) {
    console.error(`找不到机器配置：${machineEntry.path}（每台机器需自配，见脚本头注释；不入库）`)
    process.exit(2)
  }
  const machine = machineEntry.config || {}

  // 任务源（FEAT-237）：机器本地配置；未配置即不启用 GitHub 通道（保持旧行为）
  const tsCfg = machine.taskSource
  const taskSource = tsCfg
    ? {
        enabled: true,
        readyLabel: tsCfg.readyLabel || 'ready-for-agent',
        wipLabel: tsCfg.wipLabel || '施工中',
        labelSync: tsCfg.labelSync !== false,
        onUnavailable: tsCfg.onUnavailable || 'block',
        requireAnchor: tsCfg.requireAnchor === true,
      }
    : { enabled: false }

  // 1) 候选采集（本地事实层）→ 远端任务源准入 → 快照冻结
  const collected = collectLocalCandidates({ repo: main, blacklist })

  let remoteSnapshot = null
  let remoteSourceError = null
  let admission = null
  if (taskSource.enabled) {
    try {
      remoteSnapshot = fetchTaskSource({
        repo: main,
        readyLabel: taskSource.readyLabel,
        wipLabel: taskSource.wipLabel,
      })
    } catch (e) {
      remoteSourceError = String((e && e.message) || e).slice(0, 300)
    }
    admission = planTaskSourceAdmission({
      registryTasks: loadRegistry(main).tasks,
      candidates: collected.candidates,
      readyIssues: remoteSnapshot ? remoteSnapshot.ready : [],
      claimedBy: remoteSnapshot ? remoteSnapshot.claimedBy : new Map(),
      remoteError: remoteSourceError,
      onUnavailable: taskSource.onUnavailable,
      requireAnchor: taskSource.requireAnchor,
    })
  }

  // 远端任务源的硬排除项（他人已认领 / 无锚点且 requireAnchor）在门禁之前就摘掉，
  // 避免把「本就不该开工」的任务送进定义门禁，产生误导性的门禁失败记录。
  const remoteHardExcluded = new Set((admission?.preExcluded || []).map((e) => e.id))
  const localCandidates = collected.candidates.filter((c) => !remoteHardExcluded.has(c.id))

  const batchDir = path.join(main, '.scratch/night-batches', `${localDate(startAt || new Date())}-${batchName}`)
  fs.mkdirSync(batchDir, { recursive: true })
  const batchJsonPath = path.join(batchDir, 'batch.json')
  const batchCandidates = localCandidates.map((c) => {
    const rel = (p) => (p ? path.relative(batchDir, path.resolve(main, p)) : '（registry 未登记，路径缺失）')
    return { id: c.id, name: c.name, registryStatus: c.registryStatus, priority: c.priority, issueBasics: rel(c.issueBasics), taskSpec: rel(c.taskSpec) }
  })
  const snapshot = {
    name: batchName,
    maxConcurrency,
    snapshotVersion: 'm5-v1',
    snapshotAt: nowIso(),
    project: main,
    blacklist,
    candidateSources: {
      ...collected.sourceNote,
      ...(admission ? { taskSource: admission.note } : {}),
    },
    candidates: batchCandidates,
  }
  fs.writeFileSync(batchJsonPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  if (remoteSnapshot) {
    // 远端快照留档：本批到底看到哪些「可施工」issue，事后可对账
    fs.writeFileSync(path.join(batchDir, 'task-source.json'), JSON.stringify({
      capturedAt: nowIso(),
      slug: remoteSnapshot.slug,
      readyLabel: taskSource.readyLabel,
      wipLabel: taskSource.wipLabel,
      ready: remoteSnapshot.ready.map((i) => ({ number: i.number, title: i.title, labels: i.labels, assignees: i.assignees })),
    }, null, 2) + '\n', 'utf8')
  }

  // 2) 远端核验（报告性 best-effort；失败只记录，不影响本批）
  let remoteCheck = '未配置 remoteIssueCommand，本批未做远端核验'
  if (taskSource.enabled) {
    remoteCheck = '已由 taskSource（GitHub 任务源通道）承担，见上一节'
  } else if (machine.remoteIssueCommand) {
    const r = spawnSync(String(machine.remoteIssueCommand), { shell: true, cwd: main, encoding: 'utf8', timeout: 60_000 })
    remoteCheck = r.status === 0
      ? `已执行远端查询（截选）：${String(r.stdout || '').trim().split('\n').slice(0, 8).join(' ⏎ ')}`
      : `远端查询失败（status=${r.status}，夜间不重试）：${String(r.stderr || r.stdout || '').trim().slice(0, 200)}`
  }

  // 3) 开工前批次卫生（只读预演，夜间不执行删除）
  const preHygiene = { cleanup: '（未执行）', prune: '（未执行）' }
  if (!dryRun) {
    const cleanup = spawnSync(process.execPath, [path.join(__dirname, 'task-runs-cleanup.mjs'), '--repo', main], { encoding: 'utf8' })
    preHygiene.cleanup = cleanup.status === 0 ? `预演通过（status=0）${cleanup.stdout?.trim() ? '：' + cleanup.stdout.trim().split('\n').slice(-2).join(' ⏎ ') : ''}` : `预演异常（status=${cleanup.status}）：${String(cleanup.stderr || '').trim().slice(0, 200)}`
    const prune = spawnSync('git', ['worktree', 'prune', '--dry-run', '--verbose'], { cwd: main, encoding: 'utf8' })
    preHygiene.prune = prune.status === 0 && !(prune.stdout || '').trim() ? '无孤儿登记' : `status=${prune.status}｜${String(prune.stdout || '').trim() || String(prune.stderr || '').trim()}`
  }

  // 4) 机械门禁 + 排序（复用 M3 assessAndSort；依赖 git 事实核查以目标项目为准）
  const { eligible, excluded: gateExcluded } = await assessAndSort(batchCandidates, batchJsonPath, main)
  const collectorExcludedTagged = [
    ...collected.excluded.map((e) => ({ ...e })),
    ...(admission?.preExcluded || []),
    ...(admission?.orphans || []),
  ]
  const gateExcludedTagged = gateExcluded.map((e) => ({ ...e, stage: '定义门禁' }))

  // 4.5) 远端标签同步（FEAT-237）：门禁已过的任务，远端必须带「可施工」标签才进施工池。
  //      标签语义是「需求清晰可执行」，故只能在门禁之后补——之前补会把过不了门禁的任务标成可施工。
  const labelSyncLog = []
  let admitted = eligible
  if (taskSource.enabled && admission && admission.available) {
    const need = pendingLabelSync(eligible, admission.verdicts)
    const needIds = new Set(need.map((n) => n.id))
    const skipBecause = (t, reason) => {
      labelSyncLog.push({ id: t.id, result: `${reason} → 排除` })
      gateExcludedTagged.push({ id: t.id, name: t.name, stage: STAGE_TASK_SOURCE, reason })
    }
    if (need.length && !taskSource.labelSync) {
      for (const t of eligible) if (needIds.has(t.id)) skipBecause(t, `远端未标记 ${taskSource.readyLabel}，且 taskSource.labelSync=false`)
    } else if (need.length && dryRun) {
      for (const n of need) labelSyncLog.push({ id: n.id, result: `dry-run：本应补打 ${taskSource.readyLabel}（issue #${n.issueNumber}）` })
    } else if (need.length) {
      for (const n of need) {
        const t = eligible.find((x) => x.id === n.id)
        try {
          const r = markReady({ repo: main, taskId: n.id, readyLabel: taskSource.readyLabel })
          if (r.ok) {
            labelSyncLog.push({ id: n.id, result: `${r.code === 'marked' ? '已补打' : '已是就绪'} ${taskSource.readyLabel}（issue #${n.issueNumber}）` })
          } else {
            skipBecause(t || { id: n.id, name: n.id }, `远端标签同步失败（${r.code}）→ 不进施工池：${r.reason}`)
          }
        } catch (e) {
          const msg = String((e && e.message) || e).slice(0, 200)
          skipBecause(t || { id: n.id, name: n.id }, `远端标签同步异常 → 不进施工池：${msg}`)
        }
      }
    }
    admitted = eligible.filter((t) => !gateExcludedTagged.some((e) => e.id === t.id && e.stage === STAGE_TASK_SOURCE))
  }

  // 报告用：远端任务源这一节的原始事实（不加工、不美化）
  const taskSourceLines = []
  if (taskSource.enabled) {
    taskSourceLines.push(`- ${admission.note}`)
    if (admission.blocked) {
      taskSourceLines.push('- ⛔ 已阻断本批：远端任务源不可信时不开工（`taskSource.onUnavailable=block`）。确需降级请显式配 `local-only`。')
    }
    if (taskSource.labelSync === false) taskSourceLines.push('- `labelSync=false`：本轮不自动补打标签，缺标签任务一律排除')
    if (taskSource.requireAnchor) taskSourceLines.push('- `requireAnchor=true`：无 `github#N` 锚点的任务也排除')
    if (labelSyncLog.length) {
      taskSourceLines.push('- 标签补打记录：', ...labelSyncLog.map((l) => `  - ${l.id}：${l.result}`))
    }
    const claimed = [...admission.verdicts.entries()].filter(([, v]) => v.status === 'claimed')
    if (claimed.length) {
      taskSourceLines.push(`- 因他人已认领（${taskSource.wipLabel}）排除：${claimed.map(([id, v]) => `${id}（issue #${v.issueNumber}，${v.holder}）`).join('、')}`)
    }
    const noAnchor = [...admission.verdicts.entries()].filter(([, v]) => v.status === 'no-anchor').map(([id]) => id)
    if (noAnchor.length) {
      taskSourceLines.push(`- 无 github 锚点放行（不做标签筛选与认领互斥）：${noAnchor.join('、')}`)
    }
    if (admission.orphans.length) {
      taskSourceLines.push(`- 远端就绪但未纳入（${admission.orphans.length}）：`, ...admission.orphans.map((o) => `  - ${o.id} ${o.name}：${o.reason}`))
    }
  }

  const startedAt = nowIso()
  const state = createBatchState({
    name: batchName,
    maxConcurrency,
    startedAt,
    snapshot: admitted.map((t) => ({ ...t, snapshotAt: startedAt })),
    excluded: [...collectorExcludedTagged, ...gateExcludedTagged],
  })

  const sites = new Map()          // taskId -> {runId, branch, worktree, runDir}
  const children = new Map()       // taskId -> {child, watchdogTimer, killTimer}
  const launched = new Set()       // 已真实拉起（含 init 失败）的任务
  const initFailures = []
  const watchdogFired = new Set()  // 看门狗触发过的任务：进入输出，供断言「业务事实」而非挂钟（CHORE-260 · M6）

  // ----- 会话拉起与监工 -----

  function releaseSlot(taskId, row) {
    const entry = children.get(taskId)
    if (entry) {
      clearTimeout(entry.watchdogTimer)
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        try { entry.child.kill('SIGTERM') } catch { /* 已退出 */ }
      }
      children.delete(taskId)
    }
    const r = applyRelease(state, { taskId, ...row })
    if (!r.handled) return
    pump()
  }

  function watchdogFire(taskId) {
    const entry = children.get(taskId)
    if (!entry) return
    const s = sites.get(taskId) || {}
    entry.child.kill('SIGTERM')
    entry.killTimer = setTimeout(() => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        try { entry.child.kill('SIGKILL') } catch { /* 已退出 */ }
      }
    }, 10_000)
    watchdogFired.add(taskId)
    releaseSlot(taskId, {
      to: 'BLOCKED',
      blockedNode: 'session',
      reason: `看门狗超时（>${watchdogMinutes} 分钟），已终止会话；日志：${path.join(s.runDir || '', 'session.log')}`,
      reworkCount: null,
      nextStep: '人工查看 session.log 判断是否可重试',
    })
  }

  function noteInitFailure(taskId, reason) {
    // 开工现场创建失败：任务从未进入施工，直接记受阻（不占并发名额）
    state.running.delete(taskId)
    state.blocked.push({
      id: taskId, name: state.snapshot.find((t) => t.id === taskId)?.name || taskId,
      to: 'BLOCKED', blockedNode: 'run-init', reason, reworkCount: null, nextStep: '人工排查 cwf-run-init 输出',
      uatHint: null,
    })
    state.launchLog.push({ taskId, at: nowIso(), action: 'release', to: 'BLOCKED' })
    initFailures.push({ id: taskId, reason })
  }

  function launchTask(task) {
    const runId = allocRunId(main, task.id)
    const runDir = runDirFor(main, runId)
    const initTpl = machine.sceneInit || {
      command: process.execPath,
      args: [path.join(main, 'scripts/cwf-run-init.mjs'), '{taskId}', '{runId}', '--local-base'],
    }
    const vars = { taskId: task.id, runId, runDir, worktree: worktreePathFor(main, `dev-${runId}`), project: main }
    const r = spawnSync(initTpl.command, renderArgs(initTpl.args, vars), { cwd: main, encoding: 'utf8' })
    if (r.status !== 0) {
      noteInitFailure(task.id, `开工现场创建失败（status=${r.status}）：${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
      return
    }
    let runJson = {}
    try { runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) } catch { /* 兜底派生 */ }
    const branch = runJson.work_branch || `dev-${runId}`
    const worktree = runJson.worktree || worktreePathFor(main, branch)
    sites.set(task.id, { runId, branch, worktree, runDir })

    const templateText = fs.readFileSync(expandPath(schedule.sessionPrompt) || DEFAULT_PROMPT_TEMPLATE, 'utf8')
      || fs.readFileSync(DEFAULT_PROMPT_TEMPLATE, 'utf8')
    const promptFile = path.join(runDir, 'session-prompt.md')
    fs.writeFileSync(promptFile, renderPrompt(templateText, {
      TASK_ID: task.id,
      TASK_NAME: task.name,
      MAIN_CHECKOUT: main,
      WORKTREE: worktree,
      BRANCH: branch,
      RUN_DIR: runDir,
      ISSUE_PATH: task.issueBasics || '?',
      SPEC_PATH: task.taskSpec || '?',
    }), 'utf8')

    const tpl = pickAgentTemplate(machine, permission)
    const logFd = fs.openSync(path.join(runDir, 'session.log'), 'a')
    const child = spawn(tpl.command, renderArgs(tpl.args, { ...vars, promptFile }), {
      cwd: worktree,
      stdio: ['ignore', logFd, logFd],
    })
    const watchdogTimer = setTimeout(() => watchdogFire(task.id), watchdogMs)
    children.set(task.id, { child, watchdogTimer })
    child.on('exit', () => { fs.closeSync(logFd) })
  }

  let pumping = false
  function pump() {
    // 到 endAt 不再开新任务；在跑的收尾。pumping 防止 init 失败回调重入。
    if (pumping) return
    pumping = true
    try {
      while (state.running.size < maxConcurrency
        && state.queue.length
        && (!endAt || new Date() < endAt)) {
        fillCapacity(state)
        for (const id of [...state.running.keys()]) {
          if (!launched.has(id)) {
            launched.add(id)
            launchTask(state.snapshot.find((t) => t.id === id))
          }
        }
      }
    } finally {
      pumping = false
    }
  }

  // ----- 模拟 / 预演模式（不碰真实会话） -----

  if (simulatePath || dryRun) {
    fillCapacity(state)
    if (simulatePath) {
      const events = JSON.parse(fs.readFileSync(simulatePath, 'utf8'))
      for (const ev of events) {
        if (ev.op !== 'release') continue
        const r = applyRelease(state, ev)
        if (!r.handled && r.reason === 'not-running') continue
        if (!r.handled && r.reason === 'unknown-status') { console.error(`未知释放状态: ${ev.to}`); process.exit(1) }
        fillCapacity(state)
      }
    }
    const endedAt = nowIso()
    const report = buildReport({
      schedule: { ...schedule, project: main }, permission, state, sites,
      launched, leftoverQueue: state.queue,
      leftoverLabel: simulatePath ? '未启动（模拟事件排队，非真实拉起）' : '未启动（预演排队计划，真实批次按并发逐个补位）',
      snapshotCount: state.snapshot.length,
      startedAt, endedAt,
      preHygiene, postHygiene: { validate: '（预演/模拟批次未执行）' },
      remoteCheck, initFailures, taskSourceLines,
    })
    const reportPath = path.join(batchDir, 'report.md')
    fs.writeFileSync(reportPath, report, 'utf8')
    console.log(JSON.stringify({
      ok: true, milestone: 'M5', mode: simulatePath ? 'simulate' : 'dry-run',
      autoPhaseDone: autoPhaseDone(state),
      snapshotIds: state.snapshot.map((t) => t.id),
      launchOrder: state.launchLog.filter((e) => e.action === 'launch').map((e) => e.taskId),
      waiting: state.waiting.map((t) => t.id),
      blocked: state.blocked.map((t) => t.id),
      completed: state.completed.map((t) => t.id),
      excluded: state.excluded,
      taskSource: taskSource.enabled ? { note: admission.note, blocked: admission.blocked, labelSyncLog } : null,
      batchJsonPath, reportPath,
    }, null, 2))
    const taskSourceBlocked = Boolean(taskSource.enabled && admission && admission.blocked)
    process.exit((simulatePath && !autoPhaseDone(state)) || taskSourceBlocked ? 1 : 0)
  }

  // ----- 真实唤起模式 -----

  let finishing = false
  function checkFinish() {
    if (finishing) return
    const queueLeft = state.queue.length > 0 && endAt && new Date() >= endAt
    if (autoPhaseDone(state) || (children.size === 0 && queueLeft)) {
      finishing = true
      clearInterval(poller)
      finish()
    }
  }

  function pollOnce() {
    for (const [taskId, entry] of [...children]) {
      const evPath = path.join(sites.get(taskId)?.runDir || '', 'release-event.json')
      if (fs.existsSync(evPath)) {
        let ev
        try { ev = JSON.parse(fs.readFileSync(evPath, 'utf8')) } catch (e) {
          ev = { to: 'BLOCKED', blockedNode: 'release-event', reason: `释放事件不可解析：${e.message}` }
        }
        if (!['WAITING_HUMAN', 'BLOCKED', 'COMPLETED'].includes(ev.to)) {
          ev = { to: 'BLOCKED', blockedNode: 'release-event', reason: `释放事件 to 非法：${JSON.stringify(ev.to)}` }
        }
        releaseSlot(taskId, {
          to: ev.to,
          blockedNode: ev.blockedNode ?? null,
          reason: ev.reason ?? null,
          reworkCount: ev.reworkCount ?? null,
          nextStep: ev.nextStep ?? null,
        })
        continue
      }
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
        releaseSlot(taskId, {
          to: 'BLOCKED',
          blockedNode: 'session',
          reason: `会话退出但未写释放事件（exit=${entry.child.exitCode}, signal=${entry.child.signalCode}）；日志：${path.join(sites.get(taskId)?.runDir || '', 'session.log')}`,
          reworkCount: null,
          nextStep: '人工查看 session.log 判断是否可重试',
        })
      }
    }
    checkFinish()
  }

  function shutdown(signal) {
    for (const [, entry] of children) {
      clearTimeout(entry.watchdogTimer)
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        try { entry.child.kill('SIGTERM') } catch { /* 已退出 */ }
      }
    }
    if (!finishing) {
      finishing = true
      const endedAt = nowIso()
      const report = buildReport({ schedule: { ...schedule, project: main }, permission, state, sites, launched, leftoverQueue: state.queue, snapshotCount: state.snapshot.length, startedAt, endedAt, preHygiene, postHygiene: { validate: `（调度器收到 ${signal}，收工检查未执行）` }, remoteCheck, initFailures, taskSourceLines })
      fs.writeFileSync(path.join(batchDir, 'report.md'), report, 'utf8')
    }
    process.exit(130)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  pump()
  const poller = setInterval(pollOnce, pollMs)

  function finish() {
    const endedAt = nowIso()
    // 5) 收工后批次卫生
    const v = spawnSync(postValidateCommand, { shell: true, cwd: main, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const validateOk = v.status === 0
    const postHygiene = {
      validate: validateOk
        ? '通过（status=0）'
        : `异常（status=${v.status}）：${String(v.stdout || v.stderr || '').trim().split('\n').filter((l) => l.trim()).slice(-6).join(' ⏎ ')}`,
    }
    const leftoverQueue = [...state.queue]
    const report = buildReport({
      schedule: { ...schedule, project: main }, permission, state, sites, launched,
      leftoverQueue, snapshotCount: state.snapshot.length, startedAt, endedAt,
      preHygiene, postHygiene, remoteCheck, initFailures, taskSourceLines,
    })
    const reportPath = path.join(batchDir, 'report.md')
    fs.writeFileSync(reportPath, report, 'utf8')
    const done = autoPhaseDone(state)
    const taskSourceBlocked = Boolean(taskSource.enabled && admission && admission.blocked)
    console.log(JSON.stringify({
      ok: true, milestone: 'M5', mode: 'real',
      autoPhaseDone: done,
      taskSource: taskSource.enabled ? { note: admission.note, blocked: admission.blocked, labelSyncLog } : null,
      leftoverQueue,
      snapshotIds: state.snapshot.map((t) => t.id),
      launchOrder: state.launchLog.filter((e) => e.action === 'launch').map((e) => e.taskId),
      waiting: state.waiting.map((t) => t.id),
      blocked: state.blocked.map((t) => t.id),
      completed: state.completed.map((t) => t.id),
      excluded: state.excluded,
      // 看门狗触发事实（业务结果）：据此断言「挂起会话已被终止」，不再依赖挂钟阈值（CHORE-260 · M6）
      watchdogFired: [...watchdogFired],
      validate: validateOk,
      batchJsonPath, reportPath,
    }, null, 2))
    process.exit(done && !taskSourceBlocked ? 0 : 1)
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) await main()
