// cwf-run-init.mjs 纯逻辑测试（分支命名、run_id 安全、身份比对、独占开发 Home 分配）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchName, assertRunIdSafe, findIdentityMismatch, parseBudget, ensureGitExclude, repoSlugFromUrl,
  resolveBase, allocateDevDshHome, envResourcesFor, devDshTasksRoot, DEV_DSH_HOME_MARKER,
} from '../cwf-run-init.mjs'

const identity = (runId) => ({
  run_id: runId,
  issue_or_task_identity: '#185',
  work_branch: `dev-${runId}`,
  workspace_id: `wt-dev-${runId}`,
  repository: 'org/repo',
})

test('devDshTasksRoot：默认 ~/.dsh-workflow-dev/tasks，可用 VWF_DEV_DSH_TASKS_ROOT 改道', () => {
  assert.match(devDshTasksRoot({}), /\.dsh-workflow-dev[\\/]tasks$/)
  assert.equal(devDshTasksRoot({ VWF_DEV_DSH_TASKS_ROOT: '/tmp/x' }), '/tmp/x')
})

test('allocateDevDshHome：首次分配建目录 + 归属 marker，run.json 资源字段按类型分层', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwf-dev-home-'))
  const now = () => new Date('2026-09-08T05:00:00.000Z')
  const home = allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-185-01'), now })
  assert.equal(home.path, join(root, 'cwf-185-01'))
  assert.equal(home.reused, false)
  assert.equal(home.registered_at, '2026-09-08T05:00:00.000Z')
  const marker = JSON.parse(readFileSync(join(home.path, DEV_DSH_HOME_MARKER), 'utf-8'))
  assert.equal(marker.kind, 'dev-dsh-home')
  assert.equal(marker.run_id, 'cwf-185-01')
  assert.equal(marker.work_branch, 'dev-cwf-185-01')
  assert.deepEqual(envResourcesFor(home), {
    dev_dsh_home: { path: home.path, marker: home.marker, registered_at: '2026-09-08T05:00:00.000Z' },
  })
})

test('allocateDevDshHome：同 run_id 幂等复用，保留首次登记时间', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwf-dev-home-'))
  const first = allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-185-01'), now: () => new Date('2026-09-08T05:00:00.000Z') })
  const again = allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-185-01'), now: () => new Date('2026-09-09T05:00:00.000Z') })
  assert.equal(again.reused, true)
  assert.equal(again.path, first.path)
  assert.equal(again.registered_at, '2026-09-08T05:00:00.000Z')
})

test('allocateDevDshHome：目录属于其他 Run 或无 marker 时拒绝接管', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwf-dev-home-'))
  // 他人现场：目录名与本 run_id 相同但 marker 归属不同
  mkdirSync(join(root, 'cwf-185-01'), { recursive: true })
  writeFileSync(join(root, 'cwf-185-01', DEV_DSH_HOME_MARKER), JSON.stringify({ run_id: 'cwf-999-01' }))
  assert.throws(() => allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-185-01') }), /属于其他 Run（cwf-999-01）/)
  // 无 marker 的既有目录：不静默接管
  mkdirSync(join(root, 'cwf-185-02'), { recursive: true })
  assert.throws(() => allocateDevDshHome({ tasksRoot: root, identity: identity('cwf-185-02') }), /无归属 marker/)
  assert.equal(existsSync(join(root, 'cwf-185-02', DEV_DSH_HOME_MARKER)), false)
})

test('branchName：run_id 直接进分支名（单射）', () => {
  assert.equal(branchName('cwf-123-01'), 'dev-cwf-123-01')
  assert.notEqual(branchName('cwf-123-01'), branchName('cwf-123-02'))
})

test('assertRunIdSafe：仅接受已净化的小写连字符形态', () => {
  assert.doesNotThrow(() => assertRunIdSafe('cwf-123-01'))
  assert.throws(() => assertRunIdSafe('team/run-1'), /非法 run_id/) // 路径分隔符
  assert.throws(() => assertRunIdSafe('..'), /非法 run_id/)         // 穿越
  assert.throws(() => assertRunIdSafe('../x'), /非法 run_id/)
  assert.throws(() => assertRunIdSafe('CWF_105 Bootstrap'), /非法 run_id/) // 大写/下划线/空格
  assert.throws(() => assertRunIdSafe('A_B'), /非法 run_id/)        // 与 a-b 防归一化碰撞
})

