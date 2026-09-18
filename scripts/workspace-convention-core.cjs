// 工作区目录组织约定 · 纯逻辑核心（无副作用、可单测）
// 供 scripts/validate-workspace.mjs 使用；权威：docs/design/workspace-directory-convention.md
//
// 本文件只做纯函数与常量：不读文件、不调 git、不写任何东西。

'use strict';

const path = require('node:path');

// —— 命名派生规则（实例化说明 §1.1；FIX-72 起认新编号前缀 FEAT/FIX/CHORE，
//     与 CNB 远端发号 d34f618 对齐；旧前缀 LOC/CWF 永久向后兼容）——
const TASK_ID_RE = /^(?:LOC|CWF|FEAT|FIX|CHORE)-\d+$/;
const RUN_ID_RE = /^(?:loc|cwf|feat|fix|chore)-\d+(?:-s\d+)?-r\d+$/;
const BRANCH_RE = /^dev-.+-r\d+$/;

// 机制目录（非运行标识，由脚本按约定在产物根内生成，不算违规）：
//   schema      — handoff schema 的分发副本（cwf-run-init 写入，供外仓库使用）
//   env-store   — 任务环境组登记存储（ai-task-workspace-env 的 store）
const MECHANISM_DIR_NAMES = ['schema', 'env-store'];

const isTaskId = (name) => TASK_ID_RE.test(name);
const isRunId = (name) => RUN_ID_RE.test(name);
const isMechanismDir = (name) => MECHANISM_DIR_NAMES.includes(name);
const isResolvableRunDir = (name) => isTaskId(name) || isRunId(name);

// 子路径是否严格位于父路径内部（同级不算）
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 解析 `git worktree list --porcelain` 输出为记录数组。
// 块之间以空行分隔；只取本约定关心的字段。
function parsePorcelain(text) {
  return String(text)
    .split(/\n\s*\n/)
    .map((block) => {
      const rec = { path: null, branch: null, detached: false, prunable: false, bare: false, locked: false };
      for (const line of block.split('\n').filter(Boolean)) {
        if (line.startsWith('worktree ')) rec.path = line.slice('worktree '.length);
        else if (line.startsWith('branch ')) rec.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        else if (line === 'detached') rec.detached = true;
        else if (line === 'bare') rec.bare = true;
        else if (line.startsWith('prunable')) rec.prunable = true;
        else if (line.startsWith('locked')) rec.locked = true;
      }
      return rec.path ? rec : null;
    })
    .filter(Boolean);
}

// 工作区范围分类：governed（治理区，强制） / external（例外区，接口约定计警告）
// 例外区 = 外部运行时 / 编辑器创建的工作区，见模板 §1.10
function scopeOfPath(absPath, opts) {
  const { homedir = '', exemptAbsPrefixes = [], exemptPathSegments = [] } = opts || {};
  const abs = path.resolve(absPath);
  for (const prefix of exemptAbsPrefixes) {
    if (abs === prefix.replace(/\/$/, '') || abs.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) return 'external';
  }
  for (const seg of exemptPathSegments) {
    if (abs.includes(`/${seg}/`) || abs.endsWith(`/${seg}`)) return 'external';
  }
  if (homedir && abs.startsWith(homedir)) {
    for (const seg of exemptPathSegments) if (abs.includes(`/${seg}/`)) return 'external';
  }
  return 'governed';
}

// 找出「工作区套工作区」——这是硬红线（会破坏向上查找仓库根的工具）。
// 返回 [内层路径, 外层路径] 对。主检出不参与，因为主检出不是被嵌套对象，
// 「工作区位于仓库内」由单独的检查（D-1b）承担。
function findNestedWorktrees(linkedPaths) {
  const pairs = [];
  for (const a of linkedPaths) for (const b of linkedPaths) {
    if (a !== b && isInside(a, b)) pairs.push([a, b]);
  }
  return pairs;
}

// 找出位于仓库目录内的工作区（本约定下应迁至相邻容器）
function findWorktreesInsideRepo(linkedPaths, repoRoot) {
  return linkedPaths.filter((p) => isInside(p, repoRoot));
}

// 汇总：违规项按治理区/例外区分桶
function splitByScope(paths, scopeFn) {
  const governed = [];
  const external = [];
  for (const p of paths) (scopeFn(p) === 'governed' ? governed : external).push(p);
  return { governed, external };
}

module.exports = {
  TASK_ID_RE,
  RUN_ID_RE,
  BRANCH_RE,
  MECHANISM_DIR_NAMES,
  isTaskId,
  isRunId,
  isMechanismDir,
  isResolvableRunDir,
  isInside,
  parsePorcelain,
  scopeOfPath,
  findNestedWorktrees,
  findWorktreesInsideRepo,
  splitByScope,
};
