// workspace-paths 单测：路径解析是「唯一入口」，一旦回归会让新任务重新散落
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mainCheckout,
  worktreesRoot,
  worktreePathFor,
  runsRoot,
  runDirFor,
  isInside,
  isWorktreeInsideRepo,
  WORKTREES_CONTAINER_SUFFIX,
  RUNS_DIR_NAME,
} from '../workspace-paths.mjs'

const gitInit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), 'wf-paths-'))
  const repo = join(base, 'proj')
  mkdirSync(repo)
  gitInit(repo, ['init', '-q', '-b', 'main'])
  gitInit(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  // cwf-run-init 会从 origin 解析仓库 slug，夹具需提供一个
  gitInit(repo, ['remote', 'add', 'origin', 'https://example.com/org/proj.git'])
  return { base, repo }
}

test('worktreesRoot 是主检出的相邻容器（不是仓库内部）', () => {
  assert.equal(worktreesRoot('/w/proj'), `/w/proj${WORKTREES_CONTAINER_SUFFIX}`)
  assert.equal(isInside(worktreesRoot('/w/proj'), '/w/proj'), false, '容器不得位于仓库内部')
})

test('worktreePathFor 目录名 = 分支名', () => {
  assert.equal(worktreePathFor('/w/proj', 'dev-loc-018-r1'), '/w/proj-worktrees/dev-loc-018-r1')
})

test('runsRoot / runDirFor 锚定主检出', () => {
  assert.equal(runsRoot('/w/proj'), `/w/proj/${RUNS_DIR_NAME}`)
  assert.equal(runDirFor('/w/proj', 'loc-018-r1'), `/w/proj/${RUNS_DIR_NAME}/loc-018-r1`)
})

test('isInside 边界：同级、外部、自身均不算内部', () => {
  assert.equal(isInside('/w/proj/a', '/w/proj'), true)
  assert.equal(isInside('/w/proj/a/b', '/w/proj'), true)
  assert.equal(isInside('/w/proj', '/w/proj'), false, '自身不算内部')
  assert.equal(isInside('/w/proj-other', '/w/proj'), false, '同前缀的兄弟目录不算内部')
  assert.equal(isInside('/w/other', '/w/proj'), false)
})

test('mainCheckout：主检出与其工作树解析到同一路径', () => {
  const { base, repo } = makeRepo()
  try {
    const wt = join(base, 'proj-worktrees', 'dev-t-01')
    gitInit(repo, ['worktree', 'add', '-q', '-b', 'dev-t-01', wt])

    const fromRepo = mainCheckout(repo)
    const fromWorktree = mainCheckout(wt)
    assert.equal(fromRepo, fromWorktree, '从工作树内解析也必须得到同一个主检出')
    // macOS 上 /var 与 /private/var 互为软链，用 realpath 比较尾部即可
    assert.match(fromRepo, /proj$/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('真实仓库：由主检出派生的工作树路径不在仓库内部', () => {
  const { base, repo } = makeRepo()
  try {
    const main = mainCheckout(repo)
    const wt = worktreePathFor(main, 'dev-x-r1')
    assert.equal(isWorktreeInsideRepo(main, wt), false, '相邻容器布局下不得位于仓库内')
    // 与「位于仓库内」的旧形态对比，确认判定能区分二者
    assert.equal(isWorktreeInsideRepo(main, join(main, '.scratch/worktrees/dev-x-r1')), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('端到端：cfw-run-init 把工作树建到相邻容器、run 目录落主检出', () => {
  const { base, repo } = makeRepo()
  try {
    const script = join(import.meta.dirname, '..', 'cwf-run-init.mjs')
    const out = execFileSync('node', [script, 'T-1', 'loc-t-01', '--local-base'], {
      cwd: repo,
      encoding: 'utf-8',
    })
    const parsed = JSON.parse(out)
    const nr = (p) => p.replace(/^\/private/, '')

    assert.equal(nr(parsed.worktree), nr(join(base, 'proj-worktrees', 'dev-loc-t-01')), '工作树应在相邻容器内')
    assert.equal(nr(parsed.runDir), nr(join(repo, '.agent-runs', 'loc-t-01')), 'run 目录应锚定主检出')
    assert.equal(isInside(parsed.worktree, repo), false, '工作树不得位于仓库内部')
    // 决策六：run-init 只登记插件命名空间与固定端口，不再分配每 Run 独占 Home
    assert.deepEqual(parsed.plugin_namespace, 'loc-t-01')
    assert.deepEqual(parsed.dev_dsh_port, 9527)

    // 从工作树内再次执行，解析结果必须一致（证明不依赖当前目录）
    assert.equal(nr(mainCheckout(parsed.worktree)), nr(repo))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
