#!/usr/bin/env node
// 工作区路径解析 —— **唯一入口**。
//
// 约定出处：docs/design/workspace-directory-convention.md
//   §1.4 布局（相邻容器）／§1.6 锚定机制／§1.12 生命周期所有者
//
// 三条设计要点（对应三条已定决策）：
//   1) 所有路径由**主检出**派生，而不是「当前目录」。工作树是仓库的完整副本，
//      同一个相对路径在每个工作树里各自成立一次，产物随之线性复制。
//   2) 主检出用 `git rev-parse --git-common-dir` 解析——所有工作树返回同一路径，
//      取其父目录即主检出。这是本约定能成立的技术锚点。
//   3) 工作树放在主检出的**相邻容器**内（`../<仓库名>-worktrees/<分支名>/`），
//      绝不在仓库目录内部：位于仓库内会绕回「需要忽略规则」的旧形态，嵌套更是
//      会破坏所有向上逐级查找仓库根的工具。
//
// 本模块是纯函数集合（除 git 解析外无副作用），供创建入口、收口命令与校验共用。
// **禁止任何脚本自行拼接这些路径。**

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'

// 运行目录名（过程产物根）。现行名与目标名并存期间，二者都需被识别。
export const RUNS_DIR_NAME = '.agent-runs'

// 相邻容器后缀：主检出 `<父目录>/<仓库名>` → 容器 `<父目录>/<仓库名>-worktrees`
export const WORKTREES_CONTAINER_SUFFIX = '-worktrees'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

/**
 * 解析主检出（绝对路径）。可传入任意工作树内的目录，返回的都是同一个主检出。
 * 实现：`--git-common-dir` 在 linked worktree 返回主检出的 .git 绝对路径；
 * 在主检出返回 `.git`（相对），故统一 resolve 后再取父目录。
 */
export function mainCheckout(cwd) {
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir'])
  const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir)
  const dir = path.dirname(abs)
  // 规范化（macOS 上 /var 与 /private/var 互为软链）：保证不同入口得到同一字符串
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** 工作树容器根：`<主检出的父目录>/<仓库名>-worktrees` */
export function worktreesRoot(main) {
  const m = path.resolve(main)
  return path.join(path.dirname(m), `${path.basename(m)}${WORKTREES_CONTAINER_SUFFIX}`)
}

/** 某一分支的工作树路径。目录名 = 分支名（约定 §1.3 派生规则，不允许自由命名）。 */
export function worktreePathFor(main, branch) {
  return path.join(worktreesRoot(main), branch)
}

/** 过程产物根（**锚定主检出**，不在工作树内）。 */
export function runsRoot(main) {
  return path.join(path.resolve(main), RUNS_DIR_NAME)
}

/** 某次运行的产物目录：`<主检出>/<RUNS_DIR_NAME>/<run_id>` */
export function runDirFor(main, runId) {
  return path.join(runsRoot(main), runId)
}

/** child 是否位于 parent 内部（同级或外部返回 false）。 */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 工作树是否位于仓库目录内部（治理红线：不得位于仓库内）。 */
export function isWorktreeInsideRepo(main, worktreePath) {
  return isInside(worktreePath, main)
}
