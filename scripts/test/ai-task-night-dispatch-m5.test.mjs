import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createBatchState,
  fillCapacity,
  applyRelease,
  autoPhaseDone,
} from '../ai-task-execution-plan.mjs'
import { fireWatchdog, pollChildrenOnce } from '../ai-task-session-supervise.mjs'
import { writePinnedReport } from '../ai-task-pinned-write.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dispatcher = path.join(root, 'scripts/ai-task-dispatcher.mjs')
const m3Fixtures = path.join(root, 'scripts/test/fixtures/ai-task-execution-plan-m3')
const tmpRoot = fs.realpathSync(os.tmpdir())

// WFM-131 未修调度器快照：A1/A2 基线红测的唯一合法比较对象（原样内置，内容以 SHA 钉住）。
// 该版本预览仍会执行 remoteIssueCommand 并把批次快照写穿 batch.json 符号链接，红测正是要求
// 探针把这两条危险路径真正走通后，由安全断言判红；任何其他内容（含 HEAD 已提交调度器）都不是
// 有效基线，必须显式报错而不是被当成红测证据。
const WFM131_UNPATCHED_SHA256 = 'f89259569d2eb0a7ae6c416ac00ad0ac5cce876baee3eb82c9b812a4a6827aeb'
const baselineFixtureDispatcher = path.join(root, 'scripts/test/fixtures/m5-unpatched-baseline/ai-task-dispatcher.mjs')

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

// 采集器（collectLocalCandidates）与门禁（assessAndSort）都以主干 git 历史为权威源，
// 无条件跑 `git -C <项目> log main`。临时项目默认不是 git 仓库时，execFileSync 会把
// 子进程 git 的 stderr 继承到调度器进程 stderr，打印 `fatal: not a git repository`，
// 触发 assertNoInfrastructureAbort 的非 git 绊线，把基线红测提前拦在设施错误上。
// 给每个临时项目建一份最小、隔离、纯本地的 git 上下文：默认分支 main + 一个不含任务号的
// 空提交，使 `git log main` 正常退出且无 stderr。提交信息刻意避开 FEAT-/FIX-/CHORE-/LOC- 前缀，
// collectMergeFacts 解析出的合并事实仍为空，与降级为空 Map 的既有行为逐字节一致；不访问远端，
// 不改动已审核源码，也不放宽任何绊线。
function ensureLocalGitContext(proj) {
  const git = (args) => spawnSync('git', ['-C', proj, ...args], { encoding: 'utf8' })
  const init = git(['init', '-b', 'main'])
  if (init.status !== 0) {
    assert.equal(init.status, 0, `临时项目 git 初始化失败（设施错误，非红测）：${init.stderr || init.stdout}`)
    git(['init'])
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }
  git(['config', 'user.name', 'M5 Fixture'])
  git(['config', 'user.email', 'm5-fixture@localhost'])
  git(['config', 'commit.gpgsign', 'false'])
  const commit = git(['commit', '--allow-empty', '-m', 'chore: isolated test baseline (no task ref)'])
  assert.equal(commit.status, 0, `临时项目 git 提交失败（设施错误，非红测）：${commit.stderr || commit.stdout}`)
}

function buildProject({ taskIds, extraTasks = [], parent = tmpRoot }) {
  const proj = fs.mkdtempSync(path.join(parent, 'nb-dispatch-'))
  fs.mkdirSync(path.join(proj, 'docs/tasks'), { recursive: true })
  const tasks = taskIds.map((id, i) => {
    const fx = ['A', 'B', 'C'][i]
    fs.mkdirSync(path.join(proj, '.scratch/specs', id), { recursive: true })
    fs.copyFileSync(path.join(m3Fixtures, fx, 'issue-basics.md'), path.join(proj, 'docs/tasks', `${id}-defined.md`))
    fs.copyFileSync(path.join(m3Fixtures, fx, 'task-spec-V1.md'), path.join(proj, '.scratch/specs', id, 'task-spec-V1.md'))
    fs.copyFileSync(path.join(m3Fixtures, fx, 'definition-check.md'), path.join(proj, '.scratch/specs', id, 'definition-check.md'))
    return {
      task_id: id, name: `测试任务${id}`, status: '已定义', slug: 'defined',
      deps: [], env_group: id, env_role: '独立', priority: null,
      spec_path: `.scratch/specs/${id}/task-spec-V1.md`,
    }
  })
  fs.writeFileSync(path.join(proj, 'docs/tasks/registry.json'), JSON.stringify({ version: 1, tasks: [...tasks, ...extraTasks] }, null, 2) + '\n')
  fs.writeFileSync(path.join(proj, 'docs/tasks/BOARD.md'), '# fixture board\n')
  ensureLocalGitContext(proj)
  return proj
}

