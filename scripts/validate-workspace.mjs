#!/usr/bin/env node
// 工作区目录组织约定 · 机器校验（D-1 ~ D-10）
// 权威：docs/design/workspace-directory-convention.md（通用标准模板 v1.0）
//       docs/design/workspace-directory-convention-instance-workflow-manager.md（本仓库实例）
//
// 用法（仓库根目录）：
//   node scripts/validate-workspace.mjs [--repo <path>] [--json] [--warn-only]
//
// 铁律：本脚本**全程只读**。只调用 git 的只读子命令与本地文件读取，
//       不做任何删除、移动、改名、写入、prune、worktree remove。
//
// 范围分类：约定对「人工/脚本创建」的工作区与过程产物为强制（治理区），
//          对「外部运行时/编辑器」创建的工作区为接口约定（例外区，计警告不计失败）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// —— 本仓库取值（对应实例化说明 §1）——
const PROCESS_ARTIFACT_DIRS = ['.agent-runs', '.task-runs']; // 过程产物根（现行 + 目标）
const LEGACY_RUN_ROOTS = ['.agent-runs'];                    // 待迁移的现行根
const ARCHIVE_ROOT = 'docs/tasks/archive';
const SPECS_ROOT = 'docs/tasks/specs';
const REGISTRY = 'docs/tasks/registry.json';
const TERMINAL_STATUSES = ['已合并', '已取消'];

// —— 命名派生规则与纯逻辑取自 core（无副作用、可单测）——
import conventionCore from './workspace-convention-core.cjs';
const {
  BRANCH_RE,
  isMetadataDir,
  isResolvableRunDir,
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
];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const asJson = args.includes('--json');
const warnOnly = args.includes('--warn-only');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(opt('--repo') || path.join(__dirname, '..'));

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
const samePath = (a, b) => path.resolve(a) === path.resolve(b);

// 工作区范围分类：治理区（强制） / 例外区（接口约定，计警告）
const scopeOf = (p) => scopeOfPath(p, {
  homedir,
  exemptAbsPrefixes: EXEMPT_ABS_PREFIXES,
  exemptPathSegments: EXEMPT_PATH_SEGMENTS,
});

// —— 采集：git worktree list --porcelain ——
const porcelain = git(['worktree', 'list', '--porcelain']);
if (porcelain === null) {
  console.error('无法执行 git worktree list（不是 git 仓库？）');
  process.exit(2);
}
const worktrees = parsePorcelain(porcelain);

const mainWorktree = worktrees.find((w) => samePath(w.path, root)) || worktrees[0];
const linked = worktrees.filter((w) => !samePath(w.path, root));

if (!asJson) {
  console.log(`工作区校验（只读）— 仓库：${root}`);
  console.log(`工作区登记：${worktrees.length} 条（含主检出）／链接工作区 ${linked.length} 个\n`);
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
      if (isMetadataDir(name)) { bad.push(`${dir}/${name}  ← 约定元数据，应迁至 docs/design/`); continue; }
      if (!isResolvableRunDir(name)) bad.push(`${dir}/${name}  ← 非 TASK_ID / RUN_ID`);
    }
  }
  if (scanned === 0) note('D-5', '运行目录命名（未发现过程产物根目录）', []);
  else record('D-5', `运行目录命名（扫描 ${scanned} 项）`, bad.length === 0, bad.length ? bad : ['全部可解析']);
}

// —— D-6 无漏网入库 ——
{
  const tracked = (git(['ls-files']) || '').split('\n').filter(Boolean);
  const leaked = tracked.filter((f) => PROCESS_ARTIFACT_DIRS.some((d) => f === d || f.startsWith(`${d}/`))
    || f.startsWith('.scratch/'));
  record('D-6', '过程产物未入库', leaked.length === 0, leaked.length ? leaked : ['无漏网文件']);
}

// —— D-7 终态任务已清理 ——
let registry = null;
try {
  registry = JSON.parse(fs.readFileSync(path.join(root, REGISTRY), 'utf8'));
} catch (e) {
  note('D-7 ~ D-10', '任务登记册不可读，跳过（' + REGISTRY + '）', [String(e.message)]);
}
if (registry) {
  const tasks = registry.tasks || [];
  const terminal = tasks.filter((t) => TERMINAL_STATUSES.includes(t.status));
  const bad = [];
  for (const t of terminal) {
    const hits = [];
    // ① 登记册记录的 worktree 字段不得仍存在于磁盘
    if (t.worktree) {
      for (const c of [path.join(root, t.worktree), path.join(root, '.scratch/worktrees', t.worktree)]) {
        if (fs.existsSync(c)) hits.push(c);
      }
    }
    // ② 该任务的分支不得仍挂在工作区上
    if (t.branch) {
      for (const w of linked) if (w.branch === t.branch) hits.push(w.path);
    }
    const unique = [...new Set(hits)];
    if (unique.length) bad.push(`${t.task_id}（${t.status}）仍有未收口工作区：${unique.join('、')}`);
  }
  record('D-7', `终态任务（已合并/已取消，${terminal.length} 个）工作区已清理`, bad.length === 0, bad.length ? bad : ['无终态残留']);
}