test('findIdentityMismatch：幂等复用前校验身份一致', () => {
  const stored = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  const same = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  assert.deepEqual(findIdentityMismatch(stored, same), [])
  assert.equal(findIdentityMismatch(stored, { ...same, issue_or_task_identity: '#124' }).length, 1)
  assert.equal(findIdentityMismatch(stored, { ...same, base_ref: 'dev' }).length, 1)
  assert.equal(findIdentityMismatch(stored, { ...same, rollback_budget: 5 }).length, 1)
})

test('parseBudget：完整非负整数校验', () => {
  assert.equal(parseBudget('3'), 3)
  assert.equal(parseBudget('0'), 0)
  assert.throws(() => parseBudget('nope'), /非法回退额度/)
  assert.throws(() => parseBudget('3junk'), /非法回退额度/)
  assert.throws(() => parseBudget('-1'), /非法回退额度/)
  assert.throws(() => parseBudget(''), /非法回退额度/)
  assert.throws(() => parseBudget('9'.repeat(20)), /非法回退额度/) // Infinity
  assert.throws(() => parseBudget(String(Number.MAX_SAFE_INTEGER + 1)), /非法回退额度/)
})

test('ensureGitExclude：幂等追加本地排除（入参为 exclude 文件路径）', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cwf-excl-'))
  const excl = join(dir, 'info', 'exclude')
  const first = ensureGitExclude(excl, ['.scratch/', '.agent-runs/'])
  assert.deepEqual(first, ['.scratch/', '.agent-runs/'])
  const content = readFileSync(excl, 'utf-8')
  assert.match(content, /\.scratch\//)
  assert.match(content, /\.agent-runs\//)
  // 幂等：重复调用不追加
  const second = ensureGitExclude(excl, ['.scratch/'])
  assert.deepEqual(second, [])
})

test('resolveBase：远程模式先 fetch 再用 origin/<base>', () => {
  const calls = []
  const out = resolveBase({ base: 'main', localBase: false, git: (a) => calls.push(a) })
  assert.deepEqual(out, { baseRef: 'origin/main', kind: 'remote' })
  assert.deepEqual(calls, [['fetch', 'origin', 'main']])
})

test('resolveBase：本地轨道不访问远程，直接用本地分支', () => {
  const calls = []
  const out = resolveBase({ base: 'main', localBase: true, git: (a) => calls.push(a) })
  assert.deepEqual(out, { baseRef: 'main', kind: 'local' })
  assert.deepEqual(calls, [])
})

test('findIdentityMismatch：基线来源不同（local vs remote）视为不一致', () => {
  const stored = { issue_or_task_identity: '#123', base_ref: 'main', base_ref_kind: 'local', rollback_budget: 3 }
  assert.deepEqual(findIdentityMismatch(stored, { ...stored }), [])
  assert.equal(
    findIdentityMismatch(stored, { ...stored, base_ref_kind: 'remote' }).length,
    1,
  )
  // 历史 run.json 无 base_ref_kind 字段时按 remote 处理，不误报
  const legacy = { issue_or_task_identity: '#123', base_ref: 'main', rollback_budget: 3 }
  assert.deepEqual(
    findIdentityMismatch(legacy, { ...legacy, base_ref_kind: 'remote' }),
    [],
  )
  assert.equal(
    findIdentityMismatch(legacy, { ...legacy, base_ref_kind: 'local' }).length,
    1,
  )
})

test('repoSlugFromUrl：剥离认证信息（与 hostname 无关）', () => {
  assert.equal(repoSlugFromUrl('https://github.com/org/repo.git'), 'org/repo')
  assert.equal(repoSlugFromUrl('https://token123@github.com/org/repo.git'), 'org/repo')
  assert.equal(repoSlugFromUrl('git@github.com:org/repo.git'), 'org/repo')
  // GHE/其他 host：认证剥离，host 保留（不留凭据）
  assert.equal(repoSlugFromUrl('https://token@github.acme.example/org/repo.git'), 'github.acme.example/org/repo')
  assert.equal(repoSlugFromUrl('git@git.internal:org/repo.git'), 'git.internal/org/repo')
})
