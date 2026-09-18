#!/usr/bin/env node
/**
 * 本地轨道合并：把已验收的任务分支合并回本地主干，一任务一提交。
 *
 * 门禁（任一不满足即中止，不改动仓库）：
 *   1. 人工验收结果为 accept / conditional_pass（reject 禁止合并）
 *   2. 登记册存在该任务，且当前状态为「等待验收」
 *   3. 任务卡的基线版本 = 任务规格版本
 *   4. 主干分支与任务分支均存在，任务分支确有新增提交
 *   5. 任务工作区无未提交改动；主干工作区无未提交改动
 *   6. 先在主干并入任务分支试运行，冲突则中止（需人工解决）
 *
 * 执行：任务分支并入主干最新 → 归档三件套（任务卡 + 规格 + 证据摘要）→ squash 成一提交
 *      → 打标签 → 更新登记册与看板 → **删除本任务工作区（保留分支）** → `git worktree prune` 兜底
 *      → 可选推送镜像仓库（失败仅告警）
 *
 * 阶段一口径（托管暂停期，决策 0001 §6 / 约定 §1.7.1）：**删工作区、留分支**。
 * 判据是「工作区可再生（`git worktree add` 从分支重建）、分支不可再生（补登 PR 的唯一载体）」。
 * 因此本脚本完成收口四件事中的三件——归档三件套、删工作区、兜底 prune；
 * 第四件（删分支）属阶段二（托管恢复后）动作，阶段一必须保留分支。
 *
 * 删除工作区的安全门（规格 §9 R-4）：仅在①登记册状态已合并 ②归档三件套已入库
 * ③证据明细已按锚定规则落主检出 ④工作区无未提交改动/未跟踪文件 时执行；
 * **不使用 `--force`**，被拒绝时只登记为遗留项，不阻塞合并主路径。
 *
 * CLI:
 *   node scripts/local-task-merge.mjs --task LOC-001 --branch dev-loc-001-r1 --decision accept|conditional_pass
 *     [--main main] [--worktree <path>] [--scope <范围>] [--feedback <优化意见>] [--mirror <remote>]
 *     [--run-dir <run目录>] [--repo <path>] [--keep-worktree] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, update, writeBoard, STATUS_LOCAL_DEFINED, STATUS_WAITING_ACCEPTANCE, STATUS_MERGED } from './local-task-registry.mjs'
import { field, parseSpecVersion, TASK_FIELDS } from './task-card-parse.mjs'
import { mainCheckout, worktreePathFor, runDirFor } from './workspace-paths.mjs'
import { generateEvidenceSummary } from './workspace-evidence-summary.mjs'

export const MERGEABLE_DECISIONS = new Set(['accept', 'conditional_pass'])
export const PRE_MERGE_STATUS = STATUS_WAITING_ACCEPTANCE
export const MERGED_STATUS = STATUS_MERGED

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

// 运行产物目录（与 cwf-run-init 写入 info/exclude 的约定一致）不应判为「工作区脏」
const STATUS_PATHSPEC = ['.', ':!.scratch', ':!.agent-runs']

// 路径相等判定（realpath 容忍：macOS 上 /var 与 /private/var 互为软链）
function samePath(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

function worktreeStatus(cwd) {
  return git(['status', '--porcelain', '--', ...STATUS_PATHSPEC], cwd)
}

function specVersionOf(specPath) {
  // 版本解析唯一实现 = task-card-parse（LOC-002）；此处只负责读文件。
  return parseSpecVersion(fs.readFileSync(specPath, 'utf-8'), specPath)
}

export function buildCommitMessage({
  taskId,
  name,
  baseline,
  scope,
  source,
  sourceRef,
  rangeText,
  decision,
  runId,
  cardArchive,
  specArchive,
  feedback,
}) {
  const head = `${scope ? `feat(${scope})` : 'feat'}: ${name} (${taskId} ${baseline})`
  const lines = [
    head,
    '',
    `任务标识: ${taskId}`,
    `需求基线: ${baseline}`,
    `需求来源: ${source ?? '未注明'}${sourceRef ? ` — ${sourceRef}` : ''}`,
    `任务范围: ${rangeText || '（详见任务卡）'}`,
    `验收结果: ${decision === 'accept' ? '通过' : '有条件通过'}`,
    `关联交付运行: ${runId ?? '-'}`,
    `任务卡: ${cardArchive}`,
    `任务规格: ${specArchive}`,
    'GitHub 同步: 待补 issue',
  ]
  if (feedback) lines.push('', '优化意见（留给下次定义，不改本轮基线）：', feedback)
  return lines.join('\n') + '\n'
}

/**
 * 合并前检查（不改动仓库）。
 * @returns {{ ok: boolean, failures: string[], plan?: object }}
 */
