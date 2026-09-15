// 逐次持久化节点执行与成果提交（LOC-029）：records-host.mjs attempt 命令验收
// 真实子进程 + 真实临时目录（与产品运行形态一致）。覆盖规格验收标准：
//   AC-01 8 次调用留下 8 个完成 attempts；3 次评估各有正式 Revision，最新索引指向第 3 次
//   AC-02 同一节点跨 segment 再次执行也追加记录；fanout item/轮次不碰撞
//   AC-03 结果落盘后中断：已确认结果不丢失；重放同内容提交返回同一 Revision（不重复生成）；
//         遗留 running 由 close 收口为 interrupted
//   AC-04 重复提交（同键同内容幂等 / 同键异内容拒绝）、并发提交（磁盘互斥 + 唯一 tmp）
//         均不出现「证据有效且完成」却缺少记录
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RECORDS_HOST = join(here, '..', 'records-host.mjs')

const recordsDir = () => mkdtempSync(join(tmpdir(), 'vwf-attempt-'))

// 每次调用走真实 CLI 子进程：与产品运行形态一致（独立进程 + 磁盘权威）。
// 业务错误 = exit 1 + stdout { ok:false }（与既有 CLI 契约一致），helper 原样解析返回。
function cli(cmd, input) {
  let stdout
  try {
    stdout = execFileSync(process.execPath, [RECORDS_HOST, cmd, JSON.stringify(input)], { encoding: 'utf8' })
  } catch (e) {
    if (e.status === 1 && e.stdout) return JSON.parse(String(e.stdout))
    throw e
  }
  return JSON.parse(stdout)
}

function attemptInput(dir, run, attemptId, ev, extra = {}) {
  return {
    records_dir: dir,
    logical_run_id: run,
    attempt_id: attemptId,
    segment: 1,
    snapshot_revision: '1',
    provider: 'p1',
    model: 'm1',
    ...extra,
    ev,
  }
}

const callEnd = (k, n, verdict, extra = {}) => ({
  a: 'e', k, n, r: 0, t: 'call', s: 'completed', q: { verdict, node: n, round: k }, o: verdict, u: '$.verdict', ...extra,
})

test('AC-01 8 次调用留 8 个完成 attempts；3 次评估 3 个 Revision，最新索引指向第 3 次', () => {
  const dir = recordsDir()
  // 复现 loop-attempt-loss 场景：dev→review 两轮返工第三轮通过，再加测试与收口，共 8 次真实调用
  const script = [
    ['a1k1', { a: 's', k: 1, n: 'dev', r: 0, t: 'call' }],
    ['a1k1', { a: 'e', k: 1, n: 'dev', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 1 }, o: 'PASS', u: '$.verdict' }],
    ['a1k2', { a: 's', k: 2, n: 'review', r: 0, t: 'call' }],
    ['a1k2', { a: 'e', k: 2, n: 'review', r: 0, t: 'call', s: 'completed', q: { verdict: 'REJECT', v: 1 }, o: 'REJECT', u: '$.verdict' }],
    ['a1k3', { a: 's', k: 3, n: 'dev', r: 1, t: 'call' }],
    ['a1k3', { a: 'e', k: 3, n: 'dev', r: 1, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 2 }, o: 'PASS', u: '$.verdict' }],
    ['a1k4', { a: 's', k: 4, n: 'review', r: 1, t: 'call' }],
    ['a1k4', { a: 'e', k: 4, n: 'review', r: 1, t: 'call', s: 'completed', q: { verdict: 'REJECT', v: 2 }, o: 'REJECT', u: '$.verdict' }],
    ['a1k5', { a: 's', k: 5, n: 'dev', r: 2, t: 'call' }],
    ['a1k5', { a: 'e', k: 5, n: 'dev', r: 2, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 3 }, o: 'PASS', u: '$.verdict' }],
    ['a1k6', { a: 's', k: 6, n: 'review', r: 2, t: 'call' }],
    ['a1k6', { a: 'e', k: 6, n: 'review', r: 2, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 3 }, o: 'PASS', u: '$.verdict' }],
    ['a1k7', { a: 's', k: 7, n: 'test', r: 2, t: 'call' }],
    ['a1k7', { a: 'e', k: 7, n: 'test', r: 2, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 1 }, o: 'PASS', u: '$.verdict' }],
    ['a1k8', { a: 's', k: 8, n: 'closeout', r: 2, t: 'call' }],
    ['a1k8', { a: 'e', k: 8, n: 'closeout', r: 2, t: 'call', s: 'completed', q: { result: 'done' } }],
  ]
  for (const [aid, ev] of script) {
    const r = cli('attempt', attemptInput(dir, 'run-ac01', aid, ev))
    assert.equal(r.ok, true, JSON.stringify(r))
  }
  const list = cli('list', { records_dir: dir, logical_run_id: 'run-ac01' })
  // 8 个独立 attempt，全部 completed（start/end 在同一记录上构成 Revision 链）
  assert.equal(list.attempts.length, 8, '8 次调用留下 8 个 attempt 记录')
  assert.ok(list.attempts.every((a) => a.status === 'completed'), '全部完成状态')
  assert.ok(list.attempts.every((a) => a.attempt_id && a.node && a.record), '逐条可按 Run/Node/Attempt 寻址')
  // 3 次评估各有可读结果 Revision；最新索引指向第 3 次
  const review = cli('get', { records_dir: dir, logical_run_id: 'run-ac01', record_id: 'node:run-ac01:review' })
  assert.equal(review.current_revision, 3, '3 次评估形成 3 个节点 Revision')
  assert.equal(review.revisions.length, 3)
  assert.equal(review.revisions[2].body.value.v, 3, '最新 Revision 是第 3 次评估内容')
  const dev = cli('get', { records_dir: dir, logical_run_id: 'run-ac01', record_id: 'node:run-ac01:dev' })
  assert.equal(dev.current_revision, 3, '3 次实现同样 3 个 Revision')
  // start → end 追加链：attempt 记录自身 based_on 前一 Revision
  const revChain = list.records.filter((r) => r.record_id === 'attempt:run-ac01:a1k2')
  assert.equal(revChain.length, 2, '同一 attempt 的 start/end 构成 2 个 Revision')
  assert.deepEqual(revChain[1].based_on, { record_id: 'attempt:run-ac01:a1k2', record_revision: 1 })
  assert.equal(revChain[0].body.value.status, 'running')
  assert.equal(revChain[1].body.value.status, 'completed')
})