function writeMachine(proj, overrides = {}) {
  const machine = {
    agent: { templates: { 'full-access': { command: process.execPath, args: ['-e', 'process.exit(0)'] } } },
    sceneInit: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ...overrides,
  }
  const p = path.join(proj, '.scratch/night-batches/machine.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(machine, null, 2) + '\n')
  return p
}

function writeSchedule(proj, overrides = {}) {
  const schedule = {
    project: proj,
    batchName: overrides.batchName || 'test-batch',
    maxConcurrency: 2,
    permission: 'full-access',
    watchdogMinutes: 1,
    pollMs: 50,
    postValidateCommand: 'node -e "process.exit(0)"',
    machineConfig: '.scratch/night-batches/machine.json',
    ...overrides,
  }
  const p = path.join(proj, 'schedule.json')
  fs.writeFileSync(p, JSON.stringify(schedule, null, 2) + '\n')
  return p
}

function installFakeGh(tmpDir) {
  const ghLog = path.join(tmpDir, 'gh-calls.log')
  const ghWriteLog = path.join(tmpDir, 'gh-writes.log')
  const ghBin = path.join(tmpDir, 'bin')
  fs.mkdirSync(ghBin, { recursive: true })
  const ghStub = path.join(ghBin, 'gh')
  fs.writeFileSync(ghStub, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$GH_CALL_LOG"',
    'case "$*" in',
    '  issue\\ edit\\ *|issue\\ comment\\ *|issue\\ create\\ *|issue\\ close\\ *|issue\\ reopen\\ *|label\\ create\\ *|label\\ edit\\ *|label\\ delete\\ *|*--method\\ POST*|*--method\\ PATCH*|*--method\\ PUT*|*--method\\ DELETE*) printf \'%s\\n\' "$*" >> "$GH_WRITE_LOG" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), 'utf8')
  fs.chmodSync(ghStub, 0o755)
  return {
    ghLog,
    ghWriteLog,
    env: {
      ...process.env,
      PATH: `${ghBin}:${process.env.PATH || ''}`,
      GH_CALL_LOG: ghLog,
      GH_WRITE_LOG: ghWriteLog,
    },
  }
}

function runDispatcher(schedulePath, { args = [], env = {}, dispatcherPath = dispatcher } = {}) {
  return spawnSync(process.execPath, [dispatcherPath, schedulePath, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
}

function readJsonOut(r) {
  try { return JSON.parse(r.stdout) } catch { return null }
}

function readLog(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function assertPreviewRemoteCallCountZero(callLogText) {
  const lines = String(callLogText || '').split('\n').filter(Boolean)
  assert.equal(lines.length, 0, `预览远端调用数必须为零，实际截获：${lines.join(' | ') || '（无）'}`)
}

function assertProtectedLedgerUnchanged(before, after, label) {
  assert.equal(after, before, `保护账本不得变化（${label}）before=${before} after=${after}`)
}

function resolveBaselineDispatcherSource() {
  const source = process.env.M5_BASELINE_DISPATCHER
    ? path.resolve(process.env.M5_BASELINE_DISPATCHER)
    : baselineFixtureDispatcher
  if (!fs.existsSync(source)) {
    assert.fail(`WFM-131 基线材料缺失：${source}（测试设施校验失败，不是红测结果）`)
  }
  const sha = hashFile(source)
  if (sha !== WFM131_UNPATCHED_SHA256) {
    assert.fail(`WFM-131 基线内容不符：${source} SHA-256=${sha}，预期 ${WFM131_UNPATCHED_SHA256}。`
      + '红测基线只接受 WFM-131 未修调度器本体（内置副本 scripts/test/fixtures/m5-unpatched-baseline/ai-task-dispatcher.mjs）；'
      + '不要把 origin/main 已合并的其它版本当作基线（设施校验失败，不是有效红测证据）。')
  }
  return source
}

// 完整可重现的临时基线 fixture：以候选自身 scripts/ 全树为底（其被基线调度器 import 的
// 同盘模块与 night-batch-session-prompt.md 与 WFM-131 树逐字节一致），再用 SHA 钉住的
// WFM-131 未修调度器覆盖 ai-task-dispatcher.mjs。避免只拷单文件导致 ERR_MODULE_NOT_FOUND，
// 也避免缺源树文件导致 session-prompt ENOENT。
function isolatedDispatcherCopy(baselinePath) {
  const source = resolveBaselineDispatcherSource()
  assert.equal(path.resolve(baselinePath), source,
    '基线探针必须走 isolatedBaselineFixture 构建的完整临时 fixture，不得直接引用外部单文件')
  const destRoot = fs.mkdtempSync(path.join(tmpRoot, 'm5-baseline-copy-'))
  const destScripts = path.join(destRoot, 'scripts')
  fs.cpSync(path.join(root, 'scripts'), destScripts, { recursive: true })
  fs.copyFileSync(source, path.join(destScripts, 'ai-task-dispatcher.mjs'))
  return {
    dispatcherPath: path.join(destScripts, 'ai-task-dispatcher.mjs'),
    cleanup() { fs.rmSync(destRoot, { recursive: true, force: true }) },
  }
}

// 非 git 仓库绊线须跨 locale 稳健：git 依 LC_ALL/LANG 本地化输出，英文是
// `fatal: not a git repository (or any of the parent directories)`，简体中文是
// `致命错误：不是 Git 仓库（或者任何父目录）`。只匹配英文会在中文 locale 下静默漏判，
// 让本应被设施绊线拦下的临时项目缺失 .git 缺陷被掩盖。此正则同时覆盖两种措辞（含 Git/git、
// 大小写与可选空格变体），使中文与英文 locale 都能识别非 git 仓库错误。
const NON_GIT_REPO = /not a git repository|不是\s*[Gg]it\s*仓库|不是\s*[Gg]it\s*儲存庫|fatal: not a git/i

function assertNoInfrastructureAbort(r, label) {
  assert.equal(r.error, undefined, `${label}：基线运行不得以设施错误中断（${r.error}）`)
  const noise = `${r.stderr || ''}`
  assert.doesNotMatch(noise, /ENOENT[^]*session-prompt|session-prompt\.md/, `${label}：基线不得在 session-prompt.md ENOENT 处提前打断`)
  assert.doesNotMatch(noise, /ERR_MODULE_NOT_FOUND/, `${label}：基线 fixture 缺少源树文件（模块不可解析）`)
  assert.doesNotMatch(noise, NON_GIT_REPO, `${label}：基线夹具不得被非 git 仓库报错打断`)
  assert.doesNotMatch(noise, /TypeError/, `${label}：基线不得以 TypeError 冒充红测`)
}

test('M5 拒绝旧自动派发并保留只读预览（WFM-131 安全检查）', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/ai-task-night-dispatch-m5-check.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, true)
  assert.equal(out.blockedReason, 'legacy_dispatcher_disabled')
  assert.equal(out.githubWrites, 0)
  assert.equal(out.registryBoardUnchanged, true)
  assert.equal(out.previewReadOnly, true)
})

function probePreviewRemote(dispatcherPath) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'm5-a1-'))
  const proj = buildProject({ taskIds: ['FIX-A'] })
  const { ghLog, ghWriteLog, env } = installFakeGh(tmp)
  writeMachine(proj, {
    remoteIssueCommand: 'gh issue edit 999 --add-label ready-for-agent',
  })
  const schedulePath = writeSchedule(proj)
  const r = runDispatcher(schedulePath, { args: ['--now', '--preview'], env, dispatcherPath })
  return {
    tmp, proj, r, out: readJsonOut(r),
    calls: readLog(ghLog),
    writes: readLog(ghWriteLog),
  }
}

