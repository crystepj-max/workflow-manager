#!/usr/bin/env node
// 证据链机器校验引擎（契约 §8.3 九项呈递/签收前校验 + ⑩ 时间序 + ⑪ feedback 磁盘复核；M2 验收三态）
// 用法：node scripts/cwf-evidence-verify.mjs <runDir>
//   accept / conditional_pass 均要求 review approve + test pass（有条件通过 ≠ 知情接受未达标）
// 输出逐项 JSON 判定；exit 0 全部通过，exit 1 任一失败

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STAGE_MAP = {
  requirements_baseline: 'requirements',
  design_package: 'design',
  dev_handoff: 'dev',
  review_proof: 'review',
  test_proof: 'test',
}

function liveState(runDir, run) {
  // Proof 绑定比对的实况源：不信任 run.json 可变缓存（§7.3）。
  // 归档态检测（PR #132 Review）：run 已归档到主检出时实况分支 ≠ run.work_branch，
  // 不得拿主检出的 HEAD/分支去比对开发期 proof——回退 run.json 历史值
  const wt = join(runDir, '..', '..')
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim()
    if (branch !== run.work_branch) return null
    return {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim(),
      branch,
    }
  } catch {
    return null
  }
}

function liveTarget(runDir, run) {
  // 实况 target HEAD（防 checkpoint 过期：自记录后 target 再前进须拦截）
  const wt = join(runDir, '..', '..')
  try {
    execFileSync('git', ['fetch', 'origin', run.base_ref], { cwd: wt, stdio: 'pipe' })
    return execFileSync('git', ['rev-parse', `origin/${run.base_ref}`], { cwd: wt, encoding: 'utf-8' }).trim()
  } catch {
    return null // 离线/归档态：跳过实况比对
  }
}