test('AC-02 同一节点跨 segment 再次执行追加记录；fanout item 与轮次不碰撞', () => {
  const dir = recordsDir()
  // segment 1：k1 完成 impl；segment 2（续跑）同一节点再次执行（k 序号重新计数不碰撞）
  cli('attempt', attemptInput(dir, 'run-ac02', 'a1k1', { a: 'e', k: 1, n: 'impl', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS', seg: 1 }, o: 'PASS', u: '$.verdict' }))
  cli('attempt', attemptInput(dir, 'run-ac02', 'a2k1', { a: 'e', k: 1, n: 'impl', r: 1, t: 'call', s: 'completed', q: { verdict: 'PASS', seg: 2 }, o: 'PASS', u: '$.verdict' }, { segment: 2 }))
  // fanout：同段同节点两个 item + 聚合逻辑步骤，attempt_id 各自独立
  cli('attempt', attemptInput(dir, 'run-ac02', 'a2k2', { a: 's', k: 2, n: 'fan', r: 1, t: 'item', i: 0, m: '专家一' }))
  cli('attempt', attemptInput(dir, 'run-ac02', 'a2k2', { a: 'e', k: 2, n: 'fan', r: 1, t: 'item', i: 0, s: 'completed', q: { ok: true } }))
  cli('attempt', attemptInput(dir, 'run-ac02', 'a2k3', { a: 'e', k: 3, n: 'fan', r: 1, t: 'item', i: 1, s: 'failed', x: 'item 未返回有效结果' }))
  cli('attempt', attemptInput(dir, 'run-ac02', 'a2k4', { a: 'l', k: 4, n: 'fan', r: 1, t: 'logical', q: { total: 2, okCount: 1, failedCount: 1 } }))
  const list = cli('list', { records_dir: dir, logical_run_id: 'run-ac02' })
  assert.equal(list.attempts.length, 5, '跨段再执行与 item/logical 均独立成档')
  const impl = cli('get', { records_dir: dir, logical_run_id: 'run-ac02', record_id: 'node:run-ac02:impl' })
  assert.equal(impl.current_revision, 2, '跨 segment 再执行推进节点索引 Revision')
  assert.equal(impl.revisions[1].body.value.seg, 2)
  // item 结果只入档，不推进节点最新索引；聚合（logical）才推进
  const fan = cli('get', { records_dir: dir, logical_run_id: 'run-ac02', record_id: 'node:run-ac02:fan' })
  assert.equal(fan.current_revision, 1, 'item 结果不推进节点索引')
  assert.deepEqual(fan.revisions[0].body.value, { total: 2, okCount: 1, failedCount: 1 }, '节点索引承载聚合结果')
  const items = list.attempts.filter((a) => a.kind === 'item')
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((a) => a.status).sort(), ['completed', 'failed'], 'item 成功/失败各有明确状态')
})

test('AC-03 结果落盘后中断：已确认结果不丢失；重放返回同一 Revision；遗留 running 收口 interrupted', () => {
  const dir = recordsDir()
  const end = { a: 'e', k: 1, n: 'eval', r: 0, t: 'call', s: 'completed', q: { verdict: 'PASS', v: 1 }, o: 'PASS', u: '$.verdict' }
  const c1 = cli('attempt', attemptInput(dir, 'run-ac03', 'a1k1', end))
  assert.equal(c1.ok, true)
  // 进程中断后重放同一提交（同键同内容）：deduped 且 Revision 不变
  const replay = cli('attempt', attemptInput(dir, 'run-ac03', 'a1k1', end))
  assert.equal(replay.ok, true)
  assert.equal(replay.deduped, true, '同键同内容重放被识别')
  assert.equal(replay.attempt.record_revision, c1.attempt.record_revision, '重放返回同一 Revision')
  assert.deepEqual(replay.attempt.record, c1.attempt.record, '重放指向同一记录')
  const after = cli('list', { records_dir: dir, logical_run_id: 'run-ac03' })
  assert.equal(after.record_count, 2, '重放不产生新记录（attempt + node 各 1）')
  // 另一调用只发了 start 就中断：close 收口为 interrupted
  cli('attempt', attemptInput(dir, 'run-ac03', 'a1k2', { a: 's', k: 2, n: 'eval', r: 1, t: 'call' }))
  const closed = cli('attempt', { records_dir: dir, logical_run_id: 'run-ac03', close: { segment: 1, status: 'interrupted' } })
  assert.equal(closed.ok, true)
  assert.equal(closed.closed.length, 1)
  assert.equal(closed.closed[0].status, 'interrupted')
  const list2 = cli('list', { records_dir: dir, logical_run_id: 'run-ac03' })
  const dangling = list2.attempts.find((a) => a.attempt_id === 'a1k2')
  assert.equal(dangling.status, 'interrupted', '中断 attempt 有明确状态，不残留 running')
  // close 幂等：重复 close 不再产生新 Revision
  const closed2 = cli('attempt', { records_dir: dir, logical_run_id: 'run-ac03', close: { segment: 1, status: 'interrupted' } })
  assert.equal(closed2.closed.length, 0, '重复 close 无新增')
})

test('AC-04 同键异内容提交被拒绝，不覆盖既有证据', () => {
  const dir = recordsDir()
  cli('attempt', attemptInput(dir, 'run-ac04', 'a1k1', callEnd(1, 'impl', 'PASS')))
  const before = cli('list', { records_dir: dir, logical_run_id: 'run-ac04' })
  const conflict = cli('attempt', attemptInput(dir, 'run-ac04', 'a1k1', callEnd(1, 'impl', 'FAIL')))
  assert.equal(conflict.ok, false)
  assert.match(conflict.error, /COMMIT_KEY_CONFLICT/, '同键不同内容拒绝并指名提交键')
  const after = cli('list', { records_dir: dir, logical_run_id: 'run-ac04' })
  assert.equal(after.record_count, before.record_count, '拒绝不产生任何写入')
  const node = cli('get', { records_dir: dir, logical_run_id: 'run-ac04', record_id: 'node:run-ac04:impl' })
  assert.equal(node.revisions[0].body.value.verdict, 'PASS', '原证据保持不变')
})

test('AC-04 并发提交：多进程同时写同一 Run，磁盘互斥下零丢失零损坏，无共享 .tmp 残留', async () => {
  const dir = recordsDir()
  const N = 6
  const workers = []
  for (let i = 0; i < N; i++) {
    const input = attemptInput(dir, 'run-conc', 'a1k' + (i + 1), { a: 'e', k: i + 1, n: 'impl', r: 0, t: 'item', i, s: 'completed', q: { ok: i } })
    workers.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [RECORDS_HOST, 'attempt', JSON.stringify(input)], { encoding: 'utf8' })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', () => {
        try { resolve(JSON.parse(out)) } catch (e) { resolve({ ok: false, error: 'unparseable: ' + out }) }
      })
    }))
  }
  const results = await Promise.all(workers)
  assert.ok(results.every((r) => r && r.ok === true), '并发提交全部成功：' + JSON.stringify(results.filter((r) => !r || !r.ok)))
  const list = cli('list', { records_dir: dir, logical_run_id: 'run-conc' })
  assert.equal(list.attempts.length, N, 'N 个并发提交一个不少')
  assert.equal(list.record_count, N, 'item 提交只写 attempt 记录（无索引 Revision），无重复无损坏')
  // 锁文件已释放；写入走唯一 tmp 原子替换，无残留 .tmp
  assert.equal(existsSync(join(dir, encodeURIComponent('run-conc') + '.json.lock')), false, '锁文件已释放')
  const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '无 .tmp 残留（唯一 tmp 名 + rename 原子换入）')
})

