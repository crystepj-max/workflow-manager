#!/usr/bin/env node
// 工作区目录组织约定 · 机器校验（D-1 ~ D-10）
// 权威：docs/design/workspace-directory-convention.md（通用标准模板 v1.0）
//       docs/design/workspace-directory-convention-instance-workflow-manager.md（本仓库实例）
//
// 用法（主检出或任一链接工作树内均可）：
//   node scripts/validate-workspace.mjs [--repo <path>] [--json] [--warn-only]
//
// 铁律：本脚本**全程只读**。只调用 git 的只读子命令与本地文件读取，
//       不做任何删除、移动、改名、写入、prune、worktree remove。
//
// 两个角色必须分开（LOC-023 修正；此前二者共用同一个 root，导致在链接工作树内运行
// 时把主检出误判为治理区工作区，并读到该分支的旧登记册快照）：
//   · 锚点 anchor —— **数据来源**：归档目录与过程产物根只有一份，永远在主检出，
//     由 `git rev-parse --git-common-dir` 的父目录解析（约定 §1.6；唯一入口 workspace-paths.mainCheckout）。
//   · 上下文 repo —— **调用现场**：由 `--repo` 指定（默认脚本上两级）。仅决定「从哪个检出观察」。
// 被校验集合 = `git worktree list` 去掉锚点本身，其余全部纳入——**含调用方自身所在的工作树**，
// 使得「在工作树内运行」既能与主检出侧得出同一组结论，也能校验该工作树自己。
//
// 范围分类：约定对「人工/脚本创建」的工作区与过程产物为强制（治理区），
//          对「外部运行时/编辑器」创建的工作区为接口约定（例外区，计警告不计失败）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mainCheckout } from './workspace-paths.mjs';

// —— 本仓库取值（对应实例化说明 §1）——
const PROCESS_ARTIFACT_DIRS = ['.agent-runs', '.task-runs']; // 过程产物根（现行 + 目标）
const LEGACY_RUN_ROOTS = ['.agent-runs'];                    // 待迁移的现行根
const ARCHIVE_ROOT = 'docs/tasks/archive';

// —— 命名派生规则与纯逻辑取自 core（无副作用、可单测）——
import conventionCore from './workspace-convention-core.cjs';
const {
  BRANCH_RE,
  isMechanismDir,
  isResolvableRunDir,
  isTaskId,
  parsePorcelain,
  scopeOfPath,
  findNestedWorktrees,
  findWorktreesInsideRepo,
} = conventionCore;

// —— 例外区（外部运行时 / 编辑器创建，见模板 §1.10 / 实例 §4.2）——
const EXEMPT_ABS_PREFIXES = ['/private/tmp/', '/tmp/'];
const EXEMPT_PATH_SEGMENTS = [
  '.dsh/workspaces',
  '.dsh-workflow-dev/workspaces',
  '.dsh-workflow-loc001/workspaces',
  '.cursor/worktrees',
  '.codex/worktrees',
];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const asJson = args.includes('--json');
const warnOnly = args.includes('--warn-only');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 上下文（调用现场）：决定「从哪个检出观察」；默认脚本上两级
const repo = path.resolve(opt('--repo') || path.join(__dirname, '..'));

// 锚点（数据来源）：登记册 / 归档 / 过程产物根所在处，永远是主检出。
// 解析失败（非 git 仓库）时才退回上下文，保证后续能给出明确报错。
let anchor = repo;
try {
  anchor = mainCheckout(repo);
} catch {
  anchor = repo;
}

// 本地归档与过程证据的唯一路径根 = 锚点（不是上下文）
const root = anchor;

let failures = 0;
let warnings = 0;
const results = [];
const record = (id, title, ok, details) => {
  const bucket = ok ? 'pass' : 'fail';
  if (!ok) failures++;
  results.push({ id, title, ok, details });
  if (!asJson) {
    console.log(`${ok ? '✅' : '❌'} ${id} ${title}`);
    for (const d of details || []) console.log(`     ${d}`);
  }
  return bucket;
};
const warn = (id, title, details) => {
  warnings++;
  results.push({ id, title, ok: null, details });
  if (!asJson) {
    console.log(`⚠️  ${id} ${title}`);
    for (const d of details || []) console.log(`     ${d}`);
  }
};
const note = (id, title, details) => {
  results.push({ id, title, ok: null, skipped: true, details });
  if (!asJson) {
    console.log(`➖ ${id} ${title}`);
    for (const d of details || []) console.log(`     ${d}`);
  }
};

