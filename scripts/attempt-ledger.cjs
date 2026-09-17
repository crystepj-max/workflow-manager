// LOC-029 逐次 attempt 提交内核（host 侧接线逻辑，dist 内核形态）
// 职责：把编译脚本经 [vwf-attempt] 行声明的每次真实调用事件，转为对 Records Store
// （scripts/records-host.mjs attempt 命令）的逐次提交，并在段收尾做「确认 → 回填
// 节点最新索引」的固定顺序推进。业务事实（提交键去重 / Revision 链 / Proof 签发）
// 全部在 Store 端；本内核只做宿主侧编排：事件解析、每 Run 串行提交队列、失败清单、
// 遗留 running 收口与索引回填。放在内核形态的原因：dynamic 闭包（host.js+client.js）
// 有一次 cordis_define 载荷预算（190KiB），内核文件不占该预算。
//
// 用法（host.js）：
//   const t = await loadDist('attempt-ledger.cjs').then((m) => m.create({
//     call: recordsHostCall,                                  // (cmd, input) => Promise<result>
//     lrecOf: (engineRunId) => logicalRec | null,             // 引擎运行 → 逻辑运行摘要
//     snapOf: activeSnapshot,                                 // (logicalRec) => active snapshot
//   }))
//   t.line(runId, message)      // workflow/log 钩子：非事件行零动作
//   t.setWs(runId, ws)          // 段启动登记 workspace（Proof 绑定；ws 可为 null）
//   t.settle(lrec, runId, segNo) // 段收尾：Promise<{ x: 失败清单 } | null>（null=旧脚本段，走扫描回退）
'use strict'

const LINE_TAG = '[vwf-attempt]'

module.exports = {
  create(deps) {
    const call = deps.call
    const lrecOf = deps.lrecOf
    const snapOf = deps.snapOf
    if (typeof call !== 'function' || typeof lrecOf !== 'function' || typeof snapOf !== 'function') {
      throw new Error('attempt-ledger.create 需要依赖：call / lrecOf / snapOf')
    }
    // engineRunId → { f: 串行提交链, x: 失败清单 }；engineRunId → 段 workspace
    const jobs = new Map()
    const wsMap = new Map()

    // 事件行 → Records Store 逐次提交。attempt_id 由宿主侧按「段号 k 调用序号」分配：
    // 同一 attempt 的 start/end 事件落到同一条 attempt 记录的追加 Revision；提交顺序
    // 与事件顺序一致（每 Run 串行链），节点索引 Revision 不乱序。
    function line(runId, message) {
      const raw = String(message || '')
      const i = raw.indexOf(LINE_TAG)
      if (i < 0) return
      const key = String(runId || '')
      const lrec = lrecOf(key)
      if (!lrec) return
      let ev
      try { ev = JSON.parse(raw.slice(i + LINE_TAG.length)) } catch (e) { return }
      if (!ev || typeof ev !== 'object' || !ev.a || !ev.k || !ev.n) return
      const snap = snapOf(lrec)
      const pm = (snap && snap.provider_model && snap.provider_model[ev.n]) || null
      const segNo = (lrec.segments || []).length
      const st = jobs.get(key) || { f: Promise.resolve(), x: [] }
      jobs.set(key, st)
    // onLine(ev, lrec)：可选；宿主可在此挂接 resolved_inputs 等段内事实（LOC-034）
    if (typeof deps.onLine === 'function') {
      try { deps.onLine(ev, lrec) } catch (e) { /* 宿主 hook 失败不阻断 Store 提交 */ }
    }
      const sync = lrec.last_gate_sync
      const explicitRefs = (ev.w && sync && sync.record_id && sync.record_revision)
        ? [{ record_id: sync.record_id, record_revision: sync.record_revision }]
        : undefined
      const p = call('attempt', {
        logical_run_id: lrec.logical_run_id,
        attempt_id: 'a' + segNo + 'k' + ev.k,
        segment: segNo,
        snapshot_revision: snap ? String(snap.revision) : 'unspecified',
        provider: String((pm && pm.provider) || 'default'),
        model: String((pm && pm.model) || 'default'),
        workspace: wsMap.get(key) || null,
        resolved_inputs: ev.ri || null,
        explicit_refs: explicitRefs,
        ev,
      })
      st.f = st.f.then(() => p).then(
        (r) => { if (!r || r.ok !== true) st.x.push('a' + segNo + 'k' + ev.k + ':' + String((r && r.error) || '提交失败')) },
        (e) => { st.x.push('a' + segNo + 'k' + ev.k + ':' + String((e && e.message) || e)) },
      )
    }

    // Store 为逐次记录权威：把本段已确认的记录回填为节点最新索引（node_attempts 条目
    // 与 business_outcomes 增量均由 Store 端按提交时的溯源事实构造，这里只落字段）。
    function apply(rec, q) {
      const entries = Array.isArray(q && q.entries) ? q.entries : []
      for (const e of entries) rec.node_attempts.push(e)
      const bos = q && q.bos && typeof q.bos === 'object' ? q.bos : null
      if (bos) for (const k of Object.keys(bos)) rec.business_outcomes[k] = bos[k]
      if (entries.length) rec.updated_at = Date.now()
      return entries.length
    }

    // 段收尾：等提交链落盘（正式记录确认）→ 关闭遗留 running 的 attempt（事件丢失
    // 兜底，Store 端幂等）→ 拉取本段已确认记录回填索引。返回失败清单供 fail-closed；
    // null = 本段无逐次提交（旧冻结脚本），调用方走段末扫描回退。
    async function settle(lrec, runId, segNo) {
      const key = String(runId || '')
      const st = jobs.get(key)
      wsMap.delete(key)
      if (!st) return null
      jobs.delete(key)
      await st.f.catch(() => {})
      await call('attempt', { logical_run_id: lrec.logical_run_id, close: { segment: segNo, status: 'interrupted' } }).catch(() => {})
      const q = await call('list', { logical_run_id: lrec.logical_run_id, segment: segNo })
      apply(lrec, q)
      // 与段末扫描（commitNodeRecords）同形：提交成功后刷新摘要互相引用
      if (q && q.ok) {
        lrec.formal_records = { record_count: q.record_count, last_commit_at: Date.now() }
      }
      if (st.x.length) {
        // 可追溯原因：证据提交失败进入控制事件流（shape 与宿主 controlEvent 一致）
        ;(lrec.control_events = lrec.control_events || []).push({
          type: 'evidence_commit_failed',
          at: Date.now(),
          failed_commits: st.x.length,
          detail: st.x.slice(0, 5),
        })
      }
      return st
    }

    return {
      line,
      settle,
      apply,
      setWs: (runId, ws) => {
        wsMap.set(String(runId || ''), ws ? {
          workspace_id: ws.workspace_id || null,
          source_path: ws.source_path || null,
          work_branch: ws.work_branch || null,
        } : null)
      },
    }
  },
}
