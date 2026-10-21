#!/usr/bin/env node
/**
 * 历史 M5 本地登记册调度器实现。当前 CLI（包括 --preview）已完全退役，
 * 任务状态和计划由 Multica/dev-flow 管理。此文件其余代码仅保留供迁移追溯，
 * 不得作为当前开工、任务读取或报告生成入口。
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
import { fireWatchdog, pollChildrenOnce, releaseAfterExit } from './ai-task-session-supervise.mjs'
import { writePinnedReport } from './ai-task-pinned-write.mjs'

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

function buildReport({ schedule, permission, state, sites, launched, leftoverQueue, leftoverLabel = '未启动（超出 endAt 截止，未开新任务）', snapshotCount, startedAt, endedAt, preHygiene, postHygiene, remoteCheck, initFailures, taskSourceLines = [], previewOnly = false }) {
  const done = autoPhaseDone(state)
  const lines = [
    '【夜间批次报告】',
    previewOnly
      ? '说明：本报告仅为显式只读计划预览（WFM-131）；未认领任务、未补 ready 标签、未派发实施 Run、未回写 registry/BOARD。筛选/排序/补位仍复用 M3 Execution Plan 内核。'
      : '说明：本报告由 ai-task-dispatcher（M5）产生；筛选/排序/补位复用同一套 Execution Plan 内核（M3），每任务一个独立 AI 会话；未另写筛选/排序/补位规则。',
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

function canonicalOutputPath(filePath) {
  if (fs.existsSync(filePath)) return fs.realpathSync(filePath)
  const parent = path.dirname(filePath)
  return path.join(
    fs.existsSync(parent) ? fs.realpathSync(parent) : path.resolve(parent),
    path.basename(filePath),
  )
}

function stopDispatch(payload) {
  console.log(JSON.stringify({
    ok: false,
    blocked: true,
    milestone: 'M5',
    trigger: 'dispatcher',
    ...payload,
    effects: {
      registryBoardWrites: false,
      githubWrites: false,
      labelSync: false,
      planInvoked: false,
      implementationRunStarted: false,
      agentSessionSpawned: false,
      ...(payload.effects || {}),
    },
  }, null, 2))
  process.exit(1)
}

/** 受保护账本等路径：写入前校验真实目标；拒绝符号链接写穿与不可靠竞态。 */
function assertSafeReportPath(filePath, protectedLedgerPaths, {
  forceNow = false,
  previewOnly = false,
  trustedBatchReal = null,
  frozenBatch = null,
} = {}) {
  const abs = path.resolve(filePath)
  if (fs.existsSync(abs)) {
    let st
    try { st = fs.lstatSync(abs) } catch (e) {
      stopDispatch({
        forceNow, previewOnly, reasonCode: 'protected_report_path',
        message: `无法校验输出路径 ${abs}：${e.message}`,
        effects: { planInvoked: true },
      })
    }
    if (st.isSymbolicLink()) {
      let linkTarget = ''
      try { linkTarget = fs.readlinkSync(abs) } catch { /* ignore */ }
      stopDispatch({
        forceNow, previewOnly, reasonCode: 'protected_report_path',
        message: `拒绝写入符号链接输出路径 ${abs}（→ ${linkTarget}）；禁止指向 registry/BOARD 或其他保护文件。`,
        effects: { planInvoked: true },
      })
    }
  }
  let real
  try {
    real = canonicalOutputPath(abs)
  } catch (e) {
    stopDispatch({
      forceNow, previewOnly, reasonCode: 'protected_report_path',
      message: `无法解析输出路径 ${abs}：${e.message}`,
      effects: { planInvoked: true },
    })
  }
  if (protectedLedgerPaths.includes(real)) {
    stopDispatch({
      forceNow, previewOnly, reasonCode: 'protected_report_path',
      message: '拒绝把预览/批次产物写入 docs/tasks/registry.json 或 docs/tasks/BOARD.md；请使用独立批次目录。',
      effects: { planInvoked: true },
    })
  }
  // 必须落在冻结的可信批次目录内（挡住父目录别名指向任意外部保护目录）
  if (trustedBatchReal) {
    const under = real === trustedBatchReal
      || real.startsWith(trustedBatchReal.endsWith(path.sep) ? trustedBatchReal : trustedBatchReal + path.sep)
    if (!under) {
      stopDispatch({
        forceNow, previewOnly, reasonCode: 'protected_report_path',
        message: `拒绝写入可信批次目录之外的路径：${real}（可信根 ${trustedBatchReal}）`,
        effects: { planInvoked: true },
      })
    }
  }
  if (frozenBatch) {
    try {
      const dirSt = fs.lstatSync(frozenBatch.path)
      if (dirSt.isSymbolicLink()) {
        stopDispatch({
          forceNow, previewOnly, reasonCode: 'protected_report_path',
          message: `批次目录在写入前被替换为符号链接：${frozenBatch.path}`,
          effects: { planInvoked: true },
        })
      }
      if (dirSt.dev !== frozenBatch.dev || dirSt.ino !== frozenBatch.ino) {
        stopDispatch({
          forceNow, previewOnly, reasonCode: 'protected_report_path',
          message: `批次目录身份在写入前发生变化（TOCTOU）：${frozenBatch.path}`,
          effects: { planInvoked: true },
        })
      }
      const dirReal = fs.realpathSync(frozenBatch.path)
      if (dirReal !== frozenBatch.real) {
        stopDispatch({
          forceNow, previewOnly, reasonCode: 'protected_report_path',
          message: `批次目录真实路径在写入前漂移：${dirReal} ≠ ${frozenBatch.real}`,
          effects: { planInvoked: true },
        })
      }
    } catch (e) {
      stopDispatch({
        forceNow, previewOnly, reasonCode: 'protected_report_path',
        message: `无法复验批次目录：${e.message}`,
        effects: { planInvoked: true },
      })
    }
  }
  return real
}