// —— D-8 归档完整性 ——
if (registry) {
  const merged = (registry.tasks || []).filter((t) => t.status === '已合并');
  const missing = [];
  const inSpecsOnly = [];
  for (const t of merged) {
    const archiveDir = path.join(root, ARCHIVE_ROOT, t.task_id);
    if (!fs.existsSync(archiveDir)) {
      const specsDir = path.join(root, SPECS_ROOT);
      const inSpecs = fs.existsSync(specsDir) && fs.readdirSync(specsDir).some((d) => d.startsWith(t.task_id));
      if (inSpecs) inSpecsOnly.push(`${t.task_id} 仅在 ${SPECS_ROOT}/（决策五：应统一到 ${ARCHIVE_ROOT}/）`);
      else missing.push(`${t.task_id} 既不在 ${ARCHIVE_ROOT}/ 也不在 ${SPECS_ROOT}/`);
      continue;
    }
    const files = fs.readdirSync(archiveDir);
    const hasCard = files.some((f) => f.startsWith(t.task_id) && f.endsWith('.md'));
    const hasSpec = files.some((f) => /^task-spec-V\d+\.md$/.test(f));
    if (!hasCard) missing.push(`${t.task_id} 缺任务卡（${ARCHIVE_ROOT}/${t.task_id}/）`);
    if (!hasSpec) missing.push(`${t.task_id} 缺规格终版（${ARCHIVE_ROOT}/${t.task_id}/）`);
  }
  if (missing.length) record('D-8', `已合并任务（${merged.length} 个）归档完整性`, false, missing);
  else record('D-8', `已合并任务（${merged.length} 个）归档完整性`, true, ['全部齐备']);
  if (inSpecsOnly.length) warn('D-8', `归档位置未统一（${inSpecsOnly.length} 个，决策五方案甲待执行）`, inSpecsOnly);
}

// —— D-9 无超期证据残留（依赖登记册字段，未启用时提示）——
if (registry) {
  const withField = (registry.tasks || []).filter((t) => t.evidence_expires_at);
  if (withField.length === 0) {
    note('D-9', '无超期证据残留（登记册尚无 evidence_expires_at 字段，机制未启用）', ['落地步骤见模板 Part 2 的 P1']);
  } else {
    const now = Date.now();
    const expired = withField
      .filter((t) => !t.evidence_cleared_at && Date.parse(t.evidence_expires_at) < now)
      .map((t) => `${t.task_id} 到期于 ${t.evidence_expires_at}，明细未清理`);
    record('D-9', `无超期证据残留（已启用 ${withField.length} 条）`, expired.length === 0, expired.length ? expired : ['无超期项']);
  }
}

// —— D-10 收口口径一致（登记册 branch_retained vs 实际分支）——
if (registry) {
  const withField = (registry.tasks || []).filter((t) => typeof t.branch_retained === 'boolean');
  if (withField.length === 0) {
    note('D-10', '收口口径一致（登记册尚无 branch_retained 字段，机制未启用）', ['落地步骤见模板 Part 2 的 P1']);
  } else {
    const bad = [];
    for (const t of withField) {
      if (!t.branch) continue;
      const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`]) !== null;
      if (t.branch_retained && !exists) bad.push(`${t.task_id} 标记保留分支但分支不存在：${t.branch}`);
      if (!t.branch_retained && exists) bad.push(`${t.task_id} 标记不保留分支但分支仍存在：${t.branch}`);
    }
    record('D-10', `收口口径一致（已启用 ${withField.length} 条）`, bad.length === 0, bad.length ? bad : ['全部一致']);
  }
}

// —— 汇总 ——
if (asJson) {
  console.log(JSON.stringify({ root, failures, warnings, results }, null, 2));
} else {
  console.log(`\n${failures === 0 ? '✅' : '❌'} 工作区校验${failures === 0 ? '通过' : `失败（${failures} 项）`}${warnings ? `；另有 ${warnings} 项警告（例外区接口约定）` : ''}`);
}
process.exit(warnOnly || failures === 0 ? 0 : 1);