test('A1 红/绿：预览不得执行 remoteIssueCommand（假 gh 写调用为零）', () => {
  const probe = probePreviewRemote(dispatcher)
  try {
    assert.equal(probe.r.status, 0, `stdout=${probe.r.stdout}\nstderr=${probe.r.stderr}`)
    assert.equal(probe.out?.previewOnly, true)
    assertPreviewRemoteCallCountZero(probe.calls)
    assert.equal(probe.writes.trim(), '', `假 gh 写调用数须为零，got=${probe.writes.trim()}`)
    assert.equal(probe.out?.githubWrites, 0, '不得自报非零写；预览须为零')
    assert.equal(probe.out?.githubShellInvoked, false)
    assert.ok(!fs.existsSync(path.join(probe.proj, '.agent-runs')), '预览不得建实施 Run')
  } finally {
    fs.rmSync(probe.tmp, { recursive: true, force: true })
  }
})

test('A1 基线红测：未修候选必须因预览远端调用数必须为零而失败', (t) => {
  const isolated = isolatedDispatcherCopy(resolveBaselineDispatcherSource())
  const probe = probePreviewRemote(isolated.dispatcherPath)
  try {
    assertNoInfrastructureAbort(probe.r, 'A1')
    assert.equal(probe.r.status, 0, `基线须走完预览，而不是基础设施崩溃\n${probe.r.stderr}`)
    assert.equal(probe.out?.previewOnly, true, `基线须以 JSON 预览结果走完\nstdout=${probe.r.stdout}\nstderr=${probe.r.stderr}`)
    assert.match(probe.calls, /issue edit/, '基线必须实际截获到假 gh/remote shell 调用')
    let threw = null
    try { assertPreviewRemoteCallCountZero(probe.calls) } catch (e) { threw = e }
    assert.equal(threw?.name, 'AssertionError')
    assert.match(threw.message, /预览远端调用数必须为零/)
    assert.match(threw.message, /issue edit/)
    t.diagnostic(`A1 基线(${WFM131_UNPATCHED_SHA256}) 截获假 gh：${probe.calls.trim()}`)
    t.diagnostic(`A1 安全断言失败：${threw.message}`)
  } finally {
    fs.rmSync(probe.tmp, { recursive: true, force: true })
    fs.rmSync(probe.proj, { recursive: true, force: true })
    isolated.cleanup()
  }
})

