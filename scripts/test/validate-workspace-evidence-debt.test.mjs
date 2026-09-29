// WFM-115 · D-9 职责切分回归：产品校验不再随冻结旧账本的超期时钟自动变红
//
// 背景（2026-09-29 前的故障）：validate-workspace.mjs 的 D-9 只用 Date.now() 对比登记册
// evidence_expires_at / evidence_cleared_at，冻结历史条目超期后 `npm run validate` /
// `release:verify` / main CI 永久失败。而「明细未清理」只是登记册字段判定（未扫描磁盘），
// CI runner 上 `.agent-runs/` 被 Git 忽略、物理明细根本不可见——这类红灯不可能靠真实清理
// 在产品校验链内消除，只能靠伪填 evidence_cleared_at（W0 裁定禁止）。
//
// 新口径（W0 决策 + WFM-115）：D-9 降级为**可见债务报告**——
//   · 有超期未清：⚠️ 警告（逐条列出，标注登记册字段判定性质、核查入口与处置责任），
//     不计入 failures，不阻断产品校验；
//   · 无超期：照常 ✅ 显式通过；机制未启用：照常 ➖ 跳过说明；
//   · D-8 / D-10 等其他真实校验语义不变。
// 证据债的核查与清理入口仍是 scripts/task-runs-cleanup.mjs（默认只读预演）；
// --apply 是独立执行关口，不属于产品校验链。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VALIDATOR = path.join(HERE, '..', 'validate-workspace.mjs')
const CLEANER = path.join(HERE, '..', 'task-runs-cleanup.mjs')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ws-debt-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'ws-debt-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function gOk(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`)
  return r.stdout.trim()
}

function runValidator(repo) {
  const r = spawnSync(process.execPath, [VALIDATOR, '--repo', repo, '--json'], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  assert.notEqual(r.status, 2, `校验器异常退出：${r.stderr}`)
  return { status: r.status, out: JSON.parse(r.stdout) }
}

const rec = (out, id) => out.results.find((x) => x.id === id)

// 三种到期形态（归档三件套齐备，D-8 的相关性不在本用例范围）：
//   FIX-981  已到期 + 未登记清理        → 历史债，应进可见警告
//   FIX-982  未到期 + 未登记清理        → 不进债务报告
//   FIX-983  已到期 + 已登记清理        → 不进债务报告
function debtFixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-debt-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')

  const merge = { commit: 'c'.repeat(40), merged_at: '2026-09-20T00:00:00Z' }
  const tasks = [
    { task_id: 'FIX-981', status: '已合并', branch: 'dev-fix-981-r1', merge, evidence_expires_at: '2026-09-25T00:00:00Z', evidence_cleared_at: null },
    { task_id: 'FIX-982', status: '已合并', branch: 'dev-fix-982-r1', merge, evidence_expires_at: '2099-01-01T00:00:00Z', evidence_cleared_at: null },
    { task_id: 'FIX-983', status: '已合并', branch: 'dev-fix-983-r1', merge, evidence_expires_at: '2026-09-25T00:00:00Z', evidence_cleared_at: '2026-09-26T00:00:00Z' },
  ]
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({ version: 1, revision: 1, tasks }, null, 2) + '\n',
  )
  for (const t of tasks) {
    const dir = path.join(repo, 'docs', 'tasks', 'archive', t.task_id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${t.task_id}-closeout.md`), `# ${t.task_id}\n`)
    fs.writeFileSync(path.join(dir, 'task-spec-V1.md'), `# spec ${t.task_id}\n`)
    fs.writeFileSync(path.join(dir, 'evidence-summary.json'), JSON.stringify({ task_id: t.task_id }, null, 2) + '\n')
  }
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)
  return { repo }
}

test('D-9：超期历史债不再使产品校验失败（可见警告，exit 0）', () => {
  const { repo } = debtFixture()
  const { status, out } = runValidator(repo)
  assert.equal(status, 0, `产品校验不应被冻结账本时钟阻断：${JSON.stringify(out.results)}`)
  assert.equal(out.failures, 0, '历史债不得计入 failures')
  assert.ok(out.warnings >= 1, '历史债必须以警告可见，不得静默')
  const d9 = rec(out, 'D-9')
  assert.ok(d9, '应产出 D-9 记录')
  assert.equal(d9.ok, null, '有债时既非通过也非失败（警告形态）')
  assert.notEqual(d9.skipped, true, '不得以「跳过」掩盖历史债')
  const text = JSON.stringify(d9)
  assert.ok(text.includes('FIX-981'), '未处理项必须逐条可见')
})

test('D-9：债务报告如实标注字段判定性质与可执行核查入口', () => {
  const { repo } = debtFixture()
  const d9 = rec(runValidator(repo).out, 'D-9')
  const text = JSON.stringify(d9)
  assert.ok(/登记册/.test(text), '必须声明判定来源是登记册字段，不是磁盘扫描')
  assert.ok(/task-runs-cleanup/.test(text), '必须指出可执行核查入口')
  assert.notEqual(d9.ok, true, '有债时不得冒充通过')
})