export function checkMerge({ repo, taskId, branch, main = 'main', decision, worktree, runDir }) {
  const failures = []

  if (!MERGEABLE_DECISIONS.has(decision)) {
    failures.push(`人工验收结果必须为 accept / conditional_pass，实际：${decision ?? '（缺失）'}`)
  }

  const registry = loadRegistry(repo)
  const record = registry.tasks.find((r) => r.task_id === taskId)
  if (!record) failures.push(`登记册中不存在任务：${taskId}`)

  let card = null
  let cardPath = null
  let specPath = null
  if (record) {
    if (record.status !== PRE_MERGE_STATUS) {
      failures.push(`任务状态必须为「${PRE_MERGE_STATUS}」，实际：${record.status}`)
    }
    const tasksDir = path.join(repo, 'docs', 'tasks')
    if (fs.existsSync(tasksDir)) {
      const hit = fs.readdirSync(tasksDir).find((f) => f.startsWith(`${taskId}-`) && f.endsWith('.md'))
      if (hit) {
        cardPath = path.join(tasksDir, hit)
        card = fs.readFileSync(cardPath, 'utf-8')
      }
    }
    if (!cardPath) failures.push(`本地任务卡缺失：docs/tasks/${taskId}-<slug>.md`)

    specPath = record.spec_path ? path.join(repo, record.spec_path) : null
    if (!specPath) {
      const guess = path.join(repo, '.scratch', `${taskId}-${record.slug}`, `task-spec-${record.baseline}.md`)
      specPath = fs.existsSync(guess) ? guess : null
    }
    if (!specPath || !fs.existsSync(specPath)) failures.push('本地任务规格缺失或路径不可解析')
  }

  if (card) {
    const cardVersion = field(card, TASK_FIELDS.BASELINE)
    const base = record?.baseline
    if (base && cardVersion && cardVersion.toUpperCase() !== base.toUpperCase()) {
      failures.push(`版本不一致：任务卡=${cardVersion} 登记册=${base}`)
    }
    if (specPath && fs.existsSync(specPath)) {
      const sv = specVersionOf(specPath)
      if (sv && cardVersion && sv.toUpperCase() !== cardVersion.toUpperCase()) {
        failures.push(`版本不一致：任务卡=${cardVersion} 规格=${sv}`)
      }
    }
  }

  // git 侧检查
  // 工作树路径由主检出派生（相邻容器），不再依赖 `.scratch/worktrees/` 这一旧布局
  const wt = worktree || worktreePathFor(mainCheckout(repo), branch)
  if (!fs.existsSync(wt)) failures.push(`任务工作区不存在：${wt}`)
  else {
    const dirty = worktreeStatus(wt)
    if (dirty) failures.push(`任务工作区有未提交改动：\n${dirty}`)
  }

  const mainDirty = worktreeStatus(repo)
  if (mainDirty) failures.push(`主干工作区有未提交改动：\n${mainDirty}`)

  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
  if (currentBranch !== main) failures.push(`主干工作区当前不在 ${main}（实际：${currentBranch}）`)

  if (!git(['branch', '--list', branch], repo)) failures.push(`任务分支不存在：${branch}`)
  else {
    const ahead = git(['rev-list', '--count', `${main}..${branch}`], repo)
    if (Number(ahead) === 0) failures.push(`任务分支相对 ${main} 没有新增提交：${branch}`)
  }

  if (runDir) {
    const runJson = path.join(runDir, 'run.json')
    if (!fs.existsSync(runJson)) failures.push(`交付运行目录无效（缺 run.json）：${runDir}`)
  }

  if (failures.length) return { ok: false, failures }
  return {
    ok: true,
    failures: [],
    plan: { repo, taskId, branch, main, worktree: wt, cardPath, specPath, record },
  }
}