function probeSymlinkWriteThrough(dispatcherPath) {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  writeMachine(proj)
  const schedulePath = writeSchedule(proj, { batchName: 'symlink-batch' })
  const dates = new Set([
    new Date().toISOString().slice(0, 10),
    localDay(),
  ])
  const registry = path.join(proj, 'docs/tasks/registry.json')
  const board = path.join(proj, 'docs/tasks/BOARD.md')
  const regBefore = hashFile(registry)
  const boardBefore = hashFile(board)
  for (const day of dates) {
    const dir = path.join(proj, '.scratch/night-batches', `${day}-symlink-batch`)
    fs.mkdirSync(dir, { recursive: true })
    const batchJson = path.join(dir, 'batch.json')
    try { fs.unlinkSync(batchJson) } catch { /* ignore */ }
    fs.symlinkSync(registry, batchJson)
  }
  const r = runDispatcher(schedulePath, { args: ['--now', '--preview'], dispatcherPath })
  return {
    proj, r, out: readJsonOut(r),
    regBefore, regAfter: hashFile(registry),
    boardBefore, boardAfter: hashFile(board),
  }
}

test('A2 红/绿：batch.json 符号链接写穿须在首次写入前拒绝且 registry 不变', () => {
  const probe = probeSymlinkWriteThrough(dispatcher)
  assert.equal(probe.r.error, undefined)
  assert.notEqual(probe.out, null, `stdout=${probe.r.stdout}\nstderr=${probe.r.stderr}`)
  assertProtectedLedgerUnchanged(probe.regBefore, probe.regAfter, 'registry')
  assertProtectedLedgerUnchanged(probe.boardBefore, probe.boardAfter, 'BOARD')
  assert.equal(probe.r.status, 1, `stdout=${probe.r.stdout}\nstderr=${probe.r.stderr}`)
  assert.equal(probe.out?.blocked, true)
  assert.equal(probe.out?.reasonCode, 'protected_report_path')
  assert.ok(!fs.existsSync(path.join(probe.proj, '.agent-runs')))
})

test('A2 基线红测：未修候选必须改写保护账本并由保护账本不得变化失败', (t) => {
  const isolated = isolatedDispatcherCopy(resolveBaselineDispatcherSource())
  let probe = null
  try {
    probe = probeSymlinkWriteThrough(isolated.dispatcherPath)
    assertNoInfrastructureAbort(probe.r, 'A2')
    assert.notEqual(probe.out, null, `基线输出必须是 JSON\nstdout=${probe.r.stdout}\nstderr=${probe.r.stderr}`)
    assert.notEqual(probe.regBefore, probe.regAfter, '基线必须实际改写受保护 registry')
    assert.match(fs.readFileSync(path.join(probe.proj, 'docs/tasks/registry.json'), 'utf8'), /snapshotVersion/, '改写内容须是批次快照，而不是空文件')
    let threw = null
    try { assertProtectedLedgerUnchanged(probe.regBefore, probe.regAfter, 'registry') } catch (e) { threw = e }
    assert.equal(threw?.name, 'AssertionError')
    assert.match(threw.message, /保护账本不得变化/)
    assert.match(threw.message, new RegExp(probe.regBefore))
    assert.match(threw.message, new RegExp(probe.regAfter))
    t.diagnostic(`A2 基线(${WFM131_UNPATCHED_SHA256}) registry ${probe.regBefore} → ${probe.regAfter}`)
    t.diagnostic(`A2 安全断言失败：${threw.message}`)
  } finally {
    if (probe) fs.rmSync(probe.proj, { recursive: true, force: true })
    isolated.cleanup()
  }
})

test('A2b 红/绿：批次目录符号链接到外部保护目录须拒绝且哨兵不变', () => {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  writeMachine(proj)
  const schedulePath = writeSchedule(proj, { batchName: 'alias-batch' })
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-alias-ext-'))
  const sentinel = path.join(external, 'batch.json')
  fs.writeFileSync(sentinel, 'SENTINEL-MUST-NOT-OVERWRITE\n')
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const localDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const batches = path.join(proj, '.scratch/night-batches')
  fs.mkdirSync(batches, { recursive: true })
  const batchDir = path.join(batches, `${localDay}-alias-batch`)
  fs.symlinkSync(external, batchDir)

  const r = runDispatcher(schedulePath, { args: ['--now', '--preview'] })
  const out = readJsonOut(r)
  assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.equal(out?.blocked, true)
  assert.equal(out?.reasonCode, 'protected_report_path')
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SENTINEL-MUST-NOT-OVERWRITE\n')
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')))
  fs.rmSync(external, { recursive: true, force: true })
})

test('A2c 红/绿：项目根符号链接不得把批次写进外部哨兵', () => {
  const real = buildProject({ taskIds: ['FIX-A'] })
  writeMachine(real)
  const link = path.join(path.dirname(real), `m5-proj-link-${Date.now()}`)
  fs.symlinkSync(real, link)
  const schedulePath = writeSchedule(real, { batchName: 'root-link', project: link })
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const localDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const sentinelDir = path.join(real, '.scratch/night-batches', `${localDay}-root-link`)
  fs.mkdirSync(sentinelDir, { recursive: true })
  const sentinel = path.join(sentinelDir, 'batch.json')
  fs.writeFileSync(sentinel, 'SENTINEL-MUST-NOT-OVERWRITE\n')
  const before = fs.readFileSync(sentinel, 'utf8')
  const r = runDispatcher(schedulePath, { args: ['--now', '--preview'] })
  const out = readJsonOut(r)
  assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.equal(out?.reasonCode, 'protected_report_path')
  assert.equal(fs.readFileSync(sentinel, 'utf8'), before)
  fs.unlinkSync(link)
})