test('verifyBranch 完成事件按段末扫描同形签发 Proof：依赖当时节点 Revision，目标前进后 stale', () => {
  const dir = recordsDir()
  cli('attempt', attemptInput(dir, 'run-pf', 'a1k1', callEnd(1, 'impl', 'PASS')))
  cli('attempt', attemptInput(dir, 'run-pf', 'a1k2', callEnd(2, 'review', 'PASS', { w: { b: 'dev-x', h: 'head-A' } })))
  const list1 = cli('list', { records_dir: dir, logical_run_id: 'run-pf' })
  const proofRec = list1.records.find((r) => r.record_id === 'proof:run-pf:review')
  assert.ok(proofRec, 'verifyBranch 完成事件签发 proof_decision')
  // 与段末扫描同形：依赖 = 签发时刻全部节点记录当前 Revision（含刚落盘的 review 自身）
  assert.ok(proofRec.dependencies.some((d) => d.record_id === 'node:run-pf:impl' && d.record_revision === 1), 'Proof 依赖签发时 impl 当前 Revision')
  assert.ok(proofRec.dependencies.some((d) => d.record_id === 'node:run-pf:review' && d.record_revision === 1), 'Proof 依赖含 review 自身刚推进的 Revision')
  assert.equal(proofRec.body.value.verified_head, 'head-A')
  assert.equal(proofRec.body.value.verified_branch, 'dev-x')
  // impl 前进后旧 Proof 判 stale（保留不删）
  cli('attempt', attemptInput(dir, 'run-pf', 'a1k3', callEnd(3, 'impl', 'PASS')))
  const list2 = cli('list', { records_dir: dir, logical_run_id: 'run-pf' })
  const cov = list2.coverage.find((c) => c.proof.record_id === 'proof:run-pf:review' && c.target_record_id === 'node:run-pf:impl')
  assert.equal(cov.status, 'not_covering_current', '目标 Revision 前进后旧 Proof stale')
  assert.equal(cov.stale, true)
})

