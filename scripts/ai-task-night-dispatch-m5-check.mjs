#!/usr/bin/env node
/**
 * M5 safety check (WFM-131/WFM-133):
 * - default dispatcher fails closed before claim / label sync / implementation Run
 * - registry-only candidates and missing Multica facts cannot auto-dispatch
 * - repeated triggers stay blocked; explicit --preview is read-only
 * - preview never runs remote shell (incl. remoteIssueCommand); GitHub write calls stay zero
 * - report paths refuse symlink write-through to registry/BOARD before first write
 * - registry/BOARD hashes unchanged
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const errors = []
function fail(message) { errors.push(message) }
function ok(condition, message) { if (!condition) fail(message) }
function read(rel) {
  const target = path.join(root, rel)
  ok(fs.existsSync(target), `缺少: ${rel}`)
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
}
function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}
function parseJson(result, label) {
  try { return JSON.parse(result.stdout) } catch {
    fail(`${label} 输出非 JSON: ${result.stdout}\n${result.stderr}`)
    return null
  }
}

const doc = read('docs/design/night-batch-dispatcher.md')
ok(/WFM-131/.test(doc) && /fail-closed/.test(doc) && /--preview/.test(doc), 'M5 文档须声明当前 fail-closed 与只读预览')
ok(/M3|Execution Plan|候选采集/.test(doc), 'M5 文档须保留计划/采集定位')
ok(/remoteIssueCommand|远端 shell|符号链接|写穿/.test(doc), 'M5 文档须声明预览禁远端 shell 与产物路径保护')

const dispatcher = path.join(root, 'scripts/ai-task-dispatcher.mjs')
ok(fs.existsSync(dispatcher), '缺少 ai-task-dispatcher.mjs')
const dispatcherSrc = fs.readFileSync(dispatcher, 'utf8')
ok(/legacy_dispatcher_disabled/.test(dispatcherSrc), '调度器须有可识别的 fail-closed 停止路径')
ok(/--preview/.test(dispatcherSrc), '调度器须显式提供只读预览入口')
ok(/previewOnly/.test(dispatcherSrc), '调度器须区分只读预览')
ok(/assessAndSort|fillCapacity|applyRelease/.test(dispatcherSrc), '只读预览须保留 M3 排序/并发/补位算法引用')
ok(/assertSafeReportPath|writeFileSafe|protected_report_path|ensureTrustedBatchDir/.test(dispatcherSrc), '须在写入前校验报告路径并拒绝符号链接写穿')
ok(/只读预览：已跳过全部远端 shell|preview.*remoteIssueCommand|跳过.*remoteIssueCommand/.test(dispatcherSrc), '预览须跳过 remoteIssueCommand')
ok(/ai-task-session-supervise|fireWatchdog|pollChildrenOnce/.test(dispatcherSrc), '调度器须接入会话监工模块（看门狗/释放契约）')
ok(/ai-task-pinned-write\.py|assertNoSymlinkInChain/.test(dispatcherSrc), '报告写入须钉扎目录 fd，并拒绝项目根/祖先符号链接')
ok(/项目根及其祖先/.test(dispatcherSrc), '调度器须拒绝项目根及其祖先上的符号链接')
ok(fs.existsSync(path.join(root, 'scripts/ai-task-session-supervise.mjs')), '须有会话监工模块供假会话回归')
ok(fs.existsSync(path.join(root, 'scripts/ai-task-pinned-write.py')), '须有目录 fd 钉扎写入辅助')
const superviseSrc = fs.readFileSync(path.join(root, 'scripts/ai-task-session-supervise.mjs'), 'utf8')
ok(/pendingExit|watchdogReleased/.test(superviseSrc) && /child\.once\('exit'/.test(superviseSrc), '看门狗须等子进程退出后再释放名额')

const m3Fixtures = path.join(root, 'scripts/test/fixtures/ai-task-execution-plan-m3')
const ledgerPaths = [
  path.join(root, 'docs/tasks/registry.json'),
  path.join(root, 'docs/tasks/BOARD.md'),
]
const ledgerHashesBefore = ledgerPaths.map(hashFile)

const tmpRoot = fs.realpathSync(os.tmpdir())
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm5-dispatch-safety-'))
try {
  const proj = path.join(tmpDir, 'proj')
  fs.mkdirSync(path.join(proj, 'docs/tasks'), { recursive: true })
  for (const [i, id] of ['FIX-A', 'FIX-B'].entries()) {
    const fx = ['A', 'B'][i]
    fs.mkdirSync(path.join(proj, '.scratch/specs', id), { recursive: true })
    fs.copyFileSync(path.join(m3Fixtures, fx, 'issue-basics.md'), path.join(proj, 'docs/tasks', `${id}-defined.md`))
    fs.copyFileSync(path.join(m3Fixtures, fx, 'task-spec-V1.md'), path.join(proj, '.scratch/specs', id, 'task-spec-V1.md'))
    fs.copyFileSync(path.join(m3Fixtures, fx, 'definition-check.md'), path.join(proj, '.scratch/specs', id, 'definition-check.md'))
  }
  // registry-only 候选：无 Multica issue 事实、无 Owner；仅本地旧账本条目
  fs.writeFileSync(path.join(proj, 'docs/tasks/registry.json'), JSON.stringify({
    version: 1,
    tasks: [
      {
        task_id: 'FIX-A', name: 'registry-only A', status: '已定义', slug: 'defined',
        deps: [], env_group: 'FIX-A', env_role: '独立', priority: null,
        spec_path: '.scratch/specs/FIX-A/task-spec-V1.md',
      },
      {
        task_id: 'FIX-B', name: 'registry-only B', status: '已定义', slug: 'defined',
        deps: [], env_group: 'FIX-B', env_role: '独立', priority: null,
        spec_path: '.scratch/specs/FIX-B/task-spec-V1.md',
      },
    ],
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(proj, 'docs/tasks/BOARD.md'), '# fixture board\n')

  const schedulePath = path.join(proj, 'schedule.json')
  fs.writeFileSync(schedulePath, JSON.stringify({
    project: proj,
    batchName: 'safety-batch',
    maxConcurrency: 2,
    permission: 'full-access',
    watchdogMinutes: 1,
    pollMs: 50,
    postValidateCommand: 'node -e "process.exit(0)"',
    machineConfig: '.scratch/night-batches/machine.json',
  }, null, 2) + '\n')

  const scheduleFuture = path.join(proj, 'schedule-future.json')
  fs.writeFileSync(scheduleFuture, JSON.stringify({
    ...JSON.parse(fs.readFileSync(schedulePath, 'utf8')),
    startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }, null, 2) + '\n')

  const ghLog = path.join(tmpDir, 'gh-calls.log')
  const ghWriteLog = path.join(tmpDir, 'gh-writes.log')
  const ghBin = path.join(tmpDir, 'bin')
  fs.mkdirSync(ghBin)
  const ghStub = path.join(ghBin, 'gh')
  fs.writeFileSync(ghStub, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$GH_CALL_LOG"',
    'case "$*" in',
    '  issue\\ edit\\ *|issue\\ comment\\ *|issue\\ create\\ *|issue\\ close\\ *|issue\\ reopen\\ *|label\\ create\\ *|label\\ edit\\ *|label\\ delete\\ *|*--method\\ POST*|*--method\\ PATCH*|*--method\\ PUT*|*--method\\ DELETE*) printf \'%s\\n\' "$*" >> "$GH_WRITE_LOG" ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'), 'utf8')
  fs.chmodSync(ghStub, 0o755)
  const shimEnv = {
    ...process.env,
    PATH: `${ghBin}:${process.env.PATH || ''}`,
    GH_CALL_LOG: ghLog,
    GH_WRITE_LOG: ghWriteLog,
  }

  // 未到点不进入派发（此时尚未创建 machine / 批次目录）。
  const pending = spawnSync(process.execPath, [dispatcher, scheduleFuture], { encoding: 'utf8', env: shimEnv })
  ok(pending.status === 3, `未到点应 exit 3，got ${pending.status}\n${pending.stdout}\n${pending.stderr}`)
  const pendingOut = parseJson(pending, 'pending')
  ok(pendingOut && pendingOut.pending === true, '未到点须 pending:true')
  ok(!fs.existsSync(path.join(proj, '.scratch/night-batches')), '未到点不得产出批次目录')
  ok(!fs.existsSync(path.join(proj, '.agent-runs')), '未到点不得创建实施 Run 现场')

  const machinePath = path.join(proj, '.scratch/night-batches/machine.json')
  fs.mkdirSync(path.dirname(machinePath), { recursive: true })
  // 故意配置写意图命令：预览必须完全不执行（A1）
  fs.writeFileSync(machinePath, JSON.stringify({
    remoteIssueCommand: 'gh issue edit 999 --add-label ready-for-agent',
  }, null, 2) + '\n')

  // 默认 / --now / 单独 --dry-run：重复触发均 fail-closed，不派发、不写账本。
  for (const [attempt, args] of [
    [1, ['--now']],
    [2, ['--now']],
    [3, ['--dry-run']],
  ]) {
    const blocked = spawnSync(process.execPath, [dispatcher, schedulePath, ...args], {
      encoding: 'utf8',
      env: shimEnv,
    })
    ok(blocked.status === 1, `第 ${attempt} 次触发须 fail-closed，got ${blocked.status}`)
    const blockedOut = parseJson(blocked, `blocked ${attempt}`)
    ok(
      blockedOut
        && blockedOut.blocked === true
        && blockedOut.reasonCode === 'legacy_dispatcher_disabled',
      `第 ${attempt} 次触发须说明旧 M5 派发停用原因`,
    )
    ok(
      blockedOut
        && blockedOut.effects?.implementationRunStarted === false
        && blockedOut.effects?.agentSessionSpawned === false
        && blockedOut.effects?.githubWrites === false
        && blockedOut.effects?.registryBoardWrites === false,
      `第 ${attempt} 次触发不得写 GitHub/账本或启动实施 Run`,
    )
    ok(!fs.existsSync(path.join(proj, '.agent-runs')), `第 ${attempt} 次阻断不得创建 .agent-runs`)
  }
  ok(!fs.existsSync(ghLog) || fs.readFileSync(ghLog, 'utf8').trim() === '', '阻断路径不得调用 GitHub CLI')
  ok(!fs.existsSync(ghWriteLog) || fs.readFileSync(ghWriteLog, 'utf8').trim() === '', '阻断路径 GitHub 写调用数须为零')

  // 显式只读预览：可跑诊断/计划，但零 GitHub 写、零实施 Run、不改账本；且不得执行 remoteIssueCommand。
  const preview = spawnSync(process.execPath, [dispatcher, schedulePath, '--now', '--preview'], {
    encoding: 'utf8',
    env: shimEnv,
  })
  ok(preview.status === 0, `只读预览应成功\n${preview.stdout}\n${preview.stderr}`)
  const previewOut = parseJson(preview, 'preview')
  if (!previewOut) {
    fail('预览输出无法解析，跳过后续预览字段断言（避免 TypeError 掩盖安全断言）')
  } else {
    ok(previewOut.previewOnly === true && previewOut.mode === 'preview', '预览输出须标记 preview')
    ok(previewOut.implementationRunStarted === false && previewOut.agentSessionSpawned === false, '预览不得启动实施 Run')
    ok(previewOut.githubWrites === 0 && previewOut.registryBoardWrites === false, '预览不得写 GitHub/旧账本')
    ok(previewOut.githubShellInvoked === false, '预览不得执行远端 shell（remoteIssueCommand）')
    ok(Array.isArray(previewOut.snapshotIds) && previewOut.snapshotIds.length >= 1, '预览须产出只读计划快照')
    if (typeof previewOut.reportPath === 'string' && fs.existsSync(previewOut.reportPath)) {
      const reportText = fs.readFileSync(previewOut.reportPath, 'utf8')
      ok(/只读计划预览|WFM-131/.test(reportText) && /未.*认领|未.*补/.test(reportText), '报告须明确只读且未派发')
      ok(/跳过全部远端 shell|remoteIssueCommand/.test(reportText), '报告须注明已跳过远端 shell')
    } else {
      fail('显式预览须写出独立报告（reportPath 缺失或文件不存在）')
    }
  }
  ok(!fs.existsSync(path.join(proj, '.agent-runs')), '预览不得创建实施 Run 现场')
  ok(!fs.existsSync(ghLog) || fs.readFileSync(ghLog, 'utf8').trim() === '', '预览期间不得调用 gh（含 remoteIssueCommand）')
  ok(!fs.existsSync(ghWriteLog) || fs.readFileSync(ghWriteLog, 'utf8').trim() === '', '预览期间 GitHub 写调用数须为零')

  // A2：预置 batch.json → registry 符号链接；须在首次写入前拒绝，registry 哈希不变
  const fixtureRegistry = path.join(proj, 'docs/tasks/registry.json')
  const fixtureBoard = path.join(proj, 'docs/tasks/BOARD.md')
  const fixtureRegistryHash = hashFile(fixtureRegistry)
  const fixtureBoardHash = hashFile(fixtureBoard)
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const localDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const symlinkBatch = 'symlink-probe'
  const scheduleSymlink = path.join(proj, 'schedule-symlink.json')
  fs.writeFileSync(scheduleSymlink, JSON.stringify({
    ...JSON.parse(fs.readFileSync(schedulePath, 'utf8')),
    batchName: symlinkBatch,
  }, null, 2) + '\n')
  const probeDir = path.join(proj, '.scratch/night-batches', `${localDay}-${symlinkBatch}`)
  fs.mkdirSync(probeDir, { recursive: true })
  fs.symlinkSync(fixtureRegistry, path.join(probeDir, 'batch.json'))
  const symlinkPreview = spawnSync(process.execPath, [dispatcher, scheduleSymlink, '--now', '--preview'], {
    encoding: 'utf8',
    env: shimEnv,
  })
  ok(symlinkPreview.status === 1, `符号链接写穿须被拒绝，got ${symlinkPreview.status}`)
  const symlinkOut = parseJson(symlinkPreview, 'symlink-preview')
  ok(
    symlinkOut && symlinkOut.blocked === true && symlinkOut.reasonCode === 'protected_report_path',
    '符号链接写穿须报告 protected_report_path',
  )
  ok(hashFile(fixtureRegistry) === fixtureRegistryHash, '符号链接探针不得改写 fixture registry')
  ok(hashFile(fixtureBoard) === fixtureBoardHash, '符号链接探针不得改写 fixture BOARD')

  // A2b：批次目录本身链到外部保护目录；哨兵不得被覆盖
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-alias-ext-'))
  const sentinel = path.join(external, 'batch.json')
  fs.writeFileSync(sentinel, 'SENTINEL-MUST-NOT-OVERWRITE\n')
  const aliasBatch = 'dir-alias-probe'
  const scheduleAlias = path.join(proj, 'schedule-alias.json')
  fs.writeFileSync(scheduleAlias, JSON.stringify({
    ...JSON.parse(fs.readFileSync(schedulePath, 'utf8')),
    batchName: aliasBatch,
  }, null, 2) + '\n')
  const aliasDir = path.join(proj, '.scratch/night-batches', `${localDay}-${aliasBatch}`)
  try { fs.rmSync(aliasDir, { recursive: true, force: true }) } catch { /* ignore */ }
  fs.symlinkSync(external, aliasDir)
  const aliasPreview = spawnSync(process.execPath, [dispatcher, scheduleAlias, '--now', '--preview'], {
    encoding: 'utf8',
    env: shimEnv,
  })
  ok(aliasPreview.status === 1, `批次目录别名须被拒绝，got ${aliasPreview.status}`)
  const aliasOut = parseJson(aliasPreview, 'alias-preview')
  ok(
    aliasOut && aliasOut.blocked === true && aliasOut.reasonCode === 'protected_report_path',
    '批次目录别名须报告 protected_report_path',
  )
  ok(fs.readFileSync(sentinel, 'utf8') === 'SENTINEL-MUST-NOT-OVERWRITE\n', '外部哨兵不得被批次产物覆盖')
  fs.rmSync(external, { recursive: true, force: true })

  const pinSelf = spawnSync('python3', [path.join(root, 'scripts/ai-task-pinned-write.py'), '--self-test'], { encoding: 'utf8' })
  ok(pinSelf.status === 0, `目录钉扎自测须通过\n${pinSelf.stdout}\n${pinSelf.stderr}`)

  const rootLink = path.join(tmpDir, 'proj-link')
  fs.symlinkSync(proj, rootLink)
  const rootLinkBatch = 'root-link-probe'
  const scheduleRootLink = path.join(proj, 'schedule-root-link.json')
  fs.writeFileSync(scheduleRootLink, JSON.stringify({
    ...JSON.parse(fs.readFileSync(schedulePath, 'utf8')),
    project: rootLink,
    batchName: rootLinkBatch,
  }, null, 2) + '\n')
  const rootSentinelDir = path.join(proj, '.scratch/night-batches', `${localDay}-${rootLinkBatch}`)
  fs.mkdirSync(rootSentinelDir, { recursive: true })
  const rootSentinel = path.join(rootSentinelDir, 'batch.json')
  fs.writeFileSync(rootSentinel, 'SENTINEL-MUST-NOT-OVERWRITE\n')
  const rootLinkPreview = spawnSync(process.execPath, [dispatcher, scheduleRootLink, '--now', '--preview'], {
    encoding: 'utf8',
    env: shimEnv,
  })
  ok(rootLinkPreview.status === 1, `项目根符号链接须被拒绝，got ${rootLinkPreview.status}`)
  const rootLinkOut = parseJson(rootLinkPreview, 'root-link-preview')
  ok(rootLinkOut && rootLinkOut.reasonCode === 'protected_report_path', '项目根符号链接须报告 protected_report_path')
  ok(fs.readFileSync(rootSentinel, 'utf8') === 'SENTINEL-MUST-NOT-OVERWRITE\n', '项目根链接不得覆盖外部/目标哨兵')

  // 项目根自身是真目录，但其父目录是 alias → real。预览必须拒绝，且不能写 batch/report。
  const ancestorAlias = path.join(tmpRoot, `m5-ancestor-alias-${Date.now()}`)
  fs.symlinkSync(tmpDir, ancestorAlias)
  const lexicalProject = path.join(ancestorAlias, 'proj')
  const ancestorBatch = 'ancestor-link-probe'
  const scheduleAncestor = path.join(proj, 'schedule-ancestor.json')
  fs.writeFileSync(scheduleAncestor, JSON.stringify({
    ...JSON.parse(fs.readFileSync(schedulePath, 'utf8')),
    project: lexicalProject,
    batchName: ancestorBatch,
  }, null, 2) + '\n')
  const ancestorPreview = spawnSync(process.execPath, [dispatcher, scheduleAncestor, '--now', '--preview'], {
    encoding: 'utf8',
    env: shimEnv,
  })
  ok(ancestorPreview.status === 1, `项目根祖先符号链接须被拒绝，got ${ancestorPreview.status}\n${ancestorPreview.stdout}\n${ancestorPreview.stderr}`)
  const ancestorOut = parseJson(ancestorPreview, 'ancestor-preview')
  ok(ancestorOut && ancestorOut.blocked === true && ancestorOut.reasonCode === 'protected_report_path', '项目根祖先符号链接须报告 protected_report_path')
  const ancestorBatchDir = path.join(proj, '.scratch/night-batches', `${localDay}-${ancestorBatch}`)
  ok(!fs.existsSync(path.join(ancestorBatchDir, 'batch.json')), '祖先符号链接不得写出 batch.json')
  ok(!fs.existsSync(path.join(ancestorBatchDir, 'report.md')), '祖先符号链接不得写出 report.md')
  ok(!fs.existsSync(path.join(ancestorBatchDir, 'task-source.json')), '祖先符号链接不得写出 task-source.json')
  ok(hashFile(fixtureRegistry) === fixtureRegistryHash, '祖先符号链接探针不得改写 fixture registry')
  ok(hashFile(fixtureBoard) === fixtureBoardHash, '祖先符号链接探针不得改写 fixture BOARD')
  fs.unlinkSync(ancestorAlias)

  // 正常第二次预览：夹具账本仍不得被改写
  const preview2 = spawnSync(process.execPath, [dispatcher, schedulePath, '--preview'], {
    encoding: 'utf8',
    env: shimEnv,
  })
  ok(preview2.status === 0, `第二次预览应成功\n${preview2.stderr}`)
  ok(
    hashFile(fixtureRegistry) === fixtureRegistryHash
      && hashFile(fixtureBoard) === fixtureBoardHash,
    '预览不得改写 fixture registry/BOARD',
  )
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

const ledgerHashesAfter = ledgerPaths.map(hashFile)
ok(JSON.stringify(ledgerHashesAfter) === JSON.stringify(ledgerHashesBefore), '仓库 registry.json / BOARD.md 前后哈希必须一致')

if (errors.length) {
  console.error('M5 安全检查失败：')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}
console.log(JSON.stringify({
  ok: true,
  milestone: 'M5',
  blockedReason: 'legacy_dispatcher_disabled',
  repeatedTriggersBlocked: true,
  githubWrites: 0,
  previewRemoteShellSkipped: true,
  symlinkWriteThroughBlocked: true,
  registryBoardUnchanged: true,
  previewReadOnly: true,
}, null, 2))
