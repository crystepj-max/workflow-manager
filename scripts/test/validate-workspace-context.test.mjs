// LOC-023 回归：validate-workspace 的「锚点 / 被校验集合」分离
//
// 覆盖验收 V-3（链接工作树内运行与主检出侧结论逐项一致）、
//      V-4（工作树内运行时该工作树自身仍被校验）、
//      V-5（外部运行时工作区只计警告）。
//
// 反例锚点：修改前 linked 以「当前 root」为排除对象，于是从链接工作树内运行时
// 主检出被当成治理区工作区（D-2/D-3/D-4 误报）、D-5 在错误位置找产物根、
// D-7/D-8 读到该分支的旧登记册快照。

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'validate-workspace.mjs')

// 夹具根必须落在「治理区」：macOS 的 os.tmpdir() 是 /var/folders/…（判治理区，用例通过），
// 而 Linux 的 os.tmpdir() 就是 /tmp —— 正是 validate-workspace 的例外区前缀
// （scripts/validate-workspace.mjs 的 EXEMPT_ABS_PREFIXES）。夹具一旦落进例外区，
// 违规只计警告，本文件用例成片误判（CHORE-260 · M3）。故改用仓库内被 Git 忽略的
// .scratch/ 作平台无关的确定根，不再依赖宿主 tmpdir。
const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.scratch', 'ws-ctx-fixtures')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ws-ctx-test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'ws-ctx-test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function g(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

function gOk(args, cwd) {
  const r = g(args, cwd)
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`)
  return r.stdout.trim()
}

/** 建一个「主检出 + 三个链接工作区」的临时仓库，返回各路径。 */
function fixture() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true })
  const base = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'ws-ctx-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  gOk(['init', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true })
  // 锚点登记册：不含任何终态任务
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2) + '\n')
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'init'], repo)

  // A：合规工作区（目录名 = 分支名，治理区）
  const wtA = path.join(base, 'repo-worktrees', 'dev-loc-999-r1')
  // B：目录名 ≠ 分支名（治理区违规，用于验证 D-2 报出且工作树内能校验自身）
  const wtB = path.join(base, 'repo-worktrees', 'bad-dir-name')
  // C：外部运行时工作区（例外区，目录名 ≠ 分支名，只应计警告）
  const wtC = path.join(base, '.codex', 'worktrees', 'abc', 'repo')

  for (const [wt, branch] of [[wtA, 'dev-loc-999-r1'], [wtB, 'dev-loc-998-r1'], [wtC, 'dev-loc-997-r1']]) {
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    gOk(['branch', branch, 'main'], repo)
    gOk(['worktree', 'add', wt, branch], repo)
  }

  // A 分支上提交一份与锚点不同的登记册（含 2 个终态任务）：
  // 若校验器仍读「上下文」的登记册，D-7/D-8 的计数会与主检出侧不一致。
  fs.writeFileSync(
    path.join(wtA, 'docs', 'tasks', 'registry.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        { task_id: 'LOC-901', status: '已合并', branch: 'dev-loc-901-r1' },
        { task_id: 'LOC-902', status: '已取消', branch: 'dev-loc-902-r1' },
      ],
    }, null, 2) + '\n',
  )
  gOk(['add', '-A'], wtA)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'chore: branch-only registry'], wtA)

  return { base, repo, wtA, wtB, wtC }
}

function run(repo) {
  const r = spawnSync('node', [SCRIPT, '--repo', repo, '--json'], { encoding: 'utf-8', env: GIT_ENV })
  assert.ok(r.stdout, `校验器无输出：${r.stderr}`)
  return JSON.parse(r.stdout)
}

// 同一 id 可能出现两条记录（治理区失败 + 例外区警告），故按 ok 取值：
//   ok === false → 治理区结论；ok === null → 例外区警告
const findRec = (out, id, kind = 'fail') =>
  out.results.find((r) => r.id === id && (kind === 'warn' ? r.ok === null : r.ok !== null))
const details = (out, id, kind = 'fail') => (findRec(out, id, kind)?.details || []).join(' | ')

test('V-3：链接工作树内运行与主检出侧结论逐项一致', () => {
  const { repo, wtA } = fixture()
  const fromMain = run(repo)
  const fromWorktree = run(wtA)

  // 失败项数量一致
  assert.equal(fromWorktree.failures, fromMain.failures, '失败项数量不一致')
  // 每个检查项的 id / ok / 明细逐项一致（顺序亦一致）
  const norm = (o) => o.results.map((r) => ({ id: r.id, ok: r.ok, title: r.title, details: r.details }))
  assert.deepEqual(norm(fromWorktree), norm(fromMain), '两侧检查结论不一致')
  // 锚点解析：两侧应指向同一个主检出
  assert.equal(fromWorktree.anchor, fromMain.anchor)
  assert.equal(fromWorktree.root, fromMain.root)
  // 上下文不同
  assert.notEqual(fromWorktree.context, fromMain.context)
})

test('V-3：主检出不得被当成治理区工作区（D-2/D-3/D-4）', () => {
  const { repo, wtA, wtB } = fixture()
  const fromWorktree = run(wtA)
  // 精确锚定「修改前的报错形态」：主检出被当成链接工作区时的明细行长这样——
  //   D-2: <主检出>  目录名=repo  分支=(detached|main|...)   ← 目录名 ≠ 分支名
  //   D-3: <主检出>  分支=main                                ← 分支不符 dev-*-r<n>
  //   D-4: <主检出>/.agent-runs                               ← 主检出的产物根被当成工作区内的产物
  for (const [id, needle] of [
    ['D-2', `${repo}  目录名=`],
    ['D-3', `${repo}  分支=`],
    ['D-4', `${repo}/.agent-runs`],
    ['D-4', `${repo}/.task-runs`],
  ]) {
    assert.ok(!details(fromWorktree, id).includes(needle), `${id} 仍把主检出列为违规项：${details(fromWorktree, id)}`)
  }
  // 真正的治理区违规仍须报出（修正不得把检查一并放空）
  assert.ok(details(fromWorktree, 'D-2').includes(wtB), '治理区违规仍应报出')
})

test('V-3：锚点数据来源——工作树内也读主检出的登记册', () => {
  const { repo, wtA } = fixture()
  const fromMain = run(repo)
  const fromWorktree = run(wtA)
  // 两份运行都必须报「终态任务 0 个」（锚点登记册为空），
  // 而不是 A 分支上那份含 2 个终态任务的快照
  for (const out of [fromMain, fromWorktree]) {
    assert.match(findRec(out, 'D-7').title, /终态任务（已合并\/已取消，0 个）/, findRec(out, 'D-7').title)
  }
})

test('V-4：工作树内运行仍校验该工作树自身', () => {
  const { wtB } = fixture()
  const out = run(wtB)
  assert.equal(findRec(out, 'D-2')?.ok, false, 'D-2 应报出目录名 ≠ 分支名')
  assert.ok(details(out, 'D-2').includes(wtB), `D-2 明细应包含调用方自身所在工作树：${details(out, 'D-2')}`)
})

test('V-5：外部运行时工作区（.codex/worktrees）只计警告不计失败', () => {
  const { repo, wtA, wtC } = fixture()
  for (const target of [repo, wtA]) {
    const out = run(target)
    // C 是违规（目录名 ≠ 分支名）但属例外区：以警告形式出现，不计入失败明细
    assert.ok(!details(out, 'D-2', 'fail').includes(wtC), 'C 不应计入 D-2 失败明细')
    assert.ok(details(out, 'D-2', 'warn').includes(wtC), `C 应以警告形式报出：${details(out, 'D-2', 'warn')}`)
    // 治理区仍有 B 的违规 —— 例外区清单不得掩盖治理区问题
    assert.equal(findRec(out, 'D-2', 'fail').ok, false, '治理区 B 的违规应仍判失败')
  }
})

test('D-6：并集口径——锚点与上下文任一漏网都报出', () => {
  const { repo, wtA } = fixture()
  // 在 A 分支提交一个过程产物路径（漏网入库）
  fs.mkdirSync(path.join(wtA, '.agent-runs'), { recursive: true })
  fs.writeFileSync(path.join(wtA, '.agent-runs', 'leak.json'), '{}\n')
  gOk(['add', '-A', '-f'], wtA)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'chore: leak'], wtA)

  // 从 A 运行：必须报出该漏网
  assert.equal(findRec(run(wtA), 'D-6').ok, false, '上下文漏网应被报出')
  // 从主检出运行：主干干净，D-6 通过（并集不改变主干自身结论）
  assert.equal(findRec(run(repo), 'D-6').ok, true)
})

test('V-8 / R-8：D-10 无法核验的终态任务一律显式标注，且不计失败', () => {
  const { repo } = fixture()
  // 锚点登记册加入三个已合并任务，覆盖 D-10 无法核验的两种形态与一个可核验对照：
  //   LOC-901 —— 从未登记分支（无分支记录 → 无法核验）
  //   LOC-902 —— 有分支记录但 branch_retained 非布尔值（→ 同样无法核验；只判「无分支」会漏掉这一形态）
  //   LOC-903 —— 有分支记录 + 布尔字段（可核验，把 D-10 判定机制激活并作为对照）
  const regPath = path.join(repo, 'docs', 'tasks', 'registry.json')
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'))
  reg.tasks.push({ task_id: 'LOC-901', status: '已合并', branch: null, branch_retained: null })
  reg.tasks.push({ task_id: 'LOC-902', status: '已合并', branch: 'dev-loc-902-r1', branch_retained: null })
  reg.tasks.push({ task_id: 'LOC-903', status: '已合并', branch: 'dev-loc-903-r1', branch_retained: false })
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n')
  // 补上归档三件套，避免 D-8 干扰本用例判读
  for (const id of ['LOC-901', 'LOC-902', 'LOC-903']) {
    const arch = path.join(repo, 'docs', 'tasks', 'archive', id)
    fs.mkdirSync(arch, { recursive: true })
    fs.writeFileSync(path.join(arch, `${id}-demo.md`), '# 任务卡\n')
    fs.writeFileSync(path.join(arch, 'task-spec-V1.md'), '**版本**：V1\n')
    fs.writeFileSync(path.join(arch, 'evidence-summary.json'), '{}\n')
  }
  gOk(['add', '-A'], repo)
  gOk(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'chore: unverifiable terminal tasks'], repo)

  const out = run(repo)
  const noteRec = out.results.find((r) => r.id === 'D-10' && r.ok === null && (r.details || []).join(' ').includes('LOC-901'))
  assert.ok(noteRec, 'D-10 应给出「无法核验」的显式说明行，而不是静默跳过')
  const text = (noteRec.details || []).join(' ')
  assert.ok(text.includes('未登记分支'), `应说明无分支记录的原因：${text}`)
  assert.ok(text.includes('LOC-902'), `有分支但字段非布尔值也必须列出：${text}`)
  assert.ok(text.includes('非布尔值'), `应说明字段非布尔值的原因：${text}`)
  assert.ok(!text.includes('LOC-903'), `可核验的任务不应出现在说明行：${text}`)
  assert.equal(findRec(out, 'D-10', 'fail').ok, true, '无法核验项不得计为失败')
  // 新增说明行不得改变失败计数：本 fixture 刻意构造的治理区违规只有 D-2 一项
  assert.equal(out.failures, 1, JSON.stringify(out.results.filter((r) => r.ok === false)))
  assert.ok(!out.results.some((r) => r.id === 'D-10' && r.ok === false), 'D-10 不得因无法核验项转为失败')
})