/**
 * 从文件系统根走到目标：每一级都必须是真实目录，并绑定 dev/ino。
 * 项目根上方的祖先符号链接（alias → real，根自身仍是真目录）不能绕过。
 * 符号链接、别名、非目录，或两次读取身份不一致时 fail-closed。
 * allowMissingSuffix：批次目录尚未创建时，只绑定已经存在的祖先。
 */
function describePathChain(absPath, { allowMissingSuffix = false } = {}) {
  const lexical = path.resolve(absPath)
  const parts = lexical.split(path.sep).filter(Boolean)
  let cur = path.sep
  const rows = []
  let deepest = path.sep
  for (const part of parts) {
    cur = path.join(cur, part)
    let st
    try {
      st = fs.lstatSync(cur)
    } catch (e) {
      if (allowMissingSuffix && e && e.code === 'ENOENT') break
      throw new Error(`无法校验路径链 ${cur}：${e.message}`)
    }
    if (st.isSymbolicLink()) {
      let linkTarget = ''
      try { linkTarget = fs.readlinkSync(cur) } catch { /* ignore */ }
      throw new Error(`拒绝路径链上的符号链接（含项目根及其祖先）：${cur}${linkTarget ? ` → ${linkTarget}` : ''}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`路径链上存在非目录，无法可靠绑定：${cur}`)
    }
    rows.push(`${st.dev}:${st.ino}`)
    deepest = cur
  }
  if (rows.length === 0) throw new Error(`无法绑定路径身份：${lexical}`)
  let real
  try {
    real = fs.realpathSync(deepest)
  } catch (e) {
    throw new Error(`无法解析真实路径 ${deepest}：${e.message}`)
  }
  if (real !== deepest) {
    throw new Error(`路径与真实身份不一致（别名或符号链接）：${deepest} ≠ ${real}`)
  }
  if (!allowMissingSuffix && deepest !== lexical) {
    throw new Error(`路径未完整绑定：${lexical}`)
  }
  return { lexical, real, identity: rows.join('|') }
}

function assertNoSymlinkInChain(absPath, opts = {}, chainOpts = {}) {
  let first
  let second
  try {
    first = describePathChain(absPath, chainOpts)
    second = describePathChain(absPath, chainOpts)
  } catch (e) {
    stopDispatch({
      ...opts, reasonCode: 'protected_report_path',
      message: e.message,
      effects: { planInvoked: true },
    })
  }
  if (first.identity !== second.identity || first.real !== second.real) {
    stopDispatch({
      ...opts, reasonCode: 'protected_report_path',
      message: `路径身份在校验期间发生变化，无法可靠绑定：${path.resolve(absPath)}`,
      effects: { planInvoked: true },
    })
  }
  if (chainOpts.frozenIdentity && chainOpts.frozenIdentity !== first.identity) {
    stopDispatch({
      ...opts, reasonCode: 'protected_report_path',
      message: `路径身份与打开时冻结值不符：${path.resolve(absPath)}`,
      effects: { planInvoked: true },
    })
  }
  return first.identity
}

/**
 * 在 main/.scratch/night-batches 下创建/校验可信批次目录。
 * 拒绝目录本身、项目根及其全部祖先为符号链接，并冻结 dev/ino/realpath 供后续写入复验。
 */
function ensureTrustedBatchDir(mainCheckout, batchDir, opts = {}) {
  const projectIdentity = assertNoSymlinkInChain(mainCheckout, opts, {
    frozenIdentity: opts.projectIdentity,
  })
  assertNoSymlinkInChain(batchDir, opts, { allowMissingSuffix: true })
  const scratch = path.join(mainCheckout, '.scratch')
  const batches = path.join(scratch, 'night-batches')
  for (const dir of [scratch, batches]) {
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink()) {
        stopDispatch({
          ...opts, reasonCode: 'protected_report_path',
          message: `拒绝使用符号链接的批次祖先目录：${dir}`,
          effects: { planInvoked: true },
        })
      }
      if (!st.isDirectory()) {
        stopDispatch({
          ...opts, reasonCode: 'protected_report_path',
          message: `批次祖先路径不是目录：${dir}`,
          effects: { planInvoked: true },
        })
      }
    } else {
      fs.mkdirSync(dir, { recursive: true })
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink()) {
        stopDispatch({
          ...opts, reasonCode: 'protected_report_path',
          message: `创建后批次祖先目录为符号链接：${dir}`,
          effects: { planInvoked: true },
        })
      }
    }
  }
  const batchesReal = fs.realpathSync(batches)
  const mainReal = fs.realpathSync(mainCheckout)
  if (!batchesReal.startsWith(mainReal + path.sep)) {
    stopDispatch({
      ...opts, reasonCode: 'protected_report_path',
      message: `night-batches 真实路径越出项目主检出：${batchesReal}`,
      effects: { planInvoked: true },
    })
  }

  if (fs.existsSync(batchDir)) {
    const st = fs.lstatSync(batchDir)
    if (st.isSymbolicLink()) {
      stopDispatch({
        ...opts, reasonCode: 'protected_report_path',
        message: `拒绝批次目录为符号链接（可指向任意外部保护目录）：${batchDir}`,
        effects: { planInvoked: true },
      })
    }
    if (!st.isDirectory()) {
      stopDispatch({
        ...opts, reasonCode: 'protected_report_path',
        message: `批次路径不是目录：${batchDir}`,
        effects: { planInvoked: true },
      })
    }
  } else {
    // 父目录已核为真实目录；非 recursive 创建叶子，避免沿途跟随未知链接
    fs.mkdirSync(batchDir, { recursive: false })
  }

  const st = fs.lstatSync(batchDir)
  if (st.isSymbolicLink()) {
    stopDispatch({
      ...opts, reasonCode: 'protected_report_path',
      message: `创建后批次目录为符号链接：${batchDir}`,
      effects: { planInvoked: true },
    })
  }
  const batchDirReal = fs.realpathSync(batchDir)
  assertNoSymlinkInChain(batchDir, opts)
  assertNoSymlinkInChain(mainCheckout, opts, { frozenIdentity: projectIdentity })
  if (!(batchDirReal === batchesReal || batchDirReal.startsWith(batchesReal + path.sep))) {
    stopDispatch({
      ...opts, reasonCode: 'protected_report_path',
      message: `批次目录真实路径不在 night-batches 下：${batchDirReal}`,
      effects: { planInvoked: true },
    })
  }
  return {
    path: batchDir,
    real: batchDirReal,
    dev: st.dev,
    ino: st.ino,
  }
}

/**
 * 安全落盘：写入前与写入后均校验真实目标；已存在符号链接则 fail-closed。
 * 无法在校验与写入间可靠防竞态时拒绝写报告。
 */
function writeFileSafe(filePath, content, protectedLedgerPaths, opts = {}) {
  assertSafeReportPath(filePath, protectedLedgerPaths, opts)
  const abs = path.resolve(filePath)
  const parent = path.dirname(abs)
  const base = path.basename(abs)
  // 禁止沿路径 mkdir/rename；父目录必须已是冻结批次根
  if (opts.frozenBatch && path.resolve(parent) !== path.resolve(opts.frozenBatch.path)) {
    stopDispatch({
      forceNow: opts.forceNow, previewOnly: opts.previewOnly,
      reasonCode: 'protected_report_path',
      message: `报告文件必须直接位于可信批次目录内：${abs}`,
      effects: { planInvoked: true },
    })
  }
  assertSafeReportPath(filePath, protectedLedgerPaths, opts)
  if (opts.projectRoot) {
    assertNoSymlinkInChain(opts.projectRoot, opts, { frozenIdentity: opts.projectIdentity })
  }
  assertNoSymlinkInChain(parent, opts)
  if (!opts.frozenBatch) {
    stopDispatch({
      forceNow: opts.forceNow, previewOnly: opts.previewOnly,
      reasonCode: 'protected_report_path',
      message: `拒绝写入未冻结身份的批次目录：${abs}`,
      effects: { planInvoked: true },
    })
  }
  // Node 打开目录并核对冻结 dev/ino 后，才把该 fd 交给写入器。身份不符则不写。
  const pinned = writePinnedReport({
    directory: parent,
    basename: base,
    content,
    dev: opts.frozenBatch.dev,
    ino: opts.frozenBatch.ino,
  })
  if (!pinned.ok) {
    stopDispatch({
      forceNow: opts.forceNow, previewOnly: opts.previewOnly,
      reasonCode: 'protected_report_path',
      message: `拒绝写入报告路径（目录身份不符或钉扎失败）：${abs}：${pinned.message}`,
      effects: { planInvoked: true },
    })
  }
  assertSafeReportPath(abs, protectedLedgerPaths, opts)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 1 || argv[0].startsWith('-')) {
    console.error('用法: node scripts/ai-task-dispatcher.mjs <schedule.json> [--now] [--wait-ms N] [--preview] [--dry-run] [--simulate events.json]')
    process.exit(2)
  }
  const schedulePath = path.resolve(argv[0])
  const forceNow = argv.includes('--now')
  const previewOnly = argv.includes('--preview')
  // 显式预览强制只读；单独 --dry-run/--simulate 不能绕过 fail-closed。
  const dryRun = previewOnly || argv.includes('--dry-run')
  const simIdx = argv.indexOf('--simulate')
  const simulatePath = simIdx >= 0 ? path.resolve(argv[simIdx + 1]) : null
  let waitMs = 0
  const wIdx = argv.indexOf('--wait-ms')
  if (wIdx >= 0) waitMs = Number(argv[wIdx + 1] || 0)

  const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'))
  if (!schedule.project) { console.error('schedule.json 须含 project'); process.exit(2) }
  const main = path.resolve(expandPath(schedule.project))
  if (!fs.existsSync(main)) { console.error(`找不到项目主检出：${main}`); process.exit(2) }
  // 打开时绑定项目根及全部祖先。祖先别名在任何批次写入之前拒绝。
  const projectIdentity = assertNoSymlinkInChain(main, { forceNow, previewOnly })
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

  if (!previewOnly) {
    stopDispatch({
      forceNow,
      dryRun: argv.includes('--dry-run'),
      simulate: Boolean(simulatePath),
      reasonCode: 'legacy_dispatcher_disabled',
      message: '旧版 M5 自动派发已停用：当前平台契约未证明同一 Task 的服务端独占实施 Claim，也未证明旧 Run 停止后的安全接管；Owner、并发、Multica 事实与依赖状态无法由本入口权威确认。registry-only / GitHub legacy 候选不得自动认领、补 ready 标签或启动实施 Run；未回写 registry/BOARD。仅可使用 --preview 查看只读诊断与计划。',
    })
  }

  const protectedLedgerPaths = [
    path.join(main, 'docs/tasks/registry.json'),
    path.join(main, 'docs/tasks/BOARD.md'),
  ].map((p) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p)))

  let safeWriteOpts = { forceNow, previewOnly }

  const machineEntry = loadMachineConfig(schedule, main)
  if (dryRun) {
    if (!machineEntry.exists) console.error(`提示：机器配置不存在（preview/dry-run 继续）：${machineEntry.path}`)
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
  // 只读预览：不走 GitHub/远端 shell（含 taskSource 拉取与任意 remoteIssueCommand）
  if (taskSource.enabled && !previewOnly) {
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
  } else if (taskSource.enabled && previewOnly) {
    admission = planTaskSourceAdmission({
      registryTasks: loadRegistry(main).tasks,
      candidates: collected.candidates,
      readyIssues: [],
      claimedBy: new Map(),
      remoteError: '只读预览：跳过远端 GitHub/shell 调用',
      onUnavailable: 'local-only',
      requireAnchor: false,
    })
  }

  // 远端任务源的硬排除项（他人已认领 / 无锚点且 requireAnchor）在门禁之前就摘掉，
  // 避免把「本就不该开工」的任务送进定义门禁，产生误导性的门禁失败记录。
  const remoteHardExcluded = new Set((admission?.preExcluded || []).map((e) => e.id))
  const localCandidates = collected.candidates.filter((c) => !remoteHardExcluded.has(c.id))

  const batchDir = path.join(main, '.scratch/night-batches', `${localDate(startAt || new Date())}-${batchName}`)
  const frozenBatch = ensureTrustedBatchDir(main, batchDir, { forceNow, previewOnly, projectIdentity })
  safeWriteOpts = {
    forceNow,
    previewOnly,
    trustedBatchReal: frozenBatch.real,
    frozenBatch,
    projectRoot: main,
    projectIdentity,
  }
  const batchJsonPath = path.join(batchDir, 'batch.json')
  const taskSourceJsonPath = path.join(batchDir, 'task-source.json')
  const reportPathEarly = path.join(batchDir, 'report.md')
  // 首次写入前校验全部报告路径（含已存在的符号链接写穿）
  for (const p of [batchJsonPath, taskSourceJsonPath, reportPathEarly]) {
    assertSafeReportPath(p, protectedLedgerPaths, safeWriteOpts)
  }
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
  writeFileSafe(batchJsonPath, JSON.stringify(snapshot, null, 2) + '\n', protectedLedgerPaths, safeWriteOpts)
  if (remoteSnapshot) {
    // 远端快照留档：本批到底看到哪些「可施工」issue，事后可对账
    writeFileSafe(taskSourceJsonPath, JSON.stringify({
      capturedAt: nowIso(),
      slug: remoteSnapshot.slug,
      readyLabel: taskSource.readyLabel,
      wipLabel: taskSource.wipLabel,
      ready: remoteSnapshot.ready.map((i) => ({ number: i.number, title: i.title, labels: i.labels, assignees: i.assignees })),
    }, null, 2) + '\n', protectedLedgerPaths, safeWriteOpts)
  }

  // 2) 远端核验（报告性 best-effort；失败只记录，不影响本批）
  //    只读预览：完全不执行任意远端 shell 命令（含 machine.remoteIssueCommand）。
  let remoteCheck = '未配置 remoteIssueCommand，本批未做远端核验'
  let githubShellInvoked = false
  if (previewOnly) {
    remoteCheck = '只读预览：已跳过全部远端 shell / GitHub 命令（含 remoteIssueCommand）'
  } else if (taskSource.enabled) {
    remoteCheck = '已由 taskSource（GitHub 任务源通道）承担，见上一节'
  } else if (machine.remoteIssueCommand) {
    githubShellInvoked = true
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
  //      WFM-131：预览路径禁止补标/认领；真实自动派发入口已 fail-closed。
  const labelSyncLog = []
  let admitted = eligible
  if (taskSource.enabled && admission && admission.available) {
    const need = pendingLabelSync(eligible, admission.verdicts)
    const needIds = new Set(need.map((n) => n.id))
    const skipBecause = (t, reason) => {
      labelSyncLog.push({ id: t.id, result: `${reason} → 排除` })
      gateExcludedTagged.push({ id: t.id, name: t.name, stage: STAGE_TASK_SOURCE, reason })
    }
    if (need.length && (previewOnly || !taskSource.labelSync)) {
      for (const t of eligible) {
        if (needIds.has(t.id)) {
          skipBecause(
            t,
            previewOnly
              ? `只读预览：远端未标记 ${taskSource.readyLabel}，禁止自动补标`
              : `远端未标记 ${taskSource.readyLabel}，且 taskSource.labelSync=false`,
          )
        }
      }
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
    if (entry && entry.child.exitCode === null && entry.child.signalCode === null) {
      releaseAfterExit({
        entry,
        taskId,
        row,
        killEscalationMs: 10_000,
        onRelease: (id, next) => releaseSlot(id, next),
      })
      return
    }
    if (entry) {
      clearTimeout(entry.watchdogTimer)
      if (entry.killTimer) clearTimeout(entry.killTimer)
      children.delete(taskId)
    }
    const r = applyRelease(state, { taskId, ...row })
    if (!r.handled) return
    pump()
  }

  function watchdogFire(taskId) {
    fireWatchdog({
      taskId,
      children,
      sites,
      watchdogMinutes,
      watchdogFired,
      onRelease: (id, row) => releaseSlot(id, row),
    })
  }

  function pollOnce() {
    pollChildrenOnce({
      children,
      sites,
      onRelease: (id, row) => releaseSlot(id, row),
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

  // ----- 模拟 / 只读预览模式（不碰真实会话、不写旧账本） -----

  if (simulatePath || dryRun) {
    // endAt 已过则不开新任务，剩余队列如实进入 leftover（与真实路径语义一致）
    if (!endAt || new Date() < endAt) {
      fillCapacity(state)
    }
    if (simulatePath) {
      const events = JSON.parse(fs.readFileSync(simulatePath, 'utf8'))
      for (const ev of events) {
        if (ev.op !== 'release') continue
        if (endAt && new Date() >= endAt) break
        const r = applyRelease(state, ev)
        if (!r.handled && r.reason === 'not-running') continue
        if (!r.handled && r.reason === 'unknown-status') { console.error(`未知释放状态: ${ev.to}`); process.exit(1) }
        if (!endAt || new Date() < endAt) fillCapacity(state)
      }
    }
    const endedAt = nowIso()
    const leftoverLabel = previewOnly
      ? (endAt && new Date() >= endAt
        ? '未启动（超出 endAt 截止，未开新任务）'
        : '未启动（只读预览：未认领、未补标、未拉起实施 Run）')
      : (simulatePath ? '未启动（模拟事件排队，非真实拉起）' : '未启动（预演排队计划，真实批次按并发逐个补位）')
    const report = buildReport({
      schedule: { ...schedule, project: main }, permission, state, sites,
      launched, leftoverQueue: state.queue,
      leftoverLabel,
      snapshotCount: state.snapshot.length,
      startedAt, endedAt,
      preHygiene, postHygiene: { validate: '（预览/预演/模拟批次未执行）' },
      remoteCheck, initFailures, taskSourceLines,
      previewOnly,
    })
    const reportPath = path.join(batchDir, 'report.md')
    writeFileSafe(reportPath, report, protectedLedgerPaths, safeWriteOpts)
    // 预览路径不得执行远端 shell；若误调用则不得自报 githubWrites:0
    const githubWrites = previewOnly ? 0 : (githubShellInvoked ? null : 0)
    if (previewOnly && githubShellInvoked) {
      stopDispatch({
        forceNow, previewOnly: true,
        reasonCode: 'preview_remote_shell_forbidden',
        message: '只读预览路径不得执行远端 shell 命令；检测到 remoteIssueCommand 已被调用。',
        effects: { planInvoked: true, githubWrites: true },
      })
    }
    console.log(JSON.stringify({
      ok: true, milestone: 'M5',
      mode: previewOnly ? 'preview' : (simulatePath ? 'simulate' : 'dry-run'),
      previewOnly: Boolean(previewOnly),
      implementationRunStarted: false,
      agentSessionSpawned: false,
      githubWrites: githubWrites === null ? 'unknown' : githubWrites,
      githubShellInvoked: Boolean(githubShellInvoked),
      registryBoardWrites: false,
      autoPhaseDone: autoPhaseDone(state),
      snapshotIds: state.snapshot.map((t) => t.id),
      launchOrder: state.launchLog.filter((e) => e.action === 'launch').map((e) => e.taskId),
      leftoverQueue: state.queue,
      waiting: state.waiting.map((t) => t.id),
      blocked: state.blocked.map((t) => t.id),
      completed: state.completed.map((t) => t.id),
      excluded: state.excluded,
      taskSource: taskSource.enabled ? { note: admission.note, blocked: admission.blocked, labelSyncLog } : null,
      batchJsonPath, reportPath,
    }, null, 2))
    const taskSourceBlocked = Boolean(taskSource.enabled && admission && admission.blocked)
    const endAtLeftover = Boolean(endAt && new Date() >= endAt && state.queue.length > 0)
    process.exit((simulatePath && !autoPhaseDone(state)) || taskSourceBlocked || endAtLeftover ? 1 : 0)
  }

  // 真实唤起路径：在 Claim/接管实证前保持不可达（默认 fail-closed；--preview 已走上方只读分支）。
  stopDispatch({
    forceNow,
    previewOnly: false,
    reasonCode: 'legacy_dispatcher_disabled',
    message: '旧版 M5 真实唤起路径已停用；缺少 --preview 时不得继续派发。',
  })
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  console.error(JSON.stringify({
    ok: false,
    code: 'legacy_registry_dispatcher_disabled',
    reason: '旧 M5 dispatcher 依赖本地 registry.json 与 GitHub Task 标签，已退役；当前执行由 Multica 管理。',
    effects: '未读取 registry.json，未创建批次文件，未查询或写入 GitHub Task 标签，未启动 Run。',
  }, null, 2))
  process.exitCode = 2
}