test('异常与边界：缺字段/非法事件拒绝；attempt 视图可按 node 与 attempt_id 过滤', () => {
  const dir = recordsDir()
  const bad = cli('attempt', { records_dir: dir, logical_run_id: 'run-edge', attempt_id: 'a1k1', ev: { a: 'x', k: 1, n: 'n' } })
  assert.equal(bad.ok, false, '非法 ev.a 拒绝')
  const bad2 = cli('attempt', { records_dir: dir, logical_run_id: 'run-edge', ev: { a: 's', k: 1, n: 'n' } })
  assert.equal(bad2.ok, false, '缺 attempt_id 拒绝')
  cli('attempt', attemptInput(dir, 'run-edge', 'a1k1', callEnd(1, 'impl', 'PASS')))
  cli('attempt', attemptInput(dir, 'run-edge', 'a1k2', callEnd(2, 'review', 'PASS')))
  const byNode = cli('list', { records_dir: dir, logical_run_id: 'run-edge', node: 'impl' })
  assert.equal(byNode.attempts.length, 1, '按 Node 过滤')
  assert.equal(byNode.attempts[0].attempt_id, 'a1k1')
  const byAttempt = cli('list', { records_dir: dir, logical_run_id: 'run-edge', attempt_id: 'a1k2' })
  assert.equal(byAttempt.attempts.length, 1, '按 Attempt 过滤')
  assert.equal(byAttempt.attempts[0].node, 'review')
})