const git = (a, cwd = root) => {
  try {
    return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
};

const homedir = process.env.HOME || '';
// 路径相等判定：先按字面解析比较，再按 realpath 比较——macOS 上 /var 与 /private/var
// 互为软链，锚点（realpath 规范化）与 `git worktree list` 的字面路径可能只差这一层。
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const samePath = (a, b) => path.resolve(a) === path.resolve(b) || realOr(a) === realOr(b);

// 工作区范围分类：治理区（强制） / 例外区（接口约定，计警告）
const scopeOf = (p) => scopeOfPath(p, {
  homedir,
  exemptAbsPrefixes: EXEMPT_ABS_PREFIXES,
  exemptPathSegments: EXEMPT_PATH_SEGMENTS,
});

// —— 采集：git worktree list --porcelain（登记表是仓库级的，从锚点读）——
const porcelain = git(['worktree', 'list', '--porcelain'], root);
if (porcelain === null) {
  console.error(`无法执行 git worktree list（不是 git 仓库？）：${root}`);
  process.exit(2);
}
const worktrees = parsePorcelain(porcelain);

// 被校验集合 = 全部工作区去掉锚点本身（主检出不是「工作区」）；
// 其余全部纳入——**包括调用方自身所在的工作树**，否则在工作树内运行永远无法校验它自己。
const anchorEntry = worktrees.find((w) => samePath(w.path, root));
const linked = worktrees.filter((w) => !samePath(w.path, root));

if (!asJson) {
  console.log(`工作区校验（只读）— 锚点（主检出）：${root}`);
  if (!samePath(repo, root)) console.log(`　　　　　　　　　 调用上下文：${repo}`);
  console.log(`工作区登记：${worktrees.length} 条（含主检出 ${anchorEntry ? '1' : '0'} 条）／被校验工作区 ${linked.length} 个\n`);
}

// —— D-1a 工作区位置：禁止嵌套（红线）——
{
  const live = linked.filter((w) => !w.prunable).map((w) => w.path);
  const pairs = findNestedWorktrees(live);
  record('D-1a', '工作区禁止嵌套（工作区套工作区）', pairs.length === 0,
    pairs.length ? pairs.map(([a, b]) => `${a}  ⤶ 位于另一工作区 ${b} 内部`) : ['无嵌套']);
}

// —— D-1b 工作区位置：不得位于仓库目录内 ——
{
  const live = linked.filter((w) => !w.prunable).map((w) => w.path);
  const inside = findWorktreesInsideRepo(live, root);
  record('D-1b', '工作区不得位于仓库目录内', inside.length === 0,
    inside.length ? inside.map((p) => `${p}  ← 应在相邻容器 ../${path.basename(root)}-worktrees/ 内`) : ['治理区全部在仓库外']);
}

// —— D-2 工作区目录名 = 分支名 ——
{
  const governed = [];
  const external = [];
  for (const w of linked) {
    if (w.prunable) continue;
    const base = path.basename(w.path);
    const okMatch = !w.detached && w.branch && base === w.branch;
    if (okMatch) continue;
    const line = `${scopeOf(w.path) === 'governed' ? '' : '[例外区] '}${w.path}  目录名=${base}  分支=${w.detached ? '(detached)' : w.branch || '(无)'}`;
    (scopeOf(w.path) === 'governed' ? governed : external).push(line);
  }
  if (governed.length) record('D-2', '工作区目录名 = 分支名', false, governed);
  else record('D-2', '工作区目录名 = 分支名', true, ['治理区全部一致']);
  if (external.length) warn('D-2', `例外区工作区目录名 ≠ 分支名（${external.length} 个，接口约定，见模板 §1.10）`, external.slice(0, 12));
}

// —— D-3 分支名符合派生规则 ——
{
  const bad = [];
  for (const w of linked) {
    if (scopeOf(w.path) !== 'governed' || w.prunable || w.detached) continue;
    if (!BRANCH_RE.test(w.branch || '')) bad.push(`${w.path}  分支=${w.branch}`);
  }
  record('D-3', '治理区分支名符合 dev-<run-id> 派生规则', bad.length === 0, bad.length ? bad : ['全部匹配']);
}

// —— D-4 过程产物位置：工作区内不得存在过程产物目录（主检出是产物落点，不在此列）——
{
  const bad = [];
  for (const w of linked) {
    if (w.prunable || !fs.existsSync(w.path)) continue;
    for (const dir of PROCESS_ARTIFACT_DIRS) {
      if (fs.existsSync(path.join(w.path, dir))) {
        bad.push(`${scopeOf(w.path) === 'governed' ? '' : '[例外区] '}${w.path}/${dir}`);
      }
    }
  }
  const gov = bad.filter((l) => !l.startsWith('[例外区]'));
  if (gov.length) record('D-4', '工作区内不得存在过程产物目录', false, gov);
  else record('D-4', '工作区内不得存在过程产物目录', true, ['治理区全部干净']);
  const ext = bad.filter((l) => l.startsWith('[例外区]'));
  if (ext.length) warn('D-4', `例外区工作区内含过程产物目录（${ext.length} 个）`, ext.slice(0, 10));
}

// —— D-5 运行目录命名：可解析为 TASK_ID 或 RUN_ID ——
{
  const bad = [];
  let scanned = 0;
  for (const dir of PROCESS_ARTIFACT_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      if (!fs.statSync(path.join(abs, name)).isDirectory()) continue;
      scanned++;
      if (isMechanismDir(name)) continue; // 机制目录（schema / env-store），由脚本按约定生成，非运行标识
      if (!isResolvableRunDir(name)) bad.push(`${dir}/${name}  ← 非 TASK_ID / RUN_ID`);
    }
  }
  if (scanned === 0) note('D-5', '运行目录命名（未发现过程产物根目录）', []);
  else record('D-5', `运行目录命名（扫描 ${scanned} 项）`, bad.length === 0, bad.length ? bad : ['全部可解析']);
}