test('A2f：项目根自身是真目录但其祖先为符号链接时，预览必须拒绝且不写 batch/report', () => {
  const realParent = fs.mkdtempSync(path.join(tmpRoot, 'm5-anc-real-'))
  const alias = path.join(tmpRoot, `m5-anc-alias-${Date.now()}-${process.pid}`)
  const proj = buildProject({ taskIds: ['FIX-A'], parent: realParent })
  try {
    writeMachine(proj)
    fs.symlinkSync(realParent, alias)
    const lexical = path.join(alias, path.basename(proj))
    assert.equal(fs.lstatSync(lexical).isSymbolicLink(), false, '项目根自身必须是真目录')
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true, '项目根的父级必须是符号链接')
    const registry = path.join(proj, 'docs/tasks/registry.json')
    const board = path.join(proj, 'docs/tasks/BOARD.md')
    const regBefore = hashFile(registry)
    const boardBefore = hashFile(board)
    const schedulePath = writeSchedule(proj, { project: lexical, batchName: 'ancestor-link' })
    const r = runDispatcher(schedulePath, { args: ['--now', '--preview'] })
    const out = readJsonOut(r)
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`)
    assert.equal(out?.blocked, true)
    assert.equal(out?.reasonCode, 'protected_report_path')
    assert.match(out?.message || '', /符号链接|祖先|别名/)
    assertProtectedLedgerUnchanged(regBefore, hashFile(registry), 'registry')
    assertProtectedLedgerUnchanged(boardBefore, hashFile(board), 'BOARD')
    const batchDir = path.join(proj, '.scratch/night-batches', `${localDay()}-ancestor-link`)
    assert.equal(fs.existsSync(path.join(batchDir, 'batch.json')), false, '不得写出 batch.json')
    assert.equal(fs.existsSync(path.join(batchDir, 'report.md')), false, '不得写出 report.md')
    assert.equal(fs.existsSync(path.join(batchDir, 'task-source.json')), false, '不得写出 task-source.json')
    assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')))
  } finally {
    try { fs.unlinkSync(alias) } catch { /* ignore */ }
    fs.rmSync(realParent, { recursive: true, force: true })
  }
})

test('A2d 钉扎写入：换路后不得覆盖外部哨兵', () => {
  const helper = path.join(root, 'scripts/ai-task-pinned-write.py')
  const r = spawnSync('python3', [helper, '--self-test'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.match(r.stdout, /ok/)
})

test('A2e 检查后换目录：打开到的身份与冻结值不符时不得写入哨兵', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-pin-real-'))
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-pin-decoy-'))
  const sentinel = path.join(decoy, 'batch.json')
  fs.writeFileSync(sentinel, 'SENTINEL\n')
  const frozen = fs.statSync(real)
  const slot = path.join(os.tmpdir(), `m5-pin-slot-${Date.now()}`)
  fs.renameSync(real, `${real}-moved`)
  fs.renameSync(decoy, slot)
  const result = writePinnedReport({
    directory: slot,
    basename: 'batch.json',
    content: 'SHOULD-NOT-LAND\n',
    dev: frozen.dev,
    ino: frozen.ino,
  })
  assert.equal(result.ok, false, result.message)
  assert.equal(fs.readFileSync(path.join(slot, 'batch.json'), 'utf8'), 'SENTINEL\n')
  const okWrite = writePinnedReport({
    directory: `${real}-moved`,
    basename: 'batch.json',
    content: 'PINNED\n',
    dev: frozen.dev,
    ino: frozen.ino,
  })
  assert.equal(okWrite.ok, true, okWrite.message)
  assert.equal(fs.readFileSync(path.join(`${real}-moved`, 'batch.json'), 'utf8'), 'PINNED\n')
  assert.equal(fs.readFileSync(path.join(slot, 'batch.json'), 'utf8'), 'SENTINEL\n')
})

test('M5 未到点：pending 退出码 3，不建任何现场', () => {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  const schedulePath = writeSchedule(proj, { startAt: new Date(Date.now() + 60_000).toISOString() })
  const r = runDispatcher(schedulePath)
  assert.equal(r.status, 3)
  const out = readJsonOut(r)
  assert.equal(out.pending, true)
  assert.ok(!fs.existsSync(path.join(proj, '.scratch/night-batches')), '未到点不得产出批次目录')
})

test('M5 默认/--dry-run 单独触发 fail-closed，不建 Run', () => {
  const proj = buildProject({ taskIds: ['FIX-A'] })
  writeMachine(proj)
  const schedulePath = writeSchedule(proj)
  for (const args of [['--now'], ['--dry-run']]) {
    const r = runDispatcher(schedulePath, { args })
    const out = readJsonOut(r)
    assert.equal(r.status, 1)
    assert.equal(out?.reasonCode, 'legacy_dispatcher_disabled')
    assert.equal(out?.effects?.implementationRunStarted, false)
  }
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')))
})

test('M5 --preview：只出计划与快照，不建现场、不拉会话（原 dry-run 语义保留）', () => {
  const proj = buildProject({ taskIds: ['FIX-A', 'FIX-B'] })
  const schedulePath = writeSchedule(proj) // 无 machine.json，preview 允许
  const r = runDispatcher(schedulePath, { args: ['--preview'] })
  const out = readJsonOut(r)
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.equal(out.mode, 'preview')
  assert.equal(out.previewOnly, true)
  assert.equal(out.launchOrder.length, 2)
  assert.ok(fs.existsSync(out.batchJsonPath))
  assert.ok(fs.existsSync(out.reportPath))
  const batch = JSON.parse(fs.readFileSync(out.batchJsonPath, 'utf8'))
  assert.equal(batch.snapshotVersion, 'm5-v1')
  assert.equal(batch.candidates.length, 2)
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')), 'preview 不得创建 run 现场')
  const report = fs.readFileSync(out.reportPath, 'utf8')
  assert.match(report, /只读计划预览|WFM-131/)
})

test('M5 endAt 截止（preview）：到点不开新任务，剩余任务如实报告', () => {
  const proj = buildProject({ taskIds: ['FIX-A', 'FIX-B'] })
  writeMachine(proj)
  const schedulePath = writeSchedule(proj, {
    endAt: new Date(Date.now() - 1000).toISOString(),
  })
  const r = runDispatcher(schedulePath, { args: ['--now', '--preview'] })
  const out = readJsonOut(r)
  assert.equal(r.status, 1, '有未启动任务时以非零码提示')
  assert.deepEqual([...(out.leftoverQueue || [])].sort(), ['FIX-A', 'FIX-B'])
  assert.equal(out.launchOrder.length, 0)
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')), '截止后不得开工')
  const report = fs.readFileSync(out.reportPath, 'utf8')
  assert.match(report, /未启动（超出 endAt/)
})

test('M5 状态机：并发上限 2 + 释放后第三项补位（原假会话覆盖，不触发真实派发）', () => {
  const snap = (ids) => ids.map((id) => ({ id, name: id, priority: 'P2', definedAt: '2026-01-01T00:00:00Z' }))
  let n = 0
  const nowIso = () => `2026-01-01T00:00:0${n++}Z`
  const s = createBatchState({
    name: 'm5-concurrency',
    maxConcurrency: 2,
    startedAt: '2026-01-01T00:00:00Z',
    snapshot: snap(['FIX-A', 'FIX-B', 'FIX-C']),
  })
  fillCapacity(s, nowIso)
  assert.deepEqual([...s.running.keys()], ['FIX-A', 'FIX-B'])
  assert.deepEqual(s.queue, ['FIX-C'])
  assert.ok(s.running.size <= 2, '并发峰值不得超过 2')
  applyRelease(s, { op: 'release', taskId: 'FIX-A', to: 'WAITING_HUMAN', uatHint: 'uat-card.md' })
  fillCapacity(s, nowIso)
  assert.deepEqual([...s.running.keys()].sort(), ['FIX-B', 'FIX-C'])
  assert.equal(s.queue.length, 0)
  assert.deepEqual(s.waiting.map((t) => t.id), ['FIX-A'])
  applyRelease(s, { op: 'release', taskId: 'FIX-B', to: 'BLOCKED', blockedNode: 'dev', reason: '测试注入受阻' })
  applyRelease(s, { op: 'release', taskId: 'FIX-C', to: 'COMPLETED' })
  fillCapacity(s, nowIso)
  assert.equal(autoPhaseDone(s), true)
  assert.deepEqual(s.launchLog.filter((e) => e.action === 'launch').map((e) => e.taskId), ['FIX-A', 'FIX-B', 'FIX-C'])
})

test('M5 假会话看门狗：挂起进程被 SIGTERM，记 BLOCKED 并释放名额补位', async () => {
  const snap = (ids) => ids.map((id) => ({ id, name: id, priority: 'P2', definedAt: '2026-01-01T00:00:00Z' }))
  let n = 0
  const nowIso = () => `2026-01-01T00:00:0${n++}Z`
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-wd-run-'))
  fs.writeFileSync(path.join(runDir, 'session.log'), '')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 999999)'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)

    const children = new Map([['FIX-A', { child }]])
    const sites = new Map([['FIX-A', { runDir }]])
    const watchdogFired = new Set()
    const state = createBatchState({
      name: 'm5-watchdog-live',
      maxConcurrency: 1,
      startedAt: '2026-01-01T00:00:00Z',
      snapshot: snap(['FIX-A', 'FIX-B']),
    })
    fillCapacity(state, nowIso)
    assert.deepEqual([...state.running.keys()], ['FIX-A'])

    const result = fireWatchdog({
      taskId: 'FIX-A',
      children,
      sites,
      watchdogMinutes: 0.01,
      watchdogFired,
      killEscalationMs: 100,
      onRelease: (id, row) => {
        children.delete(id)
        applyRelease(state, { taskId: id, ...row })
        fillCapacity(state, nowIso)
      },
    })
    assert.equal(result.fired, true)
    if (child.exitCode === null && child.signalCode === null) {
      assert.equal(result.pendingExit, true)
      assert.deepEqual([...state.running.keys()], ['FIX-A'], '子进程仍存活时不得释放名额')
      assert.equal(state.blocked.length, 0)
    }

    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.on('exit', resolve)
      setTimeout(resolve, 2000)
    })
    assert.ok(watchdogFired.has('FIX-A'))
    assert.match(state.blocked[0]?.reason || '', /看门狗超时/)
    assert.deepEqual([...state.running.keys()], ['FIX-B'], '退出后才释放名额并补位')
    assert.ok(
      child.signalCode === 'SIGTERM' || child.signalCode === 'SIGKILL' || child.exitCode !== null,
      `挂起会话须被终止，got signal=${child.signalCode} exit=${child.exitCode}`,
    )
  } finally {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
})

test('M5 假会话看门狗：忽略 SIGTERM 时不得先补位造成 3 个进程同时存活', async () => {
  const snap = (ids) => ids.map((id) => ({ id, name: id, priority: 'P2', definedAt: '2026-01-01T00:00:00Z' }))
  let n = 0
  const nowIso = () => `2026-01-01T00:00:0${n++}Z`
  const hang = (ignoreTerm) => spawn('python3', ['-c', ignoreTerm
    ? 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready", flush=True); time.sleep(30)'
    : 'import time; print("ready", flush=True); time.sleep(30)'])
  const waitReady = (child) => new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`假会话未就绪：${buf}`)), 10_000)
    child.stdout.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`假会话提前退出 code=${code} signal=${signal}`))
    })
  })
  const childA = hang(true)
  const childB = hang(false)
  const spawned = new Map([['FIX-A', childA], ['FIX-B', childB]])
  let maxAlive = 0
  const note = () => {
    const alive = [...spawned.values()].filter((c) => c.exitCode === null && c.signalCode === null).length
    if (alive > maxAlive) maxAlive = alive
  }
  try {
    await Promise.all([waitReady(childA), waitReady(childB)])
    note()
    const children = new Map([['FIX-A', { child: childA }], ['FIX-B', { child: childB }]])
    const sites = new Map([['FIX-A', { runDir: os.tmpdir() }], ['FIX-B', { runDir: os.tmpdir() }]])
    const watchdogFired = new Set()
    const state = createBatchState({
      name: 'm5-watchdog-cap',
      maxConcurrency: 2,
      startedAt: '2026-01-01T00:00:00Z',
      snapshot: snap(['FIX-A', 'FIX-B', 'FIX-C']),
    })
    fillCapacity(state, nowIso)
    assert.deepEqual([...state.running.keys()], ['FIX-A', 'FIX-B'])
    fireWatchdog({
      taskId: 'FIX-A',
      children,
      sites,
      watchdogMinutes: 0.01,
      watchdogFired,
      killEscalationMs: 200,
      onRelease: (id, row) => {
        children.delete(id)
        applyRelease(state, { taskId: id, ...row })
        fillCapacity(state, nowIso)
        for (const runningId of state.running.keys()) {
          if (!spawned.has(runningId)) spawned.set(runningId, hang(false))
        }
        note()
      },
    })
    note()
    assert.equal(spawned.has('FIX-C'), false, 'A 未退出时不得启动第三项')
    assert.ok(state.running.has('FIX-A'))
    assert.equal(childA.exitCode, null)
    assert.equal(childA.signalCode, null)
    assert.ok(maxAlive <= 2, `并发峰值 ${maxAlive} 超过 2`)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(childA.signalCode, null, '忽略 SIGTERM 的会话在升级前必须仍存活')
    assert.equal(spawned.has('FIX-C'), false)
    await new Promise((resolve) => {
      if (childA.exitCode !== null || childA.signalCode !== null) return resolve()
      childA.on('exit', resolve)
      setTimeout(resolve, 3000)
    })
    note()
    assert.equal(childA.signalCode, 'SIGKILL')
    assert.equal(spawned.has('FIX-C'), true)
    assert.ok(maxAlive <= 2, `补位后并发峰值 ${maxAlive} 超过 2`)
    assert.ok(watchdogFired.has('FIX-A'))
  } finally {
    for (const child of spawned.values()) {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
  }
})

test('M5 假会话：已写 release-event 但进程仍存活时不得补位', async () => {
  const snap = (ids) => ids.map((id) => ({ id, name: id, priority: 'P2', definedAt: '2026-01-01T00:00:00Z' }))
  let n = 0
  const nowIso = () => `2026-01-01T00:00:0${n++}Z`
  const hang = (ignoreTerm) => spawn('python3', ['-c', ignoreTerm
    ? 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready", flush=True); time.sleep(30)'
    : 'import time; print("ready", flush=True); time.sleep(30)'])
  const waitReady = (child) => new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('假会话未就绪')), 10_000)
    child.stdout.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('ready')) { clearTimeout(timer); resolve() }
    })
  })
  const runA = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-rel-live-'))
  fs.writeFileSync(path.join(runA, 'release-event.json'), JSON.stringify({ to: 'COMPLETED' }))
  const childA = hang(true)
  const childB = hang(false)
  const spawned = new Map([['FIX-A', childA], ['FIX-B', childB]])
  let maxAlive = 0
  const note = () => {
    const alive = [...spawned.values()].filter((c) => c.exitCode === null && c.signalCode === null).length
    if (alive > maxAlive) maxAlive = alive
  }
  let releasedEarly = false
  try {
    await Promise.all([waitReady(childA), waitReady(childB)])
    const children = new Map([['FIX-A', { child: childA }], ['FIX-B', { child: childB }]])
    const sites = new Map([['FIX-A', { runDir: runA }], ['FIX-B', { runDir: os.tmpdir() }]])
    const state = createBatchState({
      name: 'm5-release-while-alive',
      maxConcurrency: 2,
      startedAt: '2026-01-01T00:00:00Z',
      snapshot: snap(['FIX-A', 'FIX-B', 'FIX-C']),
    })
    fillCapacity(state, nowIso)
    pollChildrenOnce({
      children,
      sites,
      killEscalationMs: 200,
      onRelease: (id, row) => {
        if (childA.exitCode === null && childA.signalCode === null) releasedEarly = true
        children.delete(id)
        applyRelease(state, { taskId: id, ...row })
        fillCapacity(state, nowIso)
        for (const runningId of state.running.keys()) {
          if (!spawned.has(runningId)) spawned.set(runningId, hang(false))
        }
        note()
      },
    })
    note()
    assert.equal(releasedEarly, false)
    assert.equal(spawned.has('FIX-C'), false, 'A 仍存活时不得启动第三项')
    assert.ok(state.running.has('FIX-A'))
    assert.ok(maxAlive <= 2)
    await new Promise((resolve) => {
      if (childA.exitCode !== null || childA.signalCode !== null) return resolve()
      childA.on('exit', resolve)
      setTimeout(resolve, 3000)
    })
    note()
    assert.equal(releasedEarly, false, '释放回调发生时旧进程必须已经退出')
    assert.equal(childA.signalCode, 'SIGKILL')
    assert.equal(spawned.has('FIX-C'), true)
    assert.ok(maxAlive <= 2, `并发峰值 ${maxAlive}`)
    assert.deepEqual(state.completed.map((t) => t.id), ['FIX-A'])
  } finally {
    for (const child of spawned.values()) {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
  }
})

test('M5 假会话：退出未写 release-event.json → poll 记 BLOCKED', async () => {
  const snap = (ids) => ids.map((id) => ({ id, name: id, priority: 'P2', definedAt: '2026-01-01T00:00:00Z' }))
  let n = 0
  const nowIso = () => `2026-01-01T00:00:0${n++}Z`
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-rel-run-'))
  fs.writeFileSync(path.join(runDir, 'session.log'), 'log')
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(child.exitCode, 0)
  assert.ok(!fs.existsSync(path.join(runDir, 'release-event.json')))

  const children = new Map([['FIX-A', { child }]])
  const sites = new Map([['FIX-A', { runDir }]])
  const state = createBatchState({
    name: 'm5-release-missing-live',
    maxConcurrency: 1,
    startedAt: '2026-01-01T00:00:00Z',
    snapshot: snap(['FIX-A']),
  })
  fillCapacity(state, nowIso)

  const { released } = pollChildrenOnce({
    children,
    sites,
    onRelease: (id, row) => {
      children.delete(id)
      applyRelease(state, { taskId: id, ...row })
    },
  })
  assert.deepEqual(released, ['FIX-A'])
  assert.equal(state.blocked.length, 1)
  assert.match(state.blocked[0].reason, /会话退出但未写释放事件/)
  assert.equal(autoPhaseDone(state), true)
})

test('M5 --preview --simulate：释放后补位计划（无真实会话）', () => {
  const proj = buildProject({ taskIds: ['FIX-A', 'FIX-B', 'FIX-C'] })
  writeMachine(proj)
  const schedulePath = writeSchedule(proj)
  const eventsPath = path.join(proj, 'events.json')
  fs.writeFileSync(eventsPath, JSON.stringify([
    { op: 'release', taskId: 'FIX-A', to: 'WAITING_HUMAN' },
    { op: 'release', taskId: 'FIX-B', to: 'BLOCKED', blockedNode: 'dev', reason: '测试注入受阻' },
    { op: 'release', taskId: 'FIX-C', to: 'COMPLETED' },
  ]) + '\n')
  const r = runDispatcher(schedulePath, { args: ['--now', '--preview', '--simulate', eventsPath] })
  const out = readJsonOut(r)
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
  assert.equal(out.mode, 'preview')
  assert.deepEqual([...out.waiting].sort(), ['FIX-A'])
  assert.deepEqual(out.blocked, ['FIX-B'])
  assert.deepEqual(out.completed, ['FIX-C'])
  assert.equal(out.launchOrder.length, 3, '三个任务都进入启动计划（并发 2，必有补位）')
  assert.ok(!fs.existsSync(path.join(proj, '.agent-runs')))
})