function commitDateOf(runDir, sha) {
  // 取 git 自证的 author 日期（rebase/amend 只改 committer，author 更抗改写）。
  // 非十六进制直接拒查：避免把记录里的字符串当 revision 表达式传给 git。取不到返回 NaN，由 ⑩ 显式报「未评估」
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(sha)) return NaN
  try {
    const out = execFileSync('git', ['show', '-s', '--format=%aI', sha], {
      cwd: join(runDir, '..', '..'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return Date.parse(out)
  } catch {
    return NaN
  }
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

export function verifyEvidenceChain(runDir, { live = null } = {}) {
  // live：实况 HEAD/branch 注入（测试）或缺省从 git 读取——Proof 绑定比对以实况为准，不信任 run.json 缓存
  const checks = []
  const check = (id, name, ok, detail) => checks.push({ id, name, ok, detail })

  const run = loadJson(join(runDir, 'run.json'))
  const index = loadJson(join(runDir, 'index.json'))
  const apFile = index.acceptance_package
  if (!apFile || !existsSync(join(runDir, apFile))) {
    check('chain', '验收包存在', false, 'index.json 无 acceptance_package 指向')
    return { ok: false, checks }
  }
  const ap = loadJson(join(runDir, apFile))
  const refs = ap.payload?.assembled || {}
  const records = {}
  for (const [field, ref] of Object.entries(refs)) {
    if (field === 'integration_checkpoint') continue
    const rt = field.replace(/_ref$/, '')
    records[rt] = existsSync(join(runDir, ref)) ? loadJson(join(runDir, ref)) : null
  }

  // ① record_type 与产生 Stage 映射正确（§8.1）
  const badMap = Object.entries(records)
    .filter(([rt, r]) => r && (r.record_type !== rt || r.run?.stage !== STAGE_MAP[rt]))
    .map(([rt, r]) => `${rt}(实际 ${r.record_type}/${r.run?.stage})`)
  check('①', 'record_type 与 Stage 映射', badMap.length === 0, badMap.join('; ') || 'ok')

  const review = records.review_proof, test = records.test_proof
  const dev = records.dev_handoff, design = records.design_package
  const baseline = records.requirements_baseline

  // ② review approve + test pass（M2：conditional_pass 同样要求）
  {
    const ok = review?.payload?.verdict === 'approve' && test?.payload?.verdict === 'pass'
    check('②', 'review approve 且 test pass', ok, ok ? 'ok' : `review=${review?.payload?.verdict} test=${test?.payload?.verdict}`)
  }

  // ③ 同 Run / 同 workspace lineage
  const all = [baseline, design, dev, review, test, ap].filter(Boolean)
  const runIds = new Set(all.map(r => r.run?.run_id))
  const workspaces = new Set(all.map(r => r.run?.workspace_id))
  const branches = new Set(all.map(r => r.run?.work_branch))
  const okLineage = runIds.size === 1 && workspaces.size === 1 && branches.size === 1
    && [...runIds][0] === run.run_id && [...branches][0] === run.work_branch
    && [...workspaces][0] === run.workspace_id
  check('③', '同 Run/workspace lineage', okLineage, okLineage ? 'ok' : `run_id=${[...runIds]} ws=${[...workspaces]} br=${[...branches]}`)

  // ④ Proof HEAD/branch 与实况一致（§7.3）：不信任 run.json 缓存
  const liveNow = live || liveState(runDir, run)
  const refHead = liveNow ? liveNow.head : run.current_head
  const refBranch = liveNow ? liveNow.branch : run.work_branch
  const badHead = []
  for (const [rt, r] of [['review_proof', review], ['test_proof', test]]) {
    if (r && (r.payload?.verified_head !== refHead || r.payload?.verified_branch !== refBranch)) {
      badHead.push(`${rt}(head=${r.payload?.verified_head} ≠ 实况 ${refHead})`)
    }
  }
  if (liveNow && run.current_head !== liveNow.head) {
    badHead.push(`run.json current_head(${run.current_head}) 落后于实况——先 reverify`)
  }
  // 同项附带 Integration Checkpoint 条件不变量与实况复核（§7.3）：引擎不经 schema，此处直验
  const ckpt = refs.integration_checkpoint
  if (!ckpt || typeof ckpt !== 'object') {
    badHead.push('integration_checkpoint 缺失')
  } else {
    if (ckpt.target_advanced === true && ckpt.proofs_state !== 'rerun_completed') {
      badHead.push('checkpoint target 已前进但 proofs_state≠rerun_completed（受影响 Proof 未重跑）')
    }
    // checkpoint 实况复核：自记录后 target 再前进 / 声称未前进但实况已前进 → 拒绝
    const liveT = live && 'targetHead' in live ? live.targetHead : liveTarget(runDir, run)
    if (liveT) {
      if (ckpt.target_head_at_check !== liveT) {
        badHead.push(`checkpoint 过期：target 自记录（${ckpt.target_head_at_check}）后又前进（现 ${liveT}）——重新执行 checkpoint`)
      } else if (ckpt.target_advanced === false && liveT !== run.base_commit) {
        badHead.push('checkpoint 称未前进但实况 target 已前进')
      }
    }
  }
  check('④', 'Proof 绑定实况 HEAD/branch 且 checkpoint 条件不变量成立', badHead.length === 0, badHead.join('; ') || 'ok')

  // ⑤ baseline confirmed 且无残留 gaps
  const ok5 = baseline?.payload?.status === 'confirmed' && (baseline.payload.gaps || []).length === 0
  check('⑤', 'baseline confirmed 且无残留 gaps', ok5, ok5 ? 'ok' : `status=${baseline?.payload?.status} gaps=${(baseline?.payload?.gaps || []).length}`)

  // ⑥ design package_ready；过门必带 Decision Record 且 chosen ∈ 呈递候选集
  let ok6 = design?.payload?.outcome === 'package_ready'
  let detail6 = ok6 ? 'ok' : `outcome=${design?.payload?.outcome}`
  if (ok6 && design.payload.decision_required) {
    if (!design.payload.decision) {
      ok6 = false; detail6 = '命中条件门但无 Decision Record'
    } else if (!design.payload.decision_request) {
      ok6 = false; detail6 = '命中条件门但缺 decision_request（呈递候选集丢失）'
    } else {
      const names = design.payload.decision_request.options.map(o => o.name)
      if (!names.includes(design.payload.decision.chosen)) {
        ok6 = false; detail6 = `chosen(${design.payload.decision.chosen}) 不在呈递候选集 ${names}`
      } else if (design.payload.decision.question !== design.payload.decision_request.question) {
        ok6 = false; detail6 = `decision.question 与呈递的 decision_request.question 不一致（人工答的那份被事后替换）`
      }
    }
  }
  check('⑥', 'design package_ready 且过门已决', ok6, detail6)

  // ⑦ dev handoff_ready
  const ok7 = dev?.payload?.outcome === 'handoff_ready'
  check('⑦', 'dev handoff_ready', ok7, ok7 ? 'ok' : `outcome=${dev?.payload?.outcome}`)

  // ⑧ 验收映射与基线验收标准逐条完整无重复对应
  const want = baseline?.payload?.acceptance || []
  const mapping = (test?.payload?.acceptance_mapping || []).map(m => m.acceptance_item)
  const dup = mapping.filter((m, i) => mapping.indexOf(m) !== i)
  const missing = want.filter(w => !mapping.includes(w))
  const extra = mapping.filter(m => !want.includes(m))
  let ok8 = missing.length === 0 && extra.length === 0 && dup.length === 0
  let detail8 = ok8 ? 'ok' : `missing=${missing.length} extra=${extra.length} dup=${dup.length}`
  if (ok8) {
    const notPass = (test.payload.acceptance_mapping || []).filter(m => m.result !== 'pass')
    ok8 = notPass.length === 0
    if (!ok8) detail8 = `非 pass 结果 ${notPass.length} 项`
  }
  check('⑧', '验收映射完整无重复（accept/conditional_pass 场景全 pass）', ok8, detail8)

  // ⑨ review/test 产生者异于 dev 且独立会话标志为真（异源自证禁令 + 自声明缺一不可）
  const ok9 = review && test && dev
    && review.produced_by !== dev.produced_by && test.produced_by !== dev.produced_by
    && review.payload?.independent_session === true && test.payload?.independent_session === true
  check('⑨', 'review/test 与 dev 异源且独立会话标志为真', Boolean(ok9), ok9 ? 'ok' : `produced_by(review=${review?.produced_by} test=${test?.produced_by} dev=${dev?.produced_by}) independent_session(review=${review?.payload?.independent_session} test=${test?.payload?.independent_session})`)

  // ⑩ 时间序：人不可能签收一个当时还不存在的提交
  {
    const decidedRaw = ap.payload?.decided_at
    const decidedAt = Date.parse(decidedRaw ?? '')
    const sha = ap.payload?.verified_head
    const cd = live && 'commitDate' in live
      ? Date.parse(live.commitDate)
      : (Number.isFinite(decidedAt) ? commitDateOf(runDir, sha) : NaN)
    let ok10 = true
    let detail10
    if (!Number.isFinite(decidedAt)) {
      detail10 = '未评估：无 decided_at（awaiting_decision 形态本无签收时刻）'
    } else if (!Number.isFinite(cd)) {
      // D-4：不可达只显式报出、不阻断——否则归档/离线态整链永远红（实测 56/88 条不可评估）
      detail10 = `未评估：verified_head(${String(sha).slice(0, 12)}) 提交时刻本地不可达`
    } else if (cd > decidedAt) {
      ok10 = false
      detail10 = `倒挂 ${Math.floor((cd - decidedAt) / 60000)} 分钟：签收 ${decidedRaw} 早于所验提交 ${new Date(cd).toISOString()}（D-2 零容差，分钟级同样判失败）`
    } else {
      detail10 = `ok（提交早于签收 ${Math.floor((decidedAt - cd) / 60000)} 分钟）`
    }
    // ⑩-a 反向软判（D-1）：记录不得早于它所记载的签收——只提示，不参与整链结论
    const recCreated = Date.parse(ap.created_at ?? '')
    if (Number.isFinite(decidedAt) && Number.isFinite(recCreated) && recCreated < decidedAt) {
      detail10 += `；提示：记录 created_at(${ap.created_at}) 早于所载签收 ${decidedRaw}，偏离 ${Math.round((decidedAt - recCreated) / 60000)} 分钟（跨机时钟偏差与回填皆可能，不阻断）`
    }
    check('⑩', '时间序：签收不得早于所验提交', ok10, detail10)
  }

  // ⑪ conditional_pass 必须带非空 feedback（契约 §8.3 ②）。schema 已约束经 cwf-record 的写入，
  // 此处复核磁盘记录本身——直接改文件或手搓记录会绕过 schema，只有整链校验能兜住
  {
    const d = ap.payload?.decision
    let ok11 = true
    let detail11 = d === 'conditional_pass' ? 'ok' : `decision=${d}——不要求 feedback`
    if (d === 'conditional_pass') {
      const fb = ap.payload?.feedback
      if (typeof fb !== 'string' || !/\S/.test(fb)) {
        ok11 = false; detail11 = 'conditional_pass 缺 feedback：优化意见未落记录，等同把有条件通过洗成普通通过（契约 §8.3 ②）'
      }
    }
    check('⑪', 'conditional_pass 附非空 feedback', ok11, detail11)
  }

  return { ok: checks.every(c => c.ok), checks }
}

function main() {
  const args = process.argv.slice(2)
  const runDir = args[0]
  if (!runDir) {
    console.error('用法: node scripts/cwf-evidence-verify.mjs <runDir>')
    process.exit(2)
  }
  if (args.includes('--decision') && args[args.indexOf('--decision') + 1] === 'user_accepted') {
    console.error('M2：已废弃 --decision user_accepted。有条件通过请用 conditional_pass（仍要求审查通过+测试通过，并在 feedback 记录优化意见）。')
    process.exit(2)
  }
  const result = verifyEvidenceChain(runDir)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