test('D-9：未到期与已登记清理项不进债务报告', () => {
  const { repo } = debtFixture()
  const d9 = rec(runValidator(repo).out, 'D-9')
  const text = JSON.stringify(d9)
  assert.ok(!text.includes('FIX-982'), '未到期项不是债')
  assert.ok(!text.includes('FIX-983'), '已登记清理项不是债')
})

test('D-9：机制未启用仍为跳过说明', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-debt-off-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({ version: 1, revision: 1, tasks: [{ task_id: 'FIX-984', status: '进行中' }] }, null, 2) + '\n',
  )
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)
  const { status, out } = runValidator(repo)
  assert.equal(status, 0)
  const d9 = rec(out, 'D-9')
  assert.ok(d9, '应产出 D-9 记录')
  assert.equal(d9.skipped, true, '机制未启用 = 跳过说明，不是警告')
})

test('D-9：全绿账本仍为显式通过', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-debt-ok-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  const merge = { commit: 'c'.repeat(40), merged_at: '2026-09-20T00:00:00Z' }
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({
      version: 1, revision: 1,
      tasks: [
        { task_id: 'FIX-985', status: '已合并', branch: 'dev-fix-985-r1', merge, evidence_expires_at: '2099-01-01T00:00:00Z', evidence_cleared_at: null },
        { task_id: 'FIX-986', status: '已合并', branch: 'dev-fix-986-r1', merge, evidence_expires_at: '2026-09-25T00:00:00Z', evidence_cleared_at: '2026-09-26T00:00:00Z' },
      ],
    }, null, 2) + '\n',
  )
  for (const id of ['FIX-985', 'FIX-986']) {
    const dir = path.join(repo, 'docs', 'tasks', 'archive', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}-closeout.md`), `# ${id}\n`)
    fs.writeFileSync(path.join(dir, 'task-spec-V1.md'), `# spec ${id}\n`)
    fs.writeFileSync(path.join(dir, 'evidence-summary.json'), JSON.stringify({ task_id: id }, null, 2) + '\n')
  }
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)
  const { status, out } = runValidator(repo)
  assert.equal(status, 0)
  const d9 = rec(out, 'D-9')
  assert.equal(d9.ok, true, '无超期项时应显式通过')
})

test('职责切分不削弱 D-8 / D-10 的真实校验语义', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-debt-guard-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  const merge = { commit: 'c'.repeat(40), merged_at: '2026-09-20T00:00:00Z' }
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({
      version: 1, revision: 1,
      tasks: [
        // D-8 违例：已合并但无归档目录
        { task_id: 'FIX-987', status: '已合并', branch: 'dev-fix-987-r1', merge },
        // D-10 违例：标保留但远端无该分支
        { task_id: 'FIX-988', status: '已合并', branch: 'dev-fix-988-r1', merge, branch_retained: true },
      ],
    }, null, 2) + '\n',
  )
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)
  const { status, out } = runValidator(repo)
  assert.equal(status, 1, '真实校验违例仍应失败')
  assert.equal(rec(out, 'D-8')?.ok, false, 'D-8 归档完整性语义不变')
  assert.equal(rec(out, 'D-10')?.ok, false, 'D-10 收口口径语义不变')
  assert.ok(out.failures >= 2)
})

// —— 可执行核查入口（task-runs-cleanup.mjs，默认只读预演；--apply 为独立执行关口）——

// 给 FIX-981 造物理明细（.agent-runs/fix-981-r1），验证核查入口的「报告不删」与「执行消除」。
function withRunDetails(repo) {
  const runDir = path.join(repo, '.agent-runs', 'fix-981-r1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'checkpoint.json'), '{}\n')
  return runDir
}

test('核查入口：dry-run 报告到期明细且不删任何内容', () => {
  const { repo } = debtFixture()
  const runDir = withRunDetails(repo)
  const r = spawnSync(process.execPath, [CLEANER, '--repo', repo], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  assert.equal(r.status, 0, `预演不应失败：${r.stderr}`)
  assert.ok(r.stdout.includes('FIX-981'), '预演必须列出未处理项')
  assert.ok(fs.existsSync(runDir), '预演不得删除明细')
  const reg = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), 'utf8'))
  assert.equal(reg.tasks.find((t) => t.task_id === 'FIX-981').evidence_cleared_at, null, '预演不得回填登记册')
})

test('执行关口：--apply 后债务真实消除且 D-9 显式转绿', () => {
  const { repo } = debtFixture()
  const runDir = withRunDetails(repo)
  const r = spawnSync(process.execPath, [CLEANER, '--repo', repo, '--apply'], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  assert.equal(r.status, 0, `执行不应失败：${r.stderr}`)
  assert.ok(!fs.existsSync(runDir), '执行后明细应已删除（fixture 内）')
  const reg = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), 'utf8'))
  assert.ok(reg.tasks.find((t) => t.task_id === 'FIX-981').evidence_cleared_at, '执行后应登记清理时间')
  const { status, out } = runValidator(repo)
  assert.equal(status, 0)
  const d9 = rec(out, 'D-9')
  assert.equal(d9.ok, true, '债务消除后 D-9 显式通过（非跳过）')
  assert.ok(!JSON.stringify(d9).includes('FIX-981'), '已处理项不再出现在报告里')
})
