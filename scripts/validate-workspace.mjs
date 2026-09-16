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
//   · 锚点 anchor —— **数据来源**：登记册、归档目录、过程产物根只有一份，永远在主检出，
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
const REGISTRY = 'docs/tasks/registry.json';
const TERMINAL_STATUSES = ['已合并', '已取消'];

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

// 数据读写的唯一根 = 锚点（不是上下文）
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
// 语义分层（FIX-72）：
//   · 本地收口任务：全套三件套（任务卡 + 规格终版 + 证据摘要）——原有要求不变；
//   · 远程收口任务（经 CNB 合并请求合入，本地无完整收口流程）：轻量归档——
//     任务卡存根（.md）+ evidence-summary.json，摘要必须携带凭据字段（R-3）：
//     `archive_form: "lightweight-remote"`、`merge.commit`（与登记册逐字一致）、
//     `remote_ref`（CNB 指针）。缺任一凭据即失败——轻量 ≠ 无凭据。
if (registry) {
  const merged = (registry.tasks || []).filter((t) => t.status === '已合并');
  const missing = [];
  for (const t of merged) {
    const archiveDir = path.join(root, ARCHIVE_ROOT, t.task_id);
    if (!fs.existsSync(archiveDir)) {
      missing.push(`${t.task_id} 无归档目录（${ARCHIVE_ROOT}/${t.task_id}/）`);
      continue;
    }
    const files = fs.readdirSync(archiveDir);
    const hasCard = files.some((f) => f.startsWith(t.task_id) && f.endsWith('.md'));
    const hasSpec = files.some((f) => /^task-spec-V\d+\.md$/.test(f));
    const hasSummary = files.includes('evidence-summary.json');
    let summary = null;
    if (hasSummary) {
      try { summary = JSON.parse(fs.readFileSync(path.join(archiveDir, 'evidence-summary.json'), 'utf8')); } catch { /* 坏摘要按无凭据处理 */ }
    }
    const remoteCloseout = summary && summary.archive_form === 'lightweight-remote';
    if (remoteCloseout) {
      if (!hasCard) missing.push(`${t.task_id} 轻量归档缺任务卡存根（${ARCHIVE_ROOT}/${t.task_id}/）`);
      const regCommit = t.merge && t.merge.commit;
      if (!regCommit || !summary.merge || summary.merge.commit !== regCommit) {
        missing.push(`${t.task_id} 轻量归档 merge.commit 与登记册不一致或缺失（R-5：禁止编造）`);
      }
      if (!summary.remote_ref) missing.push(`${t.task_id} 轻量归档缺 remote_ref（远程收口指针）`);
    } else {
      if (!hasCard) missing.push(`${t.task_id} 缺任务卡（${ARCHIVE_ROOT}/${t.task_id}/）`);
      if (!hasSpec) missing.push(`${t.task_id} 缺规格终版（${ARCHIVE_ROOT}/${t.task_id}/）`);
      if (!hasSummary) missing.push(`${t.task_id} 缺证据摘要（${ARCHIVE_ROOT}/${t.task_id}/evidence-summary.json）`);
    }
  }
  if (missing.length) record('D-8', `已合并任务（${merged.length} 个）归档完整性`, false, missing);
  else record('D-8', `已合并任务（${merged.length} 个）归档完整性`, true, ['全部齐备（本地收口=三件套；远程收口=轻量归档含凭据）']);
  // 决策五范围收窄（FIX-72）：docs/tasks/specs/ 已复位为「定义入库家」（2026-09-16 起），
  // 不再作为废弃目录告警；警告改为检测 archive/ 内混入的非任务目录（同名漂移）。
  const archiveRoot = path.join(root, ARCHIVE_ROOT);
  if (fs.existsSync(archiveRoot)) {
    const drift = fs
      .readdirSync(archiveRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isTaskId(e.name))
      .map((e) => e.name);
    if (drift.length) {
      warn('D-8', `${ARCHIVE_ROOT}/ 内出现非任务标识目录（同名漂移）`, drift);
    }
  }
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
  // V2 / R-8：凡 D-10 **无法核验**的终态任务都必须显式列出，不得以「全部一致」掩盖。
  // 「无法核验」的完整定义 = 不满足 D-10 的核验前提（`branch_retained` 为布尔值 **且** 有分支记录），
  // 因此两种形态都要报：
  //   · 无分支记录（例：LOC-001 先于 Run 证据链机制落地，从未有分支）；
  //   · 有分支记录但 `branch_retained` 非布尔值（例：早期合并路径未写该字段的任务）。
  // 只按「无分支记录」判定会漏掉后者——那正是本任务要消灭的「静默跳过」同类缺口。
  // 一律**不计失败**：没有可核验的口径就没有可判定的违例。按 R-9 只陈述事实，不伪造字段值。
  const unverifiable = (registry.tasks || []).filter(
    (t) => TERMINAL_STATUSES.includes(t.status) && !(typeof t.branch_retained === 'boolean' && t.branch),
  );
  if (unverifiable.length) {
    note('D-10', `无法核验的终态任务（${unverifiable.length} 个：无分支记录，或 branch_retained 非布尔值）`,
      unverifiable.map((t) => {
        const why = !t.branch ? 'branch 为空——历史上未登记分支' : `branch_retained=${JSON.stringify(t.branch_retained)}——非布尔值，无保留口径可核`;
        return `${t.task_id}（${t.status}）${why}，按 R-9 不伪造`;
      }));
  }
}

// —— 汇总 ——
if (asJson) {
  console.log(JSON.stringify({ root, anchor, context: repo, failures, warnings, results }, null, 2));
} else {
  console.log(`\n${failures === 0 ? '✅' : '❌'} 工作区校验${failures === 0 ? '通过' : `失败（${failures} 项）`}${warnings ? `；另有 ${warnings} 项警告（例外区接口约定）` : ''}`);
}
process.exit(warnOnly || failures === 0 ? 0 : 1);