// —— D-6 无漏网入库 ——
// 取「锚点（主干交付物）∪ 调用上下文（当前检出）」的并集：
//   · 只看锚点 → 在任务分支里运行会漏掉该分支自己的漏网；
//   · 只看上下文 → 主检出侧与工作树侧结论会漂移。
// 并集对两侧都是同一份「主干 + 现场」的可见范围，且保留合并前的自查能力。
{
  const seen = new Map();
  for (const [label, cwd] of [['锚点', root], ['上下文', repo]]) {
    const files = (git(['ls-files'], cwd) || '').split('\n').filter(Boolean);
    for (const f of files) {
      if (!seen.has(f)) seen.set(f, new Set());
      seen.get(f).add(label);
    }
  }
  const leaked = [...seen.entries()]
    .filter(([f]) => PROCESS_ARTIFACT_DIRS.some((d) => f === d || f.startsWith(`${d}/`)) || f.startsWith('.scratch/'))
    .map(([f, labels]) => `${f}  (见于：${[...labels].join('、')})`);
  record('D-6', '过程产物未入库', leaked.length === 0, leaked.length ? leaked : ['无漏网文件']);
}

// —— D-7 任务状态与终态工作区 ——
// 当前任务状态由 Multica 管理；工作区结构在 D-1 至 D-6 校验，不从历史账本推断任务归属。
note('D-7', '任务终态与工作区收口（由 Multica 管理）', [
  '未读取 docs/tasks/registry.json 或 BOARD.md；当前 Task 状态、负责人及收口状态以 Multica 为准。',
]);

// —— D-8 历史归档结构 ——
// 只检查仓库里已存在的历史归档目录，不用旧 Task 状态推断哪些任务“应该”有归档。
{
  const archiveRoot = path.join(root, ARCHIVE_ROOT);
  if (!fs.existsSync(archiveRoot)) {
    note('D-8', '历史归档结构（未发现归档目录）', [`${ARCHIVE_ROOT}/ 不存在`]);
  } else {
    const taskDirs = fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isTaskId(entry.name));
    const missing = [];
    for (const entry of taskDirs) {
      const taskId = entry.name;
      const archiveDir = path.join(archiveRoot, taskId);
      const files = fs.readdirSync(archiveDir);
      const hasCard = files.some((file) => file.startsWith(taskId) && file.endsWith('.md'));
      const hasSpec = files.some((file) => /^task-spec-V\d+\.md$/.test(file));
      const summaryPath = path.join(archiveDir, 'evidence-summary.json');
      let summary = null;
      if (fs.existsSync(summaryPath)) {
        try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { /* malformed summary */ }
      }
      if (summary?.archive_form === 'lightweight-remote') {
        if (!hasCard) missing.push(`${taskId} 轻量历史归档缺任务卡存根`);
        if (typeof summary.merge?.commit !== 'string' || !summary.merge.commit.trim()) {
          missing.push(`${taskId} 轻量历史归档缺 merge.commit`);
        }
        if (typeof summary.remote_ref !== 'string' || !summary.remote_ref.trim()) {
          missing.push(`${taskId} 轻量历史归档缺 remote_ref`);
        }
      } else {
        if (!hasCard) missing.push(`${taskId} 历史归档缺任务卡`);
        if (!hasSpec) missing.push(`${taskId} 历史归档缺规格终版`);
        if (!summary) missing.push(`${taskId} 历史归档缺有效证据摘要`);
      }
    }
    record('D-8', `历史归档结构（扫描 ${taskDirs.length} 个已存在目录）`, missing.length === 0,
      missing.length ? missing : ['已存在目录结构完整；不据此推断 Multica Task 状态']);
    const drift = fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isTaskId(entry.name))
      .map((entry) => entry.name);
    if (drift.length) warn('D-8', `${ARCHIVE_ROOT}/ 内出现非任务标识目录（同名漂移）`, drift);
  }
}

// —— D-9 本地 Run 明细保留 ——
note('D-9', '本地 Run 明细保留策略（未启用自动清理）', [
  '不读取旧账本到期字段；task-runs-cleanup 已退役，.agent-runs 明细由独立保留策略另行管理。',
]);

// —— D-10 分支保留 ——
note('D-10', 'Git 分支保留策略（不从旧任务字段推断）', [
  '分支生命周期按 Git / PR 交付和远端状态管理；不读取 registry.json 的 branch_retained 字段。',
]);

// —— 汇总 ——
if (asJson) {
  console.log(JSON.stringify({ root, anchor, context: repo, failures, warnings, results }, null, 2));
} else {
  console.log(`\n${failures === 0 ? '✅' : '❌'} 工作区校验${failures === 0 ? '通过' : `失败（${failures} 项）`}${warnings ? `；另有 ${warnings} 项警告（例外区接口约定）` : ''}`);
}
process.exit(warnOnly || failures === 0 ? 0 : 1);
