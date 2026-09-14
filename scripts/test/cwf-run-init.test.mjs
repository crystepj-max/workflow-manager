// cwf-run-init.mjs 纯逻辑测试（分支命名、run_id 安全、身份比对、资源登记）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  branchName, assertRunIdSafe, findIdentityMismatch, parseBudget, ensureGitExclude, repoSlugFromUrl,
  resolveBase, envResourcesFor,
} from '../cwf-run-init.mjs'
import { DEV_DSH_PORT, pluginNamespaceFor, pluginNameFor } from '../workspace-paths.mjs'

test('envResourcesFor：只登记插件命名空间与固定端口（决策六后不再有独占 Home）', () => {
  assert.deepEqual(envResourcesFor('loc-020-r1'), {
    plugin_namespace: 'loc-020-r1',
    dev_dsh_port: DEV_DSH_PORT,
  })
  assert.equal(DEV_DSH_PORT, 9527)
  // 命名空间必须与 run_id 同形：非法形态直接拒绝，避免「裸名/穿越」进入登记
  assert.throws(() => envResourcesFor('Loc 020'), /非法任务命名空间/)
  assert.throws(() => envResourcesFor('../x'), /非法任务命名空间/)
  assert.equal(pluginNamespaceFor('loc-020-r1'), 'loc-020-r1')
})

test('pluginNameFor：插件注册名恒带任务命名空间前缀（结构上不可能出现裸名）', () => {
  assert.equal(pluginNameFor('loc-020-r1', 'vwf-abc123'), 'loc-020-r1-vwf-abc123')
  assert.equal(pluginNameFor('loc-020-r1', '-vwf-abc123'), 'loc-020-r1-vwf-abc123')
  assert.throws(() => pluginNameFor('', 'vwf-abc123'), /非法任务命名空间/)
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