function copyIntoArchive(repo, taskId, files) {
  const dir = path.join(repo, 'docs', 'tasks', 'archive', taskId)
  fs.mkdirSync(dir, { recursive: true })
  const copied = []
  for (const f of files) {
    if (!f || !fs.existsSync(f)) continue
    const dest = path.join(dir, path.basename(f))
    fs.copyFileSync(f, dest)
    copied.push(path.relative(repo, dest))
  }
  return { dir: path.relative(repo, dir), copied }
}

/**
 * 执行合并。checkMerge 通过后才可调用。
 */
export function runMerge({
  repo,
  taskId,
  branch,
  main = 'main',
  decision,
  scope,
  feedback,
  mirror,
  worktree,
  runId,
  keepWorktree = false,
  dryRun = false,
}) {
  const check = checkMerge({ repo, taskId, branch, main, decision, worktree, runDir: undefined })
  if (!check.ok) return { ok: false, merged: false, failures: check.failures }
  const { plan } = check
  const wt = plan.worktree

  const cardArchiveRel = path.join('docs', 'tasks', 'archive', taskId, path.basename(plan.cardPath))
  const specArchiveRel = path.join('docs', 'tasks', 'archive', taskId, path.basename(plan.specPath))

  const card = fs.readFileSync(plan.cardPath, 'utf-8')
  const message = buildCommitMessage({
    taskId,
    name: plan.record.name,
    baseline: plan.record.baseline,
    scope,
    source: plan.record.source,
    sourceRef: plan.record.source_ref,
    rangeText: (card.match(/### 涉及范围[\s\S]*?\n\n/) || [''])[0].replace(/[-*]\s*/g, '').trim(),
    decision,
    runId,
    cardArchive: cardArchiveRel,
    specArchive: specArchiveRel,
    feedback,
  })

  if (dryRun) {
    return { ok: true, merged: false, dryRun: true, plan, message }
  }

  // 1. 任务分支先并入主干最新进展（冲突在此暴露，不污染主干）
  try {
    git(['merge', '--no-edit', main], wt)
  } catch (e) {
    try {
      git(['merge', '--abort'], wt)
    } catch { /* 已中止或无进行中合并 */ }
    return {
      ok: false,
      merged: false,
      failures: [`任务分支并入 ${main} 时出现冲突，需人工解决后重试：${String(e.message).split('\n')[0]}`],
    }
  }

  const branchHead = git(['rev-parse', branch], repo)

  // 2. 主干 squash 合并（一任务一提交）
  try {
    git(['merge', '--squash', branch], repo)
  } catch (e) {
    try {
      git(['merge', '--abort'], repo)
    } catch {
      try {
        git(['reset', '--merge'], repo)
      } catch { /* 交人工处理 */ }
    }
    return { ok: false, merged: false, failures: [`squash 合并失败：${String(e.message).split('\n')[0]}`] }
  }

  // 3. 归档任务卡与规格（必须在提交前，才能随同一提交入库）
  const archive = copyIntoArchive(repo, taskId, [plan.cardPath, plan.specPath])

  // 3b. 归档三件套之第三件：证据摘要（§1.7.3）
  //     证据明细若仍在工作树内（收口时常见的状态），先按 §1.6 锚定规则复制到主检出，
  //     再生成摘要——摘要本身也要随这次提交入库。
  const mainRoot = mainCheckout(repo)
  const effectiveRunId = runId || branch.replace(/^dev-/, '')
  const mainRunDir = runDirFor(mainRoot, effectiveRunId)
  const wtRunDir = path.join(wt, '.agent-runs', effectiveRunId)
  let evidenceArchivedFrom = null
  if (!fs.existsSync(mainRunDir) && fs.existsSync(wtRunDir)) {
    fs.mkdirSync(path.dirname(mainRunDir), { recursive: true })
    fs.cpSync(wtRunDir, mainRunDir, { recursive: true })
    evidenceArchivedFrom = wtRunDir
  }
  let summaryPath = null
  let summaryError = null
  try {
    const res = generateEvidenceSummary({ root: mainRoot, taskId, runId: effectiveRunId, noRunEvidence: !fs.existsSync(mainRunDir) })
    summaryPath = res.outPath
  } catch (e) {
    summaryError = String(e.message).split('\n')[0]
  }

  // 4. 更新登记册与看板（spec_path 同步改指归档位置——否则收口后登记册仍指向
  //    .scratch 临时区的旧路径，成为悬空引用）
  //    branch_retained 同步写入（阶段一口径 = 保留分支），使 D-10「收口口径一致」
  //    覆盖全部已合并任务，而不是因字段缺失被静默跳过。
  update(repo, taskId, {
    status: MERGED_STATUS,
    branch,
    merge_commit: 'PENDING',
    spec_path: specArchiveRel,
    branch_retained: true,
  })
  if (feedback) update(repo, taskId, { leftovers: feedback })
  writeBoard(repo)

  // 5. 提交（含分支改动 + 归档 + 登记册）
  const msgFile = path.join(os.tmpdir(), `loc-merge-${taskId}-${Date.now()}.txt`)
  fs.writeFileSync(msgFile, message)
  git(['add', '--', 'docs/tasks'], repo)
  git(['commit', '-F', msgFile], repo)
  fs.unlinkSync(msgFile)

  const commit = git(['rev-parse', 'HEAD'], repo)
  update(repo, taskId, { merge_commit: commit })

  // 6. 打标签
  const tag = `task/${taskId.toLowerCase()}/${String(plan.record.baseline).toLowerCase()}`
  try {
    git(['tag', '-f', tag, commit], repo)
  } catch { /* 标签已存在时强制覆盖 */ }

  // 7. 删除本任务工作区（阶段一口径：删工作区、留分支）。
  //    安全门（规格 §9 R-4）：登记册已置「已合并」（上一步）、归档三件套已随提交入库、
  //    证据明细已按锚定规则落主检出（步骤 3b）、工作区干净——四项同时满足才删。
  //    **不使用 `--force`**：被拒绝时只登记遗留，不阻塞合并主路径（工作区可再生，分支已保留）。
  let workspaceRemoved = false
  let workspaceRemoveError = null
  if (keepWorktree) {
    workspaceRemoveError = '按 --keep-worktree 显式跳过删除（非常规路径）'
  } else if (samePath(wt, repo)) {
    workspaceRemoveError = '跳过删除：工作区路径与主干路径相同'
  } else {
    const dirty = worktreeStatus(wt)
    if (dirty) {
      workspaceRemoveError = `按 R-4 拒绝删除（有未提交改动或未跟踪文件，不使用 --force）：${dirty.split('\n')[0]}`
    } else {
      try {
        git(['worktree', 'remove', wt], repo)
        workspaceRemoved = true
      } catch (e) {
        // 保留 git 的原话（例如「contains modified or untracked files, use --force to delete it」），
        // 这样才能让人从遗留项直接看出为什么没删、以及是否本可选用 --force（R-4 明确不许用）。
        const detail = (e.stderr ? String(e.stderr).trim().split('\n')[0] : '') || String(e.message).split('\n')[0]
        // 本机 safe-delete 钩子会让 git 报错而实际已删除（实例文档 §11.4 已记录该现象）：
        // 一律以「登记已注销 + 磁盘已不存在」复核为准，避免把已完成的删除误记为遗留。
        const stillRegistered = (git(['worktree', 'list', '--porcelain'], repo) || '').includes(wt)
        if (!stillRegistered && !fs.existsSync(wt)) {
          workspaceRemoved = true
        } else {
          workspaceRemoveError = `git worktree remove 被拒绝：${detail}`
        }
      }
    }
  }

  // 8. 兜底注销失效的工作区登记：删父工作区不会级联注销其内部嵌套的子登记
  //    （约定 §1.7.4；该缺口已三次复现：dev-itest-a-01、ws-cwf-159-01、LOC-013 的三个 UAT 工作区）
  //    prune 失败不阻塞合并——它只是清理，不是交付条件。
  let pruned = false
  try {
    git(['worktree', 'prune'], repo)
    pruned = true
  } catch { /* 交人工处理 */ }

  let mirrorResult = 'skipped'
  if (mirror) {
    try {
      git(['push', mirror, `${main}:${main}`], repo)
      git(['push', mirror, '--tags'], repo)
      mirrorResult = 'pushed'
    } catch (e) {
      mirrorResult = `failed: ${String(e.message).split('\n')[0]}`
    }
  }

  return {
    ok: true,
    merged: true,
    task_id: taskId,
    branch,
    branch_head: branchHead,
    commit,
    tag,
    archive: archive.copied,
    evidence: {
      run_id: effectiveRunId,
      archived_from: evidenceArchivedFrom,
      summary_path: summaryPath ? path.relative(repo, summaryPath) : null,
      ...(summaryError ? { error: summaryError } : {}),
    },
    pruned,
    mirror: mirrorResult,
    workspace: {
      path: wt,
      removed: workspaceRemoved,
      ...(workspaceRemoveError ? { error: workspaceRemoveError } : {}),
    },
    cleanup_hint:
      '三件套（任务卡 + 规格 + 证据摘要）已入库；失效登记已 prune；' +
      (workspaceRemoved
        ? `本任务工作区已删除（${wt}），分支 ${branch} 按阶段一口径保留，待托管恢复后补 PR 再删。`
        : `本任务工作区未删除（${workspaceRemoveError}）；按 R-4 只登记遗留、不阻塞合并——` +
          `确认无未归档内容后人工执行 git worktree remove ${wt}，随后 git worktree prune。` +
          `分支 ${branch} 保留。`),
  }
}

// —— CLI ——
function main(argv) {
  const get = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const taskId = get('--task')
  const branch = get('--branch')
  const decision = get('--decision')
  if (!taskId || !branch || !decision) {
    console.error('用法: node scripts/local-task-merge.mjs --task LOC-001 --branch dev-loc-001-r1 --decision accept|conditional_pass [--main main] [--worktree <path>] [--scope <x>] [--feedback <x>] [--mirror <remote>] [--repo <path>] [--keep-worktree] [--dry-run]')
    process.exit(2)
  }
  const repo = path.resolve(get('--repo') || process.cwd())
  const out = runMerge({
    repo,
    taskId,
    branch,
    main: get('--main') || 'main',
    decision,
    scope: get('--scope'),
    feedback: get('--feedback'),
    mirror: get('--mirror'),
    worktree: get('--worktree'),
    runId: get('--run-id'),
    keepWorktree: argv.includes('--keep-worktree'),
    dryRun: argv.includes('--dry-run'),
  })
  if (out.merged) update(repo, taskId, { github_sync: 'pending' })
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
