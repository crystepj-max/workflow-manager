// 工作区目录组织约定 · 纯逻辑单测
// 覆盖：命名派生规则、porcelain 解析、路径包含判定、范围分类、嵌套与仓库内判定
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../scripts/workspace-convention-core.cjs');

const {
  isTaskId,
  isRunId,
  isMetadataDir,
  isResolvableRunDir,
  isInside,
  parsePorcelain,
  scopeOfPath,
  findNestedWorktrees,
  findWorktreesInsideRepo,
} = core;

test('TASK_ID：双轨道前缀 + 序号', () => {
  assert.equal(isTaskId('LOC-018'), true);
  assert.equal(isTaskId('CWF-185'), true);
  assert.equal(isTaskId('loc-018'), false, '大小写敏感：小写属 RUN_ID 体系');
  assert.equal(isTaskId('LOC-'), false);
  assert.equal(isTaskId('XYZ-1'), false);
});

test('RUN_ID：<task_id 小写>-r<n>，允许切片后缀', () => {
  assert.equal(isRunId('loc-018-r1'), true);
  assert.equal(isRunId('cwf-185-r1'), true);
  assert.equal(isRunId('loc-018-s02-r1'), true);
  assert.equal(isRunId('cwf-74-01'), false, '旧式 -01 结尾不是合法 RUN_ID');
  assert.equal(isRunId('loc-018'), false, '缺 -r<n>');
  assert.equal(isRunId('uat-budget-01'), false);
  assert.equal(isRunId('task'), false);
  assert.equal(isRunId('env-store'), false);
});

test('约定元数据目录名不得当作运行标识', () => {
  assert.equal(isMetadataDir('schema'), true);
  assert.equal(isMetadataDir('loc-018-r1'), false);
  // 元数据名虽不是运行标识，但也不应被误报为「未启用字段」类噪音
  assert.equal(isResolvableRunDir('schema'), false);
  assert.equal(isResolvableRunDir('LOC-018'), true);
  assert.equal(isResolvableRunDir('loc-018-r1'), true);
});

test('分支名派生规则', () => {
  assert.equal(core.BRANCH_RE.test('dev-loc-018-r1'), true);
  assert.equal(core.BRANCH_RE.test('dev-cwf-185-r1'), true);
  assert.equal(core.BRANCH_RE.test('dev-cwf-74-01'), false);
  assert.equal(core.BRANCH_RE.test('feat/vwf-editor-slim-oneclick'), false);
  assert.equal(core.BRANCH_RE.test('vwf/run/uat-80-01'), false);
});

test('isInside：同级不算，子路径算，父路径不算', () => {
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b'), false, '同一路径不算位于内部');
  assert.equal(isInside('/a/bc', '/a/b'), false, '前缀相同但不是子目录');
  assert.equal(isInside('/a', '/a/b'), false);
});

test('isInside：相邻容器不算嵌套', () => {
  const repo = '/Users/x/workspace/proj';
  const wt = '/Users/x/workspace/proj-worktrees/dev-loc-1-r1';
  assert.equal(isInside(wt, repo), false, 'proj-worktrees 与 proj 是兄弟目录');
});

test('parsePorcelain：解析路径、分支、状态位', () => {
  const text = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.scratch/worktrees/dev-loc-1-r1',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/dev-loc-1-r1',
    '',
    'worktree /gone',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/dev-x-r1',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree /repo/wt-detached',
    'HEAD 4444444444444444444444444444444444444444',
    'detached',
    '',
  ].join('\n');
  const list = parsePorcelain(text);
  assert.equal(list.length, 4);
  assert.equal(list[0].path, '/repo');
  assert.equal(list[0].branch, 'main');
  assert.equal(list[0].prunable, false);
  assert.equal(list[1].branch, 'dev-loc-1-r1', 'refs/heads/ 前缀应被剥离');
  assert.equal(list[2].prunable, true);
  assert.equal(list[3].detached, true);
  assert.equal(list[3].branch, null);
});

test('parsePorcelain：空输入返回空数组', () => {
  assert.deepEqual(parsePorcelain(''), []);
  assert.deepEqual(parsePorcelain('\n\n'), []);
});

test('findNestedWorktrees：只在工作区相互嵌套时命中', () => {
  const outer = '/repo/.scratch/worktrees/dev-a-r1';
  const inner = `${outer}/.scratch/worktrees/dev-b-r1`;
  const sibling = '/repo/.scratch/worktrees/dev-c-r1';
  const pairs = findNestedWorktrees([outer, inner, sibling]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], [inner, outer]);
});

test('findNestedWorktrees：相邻容器内的工作区互不嵌套', () => {
  const a = '/w/proj-worktrees/dev-a-r1';
  const b = '/w/proj-worktrees/dev-b-r1';
  assert.deepEqual(findNestedWorktrees([a, b]), []);
});

test('findWorktreesInsideRepo：仓库内命中，仓库外不命中', () => {
  const repo = '/w/proj';
  const inside = '/w/proj/.scratch/worktrees/dev-a-r1';
  const outside = '/w/proj-worktrees/dev-a-r1';
  assert.deepEqual(findWorktreesInsideRepo([inside, outside], repo), [inside]);
});

test('scopeOfPath：例外区（外部运行时 / 编辑器 / 临时目录）识别', () => {
  const opts = {
    homedir: '/Users/x',
    exemptAbsPrefixes: ['/private/tmp/', '/tmp/'],
    exemptPathSegments: ['.dsh/workspaces', '.dsh-workflow-dev/workspaces', '.cursor/worktrees'],
  };
  assert.equal(scopeOfPath('/Users/x/.dsh/workspaces/ws-1/source', opts), 'external');
  assert.equal(scopeOfPath('/Users/x/.dsh-workflow-dev/workspaces/ws-1/source', opts), 'external');
  assert.equal(scopeOfPath('/Users/x/.cursor/worktrees/proj/hplt', opts), 'external');
  assert.equal(scopeOfPath('/private/tmp/wmlist', opts), 'external');
  assert.equal(scopeOfPath('/w/proj/.scratch/worktrees/dev-a-r1', opts), 'governed');
  assert.equal(scopeOfPath('/w/proj-worktrees/dev-a-r1', opts), 'governed');
});
